# Simplificación de los diálogos entre frontend y backend (M79-T27)

Borrador para decidir antes de abrir las tareas de implementación. Objetivo: **reducir y unificar las llamadas JSON-RPC**, **eliminar condiciones de carrera y estados transitorios inestables**, y **simplificar el código** de transporte y sincronización entre `js/` y `py/`.

---

## 1. Diagnóstico del diálogo actual

### 1.1 Dos endpoints HTTP (`/`, `/mcp/external`) y dos clientes MCP
Desde M42-D12 `McpClient` solo habla con `zerochat.py`, pero el protocolo conserva la separación heredada en dos endpoints y dos proveedores:
- El frontend mantiene dos instancias de `McpClient` (`mcp_proxy` en `/` y `mcp_external` en `/mcp/external`) y dos `McpToolProvider` en `js/mcp.js` y `js/mcp-external.js`.
- Cada vez que cambia la lista de servicios MCP en marcha (`liveRunning` en `applyLiveState`), el cliente destruye `mcp_external`, instancia otro `McpClient` y lanza un `tools/list` a `/mcp/external`. Si al conectar arrancan 2 o 3 servicios (`startProfileServers` + `startEnabledServers`), repite ese ciclo tras cada servicio.
- En el servidor, `LOCAL_TOOLS_DEFINITIONS` es estática y `GLOBAL_MCP_MANAGER.tools()` ya está en memoria en `client.tools` (se puebla en el handshake stdio de cada servicio, sin I/O). Además, los nombres públicos de herramientas locales (`read_file`, `run_command`…) y externas (`<servicio>_<herramienta>`) son disjuntos.

### 1.2 Cascada de llamadas al conectar, reconectar y cambiar de proyecto
Conectar con `zerochat.py` encadena hoy hasta **5 llamadas en serie** antes de tener el estado básico listo:
1. `initialize` (`probeTarget`): devuelve `serverInfo` y `liveState`.
2. `tools/list` en `/`: pide las 8 definiciones de herramientas locales fijas.
3. `zerochat/security/get`: pide las políticas y la regla del proyecto (`policies`).
   - Al reconectar o identificarse (`connectConfigured`, `login` en `js/backend-session.js`), `ToolSecurity.setSessionToken(token)` llama a `refresh()` **antes** de `connectProxy` (con el cliente anterior) y `connectProxy` vuelve a llamar a `refresh()` justo después (**2 llamadas `security/get` seguidas**).
   - En el runner de Node (`js/run-node.js`), `connectProxy` también llama a `zerochat/security/get`, que **no está permitido para el token del runner** (`RUNNER_ALLOWED_METHODS` en `py/auth/tokens.py`), provocando en cada `--prompt` y `--conversation` un `403 Forbidden` registrado como error en el servidor y silenciado con `catch` en el cliente.
4. `tools/list` en `/mcp/external`: si hay algún servicio externo en marcha.
5. Al cambiar de proyecto (`zerochat/project/set_directory`), el servidor solo devuelve `{ cwd }`, por lo que `applyLiveState` dispara otra llamada `zerochat/security/get` aparte.

### 1.3 Contexto del proyecto: 3 llamadas `tools/call` (`read_file`) fingidas por turno
`ChatProjectContext.refresh()` (`js/project-context.js`) averigua el estado del proyecto ejecutando **hasta 3 llamadas `tools/call` (`read_file`) en serie** a través de `ToolExecutor.executeToolCall` con un `tool_call` sintético (`id: 'project_context_read'`):
1. `read_file` de `.zerochat/task.py` (`max_lines: 1`)
2. `read_file` de `.zerochat/state.md`
3. `read_file` de `AGENTS.md`

- Detecta si un fichero falta buscando texto en inglés con una expresión regular (`/does not exist|not found|no such file/i`) sobre el JSON de salida de la herramienta.
- Se ejecuta al conectar, al cambiar de proyecto y **al terminar cada turno del chat** (`js/ui-project.js:205`), dejando 3 líneas `--> POST / [tools/call: read_file]` en la consola del servidor tras cada respuesta del modelo.

### 1.4 Rebote de estado al abrir Ajustes › MCP (`verifyProxyConnection`)
Cada vez que el usuario abre `Ajustes › Servidor Local (MCP)` (`js/app.js:599`), se invoca `verifyProxyConnection()` (`js/mcp.js:539`):
- Aunque la conexión ya esté en `status: 'connected'`, cambia `mcp.status` a `'checking'` antes de enviar `initialize`, y milisegundos después vuelve a poner `status: 'connected'`.
- Esa transición `connected → checking → connected` hace parpadear el indicador, desactiva y reactiva controles (`syncServerRunControl`) y dispara **dos veces** los suscriptores de `mcp.status` (incluido `ProjectContext.refresh()` con sus 3 lecturas de ficheros).

