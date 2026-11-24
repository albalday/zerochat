# Herramientas y ejecución agéntica (`js/tools/`)

Este documento especifica las decisiones tácticas y contratos del motor agéntico (`js/agent-core.js`), las herramientas nativas (`js/tools/builtin/`), la integración de herramientas locales/MCP y sus tarjetas de interfaz. Cuelga de la visión global en [`docs/architecture.md`](../../docs/architecture.md) y complementa a [`AGENTS.md`](../../AGENTS.md) y [`js/README.md`](../README.md).

---

## 1. Arquitectura de herramientas nativas (`js/tools/builtin/`)

Cada herramienta nativa vive en `js/tools/builtin/<nombre>.tool.js` y exporta la especificación con la que `ChatAgentCore` crea su instancia `Tool`. La lista canónica está en `BUILTIN_TOOL_MODULES` (`js/agent-core.js`); `zerochat.html` y `sw.js` cargan los mismos ficheros.

### 1.1. Contrato de especificación de un módulo `.tool.js`

- `definition` (obligatoria): nombre canónico, descripción y JSON Schema de Function Calling.
- `execute(args, context)` (obligatoria): lógica de ejecución; consume dependencias a través de `context.services` (resueltas perezosamente desde `TOOL_SERVICES` en `js/agent-core.js`).
- `aliases`: otros nombres con que los modelos invocan la herramienta. El registro los resuelve con o sin guiones bajos y sin distinguir mayúsculas, y el runtime persiste la llamada con el nombre canónico registrado. Las herramientas MCP solo se resuelven por su nombre exacto.
- `category`, `metadata`, `isAvailable(config)` y `settings` (`titleKey`, `descKey`, `defaultEnabled`, `showInSettings`).
- `promptGuide`: línea de guía en el prompt de sistema para modelos sin soporte nativo de firmas de herramientas.
- `result`: `toModel(args, result)` (contenido del mensaje `tool` enviado al modelo) y `toMarkdown(args, result)` (bloque para copiar y exportar).
- `displayMode`: `collapsed` (por defecto) o `expanded`. Una tarjeta `collapsed` nace plegada y solo se despliega automáticamente para pedir autorización (volviendo a plegarse tras decidir) o cuando su vista lo solicita al terminar (capturas, comandos que siguen en segundo plano). Si el usuario la despliega manualmente, permanece desplegada.
- `view`: tarjeta opcional con `createLiveCard(args, ui)` y `updateLiveCard(card, args, result, elapsedMs, ui)` (devuelve `true` para mantener la tarjeta abierta). Para reconstruir el historial, `ChatToolCards` crea la tarjeta y pasa a `updateLiveCard` el mensaje `tool` guardado (el JSON recibido por el modelo o `{ content }` si era texto); solo las vistas que requieren otro tratamiento definen `renderHistoricalCard(args, message, ui)`.

### 1.2. Catálogo de herramientas nativas

