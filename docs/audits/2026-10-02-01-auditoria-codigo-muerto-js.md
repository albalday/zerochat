# Auditoría de código muerto y código spaghetti — módulos JavaScript

Fecha: 2026-10-02 · Rama: `dev` (8.10.0, `e88ad1c`) · Alcance: `js/**/*.js` (69 módulos, ~30 000 líneas, excluido `js/vendor/`).

## Método

- Análisis estático propio (tokenizador que descarta comentarios, cadenas y regex) sobre todos los módulos: declaraciones sin referencias, claves exportadas por cada fábrica UMD y su consumo en `js/`, `zerochat.html`, `sw.js`, `help/` y `tests/`, longitud y anidación de funciones, ventanas duplicadas de 8 líneas normalizadas.
- Cada hallazgo de código muerto se ha verificado después con `grep` palabra completa. Se descartaron falsos positivos (p. ej. `state.js` `unsubscribe`, que es una función con nombre devuelta).
- "Muerto en producción" significa sin referencias fuera de su declaración/exportación en el código que carga `zerochat.html`; puede seguir usándose en tests.

## Resumen

| Categoría | Hallazgos |
|---|---|
| Funciones locales nunca llamadas | 7 |
| Exportaciones sin ningún uso (ni prod ni tests) | 8 |
| Exportaciones usadas solo por tests | ~20 |
| Ciclos de vida `mount`/`dispose` huérfanos | 4 módulos |
| Miembros de `window.ChatApp` sin uso | 12 de 20 |
| Funciones > 150 líneas | 7 (máx. 641) |
| Helpers redefinidos en varios módulos | 10 familias, ~90 copias |
| Bloques `catch {}` vacíos | 129 |

## 1. Código muerto

### 1.1 Funciones locales declaradas y nunca llamadas

| Ubicación | Símbolo | Nota |
|---|---|---|
| `js/app.js:63` | `getMsgIcon` | Copia de la de `ui-conversation.js`; en `app.js` no se usa. |
| `js/chat-engine.js:37` | `getI18n` | Sin llamadas. |
| `js/file-parser.js:32` | `decodePdfHexString` | Decodificador hex PDF huérfano. |
| `js/file-parser.js:234` | `isReadablePdfText` | Heurística de legibilidad huérfana. |
| `js/ui-composer.js:29` | `getState` | Resolver de dependencia sin uso. |
| `js/ui-mcp.js:40` | `appendTrustedIcon` | Sin llamadas. |
| `js/ui-settings.js:24` | `getStorage` | Sin llamadas. |

Se pueden eliminar sin impacto.

### 1.2 Exportaciones sin ningún consumidor (ni producción ni tests)

| Módulo | Exportación |
|---|---|
| `js/api.js:211` | `ChatAPI.getStandardReasoningOptions` |
| `js/context-manager.js:53` | `ChatContextManager.registerEstimator` (punto de extensión nunca usado) |
| `js/cookies.js:176` | `ChatStorage.deleteBackendSession` |
| `js/debug.js:56` | `ChatDebug.toggleAutoscroll` |
| `js/i18n.js:1618` | `ChatI18n.getAvailableLanguages` |
| `js/ingestionEngine.js:132` | `ChatIngestionEngine.extractTextFromPDF` (la ruta real pasa por `extractDocumentContent`) |
| `js/ragStorage.js:66` | `ChatRagStorage.requestPersistentStorage` |
| `js/ui-inspector.js:200` | `ChatUIInspector.getCachedModels` |

Además, `ChatPwaInstall` (global) no lo consume nadie: el módulo solo existe por su efecto lateral (`beforeinstallprompt`). La exportación es inocua, pero innecesaria.

### 1.3 Exportaciones que solo usan los tests

API pública mantenida únicamente para pruebas. O se prueba a través de la API real o se elimina junto con su test:

