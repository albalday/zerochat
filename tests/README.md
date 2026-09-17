# Guía y Arquitectura de Pruebas de ZeroChat

ZeroChat utiliza el ejecutor nativo `node:test` de Node.js junto con Playwright para pruebas de navegador. Toda la suite es determinista, reproducible y está organizada por niveles de abstracción y grupos funcionales.

---

## 1. Estructura de Directorios

La carpeta `tests/` está estructurada en los siguientes niveles:

```text
tests/
├── unit/             # Pruebas unitarias de módulos aislados
├── integration/      # Pruebas de integración y colaboración entre módulos
├── browser/          # Pruebas de interfaz en navegador real con Playwright
├── architecture/     # Validaciones estáticas de contratos, AST y arquitectura
├── infrastructure/   # Pruebas de empaquetado (bundler), servidor local y runner
└── helpers/          # Utilidades compartidas excluidas de la ejecución automática
```

### Criterios por nivel

- **`unit/`**: Comportamiento funcional puro de un único módulo. Las dependencias externas (IndexedDB, APIs remotas, temporizadores) se aíslan mediante mocks ligeros o emulaciones en memoria.
- **`integration/`**: Validación de la colaboración entre múltiples módulos (p. ej., `ChatEngine` con `ChatState`, `RagService` con `RagStorage`, `MCPClient` con `ToolDispatcher`).
- **`browser/`**: Pruebas sobre Chromium headless mediante Playwright verificando renderizado de DOM, interacción de usuario, accesibilidad (ARIA/teclado), temas y carga limpia de `zerochat.html`.
- **`architecture/`**: Restricciones estáticas sobre código fuente y contratos públicos (p. ej. validación de esquemas de herramientas, no regresión de dependencias).
- **`infrastructure/`**: Validación del servidor de pruebas (`scripts/local-server.py`) y orquestador (`scripts/test-runner.mjs`).
- **`helpers/`**: Funciones auxiliares reutilizables (p. ej., `tests/helpers/browser-env.js`). Los archivos en esta carpeta nunca se descubren ni ejecutan como tests.

---

## 2. Comandos de Ejecución

### Scripts en `package.json`

| Comando | Descripción |
|---|---|
| `npm test` | Ejecuta la suite completa organizada por niveles en orden secuencial. |
| `npm run test:unit` | Ejecuta exclusivamente las pruebas unitarias (`tests/unit/`). No inicia servidor ni navegador. |
| `npm run test:integration` | Ejecuta las pruebas de integración entre subsistemas (`tests/integration/`). |
| `npm run test:browser` | Ejecuta las pruebas modulares de navegador con Playwright (`tests/browser/`). |
| `npm run test:architecture` | Ejecuta las comprobaciones arquitectónicas estáticas (`tests/architecture/`). |
| `npm run test:infrastructure` | Ejecuta las pruebas del empaquetador, servidor local y runner (`tests/infrastructure/`). |
| `npm run test:group -- <grupo>` | Ejecuta un grupo funcional específico (`turns`, `composer`, `generation`, etc.). |

### Flags del Test Runner (`scripts/test-runner.mjs`)

El runner soporta flags para filtrar e inspeccionar:

```bash
# Listar todos los archivos que se ejecutarían en npm test
node scripts/test-runner.mjs --list

# Listar los archivos que pertenecen a un nivel
node scripts/test-runner.mjs --level=unit --list

# Listar los archivos que pertenecen a un grupo funcional
npm run test:group -- composer --list

# Ejecutar una suite individual directamente
node --test tests/unit/test_icons.js
```

---

## 3. Grupos Funcionales

Para acelerar el ciclo de desarrollo sin necesidad de ejecutar siempre los 79 archivos de prueba, se definen grupos funcionales que cruzan niveles:

