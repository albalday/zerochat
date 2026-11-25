# Arquitectura y normas de frontend (JavaScript y UI)

Este documento contiene las decisiones tácticas, contratos de módulos y normas de desarrollo para el cliente web (`js/`, `css/`, `zerochat.html` y `files.html`) y su ejecución en el runner de Node.js. Cuelga de la visión global en [`docs/architecture.md`](../docs/architecture.md) y complementa a [`AGENTS.md`](../AGENTS.md).

---

## 1. Mapa de módulos y patrón UMD

Todos los módulos de `js/` siguen el patrón de fábrica **UMD** sin bundler para ejecutarse idénticamente en el navegador (`zerochat.html`, `files.html`, `sw.js`) y en Node.js (pruebas y runner desatendido):

| Capa | Módulos principales (`js/`) | Responsabilidad táctica |
|---|---|---|
| **Base y estado** | `utils.js`, `defaults.js`, `i18n.js`, `icons.js`, `state.js`, `config-store.js`, `app.js` | Utilidades puras, diccionarios bilingües (`es`/`en`), catálogo SVG, store central (`ChatState`), configuración global vs. entorno de proyecto (`ChatConfig`) y coordinador de arranque (`app.js`). |
| **Motor, contexto y proveedores** | `agent-core.js`, `chat-engine.js`, `generation-controller.js`, `context-manager.js`, `message-turns.js`, `text-tool-calls.js`, `providers.js`, `providers-webllm.js`, `api.js`, `model-catalog.js`, `profile-check.js` | Bucle agéntico (`AgentRuntime`), orquestación del turno, presupuesto de ventana de contexto y compactación por bloques atómicos, adaptadores de APIs LLM (OpenAI/LM Studio, Claude, Gemini, Ollama, OpenRouter, Custom, Mirror) e inferencia local WebGPU (`WebLLM`). |
| **Persistencia, perfiles y sesiones** | `storage-db.js`, `storage.js`, `ragStorage.js`, `profile-repository.js`, `profile-backup.js`, `profile-export-bundle.js`, `conversation-service.js`, `export.js`, `data-reset-service.js` | Conexión única `IndexedDB` (`ZeroChatDB`), frontera de almacenamiento (`ChatStorage` y `ChatRagStorage`), repositorio y cifrado/sincronización de perfiles, metadatos de conversaciones y exportación. |
| **Documentos, RAG y transporte web** | `vendor-loader.js`, `file-parser.js`, `office-parser.js`, `html-document.js`, `attachments.js`, `ingestionEngine.js`, `rag-index.js`, `rag-service.js`, `web-browser.js`, `web-search.js` | Carga bajo demanda de bundles (`js/vendor/`), extracción de PDF/Office/HTML en cliente, ingesta y búsqueda léxica Orama, y transporte web unificado anti-SSRF (`ChatWebBrowser.webFetch`). |
| **Backend, MCP, proyecto y runner** | `backend-session.js`, `mcp.js`, `mcp-external.js`, `mcp-results.js`, `mcp-status.js`, `tool-security.js`, `project-context.js`, `server-run.js`, `run-mode.js`, `run-node.js`, `headless-adapters.js`, `sandbox.js` | Sesión y login con `zerochat.py`, cliente JSON-RPC único y long-poll de `heartbeat`, conciliación de servicios MCP por proyecto, caché en memoria de permisos (`ChatToolSecurity`), detección de `.zerochat/` con plantillas bajo demanda (`templates/project/`) y ejecución desatendida en Node.js. |
| **Interfaz de usuario (DOM)** | `ui-shell.js`, `ui-sidebar.js`, `ui-conversation.js`, `ui-composer.js`, `ui-generation-status.js`, `ui-reasoning.js`, `ui-settings.js`, `ui-profiles.js`, `ui-connection.js`, `ui-mcp.js`, `ui-browser.js`, `ui-project.js`, `ui-folder-picker.js`, `ui-command-jobs.js`, `ui-inspector.js`, `ui-telemetry.js`, `ui-transfer.js`, `ui-dialogs.js`, `tool-cards.js`, `command-card.js`, `rag-ui.js`, `markdown.js`, `charts.js`, `tab-alert.js`, `pwa-install.js`, `files-page.js` | Vistas y controladores de interfaz delegados en `mount()`, renderizado Markdown/gráficos, tarjetas de herramientas/comandos y navegador de ficheros del proyecto (`files.html`). |