### 1.5 Consultas de navegador en frío y subprocesos `node` por segundo (`zerochat/browser/*`)
- `UISettings.openSettingsSection` (`js/ui-settings.js:120`) llama siempre a `UIBrowser.load()`, aunque el usuario abra `Modelo`, `Agente`, `Conexión` o `Permisos`.
- `UIBrowser.load()` lanza 2 peticiones en serie: `zerochat/browser/config/get` y `zerochat/browser/engines/list`.
- En el servidor (`py/browser/engines.py:155`), `BROWSER_ENGINES.list()` ejecuta en cada llamada un subproceso bloqueante `node cli.js install --dry-run` (`_locations`), sin cachear las rutas de esa versión de Playwright.
- Mientras se instala un motor, el frontend consulta `engines/list` cada 1 s (`ENGINE_POLL_MS = 1000`), lanzando un proceso `node` nuevo cada segundo en paralelo con la descarga.
- Al quitar un motor (`engines/remove`), el servidor actualiza `browser.json` pero no devuelve `config`, obligando al cliente a llamar a `config/get` a continuación (`js/ui-browser.js:332`).
- En el editor de perfiles (`js/ui-profiles.js:177`), `fillProfileForm` llama a `UIBrowser.loadProfileBrowser` (`engines/list`) incluso cuando se refresca el formulario con el diálogo de perfiles cerrado (p. ej. al borrar un perfil desde el menú).

### 1.6 Tarjetas de comandos y esperas (`zerochat/jobs/*`)
- Al desplegar una tarjeta de `run_command` (`CommandCardController.loadLog` en `js/command-card.js:530`) o al empezar una espera de `check_command` (`WaitCardController.pollLog` en `js/command-card.js:723`), la tarjeta hace **2 llamadas en serie**: primero `zerochat/jobs/get` (solo para leer `output_bytes` y estado) y enseguida `zerochat/jobs/log`.
- Cuando `zerochat/jobs/log` indica `done: true`, `CommandCardController.pollLog` vuelve a llamar a `zerochat/jobs/get` (`refreshStatus`) para obtener `exit_code` y `elapsed_s`.
- Al terminar un comando o un turno con comandos en segundo plano, tanto `CommandCardController` como `ui-command-jobs.js` llaman por separado a `refreshCommandJobs()` (`zerochat/jobs/list`).

### 1.7 Almacenamiento y sincronización (`zerochat/conversations/*`, `zerochat/blobs/*`)
- **`zerochat/blobs/has` en cada turno:** `uploadConversation` (`js/storage.js:353`) llama a `syncPendingBlobs(messages)` antes de cada `conversations/save`. Si una conversación tiene una imagen en el primer mensaje, en todos los turnos siguientes vuelve a enviar `zerochat/blobs/has` por red para los mismos `blobId` ya subidos en el primer turno.
- **Recargas redundantes de sesiones:**
  - `BackendSession.connectConfigured()` (`js/backend-session.js:119`) llama a `await loadSessions()` aunque `connectProxy` haya fallado (p. ej. 401 o servidor inalcanzable).
  - Cuando termina una ejecución en servidor (`js/app.js:818-825`) de la conversación abierta, se dispara a la vez `switchToSession(activeId)` (`conversations/get`, que ya actualiza la cabecera de esa conversación en `ChatState`) y `loadSessionsFromStorage()` (`conversations/list`).

---

## 2. Propuesta de simplificación

Organizada en bloques independientes, por orden de impacto en reducción de llamadas, estabilidad y limpieza de código:

### Bloque 1 (M79-T28) — Un solo endpoint (`/`) y arranque/cambio de proyecto unificados
- **Agente recomendado:** **Argon · Razonamiento medio** (toca contratos transversales entre `py/server/`, `py/auth/tokens.py`, `js/mcp.js`, `js/mcp-external.js`, `js/tool-security.js` y numerosas pruebas de integración/infraestructura).
1. **Retirar `/mcp/external` y el segundo `McpClient` (`mcp_external`):**
   - Todas las llamadas JSON-RPC van a `/`.
   - En `tools/call`, si `name` está en `LOCAL_TOOL_HANDLERS` se ejecuta como herramienta local; si no, como externa en `GLOBAL_MCP_MANAGER`.
   - Desaparecen `dispatch_external`, `EXTERNAL_METHODS`, `RUNNER_EXTERNAL_METHODS`, `EXTERNAL_ID` y el cliente duplicado en `js/mcp.js` y `js/mcp-external.js`.
