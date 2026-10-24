# Tools de ZeroChat

Cada tool nativa vive en `js/tools/builtin/<nombre>.tool.js` y exporta la especificación con la que `ChatAgentCore` crea su `Tool`. La lista de módulos está en `BUILTIN_TOOL_MODULES` (`js/agent-core.js`); `zerochat.html` y `sw.js` cargan los mismos ficheros.

- `definition` (obligatoria): nombre, descripción y JSON Schema de Function Calling.
- `execute(args, context)` (obligatoria): ejecución; consume dependencias mediante `context.services`.
- `aliases`: otros nombres con que los modelos llaman a la herramienta. El registro los resuelve con o sin guiones bajos y sin distinguir mayúsculas, y el runtime guarda la llamada con el nombre registrado. Las herramientas MCP solo se resuelven por su nombre exacto.
- `category`, `metadata`, `isAvailable(config)` y `settings` (`titleKey`, `descKey`, `defaultEnabled`, `showInSettings`).
- `promptGuide`: línea de la guía del prompt de sistema para modelos sin firmas de herramientas.
- `result`: `toModel(args, result)` (contenido del mensaje `tool`) y `toMarkdown(args, result)` (bloque para copiar y exportar).
- `displayMode`: `collapsed` (por defecto) o `expanded`. Una tarjeta `collapsed` nace plegada y no se despliega sola: solo para pedir autorización, tras la que vuelve a plegarse, o cuando su vista lo pide al terminar (una captura, un comando en segundo plano). Lo que despliega el usuario queda desplegado.
- `view`: tarjeta opcional con `createLiveCard(args, ui)` y `updateLiveCard(card, args, result, elapsedMs, ui)`, que devuelve `true` para mantener la tarjeta abierta. Para el historial, `ChatToolCards` crea la tarjeta y le pasa a `updateLiveCard` el mensaje `tool` guardado: el JSON que recibió el modelo, o `{ content }` si era texto (`content` lleva siempre el texto original). Solo las vistas que necesitan otra cosa definen `renderHistoricalCard(args, message, ui)`.

`context.services` resuelve al usarlos los módulos de `TOOL_SERVICES` (`js/agent-core.js`); el contexto de la llamada puede sustituir cualquiera, y así lo hacen las pruebas. Una dependencia nueva se añade a esa tabla.

Las herramientas de conocimiento local usan cuatro operaciones canónicas: `list_documents`, `search_knowledge_base`, `read_knowledge_chunk` y `read_knowledge_image`. La última recupera bajo demanda una imagen ya extraída del documento; el modelo decide usarla únicamente si puede analizar imágenes. El registro y la ejecución del agente usan exclusivamente las definiciones declaradas por estos módulos.

## Ejecución agéntica

`AgentRuntime` (`js/agent-core.js`) es el único bucle agéntico. `chat-engine.js` prepara el contexto y adapta sus eventos al DOM, pero no ejecuta iteraciones ni herramientas.

Una herramienta puede ceder el turno al usuario devolviendo `endTurn: true` en un resultado correcto, como hace `ask_user`. El bucle termina tras ese paso y la respuesta del usuario llega como el siguiente mensaje. `AgentRuntime` lo indica con `awaitingUser` en su resultado.

No hay límite de pasos: el bucle termina con una respuesta sin herramientas, una herramienta con `endTurn`, la protección de bucles, la cancelación del usuario o un error. El runtime nunca pide al modelo una síntesis o resumen final.

La protección de bucles guarda, solo durante el turno, la huella de los últimos 10 lotes de herramientas (nombre y argumentos con las claves ordenadas, en el orden del lote). Antes de ejecutar un lote comprueba si el historial termina en el mismo lote repetido 5 veces (`aaaaa`) o en dos lotes alternados 5 veces (`ababababab`); en ese caso no lo ejecuta, añade un aviso al texto del paso y termina con `loopDetected`. Un texto para el usuario distinto del último que reinició el control vacía el historial; la misma frase repetida en cada paso y las llamadas emitidas como texto (`<tool_call>`) no lo reinician. Ciclos como verificar, editar y volver a verificar no cuentan como bucle porque cada edición cambia los argumentos.

El razonamiento de cada paso con herramientas se devuelve al modelo dentro del mismo turno. Si el adaptador indica en `parseStreamChunk` que llegó en un campo propio (`reasoningField`: `reasoning_content` o `reasoning`), `streamChatCompletion` lo devuelve como `reasoningReplay` y `AgentRuntime` lo guarda en el mensaje `assistant` con `tool_calls`. `buildEffectiveMessages` lo vuelca en ese mismo campo solo en los mensajes posteriores al último mensaje del usuario, y el historial que devuelve el runtime lo omite, así que no se persiste. El razonamiento extraído de etiquetas `<think>` no se reenvía. Si el servidor rechaza el campo con un 400, `handleHttpError` lo quita de los mensajes y reintenta.