| Grupo | Áreas / Flujos Cubiertos | Suites Incluidas |
|---|---|---|
| `turns` | Reglas puras de turnos y coordinación con estado, motor y fachadas | `tests/unit/test_message_turns.js`, `tests/integration/test_turn_facades.js`, `tests/integration/test_chat_engine.js`, `tests/integration/test_conversation_service.js` |
| `composer` | Ciclo de vida del composer, teclado, adjuntos y atajos | `tests/unit/test_ui_composer.js`, `tests/unit/test_attachments.js`, `tests/browser/browser_composer.test.js` |
| `generation` | Estado de inferencia, motor, controlador y renderizado | `tests/unit/test_ui_generation_status.js`, `tests/integration/test_generation_controller.js`, `tests/integration/test_chat_engine.js`, `tests/browser/browser_conversation.test.js` |
| `profiles` | Repositorio de perfiles, backup, UI y configuración | `tests/integration/test_profile_repository.js`, `tests/integration/test_profile_backup.js`, `tests/unit/test_ui_profiles.js`, `tests/unit/test_config_store.js`, `tests/browser/browser_profiles_settings.test.js` |
| `mcp` | Servidores MCP, catálogo, tool dispatcher y seguridad de herramientas | `tests/integration/test_mcp.js`, `tests/integration/test_mcp_tools.js`, `tests/integration/test_tool_dispatcher.js`, `tests/integration/test_tool_security.js`, `tests/unit/test_ui_mcp.js`, `tests/browser/browser_mcp_tools.test.js` |
| `rag` | Indexación RAG, almacenamiento en chunks, compresión y UI | `tests/integration/test_rag_index.js`, `tests/integration/test_rag_storage.js`, `tests/integration/test_rag_service.js`, `tests/integration/test_rag_ui.js` |
| `providers` | Adaptadores de inferencia (OpenAI, Claude, Gemini, Ollama, OpenRouter, WebLLM) | `tests/integration/test_providers.js`, `tests/integration/test_completed_model_queries.js`, `tests/integration/test_webllm.js`, `tests/browser/browser_webllm.test.js` |
| `bundle` | Compilación de `zerochat.html`, compresión gzip-base64 y arranque limpio | `tests/infrastructure/test_bundle.js`, `tests/browser/browser_startup.test.js` |

---

## 4. Inventario Completo de Suites (79 Suites)

### Pruebas Unitarias (`tests/unit/` - 33 suites)

| Suite | Módulo / Flujo | Dependencias | Recursos Externos / Mocks | Decisión / Aislamiento |
|---|---|---|---|---|
| `test_api_utils.js` | Normalización de payloads y SSE | `js/api-utils.js` | Ninguno | Funciones puras |
| `test_attachments.js` | Normalización y validación de adjuntos | `js/attachments.js` | Ninguno | Aislamiento in-memory |
| `test_charts.js` | Generación y saneamiento SVG de gráficos | `js/charts.js` | DOM mínimo (mock) | Sin efectos colaterales |
| `test_config_store.js` | Almacén de configuración local | `js/config-store.js` | `localStorage` mockeado | Limpieza por test |
| `test_cookies.js` | Serialización de cookies | `js/cookies.js` | `document.cookie` mock | In-memory |
| `test_debug.js` | Exportación y logs de depuración | `js/debug.js` | Consola mockeada | Restauración garantizada |
| `test_dialogs.js` | Diálogos modales y promesas | `js/ui-dialogs.js` | DOM virtual | Sin alerts nativos |
| `test_export.js` | Serialización JSON, Markdown y HTML | `js/export.js` | Ninguno | Funciones puras |
| `test_file_parser.js` | Parseo de texto, PDF, docx y código | `js/file-parser.js` | ArrayBuffers en memoria | Sin I/O de disco |
| `test_i18n.js` | Diccionarios bilingües ES / EN | `js/i18n.js` | Ninguno | Verificación de simetría de claves |
| `test_icons.js` | Catálogo de iconos SVG vectoriales | `js/icons.js` | Ninguno | Verificación de catálogo y viewBox |
| `test_markdown.js` | Renderizado seguro de Markdown y KaTeX | `js/markdown.js` | DOMParser / `marked` | Prevención XSS |
| `test_message_turns.js` | Reglas puras de turnos y resolución de IDs | `js/message-turns.js` | Ninguno | Funciones puras e inmutabilidad |
| `test_sandbox.js` | Ejecución en worker / iframe seguro | `js/sandbox.js` | WebWorker mockeado | Aislamiento estricto |
| `test_state.js` | Mutadores atómicos de `ChatState` | `js/state.js` | Ninguno | Sin persistencia IndexedDB directa |
| `test_storage_db.js` | Capa base de base de datos IndexedDB | `js/storage-db.js` | `fake-indexeddb` | Reinicio de esquema |
| `test_storage_indexeddb.js` | Operaciones CRUD de IndexedDB | `js/storage-db.js` | `fake-indexeddb` | Aislamiento entre tests |
| `test_token_usage_telemetry.js` | Normalización de tokens y telemetría | `js/telemetry.js` | Ninguno | Cálculos aritméticos |
| `test_tool_cards.js` | Renderizado de tarjetas de herramientas | `js/tool-cards.js` | DOM mínimo | Verificación de atributos |
| `test_ui_composer.js` | Entrada de texto, autosize y atajos | `js/ui-composer.js` | DOM virtual | Eventos simulados |
| `test_ui_conversation.js` | Renderizado de burbujas y mensajes | `js/ui-conversation.js` | DOM virtual | Sin dependencias de red |
| `test_ui_generation_status.js` | Indicadores de estado de inferencia | `js/ui-generation-status.js` | DOM virtual | Estados de streaming |
| `test_ui_inspector.js` | Panel de inspección de estado | `js/ui-inspector.js` | DOM virtual | Mock de state |
| `test_ui_mcp.js` | Panel de configuración de MCP | `js/ui-mcp.js` | DOM virtual | Sin sockets reales |
| `test_ui_profiles.js` | Modal y selección de perfiles | `js/ui-profiles.js` | DOM virtual | In-memory |
| `test_ui_reasoning.js` | Colapsables y renderizado de razonamiento | `js/ui-reasoning.js` | DOM virtual | Animaciones mockeadas |
| `test_ui_settings.js` | Panel de ajustes y parámetros de modelo | `js/ui-settings.js` | DOM virtual | Validación de inputs |
| `test_ui_shell.js` | Layout principal, header y toolbars | `js/ui-shell.js` | DOM virtual | Estructura de elementos |
| `test_ui_sidebar.js` | Barra lateral y lista de conversaciones | `js/ui-sidebar.js` | DOM virtual | Eventos de selección |
| `test_ui_telemetry.js` | Badge de tokens y métricas visibles | `js/ui-telemetry.js` | DOM virtual | Formato de números |
| `test_ui_transfer.js` | Importación y exportación visual | `js/ui-transfer.js` | File API mockeada | Sin lecturas de disco |
| `test_utils.js` | Utilidades generales (debounce, IDs, etc.) | `js/utils.js` | Ninguno | Funciones puras |
| `test_web_tools.js` | Herramientas web del navegador | `js/web-tools.js` | fetch mockeado | Sin peticiones de red |