| Categoría | Herramienta (`js/tools/builtin/`) | Responsabilidad y alcance |
|---|---|---|
| **Web** | `search_web` (`search-web.tool.js`) | Búsqueda en DuckDuckGo HTML a través de `ChatWebBrowser.webFetch` (un único parser para backend local y Jina Reader). Puede ser reemplazada dinámicamente (`replaces`) por un servicio MCP activo como `brave`. |
| **Web** | `fetch_web_page` (`fetch-web-page.tool.js`) | Lectura de páginas web y extracción a texto/Markdown limpio (o lectura local de documentos si la URL apunta a PDF/Office). |
| **Web** | `download_doc` (`download-doc.tool.js`) | Descarga y extracción de texto/imágenes de documentos remotos (PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP). |
| **Web / Visión** | `download_image` (`download-image.tool.js`) | Descarga de imágenes para inspección visual multimodal (entrega `images` como evidencia visual). |
| **Conocimiento (RAG)** | `list_documents`, `search_knowledge_base`, `read_knowledge_chunk`, `read_knowledge_image` | Las cuatro operaciones canónicas sobre la base de conocimiento local (Orama/IndexedDB). `read_knowledge_image` recupera bajo demanda imágenes extraídas de documentos solo cuando el modelo soporta visión. |
| **Cálculo** | `execute_javascript` (`execute-javascript.tool.js`) | Ejecución de código JS en sandbox aislado de 3 capas (iframe/CSP/Worker en navegador; proceso hijo con `--permission` y sin generación de código desde cadenas en Node.js). |
| **Visualización** | `render_chart` (`render-chart.tool.js`) | Renderizado de gráficos interactivos en el flujo de la conversación (tarjeta siempre abierta fuera de los grupos). |
| **Control de turno** | `ask_user` (`ask-user.tool.js`) | Pausa el bucle agéntico (`endTurn: true`) para formular una pregunta al usuario (o detiene la ejecución en `needs_input` en modo `--conversation`). |
| **Control de turno** | `wait` (`wait.tool.js`) | Espera optimista en navegador (`seconds` hasta 24 h o hora local `until`). Deshabilitada en el runner sin ventana (`--prompt` / servidor). |
| **Control de turno** | `switch_model` (`switch-model.tool.js`) | Cambia de perfil y/o nivel de razonamiento a mitad de turno solo hacia perfiles nombrados explícitamente por el usuario en la conversación. |
| **Agente** | `delegate_task` (`delegate-task.tool.js`) | Lanza un subagente secundario de solo lectura en el mismo turno y devuelve únicamente su informe final. |

---

## 2. Bucle de ejecución agéntica (`AgentRuntime`)

`AgentRuntime` (`js/agent-core.js`) es el único bucle agéntico del sistema. `chat-engine.js` prepara el contexto y adapta eventos a las vistas del DOM (`ChatUIConversation.createTurnView`), pero no ejecuta iteraciones ni herramientas.

* **Condiciones de parada:** no hay límite artificial de pasos salvo `maxSteps`, que solo fija una ejecución desatendida de `--run-file`: antes de cada llamada al modelo, si ya hizo esas, el bucle se detiene con el estado `step_limit` sin cerrar el turno (el historial acaba en los resultados del último paso y se continúa desde ahí). El bucle termina cuando el modelo responde sin llamadas a herramientas, cuando una herramienta devuelve `endTurn: true` (como `ask_user`), cuando salta la protección contra bucles, al alcanzar `maxSteps`, por cancelación del usuario (`signal`) o por error. El runtime nunca fuerza una llamada extra para pedir un resumen final.
* **Protección contra bucles (`loop_detected`):**
  * Guarda durante el turno la huella de los últimos 10 lotes de herramientas (nombre y argumentos con claves ordenadas).
  * Antes de ejecutar un lote, comprueba si el historial termina en el mismo lote repetido 5 veces (`aaaaa`) o en dos lotes alternados 5 veces (`ababababab`). Si coincide, no lo ejecuta, cierra el turno añadiendo el aviso (`loopNotice`, en el idioma de la UI desde `ChatEngine` o en inglés desde `delegate_task`) y devuelve el estado `loop_detected`.
  * Un texto para el usuario distinto del último que reinició el control vacía el historial de huellas (la misma frase repetida o bloques `<tool_call>` en texto no lo reinician). Ciclos legítimos de editar y verificar no cuentan como bucle porque cada edición cambia los argumentos.
* **Reenvío de razonamiento dentro del turno (`reasoningReplay`):**
  * Si el adaptador indica en `parseStreamChunk` que el razonamiento llegó en un campo dedicado (`reasoningField`: `reasoning_content`, `reasoning` o `thinking` con `reasoning_signature` en Claude), `AgentRuntime` lo conserva en el mensaje `assistant` con `tool_calls`.
  * `buildEffectiveMessages` lo reenvía solo en los pasos posteriores al último mensaje del usuario dentro del turno activo, y lo omite del historial persistido. El razonamiento extraído de etiquetas `<think>` no se reenvía. Si el servidor rechaza el campo con HTTP 400, `handleHttpError` lo limpia y reintenta.
