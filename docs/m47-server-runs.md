# Especificación técnica M47: Ejecución de turnos en servidor y continuación de conversaciones (`--conversation`)

Este documento detalla la arquitectura, contratos JSON-RPC, formato en disco y desglose por tareas del hito **M47**, de modo que cualquier agente pueda implementar cada tarea de forma autónoma respetando las normas de [`AGENTS.md`](../AGENTS.md), [`js/README.md`](../js/README.md) y [`py/README.md`](../py/README.md).

---

## 1. Visión general y decisiones de arquitectura (`M47-D1`..`M47-D5`)

1. **Sin cliente CLI interactivo (`M47-D1`):** Se descarta construir un REPL en terminal (`--cli`) para evitar degradar capacidades visuales y multimodales. La interfaz web sigue siendo el cliente único y completo; el servidor gana la capacidad de ejecutar turnos agénticos en segundo plano aunque el navegador se desconecte o se cierre.
2. **Un proceso `zerochat.py --conversation <id>` por turno de servidor (`M47-D2`):**
   - Cada turno lanzado como «Ejecutar en servidor» arranca un subproceso independiente `zerochat.py --conversation <id> --profile <nombre> [--prompt <texto>]` que levanta su propio servidor efímero en un puerto libre y su instancia headless de Chromium de Playwright.
   - `RUN_SESSION` en `py/ii-run-mode.py` mantiene su diseño actual de sesión única por proceso.
   - Múltiples conversaciones pueden ejecutarse en el servidor en paralelo (máximo 1 ejecución activa por `conversation_id`).
   - El estado en vivo de cada ejecución se vuelca en `~/zerochat/runs/<conversation_id>.json` (directorio `0700`, fichero `0600`).
3. **Slider «Ejecutar en servidor» restringido a perfiles generales `Z-*` (`M47-D3`):**
   - El switch superior solo se muestra cuando el cliente está conectado al servidor (`mcp.status === 'connected'`) y el perfil activo es un perfil general (`activeProfile?.general === true`, mostrado con prefijo `Z-`).
   - No se modifica el contenido de los perfiles ni su mantenedor (`js/ui-profiles.js`).
4. **Heartbeat adaptativo (1 s / 10 s) y lectura con foco (`M47-D4`):**
   - `zerochat/heartbeat` recibe opcionalmente `{ focus_conversation_id: "<session_id>" }`.
   - `live_state(focus_conversation_id)` devuelve siempre:
     - `runs`: lista ligera de todas las entradas en `~/zerochat/runs/*.json` (`[{ conversation_id, run_id, status: "running" | "needs_input" | "error" }]`).
     - `focus_run`: objeto detallado (con `step_text`, `assistant_text`, `reasoning_text`, `pending`, `error`) **solo** si `focus_conversation_id` coincide con una tarea registrada en `~/zerochat/runs/`.
   - Mientras exista al menos una tarea con `status === "running"`, el cliente acelera el temporizador de `zerochat/heartbeat` a **1000 ms** (incluso si `exit_on_close` es `false`). Al no quedar tareas `"running"`, vuelve a `10000 ms` (o se detiene si `exit_on_close` es `false`).
   - En el servidor principal, `heartbeat_watchdog` no cierra el servidor por desconexión del navegador mientras exista algún proceso en `~/zerochat/runs/` con `status == "running"`.
5. **Pausa limpia en `ask_user` y permisos de herramientas (`M47-D5`):**
   - A diferencia de `--prompt` clásico sin `--conversation` (donde `answerToolApprovals` autoaprueba lecturas con `allow_session` y deniega `DANGEROUS_TOOLS`), cuando se ejecuta con `--conversation <id>` (sin `--allow-dangerous-tools`):
     - Cualquier llamada a `ask_user` o cualquier herramienta que requiera autorización del usuario (`requiresApproval: true` no cubierta por reglas previas) **termina limpiamente el turno**.
     - En el caso de permiso de herramienta, `ToolExecutor` genera un mensaje `tool` válido en el historial con `{ success: false, endTurn: true, awaitingApproval: true, toolName, args, error: "Execution paused waiting for user authorization." }` para que el par `assistant(tool_calls)` + `tool` quede íntegro en SQLite (evitando que `sanitizeTurnBoundaries` o los proveedores LLM rechacen el historial).
     - El worker guarda la conversación en SQLite y finaliza dejando `status: "needs_input"` en `~/zerochat/runs/<conversation_id>.json`.
     - El historial lateral marca esa conversación con un icono de interrogación (`?`).
     - Si el usuario está en esa conversación (o entra más tarde, incluso tras haber cerrado y reabierto el navegador), ve la pregunta de `ask_user` o los botones de autorización en la tarjeta de la herramienta. Al responder o autorizar, se lanza un nuevo `zerochat --conversation <id>` para continuar.

