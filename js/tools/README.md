# Tools de ZeroChat

Cada tool nativa vive en `js/tools/builtin/<nombre>.tool.js` y exporta un módulo con `id`, `definition` y `createTool(Tool)`.

El contrato obligatorio es:

- `definition`: nombre, descripción y JSON Schema de Function Calling.
- `settings`: descriptor de configuración.
- `execute(args, context)`: ejecución; consume dependencias mediante `context.services`.
- `result`: adaptadores `toModel` y/o `toMarkdown`.
- `view`: tarjeta opcional (`createLiveCard`, `updateLiveCard`, `renderHistoricalCard`).

No usar `ui` ni `handler`: fueron eliminados. Para una dependencia nueva, declárala en `js/tools/tool-runtime.js`, inyéctala en pruebas y evita acceder a globals desde `agent-core.js`.

Las herramientas de conocimiento local usan cuatro operaciones canónicas: `list_documents`, `search_knowledge_base`, `read_knowledge_chunk` y `read_knowledge_image`. La última recupera bajo demanda una imagen ya extraída del documento; el modelo decide usarla únicamente si puede analizar imágenes. El registro y la ejecución del agente usan exclusivamente las definiciones declaradas por estos módulos.

## Ejecución agéntica

`AgentRuntime` (`js/agent-core.js`) es el único bucle agéntico. `chat-engine.js` prepara el contexto y adapta sus eventos al DOM, pero no ejecuta iteraciones ni herramientas.

Una herramienta puede ceder el turno al usuario devolviendo `endTurn: true` en un resultado correcto, como hace `ask_user`. El bucle termina tras ese paso y la respuesta del usuario llega como el siguiente mensaje. `AgentRuntime` lo indica con `awaitingUser` en su resultado.

No hay límite de pasos: el bucle termina con una respuesta sin herramientas, una herramienta con `endTurn`, la protección de bucles, la cancelación del usuario o un error. El runtime nunca pide al modelo una síntesis o resumen final.

La protección de bucles guarda, solo durante el turno, la huella de los últimos 10 lotes de herramientas (nombre y argumentos con las claves ordenadas, en el orden del lote). Antes de ejecutar un lote comprueba si el historial termina en el mismo lote repetido 5 veces (`aaaaa`) o en dos lotes alternados 5 veces (`ababababab`); en ese caso no lo ejecuta, añade un aviso al texto del paso y termina con `loopDetected`. Un texto para el usuario distinto del último que reinició el control vacía el historial; la misma frase repetida en cada paso y las llamadas emitidas como texto (`<tool_call>`) no lo reinician. Ciclos como verificar, editar y volver a verificar no cuentan como bucle porque cada edición cambia los argumentos.

Toda ejecución pasa por `ToolExecutor`. Este resuelve la herramienta en `ToolRegistry`, evalúa la política de `ChatToolSecurity` y solo después invoca `tool.execute`. Las herramientas MCP que requieren confirmación se bloquean si no existe una interfaz que pueda recoger una decisión explícita del usuario.

Cada invocación recibe en `context.invocationId` un identificador único, que también lleva su tarjeta en `data-invocation-id`. Sirve para referirse a la ejecución antes de que termine.

### Comandos locales

El host local expone una sola herramienta de ejecución, `run_command`, y otra de control, `check_command`. Cada llamada a `run_command` abre una shell nueva (bash, o PowerShell en Windows) en el directorio del proyecto: no hereda `cd`, variables ni entornos virtuales de llamadas anteriores. La salida une stdout y stderr en el orden en que se producen.

- Sin `background`, espera hasta `timeout_seconds` (30 por defecto, máximo 600) y, si no ha terminado, mata el grupo de procesos completo.
- Con `background: true`, responde a los pocos segundos con un `job_id` y la primera salida; el comando sigue sin plazo hasta que termina o se detiene.
- `check_command(job_id, wait_seconds?, stop?)` devuelve el estado y solo la salida que el modelo aún no ha visto. No requiere confirmación porque solo actúa sobre comandos del registro del host.

