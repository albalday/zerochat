# Arquitectura y normas de frontend (JavaScript y UI)

Este documento contiene las especificaciones técnicas y normas de desarrollo para el cliente web (`js/`, `css/` y `zerochat.html`). Complementa a `AGENTS.md`.

---

## 1. Modularidad y patrón UMD

* **Fábricas UMD:** Todos los módulos reutilizables deben conservar el patrón UMD para ejecutarse tanto en navegador como en las pruebas de Node.js.
* **Inyección de dependencias:** Las dependencias se inyectan en la fábrica UMD o se resuelven con `ChatUtils.resolveDep`. Está prohibido escribir `window.X || require(...)` a mano.
* **I18n e Iconos:** `ChatI18n` y `ChatIcons` se cargan inmediatamente después de `utils.js` y se inyectan en la fábrica (`const { t } = I18n;`). No se crean envoltorios propios de `t()`.
* **Sin textos alternativos en `t()`:** `t()` devuelve la clave si falta la traducción. La clave debe existir obligatoriamente tanto en español como en inglés en `js/i18n.js`.
* **Sin comprobaciones defensivas para componentes garantizados:** No se añaden respaldos para lo que siempre está disponible:
  * Los módulos base que carga `zerochat.html`.
  * El contexto que `ChatToolCards` entrega a las vistas (`markdown`, `t`, `charts`, `createCardWrapper`, iconos de estado).
  * Los elementos de `ELEMENT_IDS` en `app.js`.
  * El marcado de diálogos insertado al arrancar por `ensureDialogMarkup()` de cada módulo. Ningún módulo inserta marcado al cargarse ni comprueba si un elemento existe antes de usarlo.

---

## 2. Ciclo de vida y eventos del DOM

* **Vinculación única en `mount()`:** Los módulos de interfaz enlazan sus eventos una sola vez en `mount()`, utilizando listeners delegados en el contenedor. Repintar una lista o contenedor no vuelve a enlazar eventos (lo comprueba `tests/architecture/test_ui_listeners.js`).
* **Visibilidad con `hidden`:** Los elementos se muestran y ocultan exclusivamente con el atributo `hidden`. La regla global en `css/base.css` prevalece sobre el `display` de cada clase. Queda prohibido usar `style.display` o estilos en línea para visibilidad. Solo se admiten estilos en línea para valores dinámicos derivados de los datos (ej. ancho de barras de progreso, color de series).
* **Renderizado eficiente (lazy rendering):** Para preservar el rendimiento durante el streaming SSE de tokens, se evitan mutaciones masivas continuas del DOM. Los paneles pesados, popovers o historiales complejos se actualizan bajo demanda o al finalizar la inferencia del turno.

---

## 3. Gestión del estado (`ChatState`)

* **Coordinación:** `app.js` coordina el arranque y la integración entre módulos. La lógica de dominio reside en su módulo específico.
* **Slices canónicos:** El estado compartido, persistente o necesario para coordinar subsistemas debe residir en `ChatState`, respetando sus slices:
  * `config`: configuración general y perfiles.
  * `sessions`: sesiones guardadas y metadatos.
  * `messages`: historial de conversación activo.
  * `streaming`: estado en tiempo real de la inferencia en curso.
  * `telemetry`: métricas de tokens y tiempos.
  * `ui`: estado transitorio de la interfaz.
  * `mcp`: herramientas locales y servicios MCP activos.
  * `toolSecurity`: políticas y permisos de ejecución de herramientas.
  * `project`: contexto y normas del proyecto local.
* **Mutadores atómicos:** Prohibido usar variables globales mutables de módulo que provoquen fugas entre conversaciones. Cualquier cambio de estado debe realizarse exclusivamente a través de los mutadores de dominio específicos (`appendMessage`, `replaceMessages`, `removeTurn`, `saveSessionMetadata`, `removeSession`, `replaceConversation`, `importConversation`, `setAttachments`, etc.).

---

## 4. Persistencia local

* **Frontera de persistencia:** La persistencia local se canaliza exclusivamente por dos módulos:
  * `ChatStorage` (`js/storage.js`): preferencias en `localStorage` (prefijo `zerochat_`), cookie de sesión del backend y conversaciones.
  * `ChatRagStorage` (`js/ragStorage.js`): colecciones Orama y base de conocimiento.
* **Base de datos única:** Ambos utilizan la conexión y esquema de `ZeroChatDB` (`js/storage-db.js`). Ningún otro módulo accede directamente a `localStorage`, `sessionStorage`, cookies o `IndexedDB` (lo comprueba `tests/architecture/test_persistence_boundary.js`).

---

## 5. Presentación, diseño y accesibilidad