### Pruebas de Integración (`tests/integration/` - 31 suites)

| Suite | Flujo Cubierto | Módulos Involucrados | Recursos Externos / Mocks |
|---|---|---|---|
| `test_agent_checkpoint.js` | Puntos de recuperación de agente | `agent-core.js`, `storage-db.js` | `fake-indexeddb` |
| `test_agent_core.js` | Ciclo de ejecución del agente autónomo | `agent-core.js`, `tool-dispatcher.js` | Mocks de inferencia |
| `test_agent_runtime.js` | Runtime y ejecución paso a paso de agente | `agent-runtime.js`, `state.js` | In-memory |
| `test_app_startup.js` | Secuencia completa de arranque de la app | `app.js`, módulos principales | DOM global simulado |
| `test_builtin_tools.js` | Herramientas internas (cálculo, tiempo) | `builtin-tools.js`, `sandbox.js` | Aislamiento de ejecución |
| `test_chat_engine.js` | Motor de chat y ciclo de turnos | `chat-engine.js`, `providers.js` | Streaming SSE mockeado |
| `test_completed_model_queries.js` | Consulta de modelos completados | `providers.js`, `config-store.js` | Mock de red |
| `test_context_manager.js` | Recorte y compactación de contexto | `context-manager.js`, `telemetry.js` | In-memory |
| `test_conversation_service.js` | Gestión de sesiones, títulos e historial | `conversation-service.js`, DB | `fake-indexeddb` |
| `test_data_reset_service.js` | Borrado seguro y restablecimiento | `data-reset-service.js`, DB | Limpieza de almacenes |
| `test_error_infrastructure.js` | Propagación y formato de errores | `error-handler.js`, `ui-dialogs.js` | Captura de excepciones |
| `test_generation_controller.js` | Controlador de generación y abort | `generation-controller.js`, engine | `AbortController` real |
| `test_ingestion_engine.js` | Ingestión de documentos complejos | `ingestion-engine.js`, `rag-index.js` | Parseo de buffers |
| `test_inspector.js` | Integración del inspector con estado | `inspector.js`, `state.js` | Sincronización bidireccional |
| `test_mcp.js` | Protocolo MCP, SSE y transporte | `mcp-client.js` | Mock de SSE y endpoints |
| `test_mcp_tools.js` | Ejecución de herramientas vía MCP | `mcp-client.js`, `tool-dispatcher.js` | Servidor simulado |
| `test_profile_backup.js` | Exportación e importación .zcp cifrada | `profile-repository.js`, crypto | `crypto.subtle` nativo |
| `test_profile_repository.js` | Persistencia y conmutación de perfiles | `profile-repository.js`, DB | `fake-indexeddb` |
| `test_providers.js` | Adaptadores de OpenAI, Claude, Ollama, etc.| `providers.js` | Parseo SSE y errores HTTP |
| `test_rag_index.js` | Creación y búsqueda en índice vectorial | `rag-index.js`, embeddings | In-memory vector space |
| `test_rag_service.js` | Orquestación de consulta y aumento RAG | `rag-service.js`, `rag-index.js` | Simulación de retrieval |
| `test_rag_storage.js` | Persistencia de chunks e imágenes RAG | `rag-storage.js`, DB | `fake-indexeddb` |
| `test_rag_ui.js` | Coordinación de interfaz RAG con servicio | `rag-ui.js`, `rag-service.js` | DOM simulado |
| `test_security.js` | Prevención de fugas y sanitización XSS | Múltiples módulos | Casos adversarios |
| `test_storage_reset.js` | Reseteo completo de bases de datos | `storage-db.js` | Comprobación de almacenes vacíos |
| `test_temporal_context.js` | Inyección de hora y fecha contextual | `chat-engine.js`, `message-turns.js` | Fechas fijadas |
| `test_tool_dispatcher.js` | Enrutamiento de llamadas a herramientas | `tool-dispatcher.js`, manifiestos | Registro de handlers |
| `test_tool_infrastructure.js` | Infraestructura general de ejecución tools| `tool-infrastructure.js` | Manejo de timeouts y fallos |
| `test_tool_security.js` | Políticas de confirmación y autorización | `tool-security.js`, `state.js` | Reglas de confirmación previa |
| `test_turn_facades.js` | Contratos de fachadas históricas de turnos | `message-turns.js`, `state.js`, engine | Preservación de firmas |
| `test_webllm.js` | Inferencia WebLLM y workers | `providers-webllm.js` | Mock de WebWorker y WebGPU |