Cada comando es una tarea del registro del host, con su log en un directorio temporal de la sesión. Su comienzo se guarda en disco y su final en memoria, con un tope de 5 MB, y el log se borra al cerrar ZeroChat. El cliente envía `context.invocationId` como `params._meta.zerochatJobKey`; si se aborta el turno, detiene el comando con `zerochat/jobs/stop` y esa clave. La tarjeta de `run_command` (`js/command-card.js`) sigue al comando con `zerochat/jobs/get`, primero por la clave de la invocación y después por su `job_id`. Muestra su estado y un botón para detenerlo; desplegada, su log, que pide solo al desplegarse y que se actualiza mientras el comando sigue en marcha. Si el comando sigue en segundo plano cuando termina la llamada, vuelve a la zona visible del grupo de herramientas (`ChatToolCards.reactivateToolCard`) hasta que acaba. Al terminar un turno, `js/ui-command-jobs.js` añade al final del chat un aviso estático con los comandos en segundo plano que siguen en marcha (slice `mcp.commandJobs`, actualizado con el heartbeat y con `McpManager.refreshCommandJobs`) y retira el aviso anterior. Si el heartbeat indica `exit_on_close`, avisa con `beforeunload` antes de cerrar la pestaña. Al empezar un turno, `McpManager.buildCommandNotes` busca en la conversación los comandos cuyo último estado conocido es `running` y pide al host su final con `zerochat/jobs/report`, que entrega cada final una sola vez y solo si el modelo no lo ha visto. Con lo que devuelve se redacta una nota en inglés, que se guarda en el mensaje del usuario (`commandNotes`) y que `chat-engine.js` antepone a su texto: no se muestra en el chat y el historial que ve el modelo no cambia en turnos posteriores. La interfaz consulta y controla las tareas con los métodos `zerochat/jobs/list`, `zerochat/jobs/get`, `zerochat/jobs/log` y `zerochat/jobs/stop`, y el heartbeat publica las que siguen en marcha. Al parar el servidor, también con SIGHUP, se detienen todas. Para los cierres abruptos, en Windows cada comando entra en un Job Object con `KILL_ON_JOB_CLOSE`; en POSIX, cada instancia apunta sus grupos de procesos en un registro (`zerochat-jobs-<uid>/<pid>-…/jobs.json`, con la huella de arranque de cada proceso) y al arrancar se matan los de instancias que ya no existen, sin tocar otras vivas ni PID reutilizados.

Las llamadas `tools/call` al host local incorporan además un sello efímero emitido por el backend durante `initialize`. Tras una autorización positiva, el cliente firma los bytes exactos del JSON-RPC con HMAC-SHA256 sobre `zerochat-tool-auth-v1`, identificador de arranque, método, ruta, caducidad Unix en milisegundos, nonce aleatorio de 128 bits y el SHA-256 hexadecimal del cuerpo UTF-8. El host consume el nonce de forma atómica y rechaza sellos ausentes, alterados, caducados o repetidos. Las credenciales viven solo en memoria y no se reenvían a MCP remotos. El sello vincula el flujo normal de autorización con la petición, pero un frontend comprometido que pueda leer la clave aún puede crear sellos.

## Herramienta de ejecución de código (`execute_javascript`)

`execute_javascript` (`js/tools/builtin/execute-javascript.tool.js` y `js/sandbox.js`) es una herramienta diseñada para asistir al modelo en cálculos numéricos, operaciones algorítmicas complejas y procesamiento de datos en tiempo real.