---

## 2. Contratos de datos y ficheros

### 2.1. Fichero de estado `~/zerochat/runs/<conversation_id>.json`
Nombre de fichero derivado de `urllib.parse.quote(conversation_id, safe="") + ".json"` dentro de `get_data_dir() / "runs"` (`0700`), escrito atómicamente (vía fichero `.tmp` y `os.replace`) con permisos `0600`:

```json
{
  "run_id": "k8f9...",
  "conversation_id": "session_173098...",
  "pid": 48291,
  "started_at": 1730985000000,
  "updated_at": 1730985004000,
  "status": "running",
  "step_text": "run_command",
  "assistant_text": "Voy a revisar los tests...",
  "reasoning_text": "Analizando la estructura...",
  "pending": null,
  "error": null
}
```
* **Topes exactos (para probar en `N` y `N+1` según `AGENTS.md` §4.4):**
  * `RUN_PROGRESS_TEXT_MAX = 500` para `step_text`.
  * `RUN_STREAM_TEXT_MAX = 8000` caracteres para `assistant_text` y `reasoning_text` en el fichero de situación (si supera `8000`, se conserva con aviso/elipsis `…` o los últimos/primeros `8000` caracteres).
* **Transiciones de `status`:**
  * `"running"`: mientras el subproceso vive. Si `list_server_runs` detecta que `pid` ya no existe (`OSError` en `os.kill(pid, 0)`) y `status == "running"`, actualiza el fichero a `status: "error"`, `error: "El proceso de ejecución terminó inesperadamente."`.
  * Completado normal: al recibir `zerochat/run/result` con `text` (sin `needs_input`), **se elimina** `~/zerochat/runs/<conversation_id>.json`.
  * `"needs_input"`: al recibir `zerochat/run/result` con `needs_input: { kind: "ask_user" | "tool_approval", tool_name?: string, question?: string }`. El fichero permanece en disco hasta que la conversación reciba un nuevo turno o se borre.
  * `"error"`: al recibir `zerochat/run/result` con `error` o agotarse el plazo en `run_supervisor`.

### 2.2. Métodos JSON-RPC

1. **`zerochat/run/prompt` (entre el worker headless y su servidor efímero):**
   * Respuesta ampliada:
     ```json
     {
       "prompt": "texto opcional o null",
       "conversation_id": "session_...",
       "profile": "Z-local",
       "export": null,
       "keep_page": false,
       "allow_dangerous_tools": false,
       "tool_security": { "tools": {}, "servers": {}, "directoryRules": ["R:/ruta"] }
     }
     ```
2. **`zerochat/run/progress` (del worker headless a su servidor efímero):**
   * Parámetros admitidos además de `kind` y `text`: `assistant_text` (opcional, str) y `reasoning_text` (opcional, str). Si la sesión tiene `conversation_id`, actualiza `~/zerochat/runs/<conversation_id>.json`.
3. **`zerochat/run/result` (del worker headless a su servidor efímero):**
   * Admite `{ run_id, text }` (éxito final), `{ run_id, needs_input: { kind, text } }` (pausa por `ask_user` o permiso) o `{ run_id, error }` (fallo).
