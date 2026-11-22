# Propuesta: Red de agentes y orquestador en ZeroChat

> Borrador de diseño derivado de las decisiones cerradas tras M84. No modifica código ni abre todavía un hito en `.zerochat/plan.md`.

## 1. Objetivo

Construir sobre la base de **M84** (`--run-file`, tabla `runs` en SQLite, `zerochat/heartbeat` con `focus_run`, códigos de salida y vista de pendientes) un sistema completo de control de agentes dentro del propio ZeroChat, compuesto por:

1. **Un orquestador mínimo**, siguiendo la misma filosofía que el RAG de ZeroChat: el modelo decide qué hacer y el sistema solo le inyecta el estado actualizado en cada despertar y le da tres primitivas seguras (`dispatch_agent`, `cancel_agent`, `finish_network`).
2. **Un diseñador y monitor de orquestaciones** (`network.html`), para definir redes a partir de plantillas, lanzarlas y seguir su evolución con acceso directo al chat de cada agente.

---

## 2. Principios y decisiones de diseño

### 2.1 Ámbito de directorio y seguridad

- Una **red de agentes** trabaja siempre sobre **un único directorio de proyecto**.
- Todos los agentes de la red (orquestador e hijos) heredan el **entorno guardado del proyecto** (`M80`: herramientas habilitadas, servicios MCP y reglas `R`/`W`/`X` de directorios), respetando `M84-D1` (`--run-file` nunca amplía permisos).
- Si una red necesita acceder a ficheros fuera de su carpeta, se concede mediante las **reglas `R`/`W` de directorios existentes** en la configuración del proyecto.
- El orquestador solo puede despachar, continuar o cancelar **conversaciones hijas pertenecientes a su propia ejecución de red**, y **nunca** puede aprobar retos de permisos (`zerochat/security/authorize`).

### 2.2 Separación entre definición en disco (`.zerochat/network.json`) y ejecución activa (SQLite)

- **Definición declarativa en disco (`.zerochat/network.json`):** guarda únicamente el diseño de la red (plantilla, objetivo base, roles/agentes, perfiles, razonamiento y frenos). Es 100% estable y versionable en Git: ejecutar la red nunca ensucia `git status`.
- **Instancia de ejecución en SQLite (`network_runs`):** cada vez que se lanza la red (opcionalmente con un encargo puntual que complementa al objetivo base), se crea una fila en SQLite que guarda:
  - `orchestrator_conversation_id` y el mapa de hijos (`rol -> conversation_id`);
  - estado de la red (`running`, `waiting_children`, `needs_input`, `completed`, `limit`, `error`), contador `wake_count`, condición de despertar (`wake_on: "all" | "any"`) y marca `pending_wake`;
  - una **copia congelada** de la definición y de los frenos de `.zerochat/network.json` en el momento de arrancar, de modo que ningún agente hijo con permiso `W` en la carpeta pueda alterar sus propios límites (`maxSteps`, `maxWakes`, `timeout`) editando el fichero en mitad de una corrida.
- **Convivencia:** el modo «red de agentes» convive en la misma carpeta con el modo proyecto actual (`.zerochat/plan.md`, `state.md`, `log.md`); un directorio puede usar ambos sin ser excluyentes.

### 2.3 El orquestador como «otro chat» (sin proceso residente entre turnos)

El orquestador es una conversación más de ZeroChat con su propio modelo. Para no consumir memoria ni pasos de modelo innecesarios:

1. **Estado inyectado en el despertar (sin herramienta `check_status`):** cuando el backend despierta al orquestador, el mensaje automático de reanudación ya incluye la tabla estructurada con el estado actual de todos los hijos (`running`, `completed`, `needs_input`, `limit`, `error`), su `result_text`, sus `warnings` (permisos denegados) y el presupuesto restante (`wake_count / maxWakes`). Así el orquestador decide en un único paso de modelo sin gastar un turno llamando a una herramienta de consulta.
2. **Tres primitivas de acción:**
   - `dispatch_agent`: lanza o continúa uno o varios agentes hijos (por rol definido en la red, con instrucciones para ese turno) y fija la condición del próximo despertar (`wake_on: "all"` por defecto cuando despacha varios hijos, o `"any"` si quiere reaccionar al primero que acabe; un `error` o `limit` despierta siempre).
   - `cancel_agent`: detiene un hijo en marcha que ya no es necesario.
   - `finish_network`: cierra la orquestación (`completed` o `error`) con el resumen final.
3. **Turno efímero:** en cuanto el orquestador despacha hijos y cierra su turno, **su proceso runner termina**. Mientras los hijos trabajan solo existen los procesos de los hijos activos; cuando se cumple la condición de despertar, `wake` vuelve a lanzar un turno `--conversation` sobre la conversación del orquestador.

### 2.4 Artefactos y prevención de colisiones en paralelo

- Los agentes intercambian entregables extensos mediante ficheros `.md` en el directorio del proyecto (`M79-D8`), además del `result_text` final de cada hijo que recibe el orquestador.
- Para evitar que dos hijos en paralelo se pisen editando los mismos ficheros o ejecutando comandos conflictivos:
  - Las plantillas *Pipeline por fases* y *Ejecutor + revisor* fijan `maxConcurrent = 1` por defecto.
  - En *Coordinador + especialistas*, cuando corren varios hijos en paralelo (`maxConcurrent > 1`), cada rol escribe por convención su entregable en su propia ruta (`.zerochat/artifacts/<rol>.md`).

### 2.5 Despertar unificado (`wake`): eventos en servidor y autonomía en `cron`