### Pruebas de Navegador (`tests/browser/` - 9 suites modulares)

Ejecutadas con Chromium headless mediante Playwright con concurrencia controlada (`concurrency: 2`) y helper compartido `tests/helpers/browser-env.js`:

| Suite | Casos | Responsabilidad |
|---|---|---|
| `browser_startup.test.js` | 5 | Arranque desde HTTP y `file://`, enlace de ayuda, consistencia de runtime y carga limpia de `zerochat.html` sin errores en consola |
| `browser_composer.test.js` | 5 | Inserción de texto, atajos de teclado, autosize del textarea y gestión de adjuntos en la interfaz |
| `browser_conversation.test.js` | 6 | Renderizado de mensajes, auto-scroll, formateo de código/markdown, visibilidad de controles y eliminación de turnos |
| `browser_sidebar.test.js` | 3 | Apertura/cierre de la barra lateral, navegación entre conversaciones y eliminación de sesiones |
| `browser_profiles_settings.test.js` | 10 | Selección de perfiles, conmutación de proveedor, campos de API key, visibilidad de parámetros avanzados y validación |
| `browser_dialogs_notices.test.js` | 2 | Confirmaciones modales personalizadas (`ChatDialogs`), avisos del sistema y prevención de `alert`/`confirm` nativos |
| `browser_mcp_tools.test.js` | 3 | Diálogo de configuración MCP, activación/desactivación de herramientas y renderizado de llamadas a tools |
| `browser_webllm.test.js` | 6 | Opciones de WebLLM, descarga de modelos locales, enlaces de soporte WebGPU y parámetros específicos |
| `browser_a11y_theme.test.js` | 8 | Conmutación de modo oscuro/claro, contraste, atributos ARIA, navegación por teclado y catálogo de iconos vectoriales SVG |

### Pruebas de Arquitectura (`tests/architecture/` - 3 suites)

| Suite | Responsabilidad |
|---|---|
| `test_context_cache_architecture.js` | Valida que las reglas de caché de contexto no se filtren a proveedores que no la soportan. |
| `test_tool_contract.js` | Inspecciona los esquemas JSON de las herramientas declaradas asegurando tipos válidos y ausencia de APIs obsoletas (`ui`, `handler`). |
| `test_ui_modernization.js` | Valida el cumplimiento de diseño moderno: sin emojis crudos en controles, uso exclusivo de `ChatIcons` o `<svg class="ui-icon">`, y ausencia de diálogos nativos. |

### Pruebas de Infraestructura (`tests/infrastructure/` - 2 suites)

| Suite | Responsabilidad |
|---|---|
| `test_local_server.js` | Valida el comportamiento del servidor local Python (`scripts/local-server.py`), resolución de tipos MIME y encabezados CORS. |
| `test_runner.js` | Valida el orquestador `scripts/test-runner.mjs` (descubrimiento determinista, propagación de códigos de salida, rechazo de argumentos desconocidos). |

