# Arquitectura y visión del sistema

Este documento es la raíz arquitectónica de ZeroChat. Define **los objetivos del sistema, los principios rectores y las decisiones estratégicas** de alto nivel, y mapea cada subsistema hacia los documentos tácticos (`README.md`) donde residen los contratos de implementación.

Todo desarrollador o agente debe leer este documento antes de proponer funcionalidades o diseñar cambios para no reinventar mecanismos existentes ni reabrir alternativas ya descartadas.

---

## 1. Objetivos y principios rectores

ZeroChat tiene como objetivo ofrecer un **entorno personal, privado y completo para trabajar con agentes de IA**, capaz de escalar desde una consulta puntual en un navegador sin instalar nada hasta la ejecución autónoma, en segundo plano y orquestada de múltiples agentes sobre proyectos reales.

Toda decisión técnica se subordina a cuatro principios innegociables:

1. **Simplicidad radical de distribución y despliegue:**
   - El frontend es una aplicación web estática (PWA) en JavaScript puro, **sin bundler ni paso de compilación**, servida desde GitHub Pages (o en local durante el desarrollo).
   - El backend se distribuye como un **único archivo ejecutable de Python (`zerochat.py`) que usa exclusivamente la biblioteca estándar**, compilado a partir de paquetes modulares (`py/`) e instalable vía PyPI o descarga directa.
2. **Un único motor agéntico compartido:**
   - La inteligencia del cliente (bucle de razonamiento, gestión de ventana de contexto, llamadas a herramientas, adaptadores de proveedores de IA y extracción de documentos) se escribe **una sola vez en JavaScript modular (UMD)**.
   - Tanto el navegador como las ejecuciones desatendidas por CLI o en segundo plano (mediante un proceso ligero de Node.js que descarga y cachea por versión los módulos de la interfaz) ejecutan exactamente el mismo motor. No se duplica lógica agéntica en Python.
3. **Soberanía de datos, aislamiento y mínimo privilegio:**
   - Todo el estado del servidor vive en la carpeta del usuario (`~/zerochat/`) dentro de una **única base de datos SQLite**, con un entorno virtual aislado para servicios externos. Borrar esa carpeta restablece el backend por completo.
   - Los secretos (API keys y credenciales de servicios) viven únicamente donde se usan, se almacenan ofuscados y jamás se exponen en listados ni al modelo.
4. **Agnosticismo de modelo y cero código especulativo:**
   - El sistema se diseña contra protocolos y capacidades declaradas o sondeadas, **nunca con parches o ramas para un nombre de modelo concreto**.
   - No se mantiene código muerto, opciones sin consumidor actual, ganchos exclusivos para pruebas ni capas de compatibilidad o migración perpetua.

---

## 2. Decisiones estratégicas de arquitectura

### 2.1. Cinco niveles progresivos sobre un mismo motor

ZeroChat evoluciona desde un cliente web ligero hasta un ejecutor autónomo de agentes sin fragmentar su código: el **mismo motor agéntico en JS** y el **mismo backend personal en Python** cubren cinco niveles acumulativos:

| Nivel | Qué requiere | Capacidades |
|---|---|---|
| **1. Chat web (solo frontend)** | Navegador (GitHub Pages o PWA) | Chat con APIs CORS o WebLLM (WebGPU), adjuntos (PDF/Office), RAG local en navegador, búsqueda/lectura web (Jina Reader) y sandbox JS. Sin acceso al disco. |
| **2. Chat con backend local** | `zerochat` (Python) | Ficheros y comandos por proyecto (`RWX`), modo proyecto (`.zerochat/`), servicios MCP gestionados, navegador del modelo (`browser_action`/Playwright), secretos por proyecto y persistencia/sincronización en SQLite. |
| **3. Ejecución CLI (`--prompt`, `--conversation`)** | `zerochat` + Node.js ≥ 22.13 | Peticiones desatendidas desde shell o `cron` sin interfaz gráfica, salida limpia por `stdout` y códigos de salida estructurados. |
| **4. Ejecución en segundo plano en servidor** | `zerochat` + Node.js ≥ 22.13 | Turnos lanzados desde la interfaz como procesos independientes: se puede cerrar el navegador y retomar luego el avance o responder a un `needs_input`. |
| **5. Orquestación desatendida de agentes (`--run-file`)** | `zerochat` + Node.js ≥ 22.13 | Agentes con identidad (`<nombre>` o `<subconjunto>.<nombre>`) definidos en un run-file Markdown, reanudación fiel (`launch`), agentes controladores (`controller: true`, `launch_agent`, `check_agents`) y supervisión humana de solo lectura (HITL) en la pestaña *Agentes*. |