* **Evidencia visual multimodal (`TOOL_EVIDENCE_FLAG`):**
  * Cuando cualquier herramienta devuelve imágenes en `images` (`download_image`, `read_knowledge_image`, `browser_action`), `ChatEngine` y `buildEffectiveMessages` reúnen todas las imágenes de la racha de mensajes `tool` del lote y las inyectan en un único mensaje `user` inmediatamente posterior al lote (con sus metadatos: `imageRef`, documento, página, URL), sin partir el bloque `[assistant, tool...]`.
  * `ContextManager` lo marca con `TOOL_EVIDENCE_FLAG` para que `groupIntoAtomicBlocks` lo mantenga unido al lote y no lo pode; Claude fusiona esa evidencia en el mismo turno `user` de sus `tool_result`.
* **Despacho, permisos y aislamiento de contexto (`ToolExecutor`):**
  * Toda llamada pasa por `ToolExecutor`: resuelve la herramienta en `ToolRegistry`, evalúa la política de `ChatToolSecurity` y solo entonces invoca `tool.execute`.
  * Cada invocación recibe un `context.invocationId` único (reflejado en `data-invocation-id` de su tarjeta) y `context.signal`.
  * `context.agent` (URL, API key, modelo, contexto y despacho del agente) se entrega **exclusivamente** a herramientas de categoría `agent` (`delegate_task`), de modo que las herramientas MCP y el resto no reciben jamás la API key ni el historial.

---

## 3. Herramientas especiales y de control

### 3.1. Subagente de solo lectura (`delegate_task`)
* **Conexión y perfil opcional «Subagente»:** ejecuta otra instancia de `AgentRuntime` compartiendo por defecto proveedor, modelo, prompt de sistema, normas del proyecto y presupuesto de contexto del agente principal, y hereda su `signal`. Si existe un perfil llamado `Subagente` o `Subagent` (sin distinguir mayúsculas, buscando tanto en perfiles de sesión del servidor como en locales), lo carga con `services.profiles.loadUnlocked` y usa su conexión, modelo, razonamiento, límite de contexto y su propio resumidor de compactación (si el perfil existe pero está incompleto o bloqueado, falla explícitamente sin caer silenciosamente al modelo principal).
* **Restricción estricta a solo lectura (`isReadOnlyTool`):** solo recibe las herramientas activas de lectura: las nativas `search_web`, `fetch_web_page`, `download_doc`, `download_image`, `execute_javascript` y las 4 de conocimiento, más las locales `read_file`, `list_directory`, `search_files` y `get_diagnostics`. Quedan excluidas todas las herramientas de escritura/consola, todas las MCP externas (no declaran si escriben), `ask_user`, `render_chart`, `switch_model` y la propia `delegate_task` (sin anidamiento). Cualquier intento de llamar a otra herramienta se rechaza en el despacho.
* **Tarjeta y retorno:** sus pasos intermedios y tarjetas anidadas (`context.toolCard.nest(.subagent-steps)`) se muestran en vivo dentro de la tarjeta del subagente (fuera de los grupos de herramientas), pero al agente principal y al historial persistido solo vuelve el informe final en texto (truncado a 20.000 caracteres).

### 3.2. Comandos locales (`run_command` y `check_command`)
El host local expone una herramienta de ejecución (`run_command`) y una de seguimiento/control (`check_command`):