- **Aislamiento en 3 capas (Defensa en profundidad)**:
  1. **`<iframe>` con `sandbox="allow-scripts"` (origen opaco `null`)**: Al no incluir `allow-same-origin`, el navegador bloquea completamente el acceso a `localStorage`, `sessionStorage`, `IndexedDB`, cookies y al DOM de la ventana principal (`window.parent` lanza `SecurityError`).
  2. **Content Security Policy (CSP) restrictivo**: El iframe inyecta su propia política `<meta http-equiv="Content-Security-Policy">` con `default-src 'none'`, `script-src 'unsafe-inline' 'unsafe-eval' blob:;` y `connect-src 'none'`. Esto imposibilita la exfiltración de datos mediante llamadas de red (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, WebRTC).
  3. **Web Worker desacoplado y Watchdog de timeout**: La computación se delega a un Worker interno sobre un hilo independiente para no congelar la interfaz de usuario ante algoritmos pesados o bucles. Un temporizador watchdog en el host (`timeoutMs`, por defecto 2500ms) elimina forzosamente el iframe (`iframe.remove()`) si se sobrepasa el límite de tiempo.
- **Control de salidas y recursos**: Truncado automático de salidas que superen `MAX_OUTPUT_LENGTH` (30.000 caracteres) y limitación estricta de registros de consola (`MAX_LOG_ENTRIES = 200`).
- **Supervisión y activación**: Diseñada para asistir al modelo con la visibilidad del usuario. Se puede habilitar o inhabilitar en cualquier momento desde los ajustes de herramientas.

## Nombres de herramientas

El contrato público es `<herramienta>` (nombre canónico directo) para herramientas locales
del host (como `read_file`, `write_file`, `edit_file`, `list_directory`, `execute_command`) y
`<servicio>_<herramienta>` para servicios externos, tanto directos como
agregados por el host. Ejemplo: `browser_service_browser_navigate`.
El host publica el nombre definitivo; el proveedor lo valida sin añadir prefijos.
`metadata.mcpServerId` y `metadata.originalName` conservan la identidad remota.
Las llamadas del host solo resuelven herramientas actualmente anunciadas.

Los archivos de los servicios gestionados tienen como fuente de verdad `services/`.
`npm run build:backend` ejecuta primero `scripts/build-managed-services.mjs`, que
genera `py/dd-managed-services.py` para integrarlos en `zerochat.py`.

Los componentes se codifican sin pérdida: se conservan `a-y`, `A-Z` y `0-9`;
solo en la herramienta se conserva también `_`. Cualquier otro carácter,
incluida la `z` minúscula, que abre cada escape, se representa como
`z<hexadecimal del punto de código>z`. Las mayúsculas se conservan para que los
nombres remotos (como `composio_COMPOSIO_SEARCH_TOOLS`) sigan siendo legibles y
quepan en 64 caracteres. Así se distinguen mayúsculas, puntuación y límites entre
servicio y herramienta sin depender del orden de descubrimiento. Los componentes
vacíos, los nombres públicos de más de 64 caracteres y los duplicados se rechazan
explícitamente; el host registra en consola cada herramienta descartada.
`publicToolName` en `js/mcp.js` y `public_tool_name` en `zerochat.py` deben
cambiar a la vez y se prueban con la misma tabla de casos.

El registro no genera alias MCP ni elimina sus guiones bajos para resolverlos.
Los permisos persistidos se consultan exclusivamente por identificador canónico,
nunca por nombre original, sufijo o alias. No existe migración de nombres antiguos.

## Tarjetas de ejecución

`ChatToolCards.renderCardHtml(options, context)` construye el armazón único de las
tarjetas nativas, MCP y de respaldo: cabecera, estado, botón y cuerpo plegable.
Las vistas aportan `titleHtml`, `badgeHtml` y `bodyHtml`, escapando previamente
cualquier dato externo; estos slots solo admiten HTML interno seguro.
`className` conserva selectores específicos del contenido, sin cambiar el diseño
de la cabecera. `titleSuffixHtml` permite mostrar el servidor MCP por separado
del nombre truncado. El plegado y la agrupación se coordinan en `ChatToolCards`.
Los gráficos son resultados principales: permanecen abiertos fuera de los grupos.
Las capturas MCP conservan `keepExpanded` para permitir inspeccionar la imagen.

El cierre automático se limita a la tarjeta que termina. Actualizar el estado de
un grupo o mover una tarjeta al historial no modifica el atributo `open` del
agrupador ni el plegado de otras tarjetas, respetando la interacción del usuario.