Toda ejecución pasa por `ToolExecutor`. Este resuelve la herramienta en `ToolRegistry`, evalúa la política de `ChatToolSecurity` y solo después invoca `tool.execute`. Las herramientas MCP que requieren confirmación se bloquean si no existe una interfaz que pueda recoger una decisión explícita del usuario.

Cada invocación recibe en `context.invocationId` un identificador único, que también lleva su tarjeta en `data-invocation-id`. Sirve para referirse a la ejecución antes de que termine. Cuando se ejecuta en el chat, recibe además su tarjeta en vivo en `context.toolCard` (`element`, `attachListeners(el)` y `nest(container)`, que abre una vista de tarjetas dentro de ella); fuera del chat `context.toolCard` es `null`. Las tarjetas las abre `AgentCore.dispatchToolCall` en la vista `cards` que recibe (`ChatToolCards.createCardView`), y ChatEngine no toca el DOM: pinta el turno con la vista de `ChatUIConversation.createTurnView`.

### Subagente (`delegate_task`)

`delegate_task` (`js/tools/builtin/delegate-task.tool.js`) lanza otra ejecución de `AgentRuntime` en la misma pestaña, con el mismo proveedor y modelo. Si existe un perfil llamado «Subagente» o «Subagent» (sin distinguir mayúsculas), `resolveConnection` lo busca con `context.services.profiles`, lo carga con `services.profiles.loadUnlocked` (que pide la contraseña si la API key está cifrada), comprueba que tenga `apiUrl`, `apiType` y `model` y usa su URL, tipo, API key, modelo, temperatura, razonamiento y `contextLimitOverride` (sin él, el gestor de contexto asume la capacidad de ese modelo); la compactación se crea con esa misma conexión mediante `services.engine.createHistorySummarizer`. Si el perfil existe pero no se puede leer, cargar o está incompleto, la herramienta falla en lugar de volver al modelo principal. Su historial empieza con un único mensaje de usuario, en inglés, con las normas del subagente y el encargo; reutiliza `prepareMessages`, `contextOptions` y `summarizeHistory` del agente principal, así que comparte su prompt de sistema, el directorio y las normas del proyecto, el presupuesto de contexto y la compactación, salvo cuando el perfil «Subagente» aporta los suyos. Hereda su `signal`: detener el turno detiene también al subagente. Al agente principal solo vuelve el texto final, truncado a 20.000 caracteres; sus pasos no entran en el historial.

El subagente es de solo lectura. De las definiciones activas del turno (`resolveToolDefinitions`) solo recibe las de `isReadOnlyTool`: las nativas `search_web`, `fetch_web_page`, `download_doc`, `download_image`, `execute_javascript` y las cuatro de conocimiento, y del servidor local (`mcpServerId === 'mcp_proxy'`) `read_file`, `list_directory`, `search_files` y `get_diagnostics`. Quedan fuera las MCP externas, porque no declaran si escriben, además de `ask_user`, `render_chart` y la propia `delegate_task`, así que no hay subagentes anidados. Su despacho rechaza sin ejecutarla cualquier llamada a una herramienta que no se le ofreció. Cada llamada permitida pasa por el `dispatchToolCall` del agente principal y, con él, por `ToolExecutor` y `ChatToolSecurity`.

La tarjeta (`createLiveCard`) muestra el encargo, el paso en curso en la insignia y, en `.subagent-steps`, las tarjetas de las herramientas del subagente y sus textos intermedios. El bloque de texto de cada paso se reserva al empezar el paso, encima de sus herramientas, y se rellena al terminarlo, no durante el streaming. Como ya agrupa sus llamadas, `appendToolCard` deja la tarjeta del subagente fuera de los grupos «Llamadas a herramientas», igual que los gráficos y `ask_user`. `execute` usa su tarjeta de `context.toolCard` y despacha las herramientas del subagente con la vista `context.toolCard.nest(.subagent-steps)`, de modo que las autorizaciones aparecen en las tarjetas anidadas. El informe se renderiza con `ChatMarkdown.parseMarkdown`. En el historial solo queda el mensaje `tool` con el informe, o el error en JSON, y con él se reconstruyen el encargo y el informe. El runtime ejecuta las llamadas de un lote en orden, así que varias delegaciones en una misma respuesta van una tras otra.

### Comandos locales

El host local expone una sola herramienta de ejecución, `run_command`, y otra de control, `check_command`. Cada llamada a `run_command` abre una shell nueva (bash, o PowerShell en Windows) en el directorio del proyecto: no hereda `cd`, variables ni entornos virtuales de llamadas anteriores. La salida une stdout y stderr en el orden en que se producen.

