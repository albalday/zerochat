# Norma y procedimiento de auditoría

Esta norma define cómo se audita ZeroChat para preservar su coherencia arquitectónica, su seguridad, la higiene del código y la calidad de su suite de pruebas. Complementa a [`AGENTS.md`](../AGENTS.md) y [`docs/architecture.md`](./architecture.md).

---

## 1. Alcance y modos de auditoría

Una auditoría puede solicitarse en dos alcances:

1. **Auditoría completa:** revisa todo el sistema (`js/`, `css/`, `zerochat.html`, `files.html`, `py/`, `services/`, `scripts/` y `tests/`) frente a [`docs/architecture.md`](./architecture.md), [`AGENTS.md`](../AGENTS.md) y los READMEs tácticos (`js/README.md`, `js/tools/README.md`, `py/README.md`, `tests/README.md`). Debe ejecutarse antes de cualquier incremento de versión mayor (`X.0.0`) o cuando el usuario pida:
   > Ejecuta la auditoría definida en `docs/audit.md`.
2. **Auditoría acotada (por hito, subsistema o rango de commits):** revisa un `git diff` o un subsistema concreto con los mismos criterios y el umbral de importancia de la sección 4.

> **Regla de oro:** una auditoría **no modifica código de producción ni añade tareas directamente a `.zerochat/plan.md` ni edita páginas de `help/`**. Su único entregable es un documento Markdown de diagnóstico y propuesta en `docs/` (p. ej. `docs/audit-<ámbito>.md`) para que el usuario lo lea y decida qué tareas abrir y cómo reflejarlas después en la ayuda.

---

## 2. Línea base obligatoria

Antes de inspeccionar el código, comprobar el estado del árbol de trabajo y las validaciones automáticas sin sobrescribir artefactos:

```bash
git status --short
npm run lint
npm test
```

1. **Sin regenerar a ciegas:** no ejecutar `npm run build` antes de `git status` y `npm run test:architecture`, para que cualquier desfase previo entre `py/` y `zerochat.py`, `services/` y `services/manifest.json`, `scripts/sandbox-child.js` o `js/vendor/` aflore como hallazgo.
2. **Lo que ya cubren las pruebas estáticas no se re-audita a mano:** `tests/architecture/` ya verifica automáticamente sinks de `innerHTML`, claves de `ChatI18n`, iconos del sprite y `ChatIcons`, variables y selectores CSS huérfanos, funciones/variables no usadas, frontera de persistencia (`localStorage`/`IndexedDB`), ausencia de `chdir` en backend y paridad de herramientas. La auditoría da por cubiertos esos contratos si el test pasa (salvo que detecte un hueco en el propio test) y concentra el esfuerzo en lo que el análisis estático no ve.
3. **Respeto a decisiones cerradas:** antes de señalar un diseño como hallazgo, contrastarlo con [`docs/architecture.md`](./architecture.md) y [`.zerochat/log.md`](../.zerochat/log.md) para no proponer alternativas ya descartadas.

---

## 3. Áreas de revisión

### 3.1. Código muerto, especulativo o de compatibilidad previa (`AGENTS.md` §2)
Confirmar con referencias estáticas y dinámicas:
- Módulos, funciones, exports en `return { ... }`, métodos RPC en `server/rpc.py`, ramas, opciones o parámetros sin ningún consumidor actual.
- Código de compatibilidad hacia atrás no solicitado (alias, migraciones perpetuas, formatos o campos antiguos).
- Código en producción que solo usan las pruebas (parámetros opcionales, inyecciones, guardas para objetos simulados o para Node en código de navegador).
- Listeners, temporizadores, procesos hijos, descriptores (`pidfd`/handles) o subidas temporales en memoria que no se limpien al cancelar o cerrar.

### 3.2. Fuente única de verdad y duplicación (`AGENTS.md` §2 y §6)
- **Decisiones duplicadas (hallazgo siempre):** tablas de tipos o formatos, listas de herramientas o comandos globales, predicados de dominio, constantes, topes y convenciones de nombres repetidos en 2 o más sitios (entre módulos de `js/`, entre `py/` y `js/`, o reimplementados dentro de un test en lugar de importar la fuente real).
- **Asimetría entre variantes hermanas:** adaptadores de proveedores, manejadores de herramientas con ruta (`READ_PATH_TOOLS`, `WRITE_PATH_TOOLS`, `DIRECTORY_PATH_TOOLS`), modos navegador/Node del runner o shells POSIX/PowerShell que no apliquen las mismas validaciones y límites.
- **Comportamiento repetido:** proponer extracción solo cuando existan 3 o más consumidores con el mismo contrato estable (o 2 que ya hayan divergido causando un fallo); no acoplar módulos independientes por unas pocas líneas de coincidencia accidental.

### 3.3. Fronteras de arquitectura, aislamiento y seguridad (`docs/architecture.md` §2, `AGENTS.md` §3)
- **Modelo `Sesión = Proyecto` y rutas:** verificar que ningún estado en memoria (`ProjectSession`, `JOBS`), entorno (`project_environments`), política o `commandPatterns` se filtre entre proyectos, y que toda ruta pase por `SecurityContext.absolute` resolviendo enlaces simbólicos antes de evaluar reglas `RWX`.
- **Motor de permisos (`AccessController`) y credenciales (`TokenGrant`):**
  - Ninguna herramienta se ejecuta fuera del punto único (`server/tool_calls.py`) ni reutiliza un `challengeId`.
  - La credencial `runner` está acotada a su `run_id` y `conversation_id`, sin acceso a métodos de la persona (`project/browse`, `project/create_directory`, `files/*`, `security/authorize`, listado de perfiles/conversaciones ajenas).
  - Análisis de `run_command` acorde a la shell real (`sh` o PowerShell), detección de órdenes globales y validación de comodines en `commandPatterns`.