Principios de despliegue del frontend y del servidor:
- **Origen web único:** usar la interfaz publicada en GitHub Pages mantiene un único origen para `localStorage`, cookies y Service Worker, evitando fragmentar datos al cambiar de puerto local.
- **Servidor personal del usuario del SO:** no es un servicio cloud multiusuario; corre con la cuenta local (o accesible vía túnel/proxy inverso). Un único canal `POST /` (JSON-RPC 2.0) elimina SSE/WebSockets y condiciones de carrera tras proxies.
- **Autenticación diaria y sincronización bidireccional:** toda petición exige token diario (entregado en `#token=` en local, o vía `zerochat/login` contra PAM/`LogonUserW` en remoto, sin almacenar contraseñas). Al conectar se sincronizan perfiles y conversaciones prevaleciendo la copia más reciente y descargando mensajes bajo demanda.

### 2.2. Modelo de dominio: `Sesión = Proyecto` frente a `Perfil = Modelo`

Una de las simplificaciones clave del sistema es la separación estricta entre **con qué modelo se habla** y **en qué entorno de trabajo se opera**:

- **Los Perfiles definen únicamente la conexión al modelo:** guardan proveedor, endpoint, modelo, temperatura, nivel de razonamiento y API key. No contienen listas de herramientas, ni servicios MCP, ni configuración de navegador.
- **El Proyecto es el contenedor central de definiciones, seguridad e historial:**
  - Un proyecto se identifica por la ruta de su carpeta de trabajo en el servidor (o el espacio por defecto `general` bajo `~/zerochat/general` para conversaciones sin proyecto o creadas sin conexión). El servidor nunca cambia su directorio de proceso (`chdir`); cada petición declara su proyecto activo.
  - **Entorno de ejecución por proyecto:** cada proyecto persiste sus propias instrucciones de sistema, qué herramientas nativas tiene activas, qué servicios MCP externos requiere, qué modo de navegador utiliza y sus colecciones RAG activas. Cambiar de proyecto adapta automáticamente el entorno, deteniendo los servicios MCP que sobran y arrancando los que el proyecto necesita.
  - **Seguridad y permisos por proyecto:** el backend es la única autoridad de permisos. Cada proyecto define si permite todo (`allowAll`) o si se rige por sus **reglas de directorio `RWX`** (lectura, escritura y ejecución de comandos, por defecto acotadas a la carpeta del proyecto) más los patrones de comandos aprobados (globales, de proyecto o de sesión). Lo que no está cubierto pide confirmación interactiva mediante un reto de un solo uso.
  - **Continuidad multidispositivo (`Sesión = Proyecto`):** no existe identidad de cliente (`clientId`). El estado vivo en memoria de un proyecto (permisos de sesión, retos pendientes, comandos en marcha) pertenece al proyecto. Un usuario puede empezar un trabajo en el PC y continuarlo o aprobar un reto desde una tablet viendo exactamente el mismo estado.

### 2.3. Herramientas, servicios MCP y ejecución en segundo plano sin sondeo

El ecosistema de herramientas se divide en tres niveles bajo el mismo motor de autorización, priorizando la estabilidad del servidor y la ejecución asíncrona limpia:

- **Tres familias de herramientas:**
  1. *Nativas del cliente (JS):* búsqueda y lectura web (enrutadas por el backend con validación anti-SSRF cuando está conectado), consulta RAG, sandbox de JavaScript (aislado en navegador o en proceso hijo Node sin permisos de disco ni generación dinámica de código), gráficos, preguntas al usuario (`ask_user`), espera en interfaz (`wait`), cambio de modelo (`switch_model`) y delegación (`delegate_task`).
  2. *Locales del host (Python):* operaciones sobre ficheros, búsqueda de texto fijo (nunca expresiones regulares enviadas por el modelo, para no bloquear el GIL de Python), diagnóstico, consola (`run_command`, `check_command`) y acción rápida de navegador (`browser_action`). Las herramientas de navegador automatizado se reservan en exclusiva por conversación activa durante su uso para que dos chats no pisen la misma página.
  3. *Servicios MCP gestionados:* procesos externos por `stdio` cuyo catálogo se actualiza desde la carpeta de la interfaz hacia `~/zerochat/services/`, con dependencias aisladas, control de frecuencia de llamadas salientes, secretos inyectados solo por entorno y capacidad de declarar qué herramienta nativa reemplazan mientras están activos (p. ej. un buscador MCP sustituyendo a la búsqueda web nativa).