### Reglas de modularidad
* **Inyección de dependencias:** las dependencias se inyectan en la fábrica UMD o se resuelven con `ChatUtils.resolveDep`. Está prohibido escribir `window.X || require(...)` a mano.
* **I18n e Iconos:** `ChatI18n` y `ChatIcons` se cargan inmediatamente después de `utils.js` y se inyectan en la fábrica (`const { t } = I18n;`). No se crean envoltorios propios de `t()`. `t()` devuelve la clave si falta la traducción; toda clave debe existir en español e inglés en `js/i18n.js` sin textos de respaldo tras `t()`.
* **Sin comprobaciones defensivas para componentes garantizados:** no se añaden respaldos para módulos base de `zerochat.html`, el contexto de `ChatToolCards`, elementos de `ELEMENT_IDS` en `app.js` ni diálogos insertados al arrancar por `ensureDialogMarkup()`. Ningún módulo inserta marcado al cargarse.
* **Páginas de la aplicación (`zerochat.html` y `files.html`):** `files.html` es el navegador ligero de ficheros del proyecto actual (`?project=&path=`). No carga toda la aplicación: con `utils.js`, `storage.js`, el cliente MCP y `backend-session.js` reutiliza la sesión de la cookie y la clave del proxy (`BackendSession.sessionConnection`), enviando `X-ZeroChat-Project`. `js/files-page.js` solo se monta en su página (`zerochat.html` solo usa `FilesPage.pageUrl`).

---

## 2. Ciclo de vida y eventos del DOM

* **Vinculación única en `mount()`:** los módulos de interfaz enlazan sus eventos una sola vez en `mount()`, utilizando listeners delegados en el contenedor. Repintar una lista o contenedor no vuelve a enlazar eventos (comprobado por `tests/architecture/test_ui_listeners.js`).
* **Visibilidad con `hidden`:** los elementos se muestran y ocultan exclusivamente con el atributo `hidden` (la regla global en `css/base.css` prevalece sobre `display`). Prohibido usar `style.display` o estilos en línea para visibilidad (solo se admiten estilos en línea para valores dinámicos derivados de datos, como ancho de barras de progreso o color de series).
* **Renderizado eficiente (lazy rendering):** durante el streaming SSE de tokens se evitan mutaciones masivas continuas del DOM; paneles pesados, popovers o historiales se actualizan bajo demanda o al cerrar el turno.

---

## 3. Gestión del estado (`ChatState`)

* **Coordinación:** `app.js` coordina el arranque y la integración entre módulos; la lógica de dominio reside en su módulo específico.
* **Slices canónicos de `ChatState` (`js/state.js`):**
  * `config`: configuración general y perfiles.
  * `sessions`: sesiones guardadas y metadatos.
  * `messages`: historial de conversación activo.
  * `streaming`: estado en tiempo real de la inferencia en curso.
  * `telemetry`: métricas de tokens y tiempos.
  * `ui`: estado transitorio de la interfaz (solo escrito por `state.js` y `ui-inspector.js`).
  * `mcp`: estado de conexión, herramientas locales, servicios MCP activos, trabajos `commandJobs` y ejecuciones `runs`.
  * `project`: contexto y normas del proyecto local (solo escrito mediante `setProjectContext`).
* **Mutadores atómicos:** prohibido usar variables globales mutables de módulo que provoquen fugas entre conversaciones. Todo cambio del historial o sesión pasa por los mutadores de dominio (`appendMessage`, `replaceMessages`, `removeLastTurn`, `saveSessionMetadata`, `removeSession`, `replaceConversation`, `importConversation`, `setAttachments`, etc.).

---

## 4. Persistencia local y sincronización (`ChatStorage`, `ChatRagStorage`, `ChatProfileRepository`)

* **Frontera única de persistencia:** ningún módulo fuera de almacenamiento accede directamente a `localStorage`, `sessionStorage`, cookies o `IndexedDB` (comprobado por `tests/architecture/test_persistence_boundary.js`). Todo pasa por:
  * `ChatStorage` (`js/storage.js`): preferencias en `localStorage` (prefijo `zerochat_`), cookie de sesión del backend (`{token, url}`), conversaciones e imágenes (`blobs`) sobre `ZeroChatDB` (`js/storage-db.js`).
  * `ChatRagStorage` (`js/ragStorage.js`): colecciones Orama y documentos sobre `ZeroChatDB`.