4. **`zerochat/run/start` (del cliente web al servidor principal):**
   * Entrada: `{ conversation_id: str, profile: str, prompt?: str, tool_security?: dict }`
   * Validaciones:
     * `conversation_id` válido y existente en SQLite (`get_conversation(conversation_id)` no es `None`).
     * No existe ya una ejecución con `status == "running"` para ese `conversation_id` (si existe, error `-32602`).
     * `profile` corresponde a un perfil general existente en SQLite (`get_general_profile_by_name` o `get_general_profile`).
   * Acción: Lanza subproceso `sys.executable zerochat.py --conversation <id> --profile <profile_name> [--prompt <prompt>]` (pasando `tool_security` serializado o por fichero/argumento interno), escribe el estado inicial `"running"` en `~/zerochat/runs/<conversation_id>.json` (con el `run_id` preasignado) para que esté disponible de inmediato sin condición de carrera, y devuelve:
     `{ "run_id": "...", "conversation_id": "...", "status": "running" }`.
5. **`zerochat/run/cancel` (del cliente web al servidor principal):**
   * Entrada: `{ conversation_id: str }`
   * Acción: Si hay tarea en `~/zerochat/runs/<conversation_id>.json`, termina su `pid` (y árbol de procesos si aplica), elimina el fichero de `runs/` y devuelve `{ "cancelled": true }`.
6. **`zerochat/heartbeat` (del cliente web al servidor principal):**
   * Entrada: `{ focus_conversation_id?: str }`
   * Salida en `live_state`: añade:
     * `"runs": [{ "conversation_id": "...", "run_id": "...", "status": "running" | "needs_input" | "error" }]`
     * `"focus_run": { ... } | null`

---

## 3. Desglose de tareas, nivel de agente y esfuerzo de razonamiento recomendados

| Tarea | Descripción corta | Agente recomendado | Nivel de Razonamiento |
|---|---|---|---|
| **M47-T1** | CLI `--conversation <id>` y fichero de estado `~/zerochat/runs/<conversation_id>.json` en Python | **Gemini 3.8 Flash** | **Medium** |
| **M47-T2** | Continuación en `js/run-mode.js`, progreso de texto/razonamiento y pausa limpia en `ask_user` y permisos en `js/agent-core.js` | **Argon** | **High** |
| **M47-T3** | Supervisor backend (`zerochat/run/start`, `zerochat/run/cancel`) y `live_state` con `focus_conversation_id` | **Gemini 3.8 Flash** | **High** |
| **M47-T4** | Slider superior (`Z-*`), heartbeat adaptativo 1s/10s, bloqueo de envío por conversación e iconos en historial lateral | **Argon** | **Medium** |
| **M47-T5** | Burbuja en vivo de la tarea con foco y reanudación interactiva de permisos/preguntas en el chat + E2E browser | **Argon** | **High** |
| **M47-T6** | Documentación técnica (`py/README.md`) y ayuda bilingüe (`help/run-mode.html`, `help/en/run-mode.html`) | **Gemini 3.8 Flash** | **Low** |

---

## 4. Guía detallada paso a paso por tarea

