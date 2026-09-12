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

- **Mecanismo de ejecución**: Se ejecuta en un Web Worker efímero en un hilo separado del navegador (con fallback controlado en entornos sin soporte de Worker), evitando congelar el hilo principal de la interfaz ante bucles o algoritmos pesados.
- **Control de tiempo y recursos**: Aplica un límite estricto de tiempo (`timeoutMs`, por defecto 2500ms) que termina forzosamente el Worker (`worker.terminate()`) si se sobrepasa, además de truncar salidas excesivas y limitar las llamadas a consola.
- **Filtro de seguridad en el Worker**: Dentro del entorno del Worker se neutralizan APIs de red y spawning (`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `Worker`) para prevenir llamadas externas no intencionadas durante cálculos.
- **Vigilancia del usuario técnico**: Esta herramienta **no** es un sandbox sellado a nivel de sistema operativo ni una máquina virtual impermeable. Está concebida como una utilidad para agilizar cálculos del modelo con la visibilidad, conocimiento y supervisión activa de un usuario técnico. El usuario puede habilitar o inhabilitar la herramienta en cualquier momento desde la configuración.