- **Soberanía de secretos:** ninguna ruta RPC, error, telemetría o exportación devuelve API keys ni secretos de MCP en claro (`hasApiKey` / `configured`; excepción única `zerochat/profiles/reveal` y entrega en memoria al runner). Los secretos de MCP solo se expanden en `launch.env`, nunca en argumentos de proceso.
- **Inserción segura en DOM y red:** todo dato de modelos, herramientas, MCP, documentos o red se inserta como texto (`textContent`, `setText`, `escapeHtml`), nunca en `innerHTML` fuera de la lista cerrada de `test_html_sinks.js`. En red (`webFetch` y `zerochat/web/fetch`), validación anti-SSRF en cada salto y control de frecuencia (`RATE_LIMITER`).

### 3.4. Arquitectura reactiva, límites y estabilidad (`AGENTS.md` §4)
- **Cero sondeo (no-polling) y no bloqueo del servidor:** comprobar que no se han introducido bucles `sleep` + consulta ni pausas fijas en lugar de esperas por evento/condición (`long-poll` con `wait_ms`, `pidfd`/`kqueue`/handles, `Event`/`Condition`), y que ninguna entrada del modelo se compila como expresión regular en Python (bloqueo del GIL).
- **Topes y bordes exactos (`N` y `N+1`):** todo límite que protege memoria, contexto, disco o seguridad debe truncar o rechazar con aviso explícito y contar con prueba en el borde exacto (`N` y `N+1`).

### 3.5. Higiene de la suite de pruebas (`tests/README.md`)
La propia suite de pruebas se audita con el mismo rigor que producción:
- **Normas sin prueba:** contrastar cada regla de `AGENTS.md` y cada contrato crítico de los READMEs con la prueba que falla si se infringe; señalar las normas huérfanas y proponer la prueba en el nivel más bajo que la observe.
- **Pruebas que sobran (columna «No escribir» de `tests/README.md`):** señalar para su eliminación o fusión las pruebas triviales (**T**), cosméticas (**C**), de ausencia de código ya retirado (**Z**), que solo prueban el mock (**M**), cubiertas por el humo de arranque (**A**) o duplicadas en varios niveles (**2**, p. ej. lógica sin DOM probada en Playwright).
- **Sincronización sin pausas fijas:** localizar `setTimeout` o `time.sleep` en tests que esperen estado de otro hilo/proceso en lugar de sincronizarse con lo observado.

---

## 4. Umbral de importancia y priorización

Para evitar ruido y refactorizaciones innecesarias, un hallazgo solo se numera (`F-01`, `F-02`…) si cumple **al menos una** de estas condiciones:

1. Es un **fallo funcional reproducible**, una condición de carrera o una pérdida silenciosa de datos.
2. Supone un **riesgo de seguridad, fuga entre proyectos/credenciales o bloqueo** (GIL, procesos zombi, descriptores o memoria sin tope).
3. Incumple una **norma explícita** de `AGENTS.md`, `docs/architecture.md` o los READMEs tácticos (decisión duplicada, código muerto/especulativo, norma o tope sin prueba en `N`/`N+1`, prueba prohibida en `tests/README.md`).
4. Ahorra **más de ~10 líneas netas** o elimina llamadas RPC/procesos redundantes sin acoplar módulos independientes.

Lo que quede por debajo de este umbral (micro-optimizaciones, extracciones con menos de 3 consumidores estables, preferencias subjetivas de estilo) se descarta o se agrupa al final en breves «Observaciones menores» sin proponer tarea. En una auditoría acotada, el informe debe concentrarse como máximo en los ~10 hallazgos de mayor impacto.

---

## 5. Formato del entregable en `docs/`

El resultado de la auditoría se escribe en un fichero Markdown dentro de `docs/` (por ejemplo `docs/audit-<hito-o-versión>.md`), estructurado así:

1. **Resumen y línea base:** alcance revisado (versión/commits/subsistema), resultado de `npm run lint` y `npm test`, estado de artefactos generados (`zerochat.py`, `services/manifest.json`, `py/tools/sandbox_script.py`, `js/sandbox-node-script.js`, `js/vendor/`, `sitemap.xml`) y valoración general concisa.
2. **Tabla resumen de hallazgos:** `ID`, `Prioridad` (`Crítica`, `Alta`, `Media`, `Baja`), `Área` (`Seguridad`, `Arquitectura`, `Estabilidad`, `Código muerto/Duplicación`, `Pruebas`), `Archivos` y título corto.
3. **Detalle de cada hallazgo (`F-XX`):**
   - **Evidencia:** archivos, líneas y explicación precisa del problema (o caso de reproducción).
   - **Norma o contrato afectado:** referencia a `AGENTS.md`, `docs/architecture.md` o `<subsistema>/README.md` (o qué norma/prueba de arquitectura falta para que no se repita).
   - **Propuesta de solución y prueba:** cambio acotado y qué test (`unit`, `integration`, `infrastructure`, `browser` o `architecture`) lo verificará.
4. **Propuesta de tareas para discusión:** lista de tareas candidatas (~300 líneas de código máx. cada una, separando limpieza, refactor y corrección de fallos) listas para que el usuario decida cuáles aprobar y pasar a `.zerochat/plan.md` con `python3 .zerochat/task.py` y qué cambios trasladar posteriormente a `help/`.