### Tarea `M47-T1`: CLI `--conversation <id>` y fichero de estado en `py/zz-main.py` y `py/ii-run-mode.py`
* **Agente:** Gemini 3.8 Flash · **Razonamiento:** Medium
* **Archivos a tocar:** `py/ii-run-mode.py`, `py/zz-main.py`, `zerochat.py` (`npm run build:backend`), `tests/infrastructure/test_run_mode.js`.
* **Cambios requeridos:**
  1. En `py/zz-main.py`:
     - Añadir argumento `--conversation` a `build_parser()`.
     - En `run_session_from_args`: permitir iniciar `RunSession` cuando se indique `--prompt` **o** `--conversation <id>` (o ambos).
     - Si se indica `--conversation <id>`, validar el identificador con `_validate_conversation_id` y comprobar que `get_conversation(id)` existe en SQLite (si no existe, `parser.error(...)` con salida `RUN_EXIT_ARGS`). Si no se pasa `--prompt`, verificar que la conversación en SQLite tiene al menos un mensaje `user` o una herramienta pendiente.
  2. En `py/ii-run-mode.py`:
     - Crear funciones de directorio y fichero de estado: `get_runs_dir() -> Path` (`~/zerochat/runs`, permisos `0700`) y `write_run_state(session, ...)`, `remove_run_state(conversation_id)`.
     - Ampliar `RunSession` con `conversation_id: str | None = None`, `run_id: str | None = None` (permitiendo recibirlo por variable de entorno `ZEROCHAT_RUN_ID` cuando lo lanza el servidor principal) y `tool_security: dict | None = None` (de `ZEROCHAT_RUN_SECURITY`).
     - En `dispatch_run`:
       - `zerochat/run/prompt`: incluir `"conversation_id": session.conversation_id` y `"tool_security": session.tool_security`.
       - `zerochat/run/progress`: aceptar `assistant_text` y `reasoning_text` opcionales (truncados a `RUN_STREAM_TEXT_MAX = 8000` con `"…"`) y actualizar el fichero `~/zerochat/runs/<conversation_id>.json`.
       - `zerochat/run/result`: aceptar `needs_input` (`{"kind": "ask_user" | "tool_approval", "text": "..."}`) además de `text` o `error`.
         - Si termina con `text`: eliminar `~/zerochat/runs/<conversation_id>.json`.
         - Si termina con `needs_input`: guardar `status: "needs_input"` y `pending: needs_input` en `~/zerochat/runs/<conversation_id>.json`.
         - Si termina con `error` o por timeout/cierre en `run_supervisor`: guardar `status: "error"` y `error` en `~/zerochat/runs/<conversation_id>.json`.
* **Validación:** `npm run build:backend && npm run test:infrastructure && npm run test:architecture`.

---

### Tarea `M47-T2`: Continuación en `js/run-mode.js`, progreso en vivo y pausa limpia en `ask_user` / permisos
* **Agente:** Argon · **Razonamiento:** High
* **Archivos a tocar:** `js/run-mode.js`, `js/agent-core.js`, `js/tool-cards.js`, `js/generation-controller.js`, `js/app.js`, `tests/unit/test_run_mode.js`, `tests/unit/test_agent_core.js`.
* **Cambios requeridos:**
  1. En `js/agent-core.js` y `js/tool-cards.js`:
     - Permitir que `requestToolAuthorization` (o `authorizationResponder`) devuelva `'pause_for_user'`.
     - En `ToolExecutor._authorizeToolCall`: si la decisión es `'pause_for_user'`, devolver `{ allowed: false, awaitingApproval: true, error: 'Execution paused waiting for user authorization.' }`.
     - En `ToolExecutor.executeToolCall`: si `authorization.awaitingApproval` es `true`, devolver `{ success: false, awaitingApproval: true, endTurn: true, toolName: tool.name, args, error: authorization.error, result: { endTurn: true, awaitingApproval: true } }`.
     - En `AgentRuntime.execute` (línea ~763): detener el bucle (`yieldedToUser = true; status = 'completed'; break;`) cuando `batch.results.some(r => r.endTurn === true || (r.success && r.result?.endTurn === true))`. Así el `assistantMsg` con `tool_calls` y su `toolMsg` con `awaitingApproval: true` quedan guardados juntos en `workingMessages`.
  2. En `js/run-mode.js`:
     - En `answerToolApprovals(allowDangerous, report, { pauseOnApproval = false })`:
       - En modo clásico (`pauseOnApproval === false`, es decir `--prompt` sin `--conversation`): mantiene el comportamiento actual (`allow_session` para no peligrosas, `deny` para `DANGEROUS_TOOLS` salvo `allowDangerous`).
       - En modo conversación (`pauseOnApproval === true`, es decir con `conversation_id` y sin `allowDangerous`): cualquier herramienta que llegue a pedir autorización (`promptToolAuthorization`) devuelve `'pause_for_user'` y emite `report({ kind: 'user_request', text: toolName })`.
     - Si `zerochat/run/prompt` trae `tool_security`: hidratar las reglas recibidas en `ChatToolSecurity.manager` para la sesión antes de ejecutar.
     - Si `zerochat/run/prompt` trae `conversation_id`:
       - Cargar la conversación con ` switchToSession(conversation_id)` (o `ConversationService`).
       - Si `prompt` tiene texto, ejecutar `submitComposerText(prompt, { onProgress })`; si `prompt` es vacío/null, reanudar la generación sobre el historial existente (por ejemplo si el último mensaje ya es `user` o si acaba de autorizarse una herramienta cuyo último `tool` tenía `awaitingApproval: true`, eliminando el `assistant+tool` pausado o añadiendo continuación para que el modelo reintente la llamada ya autorizada).
       - Enviar en `onProgress` (`createProgressReporter`) los deltas de `assistant_text` y `reasoning_text` cada `STREAM_PROGRESS_INTERVAL_MS` (o `1000 ms`).
       - Asegurar que `saveCurrentSession()` se completa antes de enviar `zerochat/run/result`.
       - Si terminó por `ask_user` o por `awaitingApproval`, enviar `zerochat/run/result` con `{ needs_input: { kind: ..., text: ... } }`.