- Sin `background`, espera hasta `timeout_seconds` (30 por defecto, máximo 600) y, si no ha terminado, mata el grupo de procesos completo.
- Con `background: true`, responde a los pocos segundos con un `job_id` y la primera salida; el comando sigue sin plazo hasta que termina o se detiene.
- `check_command(job_id, wait_seconds?, stop?)` devuelve el estado y solo la salida que el modelo aún no ha visto. No requiere confirmación porque solo actúa sobre comandos del registro del host.

Cada comando es una tarea del registro del host, con su log en un directorio temporal de la sesión. Su comienzo se guarda en disco y su final en memoria, con un tope de 5 MB, y el log se borra al cerrar ZeroChat. El cliente envía `context.invocationId` como `params._meta.zerochatJobKey`; si se aborta el turno, detiene el comando con `zerochat/jobs/stop` y esa clave. La tarjeta de `run_command` (`js/command-card.js`) se refiere al comando primero por la clave de la invocación y después por su `job_id`. Su reloj se calcula en el navegador; el final de un comando en segundo plano se detecta cuando deja de figurar en `mcp.commandJobs`, y entonces la tarjeta pregunta una vez con `zerochat/jobs/get`. Plegada no hace peticiones propias; desplegada pide su log cada 2 s mientras el comando sigue en marcha. Esas consultas (`jobs/get`, `jobs/log` y `jobs/list`) no se registran en la consola del servidor. Muestra su estado y un botón para detenerlo; desplegada, su log, que pide solo al desplegarse y que se actualiza mientras el comando sigue en marcha. Si el comando sigue en segundo plano cuando termina la llamada, vuelve a la zona visible del grupo de herramientas (`ChatToolCards.reactivateToolCard`) hasta que acaba. Al terminar un turno, `js/ui-command-jobs.js` añade al final del chat un aviso estático y plegado con los comandos en segundo plano que siguen en marcha (slice `mcp.commandJobs`, actualizado con el heartbeat y con `McpManager.refreshCommandJobs`) y retira el aviso anterior. Si el heartbeat indica `exit_on_close`, avisa con `beforeunload` antes de cerrar la pestaña. Al empezar un turno, `McpManager.buildCommandNotes` busca en la conversación los comandos cuyo último estado conocido es `running` y pide al host su final con `zerochat/jobs/report`, que entrega cada final una sola vez y solo si el modelo no lo ha visto. Con lo que devuelve se redacta una nota en inglés, que se guarda en el mensaje del usuario (`commandNotes`) y que `chat-engine.js` antepone a su texto: no se muestra en el chat y el historial que ve el modelo no cambia en turnos posteriores. La interfaz consulta y controla las tareas con los métodos `zerochat/jobs/list`, `zerochat/jobs/get`, `zerochat/jobs/log` y `zerochat/jobs/stop`, y el heartbeat publica las que siguen en marcha. Al parar el servidor, también con SIGHUP, se detienen todas. Para los cierres abruptos, en Windows cada comando entra en un Job Object con `KILL_ON_JOB_CLOSE`; en POSIX, cada instancia apunta sus grupos de procesos en un registro (`zerochat-jobs-<uid>/<pid>-…/jobs.json`, con la huella de arranque de cada proceso) y al arrancar se matan los de instancias que ya no existen, sin tocar otras vivas ni PID reutilizados.

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
del host (como `read_file`, `write_file`, `edit_file`, `list_directory`, `run_command`) y
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

`ChatToolCards.renderCardHtml(options)` construye el armazón único de las
tarjetas nativas, MCP y de respaldo: cabecera, estado, botón y cuerpo plegable.
Las vistas aportan `titleHtml`, `badgeHtml` y `bodyHtml`, escapando previamente
cualquier dato externo; estos slots solo admiten HTML interno seguro.
`className` conserva selectores específicos del contenido, sin cambiar el diseño
de la cabecera. `titleSuffixHtml` permite mostrar el servidor MCP por separado
del nombre truncado. El plegado y la agrupación se coordinan en `ChatToolCards`.
Los gráficos son resultados principales: permanecen abiertos fuera de los grupos.
Las capturas MCP y los comandos que siguen en marcha mantienen su tarjeta abierta.

Las vistas reciben siempre el contexto de `ChatToolCards` (`markdown`, `t`, `charts`,
`createCardWrapper` y los iconos de estado), así que no buscan dependencias en
`window` ni definen escapados propios. `fetch_web_page` y `download_doc` comparten
la tarjeta de `ChatToolCards.createWebRequestView`, que recibe el icono, los textos
y la etiqueta de estado de cada una, y las herramientas de conocimiento local, salvo
`read_knowledge_image`, la de `ChatToolCards.createTextResultView`; por eso `tool-cards.js` se carga antes que las
herramientas nativas.

El cierre automático se limita a la tarjeta que termina. Actualizar el estado de
un grupo o mover una tarjeta al historial no modifica el atributo `open` del
agrupador ni el plegado de otras tarjetas, respetando la interacción del usuario.