- `chat-engine.removeTurnFromHistory` (duplica `ChatMessageTurns.removeSelectedTurn`)
- `debug.isRawLogsEnabled`, `generation-controller.getCurrentAbortController`
- `rag-index.clearCache`, `rag-ui.setActiveBranchId`, `rag-ui.isBranchActive`
- `ragStorage.getStorageEstimate`, `ragStorage.clearAllData`, `ragStorage.STORE_*`
- `rag-service.injectRagContext`, `attachments.validateFileSize`
- `ui-mcp.buildMcpEndpoint`, `ui-sidebar.getSidebarMode`
- `tool-cards.normalizeName` (declarado en `tool-cards.js:9` y no usado internamente), `tool-cards.resolveToolView`
- `utils.serializeContent`, `utils.formatShortValue` (los consumidores usan copias locales; ver 2.2)
- `cookies.setCookie` / `getCookie` / `deleteCookie` (alias heredados de `set/get/deleteStorageItem`)

### 1.4 Ciclos de vida `mount`/`dispose` huérfanos (migración a medias)

Cuatro módulos UI implementan `mount()` con registro de listeners y `dispose()`, pero `app.js` nunca los llama y vuelve a cablear los mismos eventos en `setupEventListeners()`:

| Módulo | `mount` usado en prod | Duplicado en `app.js` |
|---|---|---|
| `js/ui-shell.js:164` | No (ni en tests) | `setupViewportListeners`, apertura/cierre de *execution info* |
| `js/ui-transfer.js:187` | No (ni en tests) | Botones de exportación e `importJsonInput` |
| `js/ui-sidebar.js:342` | Solo tests | `btnToggleSidebar`, backdrop, etc. (`app.js:1401`) |
| `js/ui-composer.js:186` | Solo tests | `submit`, `keydown`, drag & drop de `chatForm` (`app.js:1312-1542`) |

Caso grave: `handleImportFileSelected` existe dos veces con comportamiento divergente (`js/ui-transfer.js:142`, con `FileReader` en promesa y `onerror`; `js/app.js:1119`, sin `onerror` y con `typeof Attachments` defensivo). Solo se ejecuta la de `app.js`, y los tests ejercitan la otra.

Solo `UISettings.mount` y `UIProfiles.mount` están conectados de verdad. Ningún `dispose()` se invoca en producción.

### 1.5 `window.ChatApp` sobreexpuesto

`js/app.js:2137` publica 20 funciones. En producción solo se usan `startServerHeartbeat` y `stopServerHeartbeat` (desde `mcp.js`). Seis más solo las usan los tests de navegador (`switchToSession`, `deleteSession`, `createConversationBranch`, `openExecutionInfo`, `applyLanguage`, `setGenerationStatus`). Las 12 restantes no tienen ningún consumidor: `toggleReasoningMenu`, `updateReasoningUI`, `toggleDebugPanel`, `addDebugLog`, `clearDebugLogs`, `setDebugStatus`, `clearGenerationStatus`, `createNewSession`, `renameSession`, `exportConversationAs{Markdown,Json,Print}`, `getNewTabUrl`, `updateNewTabLink`.

## 2. Código spaghetti

### 2.1 Funciones desmesuradas

| Función | Líneas | Observaciones |
|---|---|---|
| `AgentRuntime.execute` (`js/agent-core.js:1012`) | **641** | 77 ramas, 8 niveles de indentación. Mezcla bucle agéntico, reintentos, detección de bucles, síntesis, checkpoints y telemetría. |
| `init` (`js/app.js:1749`) | 429 | Contiene anidado `handleImportMessage` (173 líneas, `app.js:1834`) con `console.log` de depuración. |
| `setupEventListeners` (`js/app.js:1293`) | 365 | 71 `addEventListener` en un solo bloque (ver 1.4). |
| `convertCmykJpegToRgbDataUrl` (`js/file-parser.js:700`) | 314 | Decodificador y codificador JPEG completo escrito a mano (incluye `fdct`), con 11 niveles de anidación. |
| `parsePdfStreamText` (`js/file-parser.js:296`) | 194 | 99 ramas, 7 niveles. |
| `cacheDomElements` (`js/app.js:112`) | 190 | Lista plana, aceptable, aunque acopla `app.js` a todo el DOM. |
| `createRepository` (`js/profile-repository.js:83`) | 154 | |