* **Validación:** `npm run test:unit && npm run test:integration && npm run test:architecture`.

---

### Tarea `M47-T3`: Supervisor backend (`zerochat/run/start`, `zerochat/run/cancel`) y `live_state` con foco
* **Agente:** Gemini 3.8 Flash · **Razonamiento:** High
* **Archivos a tocar:** `py/ii-run-mode.py`, `py/ff-server.py`, `py/ee-storage.py`, `zerochat.py`, `tests/infrastructure/test_server_runs.js`.
* **Cambios requeridos:**
  1. En `py/ii-run-mode.py`:
     - `list_server_runs(focus_conversation_id: str | None = None) -> tuple[list[dict], dict | None]`:
       - Lee `~/zerochat/runs/*.json`.
       - Para cada entrada con `status == "running"`, verifica si el `pid` existe (`_is_pid_running(pid)`). Si no existe, cambia el fichero a `status = "error"`, `error = "El proceso de ejecución terminó inesperadamente."`.
       - Construye la lista ligera `runs = [{"conversation_id": ..., "run_id": ..., "status": ...}]` ordenada por `started_at`.
       - Si `focus_conversation_id` coincide con una entrada, devuelve su diccionario completo como `focus_run`.
     - `start_server_run(params: dict) -> dict`:
       - Valida `conversation_id`, `profile` (debe existir en perfiles generales de SQLite), `prompt` opcional y `tool_security` opcional.
       - Comprueba que `conversation_id` existe en SQLite y que no tiene una ejecución `"running"`.
       - Genera `run_id`, escribe el fichero inicial `~/zerochat/runs/<conversation_id>.json` con `status: "running"`, y lanza el subproceso `zerochat.py --conversation <conversation_id> --profile <profile> [--prompt <prompt>]` con `ZEROCHAT_RUN_ID=<run_id>` y `ZEROCHAT_RUN_SECURITY=<json>`.
     - `cancel_server_run(conversation_id: str) -> dict`:
       - Detiene el `pid` si está en marcha, borra `~/zerochat/runs/<conversation_id>.json` y devuelve `{"cancelled": True}`.
  2. En `py/ff-server.py`:
     - `live_state(focus_conversation_id: str | None = None)` incluye `"runs"` y `"focus_run"`.
     - En `_dispatch_local`:
       - `zerochat/heartbeat` pasa `params.get("focus_conversation_id")` a `live_state(...)`.
       - Añadir despacho de `zerochat/run/start` y `zerochat/run/cancel` (permitidos en el servidor principal aunque `RUN_SESSION` sea `None`).
     - En `heartbeat_watchdog`: no cerrar el servidor por inactividad si `any(r["status"] == "running" for r in list_server_runs()[0])`.
     - En `delete_conversation` / `delete_all_conversations`: limpiar también el fichero correspondiente en `~/zerochat/runs/`.
* **Validación:** `npm run build:backend && npm run test:infrastructure && npm run test:architecture`.

---

