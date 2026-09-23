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

Toda ejecución pasa por `ToolExecutor`. Este resuelve la herramienta en `ToolRegistry`, evalúa la política de `ChatToolSecurity` y solo después invoca `tool.execute`. Las herramientas MCP que requieren confirmación se bloquean si no existe una interfaz que pueda recoger una decisión explícita del usuario.

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
`mcp_<servicio>_<herramienta>` para servicios externos, tanto directos como
agregados por el host. Ejemplo: `mcp_browser_service_browser_navigate`.
El host publica el nombre definitivo; el proveedor lo valida sin añadir prefijos.
`metadata.mcpServerId` y `metadata.originalName` conservan la identidad remota.
Las llamadas del host solo resuelven herramientas actualmente anunciadas.

Los componentes se codifican sin pérdida: se conservan `a-y` y `0-9`;
solo en la herramienta se conserva también `_`. Cualquier otro carácter,
incluida `z`, se representa como `z<hexadecimal del punto de código>z`.
Esto distingue mayúsculas, puntuación y límites entre servicio y herramienta
sin depender del orden de descubrimiento. Los componentes vacíos, los nombres
públicos de más de 64 caracteres y los duplicados se rechazan explícitamente.

El registro no genera alias MCP ni elimina sus guiones bajos para resolverlos.
Los permisos persistidos se consultan exclusivamente por identificador canónico,
nunca por nombre original, sufijo o alias. No existe migración de nombres antiguos.