Otras por encima de 100 líneas: `_authorizeToolCall` (133, `agent-core.js:584`), `create` (125, `ui-dialogs.js:7`), `connectSseStream` (115, `mcp.js:345`), `formatMessages` (113, `providers.js:1151`), `executeToolCall` (110, `agent-core.js:717`), `discoverTools` (104, `mcp.js:847`).

### 2.2 Helpers copiados en lugar de reutilizados

`ChatUtils` ya ofrece `resolveDep`, `escapeHtml`, `serializeContent`, `fetchWithTimeout` y `clone`, pero cada módulo mantiene su propia copia, en contra de AGENTS.md §2 ("comprobar si ya existe una solución equivalente"):

| Helper | Copias | Dónde |
|---|---|---|
| `resolveDep` | 14 | `utils` + 13 módulos `ui-*`, servicios y `tool-security` |
| `getI18n` / `t` | 16 / 21 | Casi todos los módulos |
| `escapeHtml` | 9 | `utils`, `charts`, `markdown`, `rag-ui`, `ui-mcp`, `ui-sidebar`, `ui-settings`, `ui-inspector`, `render-chart.tool` |
| `safeEscapeHtml` | 9 | `tool-cards` y 8 herramientas *builtin* |
| `serializeContent` | 4 | `utils`, `providers`, `context-manager`, `chat-engine` |
| `fetchWithTimeout` | 4 | `utils`, `mcp`, `web-browser`, `web-search` |
| `clone` | 4 | `utils`, `state`, `config-store`, `profile-repository` |
| `getMsgIcon` | 3 | `app` (muerta), `ui-conversation`, `generation-controller` |
| `getBranchIds` | 4 | Herramientas de conocimiento (`list-documents`, `search-knowledge-base`, `read-knowledge-chunk`, `read-knowledge-image`) |

Lógica de dominio duplicada (riesgo real de divergencia):

- **Invariante assistant→tool** (descartar o reparar mensajes `tool` huérfanos): implementada tres veces, en `chat-engine.js:176` (`buildEffectiveMessages`), `providers.js:1208` (`formatMessages`) y `message-turns.js:26` (`removeSelectedTurn`). Las versiones ya difieren: `providers` inserta un `user: 'Continue'` y las otras no.
- **Estimación de tokens**: `api.js:191` `estimateTokens` (len/3.8) frente a `context-manager.js:63` `estimateTextTokens` (len/3.6 o len/2.9). Dan cifras distintas para el mismo texto.
- **Herramientas builtin**: bloques de 9 a 17 líneas copiados entre `finish-task`/`update-plan`/`agent-checkpoint` y entre `download-pdf`/`fetch-web-page`/`search-web`. Es *boilerplate* del contrato de herramientas que podría vivir en `tool-runtime.js`.
- Duplicados internos: `ragStorage.js` (`exportBranch` y `exportBranchBlob` repiten la serialización de documentos e imágenes, 14 líneas ×2), `ui-conversation.js` (botones de acciones en `appendUserMessage` y `createAssistantMessagePlaceholder`, 12-14 líneas ×2), `web-search.js` (los dos proveedores repiten el parseo de resultados).

### 2.3 Acoplamiento de `app.js`

- 33 dependencias resueltas como `const X = window.ChatX || {}` y 82 guardas `if (X.metodo)` / `if (X.metodo) … else fallback`. Como todos los módulos se cargan siempre desde `zerochat.html`, los `else` son ramas muertas que ocultan errores de carga en lugar de fallar.
- **Dependencia inversa**: `mcp.js:1173` y `mcp.js:1270` llaman a `window.ChatApp.start/stopServerHeartbeat`. Una capa de infraestructura invoca a la capa de arranque; debería recibir callbacks o emitir eventos.