### Tarea `M47-T4`: Slider «Ejecutar en servidor» (`Z-*`), heartbeat 1s/10s, bloqueo por conversación e iconos en el historial
* **Agente:** Argon · **Razonamiento:** Medium
* **Archivos a tocar:** `zerochat.html`, `css/components/header.css`, `css/components/sidebar.css`, `js/icons.js`, `js/i18n.js`, `js/state.js`, `js/mcp.js`, `js/ui-sidebar.js`, `js/conversation-service.js`, `js/app.js`, pruebas en `tests/unit/` y `tests/integration/`.
* **Cambios requeridos:**
  1. **UI Cabecera (`zerochat.html`, `css/components/header.css`, `js/app.js`):**
     - Añadir en `.header-right` (antes de `#btn-toggle-debug`) el contenedor `#server-run-control` con un switch `#chk-server-run` y su etiqueta traducida (`header_run_on_server`: `"Ejecutar en servidor"` / `"Run on server"`).
     - Mostrar `#server-run-control` (`hidden = false`) **únicamente** cuando `State.get('mcp').status === 'connected'` **y** `getRuntimeConfig().activeProfile?.general === true`. Si se desconecta o se cambia a un perfil local, se oculta (`hidden = true`) y su estado efectivo es `false`.
  2. **Estado y Heartbeat (`js/state.js`, `js/mcp.js`):**
     - En `LIVE_RESET` / slice `mcp` de `js/state.js`: añadir `serverRuns: []` y `focusRun: null`.
     - En `js/mcp.js`:
       - Definir `HEARTBEAT_FAST_INTERVAL_MS = 1000`.
       - `readLiveState()` envía `{ focus_conversation_id: getState().get('sessions').activeId }`.
       - `applyLiveState(payload)` actualiza `serverRuns` y `focusRun` en `State.get('mcp')`, y ajusta el timer del heartbeat: si `serverRuns.some(r => r.status === 'running')`, usa intervalo de `1000 ms` (siempre activo aunque `exit_on_close` sea `false`); si no, usa `10000 ms` (solo si `exit_on_close !== false`).
  3. **Envío en modo servidor y bloqueo por conversación (`js/conversation-service.js`, `js/app.js`):**
     - En `js/conversation-service.js`: cambiar de conversación (`switchToSession`) o crear una nueva (`createNewSession`) **no** se bloquea porque una conversación tenga una tarea corriendo en el servidor (solo se bloquea si hay generación local en el navegador `GenerationController.isGenerating()`).
     - En `js/app.js` (`handleSendMessage`): si `#chk-server-run` está visible y activo:
       1. Procesa adjuntos/texto del composer, añade el mensaje `user` al historial (`State.appendMessage` + `UIConversation.appendUserMessage`), limpia el composer y guarda la sesión en SQLite (`await saveCurrentSession()`). Así aparece de inmediato en la barra lateral.
       2. Llama a `MCP.manager.startServerRun({ conversationId, profile: activeProfile.name, toolSecurity })`.
       3. Fuerza el estado de esa conversación a `"running"` en `State.get('mcp').serverRuns` y arranca el heartbeat de 1 s.
     - Si la conversación activa tiene `status === 'running'` en `serverRuns`, el botón `#btn-send` queda deshabilitado y `#btn-stop-stream` visible para permitir cancelar la ejecución en el servidor (`MCP.manager.cancelServerRun(activeSessionId)`).
  4. **Historial lateral (`js/ui-sidebar.js`) y recarga al terminar:**
     - `renderSidebarChats(elements, sessions, currentSessionId, serverRuns)` pinta junto al título de cada conversación:
       - Si su estado en `serverRuns` es `'running'`: icono `clock` con clase de estado en ejecución.
       - Si su estado en `serverRuns` es `'needs_input'` o `'error'`: icono `help-circle` (`?`) resaltado.
     - En `js/app.js`, al cambiar `mcp.serverRuns`: si una conversación que estaba en `'running'` pasa a no estar `'running'` (terminó o pasó a `'needs_input'`):
       - Si es la conversación activa (`sessionId === getCurrentSessionId()`), recarga la conversación desde SQLite (`switchToSession(sessionId, { force: true, saveCurrent: false })`).
       - Si no es la conversación activa, actualiza la lista de sesiones (`Storage.getConversationsList()`) y repinta solo la barra lateral sin cambiar de chat ni lanzar diálogos.