* **Sincronización bidireccional de conversaciones e imágenes:**
  * Al conectar (`conversations/list`), se guardan en IndexedDB las cabeceras remotas nuevas o más recientes marcadas con `messagesPending`, sin borrar mensajes locales previos hasta que se descargan bajo demanda al abrir la conversación (`conversations/get`). Sin servidor, si una conversación local tiene mensajes se abre; si nunca se descargó, lanza `CONVERSATION_NOT_DOWNLOADED`.
  * Las conversaciones creadas o editadas sin conexión (sin marca `synced`) se suben al conectar si su `updatedAt` no es más antiguo que el del servidor (una copia local ya marcada `synced` nunca pisa al servidor). Las conversaciones de más de 512 KiB se suben por tramos (`conversations/save_chunk`).
  * Los blobs de imágenes adjuntas o generadas se indexan con un índice `multiEntry` (`by_blobId`) para limpiar huérfanos al guardar o borrar conversaciones, y `ChatStorage` mantiene en memoria por sesión de conexión los `blobId` ya confirmados en el servidor para no repetir `zerochat/blobs/has` en cada turno.
* **Comprobación del perfil (`js/profile-check.js`):** compartida por la interfaz y el runner de Node. Al cambiar el perfil activo o su conexión —y al revalidar con `recheck()` desde el menú, la lupa del perfil activo o automáticamente en `visibilitychange`/fin de turno si quedó en error— consulta con su API key el listado de modelos del servidor y publica si el modelo está listo (`ui.profileCheck`) y su límite de contexto (`config.modelContextLimit`, real o `null` para el calculado); es el único que escribe ese límite, que no se guarda en el perfil. Telemetría e inspector solo lo muestran.
* **Perfiles de conexión (`js/profile-repository.js`):** guardan únicamente la conexión y parámetros del modelo. Se sincronizan bidireccionalmente con SQLite al conectar por mayor `updatedAt`, replicando las API keys cifradas en `localStorage` bajo demanda mediante `zerochat/profiles/reveal`. Si el `serverId` del backend cambia, se ofrece fusionar con el servidor o cancelar sin borrar perfiles locales.

---

## 5. Presentación, diseño y accesibilidad

* **Tokens de diseño:** todos los colores, radios, sombras y capas provienen de `css/tokens.css`, sin valores de respaldo dentro de `var()`. Fuera de `css/tokens.css` no se escriben colores literales.
* **Familias semánticas:** los estados utilizan `--success`, `--warning`, `--danger`, `--info`, `--accent`, `--teal`, `--primary`, `--neutral` y sus variantes `-text`, `-soft`, `-soft-hover` y `-border`. Las superficies oscuras comunes a ambos temas (código, terminales) usan `--console-*`.
* **Iconografía:** prohibido usar emojis crudos en controles, insignias o acciones. Se emplean exclusivamente iconos SVG de `ChatIcons` (`js/icons.js`) o `<svg class="ui-icon">` del sprite de `zerochat.html`.
* **Diálogos:** avisos, confirmaciones y solicitudes de texto usan exclusivamente `ChatDialogs.alert`, `ChatDialogs.confirm` y `ChatDialogs.prompt` (`js/ui-dialogs.js`), esperando siempre su promesa con `await` (prohibido `alert()`, `confirm()` o `prompt()` nativos).
* **Mensajes programáticos en inglés:** cualquier mensaje inyectado programáticamente para el modelo se redacta en inglés. Fuera de `js/i18n.js`, ningún literal de cadena que no sea marcado HTML lleva caracteres propios del español (`tests/architecture/test_english_literals.js`).

---

## 6. Proveedores LLM, gestión de contexto y ejecución desatendida

* **Adaptadores de IA (`js/providers.js` y `js/providers-webllm.js`):**
  * Extienden `BaseProviderAdapter` (`openai`, `claude`, `gemini`, `ollama`, `openrouter`, `custom`, `mirror`) o implementan la inferencia local en navegador (`WebLLM`), normalizando endpoints, streaming SSE, razonamiento (`reasoning_effort` / `thinking`, incluyendo `none` explícito y auto-recuperación ante HTTP 400 en `handleHttpError`), firmas de pensamiento (`thought_signature` en Gemini, `reasoning_signature` en Claude), llamadas a herramientas, puntos de caché de contexto (`cache_control` efímero con jerarquía estable de prefijo) e inspección activa con sondas (`inspect`).
