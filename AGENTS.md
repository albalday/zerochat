# 🤖 Protocolo de Desarrollo e Ingeniería para Agentes IA — ZeroChat

Este documento establece las **reglas de ingeniería, patrones de arquitectura, directrices de código, flujo de pruebas y protocolo de compilación** para ZeroChat. Cualquier agente IA (Antigravity, Claude Code, Cursor, Copilot, etc.) o desarrollador debe adherirse estrictamente a estas directrices.

---

## 1. 🛑 Reglas Cardinales e Inquebrantables

1. **Arquitectura Fuente vs Distribución**:
   - Todo el desarrollo se realiza exclusivamente en el código fuente modular: `js/`, `css/` e `index.html`.
   - **NUNCA modifiques `zerochat.html` a mano**. Este archivo es un bundle empaquetado y minificado generado por `bundle.py`.
2. **Norma Inquebrantable de Fin de Modificación: Regenerar el Bundle**:
   - Tras CUALQUIER edición en el código fuente, **SIEMPRE sin excepción**:
     1. Ejecutar las pruebas unitarias: `npm test` (o `npm run test:unit`).
     2. **REGENERAR EL BUNDLE**: Ejecutar `npm run build`.
   - Ninguna tarea se considera finalizada ni entregada al usuario sin haber ejecutado `npm run build` para garantizar que `zerochat.html` esté 100% sincronizado.
3. **Validación Obligatoria de Interfaz de Usuario (Browser Tests)**:
   - Si un cambio modifica el DOM (`index.html`), estilos (`css/`) o renderizado de componentes visuales en `js/`, es **OBLIGATORIO** ejecutar los tests de integración en navegador real:
     ```bash
     npm run test:browser
     ```
   - Esta suite (Playwright/Chromium) valida la carga en protocolo `file://`, la ausencia de errores en consola, la resolución de tokens CSS, el modo oscuro, la accesibilidad (WCAG 2.1 AA) y la integridad de iconos SVG.

---

## 2. 🏛️ Principio de Ingeniería: Reutilizar Infraestructura antes de Crear

El desarrollo en ZeroChat debe mantener un nivel de ingeniería profesional y evitar la proliferación desordenada de código:
- **Prohibido crear código redundante o "islas" desconectadas**: Antes de implementar una función, revisa los servicios, adaptadores, stores y helpers ya existentes en el repositorio.
- **Evitar la saturación de `js/app.js`**: `app.js` es únicamente el orquestador principal de arranque e inicialización. No debe inflarse con lógica de negocio específica, parsers, ni manipulación masiva de DOM que corresponda a submódulos.
- **Mantener el desacoplamiento mediante UMD**: Todos los módulos de `js/` deben seguir el patrón Factory/UMD para permitir ejecución isomórfica (tanto en el navegador bajo `file://` / `http://` como en Node.js para los tests unitarios).

---

## 3. 🧩 Estructuras Básicas a Respetar, Utilizar y Mantener

### A. Estado Global Reactivo (`ChatState` en `js/state.js`)
- **Única fuente de verdad**: Todo estado que deba compartirse, persistirse o sobrevivir al ciclo de vida de la interfaz debe residir en el store reactivo `ChatState`.
- **Slices canónicos**:
  - `config`: Preferencias y configuración del modelo, proveedor y flags.
  - `sessions`: ID activo y lista de conversaciones guardadas.
  - `messages`: Historial en memoria de la sesión activa.
  - `streaming`: Estado de generación (`isGenerating`, `status`, `error`).
  - `agent`: Turnos agénticos y herramienta en ejecución.
  - `telemetry`: Métricas de tokens, diagnósticos de contexto y latencia.
  - `ui`: Estados de paneles modales, drawers y menús.
- **Prohibido el estado volátil no controlado**: NUNCA uses variables globales de clausura en módulos o en `app.js` para retener datos de sesión o telemetría que provoquen fugas de estado entre conversaciones.

### B. Sistema Multidioma y Localización (`ChatI18n` en `js/i18n.js`)
- **Cero texto hardcodeado en la UI**: Ninguna etiqueta, botón, placeholder o mensaje visible al usuario debe escribirse directamente en texto plano en HTML o JS.
- **HTML Declarativo**: Usa atributos `data-i18n="clave"`, `data-i18n-title="clave"` o `data-i18n-placeholder="clave"`.
- **Lógica JavaScript**: Usa `ChatI18n.t('clave', { params })`.
- **Paridad estricta**: Si agregas o modificas una clave de traducción, debes actualizar **simultáneamente** los diccionarios `es` y `en` en `js/i18n.js`.