* **Tokens de diseño:** Todos los colores, radios, sombras y capas provienen de `css/tokens.css`, sin valores de respaldo dentro de `var()`. Fuera de ese fichero no se escriben colores literales.
* **Familias semánticas:** Los estados utilizan las variables `--success`, `--warning`, `--danger`, `--info`, `--accent`, `--teal`, `--primary`, `--neutral` y sus variantes `-text`, `-soft`, `-soft-hover` y `-border`. Las superficies oscuras comunes a ambos temas (código, terminales) usan `--console-*`.
* **Iconografía:** Prohibido usar emojis crudos en botones, badges, barras o acciones interactivas. Se emplean exclusivamente iconos vectoriales SVG del catálogo `ChatIcons` (`js/icons.js`) o etiquetas `<svg class="ui-icon">`.
* **Diálogos:** Avisos, confirmaciones y solicitudes de texto utilizan exclusivamente `ChatDialogs.alert`, `ChatDialogs.confirm` y `ChatDialogs.prompt` (`js/ui-dialogs.js`). Queda prohibido invocar `alert()`, `confirm()` o `prompt()` nativos. Toda llamada espera su promesa con `await` o la devuelve a quien la espera (lo comprueba `tests/architecture/test_code_hygiene.js`); las confirmaciones respetan la cancelación y revalidan el estado antes de actuar.
* **Mensajes del sistema e inyectados:** Cualquier mensaje generado programáticamente para la conversación se redacta en inglés. Fuera de `js/i18n.js`, ningún literal de cadena que no sea marcado HTML lleva caracteres propios del español (comprobado por `tests/architecture/test_english_literals.js`).

---

## 6. Proveedores y agentes

* **Adaptadores de IA:** Los proveedores deben extender `BaseProviderAdapter` (`js/providers.js`) para normalizar endpoints, SSE, streaming de razonamiento (`reasoningChunk`), tool calls y telemetría.
* **Herramientas nativas:** Las herramientas agénticas implementan las especificaciones documentadas en `js/tools/README.md`.

---

## 7. Pruebas sin navegador

* **DOM solo en navegador:** Las pruebas en Node no tienen DOM. Los módulos de dominio no reciben elementos: el motor pinta a través de vistas (`ChatUIConversation.createTurnView`, `ChatToolCards.createCardView`) y los servicios reciben referencias y callbacks de presentación. Lo que pinta o lee elementos se prueba en `tests/browser/` sobre la aplicación real. Está prohibido simular elementos con objetos planos.
* **Exportaciones limpias:** No se exportan funciones ni variables privadas exclusivamente para ser testeadas; las pruebas consumen la API pública y el contexto real.

---

## 8. Librerías de terceros (`js/vendor/`)

* **Origen único:** Las librerías externas se declaran en `scripts/vendor-manifest.mjs`, se fijan a una versión exacta en `package.json` y se empaquetan con `npm run build:vendor` (esbuild) en IIFE clásicos versionados en `js/vendor/`, que exponen un global (`ZeroChatOrama`, etc.). No se cargan desde CDN.
* **Licencias:** `build:vendor` regenera `licenses/` y `THIRD_PARTY_NOTICES.md` con todos los paquetes que acaban dentro de cada bundle (los del metafile de esbuild). El texto sale del paquete instalado (archivo de licencia o sección del README). Ni `licenses/` ni los avisos se editan a mano.
* **Arranque o bajo demanda:** Solo las librerías con `onDemand: false` se cargan en `zerochat.html` y entran en `PRECACHE_ASSETS`. El resto se pide con `await ChatVendorLoader.load('<id>')` (`js/vendor-loader.js`), que inyecta `js/vendor/<id>.browser.js` una sola vez como script clásico (válido en file://), evalúa el mismo bundle en Node y devuelve el global `ZeroChat<Id>`. El service worker lo guarda en caché al primer uso; sin conexión y sin caché, la promesa se rechaza con `code: 'VENDOR_UNAVAILABLE'`. `tests/infrastructure/test_vendor_build.js` comprueba que los artefactos versionados coinciden con la salida de la build.
* **Documentos ofimáticos:** `ChatOfficeParser` (`js/office-parser.js`) es el único consumidor de mammoth y fflate. Devuelve `{ text, images }` con el mismo contrato que el lector de PDF (Markdown con referencias `rag-image://__DOC_ID__:<id>`); sus documentos de prueba y su procedencia están en `tests/fixtures/office/`. Los consumidores son `ChatFileParser.parseFile` (adjuntos de tipo `office`, con hasta 4 imágenes enviadas al modelo si admite visión y las referencias sustituidas por marcadores), la ingesta RAG (`fileType` igual al formato, detectado antes de rechazar los ZIP) y `fetch_web_page`/`download_doc`, que leen los documentos en local sin gateway ni proxy CORS.

---

## 9. Transporte web y política de proxies (`js/web-browser.js`, `js/web-search.js`)

* **Política de cero proxies públicos:** Queda prohibido el uso de proxies o gateways públicos de terceros (como `r.jina.ai` o `allorigins.win`). Todas las peticiones web se resuelven exclusivamente mediante el backend local autorizado o de forma directa en el navegador.
* **Transporte unificado (`ChatWebBrowser.webFetch`):** Todas las herramientas web piden con una sola función, que elige el proxy porque casi ninguna web permite CORS. Con el backend local conectado (`isProxyConnected()`), todo va por `zerochat/web/fetch`, que pone el User-Agent, valida cada redirección contra SSRF y marca `truncated` si el cuerpo supera `maxBytes`. Sin backend, leer (`binary` false: `search_web`, `fetch_web_page`) va por Jina Reader (`r.jina.ai` con `X-Return-Format: html`), que devuelve el HTML de la página y no los bytes originales; descargar (`binary` true: `download_doc`, `download_image`) es un fetch directo con solo la cabecera `Accept`, CORS-safelisted, que solo funciona con las webs que permiten CORS. No hay más alternativas encadenadas: los errores, incluidos los bloqueos de Jina, llegan al modelo con su explicación. `search_web` analiza el HTML de DuckDuckGo, igual por las dos rutas.