* **Gestión de ventana de contexto (`js/context-manager.js`):**
  * Agrupa el historial en bloques atómicos indivisibles (`groupIntoAtomicBlocks`: un mensaje `assistant` con `tool_calls`, todos sus resultados `tool` y el mensaje `user` de evidencia visual marcado con `TOOL_EVIDENCE_FLAG` forman un único bloque) para podar o compactar el historial antiguo sin romper nunca la secuencia de llamadas a herramientas exigida por los proveedores.
  * **Presupuesto de entrada** (`calculateInputBudget`): el contexto del modelo (`config.modelContextLimit`, que publica `ChatProfileCheck`; 128K de respaldo si el proveedor no lo da) menos 4096 tokens de salida y un 10 % de margen, con un mínimo de 1024. Cuentan el prompt de sistema, las definiciones de herramientas del paso, las imágenes y el desfase calibrado con los `promptTokens` reales del paso anterior.
  * **Dos niveles de tope para los resultados de herramientas** (`buildOptimizedContext`): los turnos cerrados (antes del último `user`) se podan a 4000 caracteres y pierden su evidencia visual; los pasos del turno en curso no se podan entre pasos (conservan datos y caché de prefijo) y llevan un techo individual de 64.000 caracteres y uno por lote de llamadas paralelas (30 % del presupuesto), que reparte el sobrante de los resultados cortos.
  * **Compactación** (`shouldCompress` / `compressHistory`): antes de cada paso, si lo que se enviaría (con la misma poda, no el historial crudo) alcanza el 70 % del presupuesto y los turnos cerrados desde el último checkpoint ocupan al menos el 20 %, se resumen solo esos turnos cerrados; el mensaje `user` y los pasos del turno en curso se conservan tal cual. La transcripción del resumidor se acota a su presupuesto y un resumen que falla no se reintenta en el mismo turno. Las ramas resumidas (`keepActiveTurn: false`) resumen todo.
  * **Turno en curso que no cabe**: se reserva el 45 % del presupuesto a los pasos recientes completos y los anteriores se podan a 4000 caracteres; si aun así se supera el 65 %, la ventana deslizante (contigua, sin huecos) descarta los pasos más antiguos y adjunta al `user` del turno una nota determinista con las llamadas omitidas (como mucho 4000 caracteres, conservando las más recientes). El corte avanza de una vez hasta ese 65 % y se mantiene mientras los pasos nuevos quepan, para no invalidar la caché KV en cada paso.
  * **Estado del corte**: lo guarda `activeTurnCut` (`{ cut }`), que crea cada `AgentRuntime.execute`, pasa a `buildOptimizedContext` por las opciones de `prepareMessages` y descarta al compactar o cambiar de modelo. `buildOptimizedContext` no guarda estado propio: sin `activeTurnCut` no hay histéresis.
* **Motor de herramientas y modo desatendido (`js/agent-core.js`, `js/run-mode.js`, `js/run-node.js`):**
  * Las especificaciones detalladas del bucle agéntico y de las herramientas nativas residen en [`js/tools/README.md`](./tools/README.md).
  * En modo ejecución desatendida (`--prompt`, `--conversation`, `--run-file` y «Ejecutar en servidor»), `js/run-node.js` y `js/headless-adapters.js` conectan los módulos UMD de dominio al servidor local sin requerir DOM ni tocar IndexedDB, reutilizando `ConversationService.buildSessionMetadata` y el mismo contexto de proyecto (`ChatProjectContext.turnContext`) que el navegador. Tanto el navegador (`generation-controller.js`) como el runner graban la conversación tras cada paso de herramientas (`onStepHistory`).

---

## 7. Pruebas sin navegador

* **DOM solo en navegador:** las pruebas en Node (`unit/` e `integration/`) no tienen DOM. Los módulos de dominio no reciben elementos: el motor pinta a través de vistas (`ChatUIConversation.createTurnView`, `ChatToolCards.createCardView`) y los servicios reciben referencias y callbacks de presentación. Lo que pinta o lee elementos del DOM se prueba en `tests/browser/` con Playwright sobre la aplicación real. Está prohibido simular elementos con objetos planos o añadir guardas para Node en código de navegador.
* **Exportaciones limpias:** solo se exporta para probarla aislada una pieza que la aplicación ejecuta; nunca código, parámetros o inyecciones que solo usan las pruebas (criterios en [`tests/README.md`](../tests/README.md)).

---

## 8. Librerías de terceros (`js/vendor/`)