### C. Arquitectura Modular de UI (`ChatUI*` / `js/ui-*.js`)
- Cada subsistema visual debe tener su propio módulo desacoplado (ej: `ui-reasoning.js`, `ui-sidebar.js`, `ui-settings.js`, `ui-inspector.js`, `ui-telemetry.js`, `tool-cards.js`).
- **Renderizado Eficiente (Lazy Rendering)**: Evitar mutaciones masivas del DOM durante el streaming de tokens. Los componentes pesados (como modales y popovers) deben actualizarse bajo demanda al abrirse o al completarse la inferencia.

### D. Contrato Declarativo de Herramientas Agénticas (`js/tools/`)
- Cada tool vive en `js/tools/builtin/<nombre>.tool.js`.
- Debe cumplir estrictamente el contrato declarativo:
  - `definition`: Nombre, descripción y JSON Schema para Function Calling.
  - `settings`: Descriptor de habilitación y configuración.
  - `execute(args, context)`: Lógica de ejecución; consume dependencias mediante `context.services` (inyección de dependencias para testeo).
  - `result`: Adaptadores `toModel` y `toMarkdown`.
  - `view`: Tarjetas en el chat (`createLiveCard`, `updateLiveCard`, `renderHistoricalCard`).
- NUNCA uses propiedades obsoletas como `ui` o `handler`.

### E. Adaptadores de Proveedores (`js/providers.js`)
- Todos los proveedores de IA extienden `BaseProviderAdapter`.
- Gestionan diferencias de protocolo (OpenAI, Anthropic SSE, Ollama, Gemini, OpenRouter) en:
  - Normalización de endpoints y listing de modelos.
  - Streaming SSE y deltas de texto, pensamiento (`reasoningChunk`), tool calls y uso de tokens (`usage`).
  - Cache de contexto (Prompt / KV Caching) y opciones de streaming.

### F. Persistencia y Almacenamiento Local (`ZeroChatDB` en `js/storage-db.js`)
- Almacenamiento centralizado en IndexedDB con esquema relacional ligero (conversaciones, mensajes, chunks de conocimiento, imágenes extraídas).
- Mantiene aislados los adjuntos pesados (imágenes Base64) del árbol de mensajes para optimizar lecturas rápidas.

### G. Sistema de Diseño, CSS Tokens e Iconografía Vectorial
- **CSS Tokens nativos**: Usa variables de `css/tokens.css` (`--bg-surface`, `--text-main`, `--primary`, `--radius-md`, etc.) y las variantes de Glassmorphism.
- **🚫 Prohibido el uso de emojis crudos como iconos en la UI**: En botones, badges, barras de navegación o acciones, usa **exclusivamente** iconos vectoriales SVG limpios (`<svg class="ui-icon">` o a través del catálogo `ChatIcons.get('nombre', size)` en `js/icons.js`). Los emojis solo son admisibles en texto explicativo o contenido de chat.
- **Estándares modernos de CSS y HTML**: Uso de `@starting-style` para animaciones, `field-sizing: content` para textareas y componentes semánticos `<dialog>`.

---

## 4. 🧪 Protocolo de Pruebas y Comandos de Verificación

Antes de dar cualquier cambio por completado:

| Comando | Propósito | Cuándo es obligatorio |
| :--- | :--- | :--- |
| `npm test` | Suite completa de pruebas unitarias en Node.js | Tras **cualquier** cambio en código fuente. |
| `npm run test:unit` | Suite rápida omitiendo tests de browser | Durante iteraciones rápidas de lógica pura. |
| `npm run test:browser` | Suite Playwright en Chromium real | **Obligatorio** si se modifica HTML, CSS o DOM. |
| `npm run build` | Compilación y minificación del bundle `zerochat.html` | **Obligatorio** como paso final de toda tarea. |

> [!CAUTION]
> **Tolerancia cero a fallos**: Todos los tests deben pasar exitosamente (cero tests fallidos, cero advertencias en consola). No se permite comentar ni saltarse pruebas para eludir errores. Si agregas un nuevo módulo, añade su correspondiente `tests/test_<modulo>.js`.

---

## 5. 🌿 Flujo de Git y Control de Versiones

1. **Rama de trabajo**: Todo desarrollo se efectúa sobre la rama **`dev`**.
2. **Convención de commits**: Usar formato **Conventional Commits**:
   - `feat: ...` — Nueva funcionalidad.
   - `fix: ...` — Corrección de bugs.
   - `refactor: ...` — Refactorización interna sin cambio funcional.
   - `docs: ...` — Documentación (`AGENTS.md`, `README.md`).
   - `test: ...` — Nuevas pruebas o mejoras en tests.
   - `chore: ...` — Tareas de build, dependencias o mantenimiento.
3. **Confirmación**: Asegurarse de que `zerochat.html` forma parte del commit para mantener el bundle sincronizado con el código fuente.