* **Semántica de ejecución (`run_command`):**
  * Cada llamada abre una shell limpia (`bash` en POSIX, `PowerShell` en Windows) en el directorio del proyecto (`ctx.workspace_dir`), con `PYTHONUNBUFFERED=1` y combinando `stdout` y `stderr`. No hereda `cd`, variables ni entornos virtuales de llamadas previas.
  * *Paso automático a segundo plano:* sin `background: true`, espera hasta `timeout_seconds` (30 s por defecto, máx. 240 s, tope único `TOOL_WAIT_MAX_SECONDS`). Si al agotarse sigue vivo, **no lo mata**: lo pasa a segundo plano y devuelve `status: running` con su `job_id` y una nota para no relanzarlo.
  * *Prevención de duplicados:* un comando idéntico a otro que sigue en marcha en el mismo proyecto se rechaza con error indicando el `job_id` activo.
* **Seguimiento sin regex (`check_command`):**
  * `check_command(job_id, wait_seconds?, stop?, pattern?)` devuelve el estado y solo la salida nueva que el modelo aún no ha visto.
  * Con `wait_seconds` (máx. `COMMAND_MAX_WAIT`) espera a que termine; con `pattern` (uno o varios textos fijos separados por `|`, sin distinguir mayúsculas, nunca regex para no bloquear el GIL de Python) vuelve en cuanto una línea nueva coincide (`returned_because`: `pattern_matched`, `command_finished`, `wait_elapsed` o `wait_ended_by_user`).
* **Gestión de logs, tarjetas en vivo y cierre:**
  * El log de cada comando guarda su inicio en un directorio temporal de sesión en disco y su tramo final en memoria (tope 5 MB).
  * El cliente envía `context.invocationId` como `params._meta.zerochatJobKey`: abortar el turno detiene el comando con `zerochat/jobs/stop` (o corta solo la espera de `check_command` con `zerochat/jobs/end_wait` al pulsar «Dejar de esperar»).
  * La tarjeta de `run_command` (`js/command-card.js`) plegada no lanza peticiones propias y muestra `last_line` del latido; desplegada pide las últimas 40 líneas con `zerochat/jobs/log` (`tail`, esperando con `wait_ms` a que el comando se registre si aún está en autorización) y sigue la salida por long-poll (`wait_ms`).
  * Al terminar un turno con comandos aún en segundo plano, `js/ui-command-jobs.js` muestra un aviso al final del chat y, en el siguiente turno del usuario, `McpManager.buildCommandNotes` recoge con `zerochat/jobs/report` los comandos terminados y antepone una nota interna en inglés (`commandNotes`) al mensaje para informar al modelo una sola vez.
  * Al cerrarse el servidor (o ante cierres abruptos, mediante Job Objects con `KILL_ON_JOB_CLOSE` en Windows y el registro de grupos de procesos `zerochat-jobs-<uid>` en POSIX limpiado al siguiente arranque) se terminan todos los árboles de procesos huérfanos.

### 3.3. Espera en navegador (`wait`) y cambio de modelo (`switch_model`)
* **`wait` (`js/tools/builtin/wait.tool.js`, alias `sleep`):** espera `seconds` (1 a 86.400) o hasta una hora local `until` (`HH:MM` / `HH:MM:SS`) comprobando el reloj cada segundo en el navegador (no existe en el runner de Node.js). Se cancela al pulsar «Detener» o cerrar la pestaña.
* **`switch_model` (`js/tools/builtin/switch-model.tool.js`):** cambia de perfil (`profile`) y/o nivel de razonamiento (`reasoning`: `none`, `low`, `medium`, `high`, `xhigh`). Por seguridad contra *prompt injection*, el modelo no recibe la lista de perfiles y el cambio solo se acepta si el nombre del perfil aparece como palabra completa en algún mensaje del usuario de esa conversación. Al cambiar de modelo, descarta el `reasoningReplay` del modelo anterior e inyecta una nota efímera (`MODEL_SWITCH_NOTE`) para que el nuevo proveedor trate las llamadas previas como un turno cerrado (evitando errores de validación como la falta de `thought_signature` en Gemini). En el runner desatendido, pide la API key del nuevo perfil bajo demanda con `zerochat/run/profile`.