* **Validación:** `npm run test:unit && npm run test:integration && npm run test:architecture`.

---

### Tarea `M47-T5`: Burbuja de progreso en vivo en el chat y reanudación de permisos / `ask_user`
* **Agente:** Argon · **Razonamiento:** High
* **Archivos a tocar:** `js/ui-conversation.js`, `js/tool-cards.js`, `js/app.js`, `css/components/messages.css`, `tests/unit/`, `tests/integration/`, `tests/browser/`.
* **Cambios requeridos:**
  1. **Burbuja en vivo de ejecución en servidor (`js/ui-conversation.js`):**
     - Cuando la conversación activa está `"running"` en `mcp.serverRuns`, mostrar al final de `#messages-list` un bloque de asistente en vivo con cabecera `"Ejecutándose en el servidor: tarea <run_id>"` (`server_run_active_banner`).
     - Cada vez que `mcp.focusRun` se actualiza para esa conversación, pintar dentro del bloque el paso actual (`step_text`), el razonamiento plegable (`reasoning_text`) y el Markdown parcial (`assistant_text`).
  2. **Tarjetas con permiso pendiente (`awaitingApproval: true`) y `ask_user`:**
     - En `js/tool-cards.js` (`renderHistoricalToolCard`): si el último mensaje `tool` de la conversación tiene `awaitingApproval: true` (JSON en `toolMsg.content`), renderizar la tarjeta con la barra de botones de autorización (`promptToolAuthorization` interactiva: Permitir una vez, Permitir en sesión, Permitir siempre, Denegar).
     - Al pulsar un botón de autorización en esa tarjeta histórica:
       1. Registrar la decisión en `ChatToolSecurity.manager` (si no es `'allow_once'` se persiste en `ChatToolSecurity`; si es `'allow_once'` se incluye en el `tool_security` de la ejecución).
       2. Si la decisión es permitir: eliminar del historial el par `assistant(tool_calls)` + `tool(awaitingApproval)` pausado (o marcarlo para reintento), guardar en SQLite y, si el modo servidor está activo, lanzar `MCP.manager.startServerRun({ conversationId, ... })` (o ejecutar localmente si el switch se apagó).
       3. Si la decisión es denegar: actualizar el mensaje `tool` a denegado por el usuario, guardar en SQLite y relanzar el turno para que el modelo continúe sabiendo que fue denegado.
     - En `handleAskUserOption` (`js/app.js`): como `submitComposerText` delega en `handleSendMessage`, si el switch «Ejecutar en servidor» está activo, responder a un `ask_user` lanzará automáticamente el nuevo `zerochat --conversation <id>` en el servidor.
  3. **Pruebas E2E de navegador (`tests/browser/`):**
     - Probar el flujo completo: seleccionar un perfil `Z-*`, activar «Ejecutar en servidor», enviar un mensaje, ver la conversación en el historial con icono de reloj y el banner `"Ejecutándose en el servidor: tarea ..."`, cambiar a otra conversación y volver, recibir estado `needs_input` (`?`) y continuar tras responder.
* **Validación:** `npm run test:unit && npm run test:integration && npm run test:browser && npm run test:architecture`.

---

### Tarea `M47-T6`: Documentación en `py/README.md`, `help/run-mode.html` y `help/en/run-mode.html`
* **Agente:** Gemini 3.8 Flash · **Razonamiento:** Low
* **Archivos a tocar:** `py/README.md`, `help/run-mode.html`, `help/en/run-mode.html`.
* **Cambios requeridos:**
  - En `py/README.md` (§2 y §5): documentar `~/zerochat/runs/`, `--conversation <id>`, `zerochat/run/start`, `zerochat/run/cancel`, el comportamiento de `live_state(focus_conversation_id)` y la pausa en `ask_user`/permisos.
  - En `help/run-mode.html` y `help/en/run-mode.html`: documentar en español e inglés el uso de `--conversation <id>` desde la CLI y el modo «Ejecutar en servidor» desde la interfaz web con perfiles `Z-*`.
* **Validación:** `npm run test:architecture && npm run test:infrastructure`.