No existe una herramienta bloqueante de `wait`. Todo el avance de la red pasa por **una única operación idempotente y atómica `wake`**:

1. **Cerrojo y `pending_wake` contra condiciones de carrera:**
   - Si al dispararse `wake` (porque dos hijos terminan casi a la vez o coincide un evento con un `cron`) la conversación del orquestador ya está en `running`, `wake` **no lanza otro turno**: marca `pending_wake = 1` en SQLite y termina.
   - Al concluir cualquier turno del orquestador, si `pending_wake == 1`, el backend limpia la marca y reevalúa `wake` automáticamente.
2. **Evaluación de la condición de despertar:**
   - Comprueba en SQLite los hijos de la red frente al último estado visto por el orquestador.
   - Con `wake_on: "all"`, solo despierta al orquestador cuando ningún hijo despachado sigue en `running` (salvo que alguno haya caído en `error` o `limit`, o todos los que quedan estén en `needs_input`).
   - Con `wake_on: "any"`, despierta en cuanto al menos un hijo cambia a `completed`, `limit` o `error`.
   - Si no se cumple la condición (o no hay cambios), no llama al modelo y sale de inmediato.
3. **Dos modos de disparo sobre la misma operación:**
   - **Con servidor `zerochat.py` en marcha:** el servidor dispara `wake` por eventos al terminar cada hijo (vía `watch_run_exit` sobre `pid` y `pid_start` que la tabla `runs` de SQLite ya guarda desde `M83-D2`). Además, **al arrancar `zerochat.py`** reconcilia las redes activas (`network_runs`) contra `runs`: reengancha `watch_run_exit(pid, pid_start)` a cualquier agente cuyo proceso siga vivo tras un reinicio del servidor y dispara `wake` si alguno terminó o murió mientras el servidor estaba cerrado, sin depender de que haya un navegador conectado.
   - **Desde `cron` sin servidor permanente (`zerochat --network-wake`):** si hay hijos de la red cuyo `pid` sigue vivo en `runs`, los espera con `wait_pid_exit`; ejecuta `wake` y encadena los turnos de orquestador e hijos hasta que la red llegue a `completed`, `error`, `limit` o quede bloqueada en `needs_input` esperando a la persona; en ese momento el comando termina sin dejar procesos residentes.

### 2.6 Intervención humana (`needs_input`)

- Cuando un agente hijo se pausa en `needs_input` (permiso de herramienta o pregunta `ask_user`), aparece directamente en la vista **Pendientes** (`M84-T4`) para la persona y **no despierta al orquestador**.
- Una vez que la persona responde o aprueba y el hijo termina (o acaba en `limit` / `error`), ese cambio de estado dispara `wake` y despierta al orquestador.
- El propio orquestador también puede usar `ask_user` y quedar en **Pendientes** si necesita consultar directamente a la persona.

### 2.7 Configuración por agente y frenos globales

- **Por agente:** `role` (identificador estable), nombre visible, objetivo/instrucciones del rol, perfil de conexión (modelo), nivel de razonamiento y límites por turno (`maxSteps`, `timeout`).
- **Frenos globales de la red:**
  - `maxWakes`: máximo de despertares del orquestador en una ejecución de red (si se alcanza, la red pasa a estado `limit`, ampliable por la persona igual que `maxSteps` en M84-T3).
  - `maxConcurrent`: máximo de agentes hijos ejecutándose simultáneamente.

---

## 3. Diseñador y monitor (`network.html`)

Vive en una **página dedicada** (`network.html`, al estilo de `files.html`), accesible desde ZeroChat y reutilizando la sesión guardada del backend:

- **Editor de red (`.zerochat/network.json`):** objetivo general, frenos globales (`maxWakes`, `maxConcurrent`) y fichas de agentes (rol, objetivo, perfil, razonamiento, `maxSteps`, `timeout`).
- **Plantillas iniciales de organización:**
  1. **Coordinador + especialistas:** el orquestador reparte subtareas a agentes con rol fijo (con salida en `.zerochat/artifacts/<rol>.md`) y sintetiza resultados.
  2. **Pipeline por fases (`maxConcurrent = 1`):** secuencia ordenada (ej. investigar → implementar → revisar) pasando artefactos `.md` de una fase a la siguiente.
  3. **Ejecutor + revisor en bucle (`maxConcurrent = 1`):** un agente realiza el trabajo y otro lo audita hasta aprobar o agotar rondas.
- **Panel de seguimiento en vivo:** estado de la ejecución de red (`network_runs`), contador de despertares (`wake_count / maxWakes`), tarjetas de cada agente hijo con su estado/último paso, avisos de `needs_input` y enlace directo para abrir el chat del orquestador o de cualquier hijo en ZeroChat.

---

## 4. Encaje por capas (borrador)

| Capa | Responsabilidad |
|---|---|
| `py/network/` (nuevo) | Lectura/validación de `.zerochat/network.json`, tabla `network_runs` en SQLite, operación atómica `wake` (`pending_wake`, `wake_on`, servidor por eventos + CLI `--network-wake` para `cron`) y endpoints JSON-RPC `zerochat/network/*`. |
| `js/tools/builtin/` | Herramientas del orquestador (`dispatch_agent`, `cancel_agent`, `finish_network`), expuestas solo al turno del orquestador de una red activa. |
| `network.html` + `js/network-page.js` | Diseñador con las 3 plantillas, editor de `.zerochat/network.json`, lanzamiento/parada de la red y monitor en vivo. |
| `zerochat.html` / barra lateral | Enlace a `network.html` en el proyecto activo y visualización/acceso a las conversaciones del orquestador y sus hijos. |