### 3.4. Sandbox de ejecución de código (`execute_javascript`)
Diseñado con 3 capas de defensa en profundidad según el entorno (ambos truncan salidas a `MAX_OUTPUT_LENGTH = 30.000` caracteres y `MAX_LOG_ENTRIES = 200`):
1. **En navegador (`js/sandbox.js`):**
   - `<iframe sandbox="allow-scripts">` con origen opaco `null` (sin `allow-same-origin`: bloquea `localStorage`, `IndexedDB`, cookies y DOM padre).
   - CSP restrictivo inyectado (`default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'none'`), impidiendo llamadas de red (`fetch`, `XHR`, `WebSocket`, `WebRTC`).
   - Ejecución en Web Worker interno con watchdog de timeout (2500 ms por defecto) que destruye el iframe si se bloquea.
2. **En Node.js (`scripts/sandbox-child.js` → `py/tools/sandbox_script.py` y `js/sandbox-node-script.js`):** proceso hijo independiente sin variables de entorno ni token y con 3 barreras (ya que `node:vm` por sí solo no es frontera de seguridad):
   - Contexto `vm.createContext` vacío sin objetos del anfitrión, comunicando solo cadenas y recogiendo el resultado por sondeo.
   - Sin generación de código desde cadenas (`--disallow-code-generation-from-strings` y `codeGeneration: { strings: false, wasm: false }`) junto a `--permission` (sin disco ni procesos), neutralizando escapes por constructores del anfitrión (`eval` y `new Function` deshabilitados).
   - Global del anfitrión vaciado (`process`, `require`, `module` y funciones de red eliminadas antes de evaluar).

---

## 4. Codificación canónica de nombres de herramientas

* **Formato público:** `<herramienta>` para herramientas nativas y locales del host (`read_file`, `run_command`…) y `<servicio>_<herramienta>` para herramientas de servicios MCP externos (`browser_service_browser_navigate`).
* **Codificación sin pérdida (`publicToolName` en `js/mcp.js` y `public_tool_name` en `py/`):**
  * Se conservan `a-y`, `A-Z` y `0-9` (y `_` solo dentro del nombre de la herramienta).
  * Cualquier otro carácter, incluida la `z` minúscula, se escapa como `z<hexadecimal del punto de código>z`.
  * Se rechazan componentes vacíos, nombres públicos de más de 64 caracteres y duplicados. Ambas implementaciones (JS y Python) se prueban contra la misma tabla de casos.
* **Identidad en permisos:** las políticas persistidas se consultan exclusivamente por este identificador público canónico, sin alias ni eliminación de guiones bajos en herramientas MCP.

---

## 5. Tarjetas de ejecución (`ChatToolCards`)

* **Armazón único (`ChatToolCards.renderCardHtml`):** construye la estructura de todas las tarjetas (nativas, MCP y de respaldo) con `titleHtml`, `badgeHtml`, `titleSuffixHtml` y `bodyHtml` (escapando previamente cualquier dato externo). Las vistas reciben sus dependencias inyectadas desde `ChatToolCards` (`markdown`, `t`, `charts`, `createCardWrapper`, iconos de estado).
* **Agrupación y estabilidad visual:**
  * Las tarjetas se agrupan en contenedores plegables («Llamadas a herramientas») que se cortan cada 20 tarjetas para no degradar el DOM. Quedan fuera de los grupos los resultados principales o contenedores propios: gráficos (`render_chart`), preguntas (`ask_user`), esperas (`wait`) y subagentes (`delegate_task`).
  * Las tarjetas en curso entran directamente en el historial plegado del grupo (cuyo resumen muestra cuál se está ejecutando) para que la altura de la página no salte en cada llamada; solo pasan a la zona visible del grupo cuando requieren autorización interactiva del usuario o mientras un comando sigue corriendo en segundo plano.