- **Comandos resilientes y trabajo en segundo plano:**
  - Si un comando lanzado en primer plano supera su tiempo de espera inicial, **no se mata**: pasa automáticamente a segundo plano devolviendo su identificador de trabajo (`job_id`). Así no se pierde trabajo costoso ni el modelo vuelve a lanzar tareas duplicadas. Además, el servidor impide lanzar un comando idéntico a otro que ya sigue en marcha en el mismo proyecto.
- **Ejecución desatendida y CLI (`--prompt`, `--conversation`, ejecución en servidor):**
  - Las conversaciones pueden ejecutarse en segundo plano en el servidor o invocarse desde la línea de comandos mediante el runner de Node.js, con una credencial restringida exclusivamente a esa conversación y sin límites artificiales de tiempo.
  - El runner persiste la conversación en SQLite al cerrar cada paso de herramientas, y la interfaz hace lo mismo con los turnos que ejecuta en la pestaña: cualquier interrupción conserva todo el avance y la interfaz web muestra siempre el estado grabado en SQLite. Ambos bucles reciben del proyecto lo mismo (`ChatProjectContext.turnContext`: la carpeta de las rutas relativas y, con `projectMode`, sus normas y estado).
  - Si una ejecución sobre una conversación existente necesita intervención humana (`ask_user` o un reto de permisos), el proceso se detiene limpiamente en estado `needs_input` hasta que el usuario responde o autoriza la acción.
- **Arquitectura reactiva (cero bucles de sondeo):**
  - La sincronización entre navegador, servidor y procesos hijos evita los bucles `sleep` de consulta periódica: el estado vivo global, el seguimiento de logs de comandos y el arranque de servicios MCP utilizan *long-polling* despertado por cambios de estado, y la finalización de procesos externos se detecta mediante primitivas del sistema operativo (`pidfd`, `kqueue` o handles de proceso).

### 2.4. Planificación y orquestación de varios agentes

ZeroChat separa con una frontera estricta la delegación interna dentro de un turno y la planificación u orquestación de múltiples agentes:

1. **Subagente interno de solo lectura (`delegate_task`):**
   - Cuando un agente necesita explorar código, documentación o la web sin saturar su propia ventana de contexto, delega en una instancia secundaria del motor agéntico limitada estrictamente a herramientas de lectura (pudiendo usar un perfil específico de «Subagente»). Al agente principal solo regresa el informe final. No se permiten subagentes con escritura ni anidamiento recursivo. Solo existe en sesiones interactivas y se enciende con «Subagentes» en el panel de razonamiento (apagado por defecto); una ejecución en el servidor nunca lo tiene, porque si coordina agentes es un controlador con `launch_agent` y `check_agents`.
2. **Orquestación de flota: lanzamiento desde fuera o desde un agente controlador, y ZeroChat como ejecutor desatendido y consola HITL:**
   - **Cada agente es una ejecución `--run-file` independiente.** Un orquestador externo (`cron`, script o pipeline) o un agente controlador lanza cada agente con su run-file Markdown: una cabecera fija que define `agent` (`<nombre>` o `<subconjunto>.<nombre>`), `conversation_id` opcional (conversación fija o nueva por ejecución), `profile`, `controller`, `projectMode` (`false` por defecto para no mezclar normas de desarrollo con su manual operativo), `reasoning` y límites (`maxSteps`, `timeout`), y las secciones `<!-- system -->` (su manual) y `<!-- prompt -->` (la tarea). Herramientas, servicios MCP y permisos salen siempre del entorno guardado del proyecto y nunca pueden ampliarse desde el run-file. Los agentes comparten la carpeta del proyecto gobernados por sus reglas `R:`/`RW:` (salidas efímeras en `.gitignore`), sin `git worktree` propios.
   - **Coordinación sin motor de planificación en ZeroChat:** no hay grafos ni colas propias; el plan reside en el manual del controlador. Solo una ejecución `--run-file` con `controller: true` recibe `launch_agent` (arranca un agente como proceso independiente que sobrevive al controlador y devuelve `conversation_id` y `run_id`) y `check_agents` (estado, consumo de tokens, respuesta final completa o paginada, último turno bajo demanda, espera acotada sin sondeo y limpieza `prune_keep` bajo petición). Ambas actúan en el proyecto actual o en otro autorizado por `R:` (`RW:` para borrar) en las reglas del controlador, y nunca exponen chats humanos.
   - **Comunicación por respuesta final o ficheros `.md`:** para resultados de tamaño moderado basta la respuesta final del agente (leída por el controlador mediante `check_agents`, sin crear ficheros temporales ni pedir permiso de escritura); los artefactos extensos o persistentes se intercambian por ficheros `.md` sujetos a las reglas `R:`/`RW:`. No existe una herramienta genérica para leer conversaciones arbitrarias de SQLite.
   - **Interfaz web como bandeja de supervisión humana (HITL) y reanudación fiel:** las conversaciones de agentes viven en un historial separado (**Chats / Agentes**, con marca en el inactivo si alguno espera respuesta), listadas por fecha con el nombre de su agente e icono de estado. Se abren en **modo supervisión (solo lectura)** sin alterar el proyecto ni el perfil de la pestaña; al responder un `needs_input` (`ask_user` o reto de herramienta) o continuar con `--conversation`, ZeroChat reanuda el agente fielmente con el `launch` guardado por `--run-file`.