2. **Incluir `tools`, `externalTools` y `policies` en el estado del servidor:**
   - `initialize` devuelve en una sola respuesta `serverInfo`, `liveState`, las definiciones de herramientas locales (`tools`), las de los servicios MCP externos en marcha (`externalTools`, ya en memoria en Python) y las políticas de permisos del proyecto (`policies`, para credenciales `local` y `remote`).
   - `zerochat/external/servers/start|stop|configure|secret` y `live_state` incluyen las herramientas externas en marcha (o su lista cuando cambian), eliminando las llamadas `tools/list` tras arrancar o parar cada servicio MCP.
   - `zerochat/project/set_directory` devuelve `{ cwd, policies }`.
   - **Resultado:** conectar pasa de **4-5 peticiones en serie a 1 (`initialize`)**; desaparece el `403` de `security/get` en el runner de Node; y **se eliminan el método `zerochat/security/get` y `ToolSecurity.refresh()`**, ya que las políticas llegan siempre con `initialize`, `set_directory`, `security/update` y `security/authorize`.

### Bloque 2 (M79-T29) — Lectura directa del contexto de proyecto (`zerochat/project/context`)
- **Agente recomendado:** **Argon · Razonamiento bajo o medio** (cruza autorización de lectura en `ACCESS_CONTROLLER`, resolución de rutas en `py/tools/filesystem.py` y el ciclo de estado en `js/project-context.js`).
1. Sustituir las 3 llamadas `tools/call` (`read_file`) de `ChatProjectContext.refresh()` por un método RPC dedicado `zerochat/project/context` (marcado en `QUIET_RPC_METHODS` para no ensuciar la consola tras cada turno).
2. En el servidor, `zerochat/project/context` comprueba con `ACCESS_CONTROLLER` si la lectura de los ficheros del proyecto está permitida (respetando reglas `deny` o falta de permiso → `status: "denied"`) y lee en una sola pasada `.zerochat/task.py` (existencia), `.zerochat/state.md` y `AGENTS.md` (hasta `MAX_FILE_BYTES = 16384`), devolviendo `{ status, rules, state, error }`.
3. Opcionalmente, incluir ese objeto `projectContext` directamente en `initialize` y `zerochat/project/set_directory`, de modo que conectar o cambiar de carpeta no haga ninguna petición adicional para el modo proyecto.
4. **Resultado:** de **3 llamadas `tools/call` en serie** (con parseo por regex de errores en inglés) a **1 llamada silenciosa** al terminar un turno (y **0 llamadas extra** al conectar o cambiar de proyecto).

### Bloque 3 (M79-T30) — Unificar consultas de comandos (`zerochat/jobs/log` y `stop`)
- **Agente recomendado:** **Hydrogen · Razonamiento medio** (o **Argon · Razonamiento bajo**; cambios acotados a `py/tools/jobs_rpc.py`, `js/command-card.js` y `js/ui-command-jobs.js`).
1. **`zerochat/jobs/log` completo y con `tail`:**
   - Admitir en `zerochat/jobs/log` el parámetro opcional `tail` (bytes desde el final cuando aún no se tiene `offset`, p. ej. `FIRST_LOG_BYTES = 16384`, o `0` en `WaitCardController` para situarse al final) y devolver en la misma respuesta los detalles del comando (`job_details(job)`: `id`, `status`, `exit_code`, `started_at`, `elapsed_s`, `output_bytes`) junto a `text`, `next`, `total` y `done`.
   - Desplegar una tarjeta de `run_command` o iniciar la espera de `check_command` pasa de **2 llamadas (`jobs/get` + `jobs/log`) a 1 sola (`jobs/log`)**, y al terminar (`done: true`) no necesita otra llamada `jobs/get`.
2. **Estado vivo en `zerochat/jobs/stop`:**
   - Incluir en la respuesta de `zerochat/jobs/stop` la lista actualizada de `jobs` en marcha del proyecto (igual que `external/servers/stop` devuelve `servers`), evitando la llamada posterior a `zerochat/jobs/list`.
   - En el cierre de turno con comandos en segundo plano, hacer una única actualización de `commandJobs` en vez de duplicarla entre la tarjeta y `ui-command-jobs.js`.

### Bloque 4 (M79-T31) — Unificar y cachear consultas de navegador (`zerochat/browser/*`) y evitar el rebote de Ajustes › MCP
- **Agente recomendado:** **Hydrogen · Razonamiento bajo o medio** (cambios locales y bien acotados en `py/browser/engines.py`, `js/ui-browser.js`, `js/ui-settings.js`, `js/ui-profiles.js` y `js/mcp.js`).
1. **Cachear `_locations(cli)` en `BrowserEngines` (`py/browser/engines.py`):**
   - Las rutas de caché que devuelve `node cli.js install --dry-run` solo dependen de la ruta y fecha de modificación (`mtime`) de `cli.js` (la versión instalada de Playwright MCP). Cachearlas en memoria en `BrowserEngines` evita lanzar un subproceso `node` en cada consulta y elimina el subproceso `node` por segundo durante el polling de instalación.