* **Origen único:** las librerías externas se declaran en `scripts/vendor-manifest.mjs`, se fijan a una versión exacta en `package.json` y se empaquetan con `npm run build:vendor` (esbuild) en IIFE clásicos versionados en `js/vendor/`, exponiendo un global (`ZeroChatOrama`, etc.). No se cargan desde CDN. `build:vendor` regenera automáticamente `licenses/` y `THIRD_PARTY_NOTICES.md`.
* **Arranque o bajo demanda:** solo las librerías con `onDemand: false` se cargan en `zerochat.html` y entran en `PRECACHE_ASSETS` de `sw.js`. El resto se carga al primer uso con `await ChatVendorLoader.load('<id>')` (`js/vendor-loader.js`), tanto en navegador como en el runner de Node (`ChatRunnerSource`), y el Service Worker las cachea entonces (sin conexión ni caché, rechaza con `code: 'VENDOR_UNAVAILABLE'`).
* **Documentos ofimáticos y HTML (`js/office-parser.js`, `js/html-document.js`):** `ChatOfficeParser` es el único consumidor de `mammoth` y `fflate` (con límites contra zip bombs: hojas de hasta 500 filas × 50 columnas, máx. 40 imágenes de 10 MB) y devuelve `{ text, images }` con el mismo contrato que el lector de PDF (`rag-image://__DOC_ID__:<id>`). `ChatHtmlDocument.parseHtml` usa `DOMParser` en navegador o un árbol ligero en el runner de Node.js.

---

## 9. Transporte web y política de proxies (`js/web-browser.js`, `js/web-search.js`)

* **Transporte unificado (`ChatWebBrowser.webFetch`):** único punto de salida y de validación (`validateUrlForFetch`: solo `http`/`https`, bloqueando metadatos cloud, loopback, rangos privados y notaciones numéricas de IP) para todas las herramientas web (`search_web`, `fetch_web_page`, `download_doc`, `download_image`).
* **Rutas con y sin backend:**
  * Con el backend conectado (`isProxyConnected()`), toda petición web va por `zerochat/web/fetch` (con revalidación anti-SSRF en cada salto de redirección y control de frecuencia por dominio).
  * Sin backend, las lecturas textuales (`binary: false`: `search_web` sobre DuckDuckGo HTML y `fetch_web_page`) usan Jina Reader (`r.jina.ai` con `X-Return-Format: html`), y las descargas binarias (`binary: true`: `download_doc`, `download_image`) hacen un `fetch` directo del navegador (sujeto a CORS). No se encadenan otros proxies públicos: cualquier bloqueo o error llega con su explicación al modelo.

---

## 10. Caché de políticas de seguridad en cliente (`js/tool-security.js`)

* **Caché en memoria sin persistencia local:** `ChatToolSecurity` es un espejo en memoria del último estado exportado por el backend (`AccessController` en SQLite), sin guardar nada en `localStorage`, `sessionStorage` ni IndexedDB. Conserva `policies` tal cual (`allowAll` booleano por proyecto, `directoryRules` y `commandPatterns` con la forma `{ global, project, session }`), notifica a sus suscriptores (`subscribe`) y `snapshot()` entrega la copia para ejecuciones en servidor.
* **Lecturas síncronas y mutaciones por RPC:** la UI lee el estado con getters síncronos (`getToolPolicy`, `getCommandPatterns`, `getServerPolicy`, `getDirectoryRules`, `getAllowAll`) y envía cambios parciales con `zerochat/security/update` (`setToolPolicy`, `setServerPolicy`, `setDirectoryRules`, `addDirectoryRule`, `setAllowAll`, `setCommandPatterns`), adoptando atómicamente el estado exportado que devuelve el servidor.
* **Sincronización sin consultas sueltas:** las políticas llegan incluidas en `initialize`, `zerochat/project/set_directory`, `zerochat/security/update` y `zerochat/security/authorize`. El frontend no normaliza rutas ni resuelve enlaces simbólicos: toda evaluación de rutas reside en el backend.

---

## 11. Entorno de ejecución por proyecto (`js/config-store.js`, `js/mcp.js`, `js/mcp-external.js`)

* **Ajustes globales frente a ajustes del proyecto:** la configuración separa las preferencias globales del usuario (`Idioma`, `Tema`, `Cifrado`, `Modo proyecto`, `Conexión`, persistidas en `runtime_config_v2`) del entorno propio del proyecto activo (`Modelo` del perfil activo, `Agente`, `MCP`, `Navegador`, `Ramas RAG activas`, `Permisos`).
* **Aplicación y conciliación de servicios MCP:** al conectar (`initialize`), cambiar de carpeta (`setProjectDirectory`), recuperar un proyecto perdido, iniciar sin conexión (aplicando el entorno `general`) o arrancar `--prompt`/`--conversation` (`RunMode.start`), `ChatConfig.applyProjectEnvironment` aplica el entorno del proyecto (respaldado localmente hasta 50 proyectos en `project_environments_v1`) y `McpManager.reconcileProjectServers` concilia en serie los servicios MCP externos deteniendo los que sobran y arrancando los configurados para ese proyecto (incluido `playwright` cuando `browser === 'playwright'`).