---

## 3. Mapa de bajada a las decisiones tácticas y contratos

Este documento fija **el qué y el porqué**. Para consultar o modificar **el cómo** (contratos de módulos, firmas RPC, topes exactos, invariantes de código y pruebas), acude directamente al documento táctico de cada área:

| Nivel y ámbito | Documento táctico | Qué decisiones y contratos detalla |
|---|---|---|
| **Flujo de trabajo, normas y auditoría** | [`AGENTS.md`](../AGENTS.md) y [`docs/audit.md`](./audit.md) | Memoria del proyecto (`.zerochat/state.md`, `plan.md`, `log.md`, `task.py`), reglas de calidad de código, higiene, seguridad transversal, procedimiento de auditoría (`docs/audit.md`), flujo Git y política de versiones (`bump`). |
| **Motor agéntico y herramientas nativas** | [`js/tools/README.md`](../js/tools/README.md) | Contrato de `AgentRuntime`, protección contra bucles, replay de razonamiento, evidencia visual, especificación de herramientas nativas, subagente `delegate_task`, ciclo de vida de tarjetas de comandos/esperas, `switch_model`, aislamiento de `execute_javascript` y codificación canónica de nombres MCP. |
| **Arquitectura de cliente web y UI** | [`js/README.md`](../js/README.md) | Patrón UMD e inyección de dependencias, ciclo del DOM y renderizado, slices de `ChatState`, frontera de persistencia (`ChatStorage` / `ZeroChatDB`), tokens de diseño CSS e i18n, adaptadores de proveedores LLM (`ChatProviders`), carga de librerías (`js/vendor/`), transporte web/proxies, caché en cliente de permisos (`ChatToolSecurity`) y aplicación del entorno de proyecto. |
| **Servidor local, seguridad, MCP y CLI** | [`py/README.md`](../py/README.md) | Estructura de paquetes en `py/` y compilación de `zerochat.py`, estructura de `~/zerochat/`, modelo `Sesión = Proyecto` y `BrowserLease`, autenticación y tokens, motor de permisos `AccessController` (jerarquía, retos, reglas `RWX` y `commandPatterns`), esquema SQLite y sincronización, catálogo y secretos de servicios MCP, protocolo del runner desatendido (`--prompt` / `--conversation`) y publicación en PyPI. |
| **Estrategia de pruebas y validación** | [`tests/README.md`](../tests/README.md) | Pirámide de pruebas (`unit`, `integration`, `browser`, `architecture`, `infrastructure` + `py`), comandos del test runner, grupos funcionales, aislamiento sin código exclusivo en producción, pruebas en el borde exacto (`N` y `N+1`) y matriz de qué merece una prueba frente a qué debe borrarse. |
| **Memoria viva de decisiones e hitos** | [`.zerochat/log.md`](../.zerochat/log.md) y [`.zerochat/plan.md`](../.zerochat/plan.md) | Registro cronológico de invariantes activos (`log.md`), hitos en curso (`plan.md`, p. ej. contratos de orquestación en M84) e histórico archivado en `.zerochat/archive/`. |