---

## 5. Registro de Casos Reorganizados y Divididos

### Desglose de la Suite Monolítica de Navegador (`test_browser_ui.js` -> 9 suites)

La suite original `tests/browser/test_browser_ui.js` (3.360 líneas, 48 casos) se dividió en suites temáticas independientes:

| Suite Original | Comportamiento Protegido | Destino | Motivo |
|---|---|---|---|
| `test_browser_ui.js` (casos 1-5) | Arranque, runtime, enlaces de ayuda y bundle limpio | `tests/browser/browser_startup.test.js` | Aislamiento del ciclo de vida y bundle |
| `test_browser_ui.js` (casos 6-10) | Composer, atajos de teclado y adjuntos | `tests/browser/browser_composer.test.js` | Aislamiento de entrada de usuario |
| `test_browser_ui.js` (casos 11-16) | Mensajes, markdown, auto-scroll y borrado | `tests/browser/browser_conversation.test.js` | Aislamiento de flujo de conversación |
| `test_browser_ui.js` (casos 17-19) | Sidebar, colapso y sesiones | `tests/browser/browser_sidebar.test.js` | Aislamiento de navegación lateral |
| `test_browser_ui.js` (casos 20-29) | Perfiles, ajustes de proveedor y llaves | `tests/browser/browser_profiles_settings.test.js` | Aislamiento de configuración |
| `test_browser_ui.js` (casos 30-31) | Diálogos modales y confirmaciones | `tests/browser/browser_dialogs_notices.test.js` | Aislamiento de feedback interactivo |
| `test_browser_ui.js` (casos 32-34) | Herramientas y modal de MCP | `tests/browser/browser_mcp_tools.test.js` | Aislamiento de subsistema MCP |
| `test_browser_ui.js` (casos 35-40) | Soporte WebLLM, modelos y UI de descarga | `tests/browser/browser_webllm.test.js` | Aislamiento de modelos en cliente |
| `test_browser_ui.js` (casos 41-48) | Accesibilidad, contraste, ARIA e iconos | `tests/browser/browser_a11y_theme.test.js` | Aislamiento de auditoría a11y/UI |

### Consolidación de Reglas de Turnos

| Caso Original | Comportamiento Protegido | Destino | Motivo |
|---|---|---|---|
| `test_message_turns.js` (casos de función pura) | `extractBaseId`, eliminación de turnos y saneamiento | `tests/unit/test_message_turns.js` | Reglas de dominio puras sin efectos secundarios |
| `test_message_turns.js` (casos de integración con State) | Sincronización atómica de estado y mutadores | `tests/integration/test_turn_facades.js` | Comprobación de contrato y compatibilidad entre módulos |

---

## 6. Cómo Añadir Nuevas Pruebas

1. **Seleccionar el nivel correcto**:
   - Si no requiere DOM ni colaboración entre subsistemas, crear en `tests/unit/test_<modulo>.js`.
   - Si prueba interacción entre dos o más módulos con estado compartido o eventos, crear en `tests/integration/test_<flujo>.js`.
   - Si comprueba interacción visual o eventos de usuario reales, crear en `tests/browser/browser_<area>.test.js`.
2. **Nombrado de archivo**: Usar el patrón `test_*.js` o `*.test.js` dentro del directorio correspondiente.
3. **Aislamiento**:
   - Usar `beforeEach` / `afterEach` para resetear mocks y estructuras globales.
   - En pruebas de navegador, utilizar `tests/helpers/browser-env.js` (`withTestContext` o `setupBrowserEnvironment`) asegurando el cierre de páginas y contextos en bloques `finally`.
4. **Registrar en Grupos**: Si la prueba pertenece a un flujo clave (composer, mcp, rag, etc.), añadirla al mapeo `GROUPS` en `scripts/test-runner.mjs`.

---

## 7. Validación Obligatoria (`AGENTS.md`)

Antes de finalizar cualquier tarea o considerar un cambio como completado:

1. Ejecutar la suite completa:
   ```bash
   npm test
   ```
2. Si hubo cambios en `index.html`, `js/`, `css/` o scripts de empaquetado, regenerar el bundle distribuible:
   ```bash
   npm run build
   ```
3. Ejecutar las pruebas de navegador para verificar que no hay regresiones de interfaz ni errores de consola:
   ```bash
   npm run test:browser
   ```
4. Confirmar que el archivo distribuible `zerochat.html` queda sincronizado con el código fuente.