### 2.4 Estado mutable a nivel de módulo

AGENTS.md §3 prohíbe las variables de módulo que provoquen fugas de estado entre conversaciones. Candidatos a revisar:

- `js/rag-ui.js`: 9 `let` de módulo (`activeBranchIds`, `loadedBranchId`, `loadedBranchName`, `loadedBranchDesc`, `loadedBranchLang`, `isCreatingBranch`, `currentIngestionController`…). `activeBranchIds` en concreto es estado de conversación y debería vivir en `ChatState`.
- `js/debug.js`: 6 (`dom`, `isAutoscroll`, `activeFilter`, `activeThinkingBlock`…). Es estado de UI, aceptable, pero fuera del slice `ui`.
- `js/app.js`: `heartbeatTimer`, `activeHeartbeatTarget`, `heartbeatCheckInFlight`, `typingIndicatorEl`.
- El patrón `activeCleanupFns`/`cachedElements`/`cachedOptions` se repite en `ui-profiles`, `ui-settings`, `ui-transfer`, `ui-shell`, `ui-sidebar` y `ui-composer`.

### 2.5 Errores silenciados

Hay 129 bloques `catch {}` vacíos (`mcp.js` 19, `agent-core.js` 11, `file-parser.js` 8, `cookies.js` 7…). Algunos son legítimos (limpieza, `removeEventListener`), pero muchos rodean lógica de negocio, en contra de AGENTS.md §2 ("sin ocultarlos silenciosamente").

### 2.6 Colateral (fuera del alcance, detectado de paso)

Unos 100 `throw new Error('…')` con texto en español fijo (p. ej. `ingestionEngine.js:126-134`, `app.js:1139`) llegan a la interfaz sin pasar por `ChatI18n`.

## 3. Recomendaciones priorizadas

1. **Borrado inmediato y sin riesgo**: las 7 funciones de 1.1 y las 8 exportaciones de 1.2; recortar `window.ChatApp` a lo que usan `mcp.js` y los tests.
2. **Resolver la migración a medias de 1.4**: o se conecta `mount()` de `ui-shell`/`ui-transfer`/`ui-sidebar`/`ui-composer` desde `app.js` y se borra el cableado equivalente de `setupEventListeners`, o se eliminan esos `mount`/`dispose` y sus tests. Ahora mismo los tests validan código que no se ejecuta.
3. **Unificar la lógica de dominio duplicada** (2.2): un único saneador assistant→tool en `ChatMessageTurns` y un único estimador de tokens en `ChatContextManager`.
4. **Sustituir las copias de helpers** por `ChatUtils` (`resolveDep`, `escapeHtml`, `serializeContent`, `fetchWithTimeout`, `clone`), módulo a módulo y con cambios pequeños, conforme a AGENTS.md §1.
5. **Trocear `AgentRuntime.execute`** en fases (preparación, llamada al modelo, ejecución de herramientas, detección de bucles, síntesis o finalización) con tests de caracterización previos. Hacer lo mismo con `app.js` `init`, sacando `handleImportMessage` a `profile-export-bundle`/`ui-profiles`.
6. **Invertir la dependencia `mcp.js → ChatApp`** mediante callbacks inyectados.
7. **Mover `activeBranchIds` de `rag-ui` a `ChatState`** y revisar el resto del estado de módulo.
8. Revisar los `catch {}` de `mcp.js` y `agent-core.js`: registrar en `ChatDebug` o propagar el error.
9. Evaluar si el códec JPEG propio de `file-parser.js:700-1300` (`convertCmykJpegToRgbDataUrl` + `encodeRgbToJpegDataUrl`, ~600 líneas) compensa frente a convertir mediante `<canvas>`/`createImageBitmap`, y, si se mantiene, extraerlo a su propio módulo.