2. **Unificar `config/get` + `engines/list` y devolver `config` en `engines/remove`:**
   - Unificar la lectura en un solo método (o hacer que `zerochat/browser/config/get` / `engines/list` y `engines/remove` devuelvan `{ config, systemBrowsers, extensions, engines }`), reduciendo las 2 llamadas en serie al abrir la sección y al quitar un motor a 1 sola.
3. **Cargar datos de servidor solo cuando la sección o el diálogo están visibles:**
   - En `UISettings.openSettingsSection`, pedir los datos de navegador solo al abrir la pestaña `browser` (no al abrir `model`, `agent`, `connection` o `permissions`).
   - En `UIProfiles`, pedir los motores del capítulo Navegador solo con `profilesDialog.open`.
4. **Sin rebote `checking` en `Ajustes › MCP`:**
   - Al abrir `Ajustes › MCP` estando ya `connected`, no mutar `mcp.status` a `'checking'` antes del sondeo (o usar `readLiveState()`), evitando el parpadeo y el doble disparo de suscriptores.

### Bloque 5 (M79-T32) — Evitar llamadas redundantes en blobs y sesiones
- **Agente recomendado:** **Hydrogen · Razonamiento bajo** (lógica local y directa en `js/storage.js`, `js/backend-session.js` y `js/app.js`).
1. **Conjunto en memoria de blobs ya presentes en el servidor (`syncedBlobIds` en `js/storage.js`):**
   - Recordar en memoria (por sesión de conexión) los `blobId` confirmados por `blobs/has`, subidos con `blobs/put` o descargados con `blobs/get`. `syncPendingBlobs` solo consulta `zerochat/blobs/has` para los `blobId` de la conversación que aún no estén en ese conjunto (0 llamadas en turnos sucesivos sin imágenes nuevas).
2. **Limpiar recargas de sesiones innecesarias:**
   - En `BackendSession.connectConfigured()`, llamar a `loadSessions()` solo si `result.success` es `true`.
   - Al terminar una ejecución en servidor (`js/app.js`), si solo ha terminado la conversación activa (que ya se recarga con `switchToSession`), no lanzar en paralelo `loadSessionsFromStorage()` (`conversations/list`).

---

## 3. Resumen de impacto

| Escenario | Llamadas RPC hoy | Llamadas con la propuesta | Mejora de estabilidad / código |
|---|---|---|---|
| **Arranque conectado** (con modo proyecto y 1 MCP activo) | 8–10 (`initialize` + `tools/list` + `security/get` + `/mcp/external tools/list` + 3× `read_file` + `profiles/list` + `conversations/list`) | **3** (`initialize` [con tools, policies y project] + `profiles/list` + `conversations/list`) | Sin carrera de `setSessionToken`, sin doble `McpClient`, sin `403` en el runner de Node |
| **Cambiar de proyecto** (`set_directory`) | 5 (`set_directory` + `security/get` + 3× `read_file`) | **1** (`set_directory` [con `cwd`, `policies` y `projectContext`]) | Cambio atómico de carpeta, permisos y reglas/estado del proyecto |
| **Fin de cada turno en modo proyecto** | 4 (`conversations/save` + `blobs/has` + 3× `read_file`) | **2** (`conversations/save` + `project/context` silencioso; 0 `blobs/has` sin imágenes nuevas) | Consola del servidor limpia; sin llamadas `tools/call` sintéticas |
| **Abrir Ajustes (pestaña Modelo/Agente/Permisos)** | 2 + 1 subproceso `node` (`browser/config/get` + `browser/engines/list`) | **0** | No lanza Node en segundo plano si no se abre `Navegador` |
| **Abrir Ajustes › MCP** | 4 (`initialize` con rebote `checking` + 3× `read_file`) | **0** (o 1 `heartbeat` sin cambiar `status`) | Sin parpadeo `connected → checking → connected` ni refrescos en cascada |
| **Desplegar y seguir una tarjeta de `run_command`** | 2 al abrir (`jobs/get` + `jobs/log`) + 1 al acabar (`jobs/get`) + 1 `jobs/list` | **1** al abrir (`jobs/log` con `tail` y detalles) + **0** extra al acabar | Una sola ruta de lectura del estado y salida del comando |
