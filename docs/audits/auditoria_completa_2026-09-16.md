# Informe de Auditoría Completa de Código (Full Audit)

- **Fecha de ejecución**: 16 de septiembre de 2026
- **Versión auditada**: 6.8.2 (rama `dev`)
- **Metodología**: Auditoría integral conforme al estándar establecido en [`docs/audits/AuditFull.md`](AuditFull.md) y las normas de desarrollo de [`AGENTS.md`](../../AGENTS.md).

---

## 1. Resumen Ejecutivo

Se ha realizado una auditoría exhaustiva y transversal sobre la totalidad de los subsistemas, módulos JavaScript, estilos CSS, plantillas HTML, suites de pruebas unitarias/integración/navegador, herramientas agénticas y documentación técnica del proyecto ZeroChat.

### Estado de partida (Línea base)
- **Suite de pruebas de Node.js**: 585 tests ejecutados a través de 9 suites principales. Resultado: **585 pasados, 0 fallidos**.
- **Suite de pruebas de navegador (Playwright/Chromium)**: 50 tests de navegador en entorno headless real. Resultado: **50 pasados, 0 fallidos**.
- **Generación del bundle distribuible**: `npm run build` genera con éxito el artefacto portable `zerochat.html` (398.3 KB con compresión Gzip Base64 Level 9 y reducción de peso del 75.7%).
- **Estado de Git**: Árbol de trabajo limpio en la rama `dev`.

### Balance de hallazgos
No se han detectado vulnerabilidades críticas de ejecución remota ni fugas globales de estado entre sesiones. Se identificaron **7 hallazgos** clasificados por severidad:
- **0 Críticos**
- **1 Alto** (Seguridad XSS / Inyección de atributos en renderizado de miniaturas de imágenes adjuntas en `ui-conversation.js`).
- **2 Medios** (Clave i18n ausente `app_description` que degrada el `<meta name="description">`; duplicación de `fetchWithTimeout` sin bloque `finally` en `web-browser.js` y `web-search.js`).
- **4 Bajos** (Doble escape HTML en inspector; código muerto CSS `.welcome-execution-btn`; alias heredados en `cookies.js`; dispersión de `escapeHtml`).

---

## 2. Evaluación por Áreas de Revisión

### 2.1 Infraestructura Obligatoria y Gobernanza

| Área | Requisito | Estado | Observaciones |
| :--- | :--- | :---: | :--- |
| **Estado compartido** | Exclusivamente `ChatState` y mutadores de dominio | **CUMPLE** | 9 slices canónicos validados en `validateSliceKey`. Mutaciones atómicas con `appendMessage`, `replaceConversation`, etc. Sin variables globales filtradas entre sesiones. |
| **Diálogos de usuario** | Exclusivamente `ChatDialogs`; cero APIs nativas | **CUMPLE** | Se verificó estáticamente la ausencia total de llamadas a `alert()`, `confirm()` y `prompt()` en `js/` e `index.html`. |
| **Texto de interfaz** | Claves bilingües simultáneas en `ChatI18n` | **PARCIAL** | 612 claves simétricas en `es` y `en`. Se detectó que `app_description` se invoca en `i18n.js:1504` pero no está definida en los diccionarios (Hallazgo 2). |
| **Adaptadores de IA** | Extensión estricta de `BaseProviderAdapter` | **CUMPLE** | Todos los adaptadores (`Claude`, `Gemini`, `Ollama`, `OpenRouter`, `Mirror`, `WebLLM`) heredan de `BaseProviderAdapter` y normalizan razonamiento, streaming y tools. |
| **Persistencia** | `ZeroChatDB` e IndexedDB aislado | **CUMPLE** | `storage-db.js` y `cookies.js` gestionan IndexedDB con fallback transparente y aislamiento de adjuntos binarios. |
| **Contrato de herramientas** | Contrato declarativo sin `ui` ni `handler` | **CUMPLE** | Validado por `test_tool_contract.js`. Ninguna herramienta usa propiedades obsoletas. |
| **Iconografía y controles** | `ChatIcons` vectoriales; sin emojis en controles | **CUMPLE** | 74 iconos en el catálogo, todos con referencias activas. Cero emojis crudos en botones o badges. |
| **Cancelabilidad** | `AbortSignal` y limpieza de timers | **CUMPLE** | Controladores `AbortController` y timeouts en red, sandbox y streaming. |

### 2.2 Límite de Contenido Externo y Seguridad HTML

- **Markdown y Sanitización**: `Markdown.sanitizeUrl` y `Markdown.sanitizeImageUrl` bloquean de forma terminante esquemas `javascript:`, `data:text/html`, `vbscript:` y ataques de escape de comillas en URLs de enlaces e imágenes.
- **CSP (Content Security Policy)**: Política estricta en `index.html` con `object-src 'none'`, `base-uri 'self'`, y workers limitados a `blob:`, `'self'`, `https://esm.run` y `https://cdn.jsdelivr.net`.
- **Separación de datos no confiables**: El inspector de modelos, el gestor de sesiones del sidebar y las tarjetas agénticas renderizan metadatos externos de forma segura con `escapeHtml` y `textContent`.
- **Excepción detectada**: En `js/ui-conversation.js`, las miniaturas de imágenes adjuntadas en mensajes de usuario interpolan `img.dataUrl` directamente en un template `innerHTML` sin pasar por `Markdown.sanitizeImageUrl` (Hallazgo 1).

### 2.3 Código Muerto y Recursos sin Consumidores

- **Selectores CSS**: De 533 clases CSS inspeccionadas, 521 están en uso activo y 11 son clases generadas dinámicamente (`mcp-status-*`, `status-*`, `debug-entry-*`). Solo `.welcome-execution-btn` en `css/layout.css` quedó sin consumidor (Hallazgo 5).
- **Iconos**: Los 74 iconos registrados en `ChatIcons` cuentan con llamadas activas.
- **IDs del DOM**: Los 134 identificadores en `index.html` están vinculados a controladores JS, selectores CSS o atributos de accesibilidad ARIA (`aria-labelledby`).
- **Temporizadores**: No existen temporizadores descontrolados. Los 3 `setInterval` existentes en el proyecto (`ui-generation-status.js` y `ui-mcp.js`) disponen de rutinas explícitas de cancelación en `render` y `destroy`.

### 2.4 Duplicación y Deuda Técnica

- Se observó la reimplementación redundante de `fetchWithTimeout` en `web-browser.js` y `web-search.js`, omitiendo el bloque `finally` que sí implementa `ChatUtils.fetchWithTimeout` (Hallazgo 3).
- Múltiples módulos implementan utilidades locales de `escapeHtml` en lugar de referenciar la utilidad centralizada de `ChatUtils` (Hallazgo 7).

### 2.5 Documentación y Colocación (Colocation)

- Cumplimiento estricto de la política de colocación de `AGENTS.md`. No existen archivos `.md` sueltos en carpetas genéricas ni en la raíz (salvo `AGENTS.md`, `README.md` y avisos legales).
- Los subsistemas `tests/`, `js/tools/`, `scripts/mcp/` y `bundle-profiles/` contienen su correspondiente `README.md`.
- El centro de ayuda online (`help/`) cuenta con 12 artículos completos y sincronizados de forma bilingüe (`help/` en español y `help/en/` en inglés), con cero enlaces rotos.

---

## 3. Registro Detallado de Hallazgos

### Hallazgo 1: Sanitización ausente de `img.dataUrl` en miniaturas de conversación
- **Severidad**: **Alta**
- **Riesgo**: Seguridad (Inyección de atributos / XSS).
- **Evidencia**: `js/ui-conversation.js`, líneas 293–301:
  ```javascript
  const safeName = Markdown?.escapeHtml ? Markdown.escapeHtml(img.name || '') : (img.name || '');
  itemDiv.innerHTML = `
    <img src="${img.dataUrl}" alt="${safeName}" class="message-image-thumb" title="${safeName}">
    <div class="message-image-caption">${safeName}</div>
  `;
  const imgEl = itemDiv.querySelector('img');
  if (imgEl) {
    imgEl.addEventListener('click', () => {
      if (typeof window !== 'undefined') window.open(img.dataUrl, '_blank');
    });
  }
  ```
- **Descripción**: Si un payload de mensaje manipulado (por ejemplo, importado mediante exportación JSON o devuelto por un conector no confiable) contiene un `dataUrl` con comillas o esquemas peligrosos (`x" onerror="alert(1)"`), se inyectan atributos arbitrarios en el elemento `img`. Adicionalmente, `window.open(img.dataUrl, '_blank')` invocaría la URL sin validar el protocolo.
- **Solución propuesta**:
  1. Validar y sanitizar `img.dataUrl` mediante `Markdown.sanitizeImageUrl(img.dataUrl)`. Si no es válida o está vacía, no renderizar la miniatura o asignar un marcador neutro.
  2. Construir los elementos con APIs del DOM (`doc.createElement('img')`) o asignar `imgEl.src = safeDataUrl` para garantizar que no haya escape de comillas en `innerHTML`.
  3. Comprobar que `window.open` solo se ejecute sobre esquemas seguros (`data:image/`, `blob:`, `https://`).
- **Prueba de verificación**: Test unitario en `tests/unit/test_ui_conversation.js` o `tests/integration/test_security.js` que inyecte un payload con comillas y atributos `onerror`, validando que no se creen nodos ni se ejecuten scripts.

---

### Hallazgo 2: Clave i18n ausente `app_description` en `js/i18n.js`
- **Severidad**: **Media**
- **Riesgo**: Presentación / SEO / Corrección de metadatos.
- **Evidencia**: `js/i18n.js`, línea 1504:
  ```javascript
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    metaDesc.setAttribute('content', t('app_description'));
  }
  ```
  La clave `app_description` no existe en `TRANSLATIONS.es` ni en `TRANSLATIONS.en`.
- **Descripción**: Al iniciar la aplicación o cambiar de idioma, `t('app_description')` retorna el nombre literal de la clave (`"app_description"`), sustituyendo la descripción real definida en `index.html`.
- **Solución propuesta**:
  Añadir las definiciones bilingües a `TRANSLATIONS`:
  - `es`: `"ZeroChat - Cliente web universal, agente IA autónomo y RAG local en un solo archivo con cero instalación"`
  - `en`: `"ZeroChat - Universal web chat client, autonomous AI agent, and local RAG in a single zero-install file"`
- **Prueba de verificación**: Prueba en `tests/unit/test_i18n.js` que certifique que `t('app_description')` retorna texto no vacío y con significado en ambos idiomas.

---

### Hallazgo 3: Duplicación de `fetchWithTimeout` en `web-browser.js` y `web-search.js`
- **Severidad**: **Media**
- **Riesgo**: Deuda técnica y consistencia en cancelación.
- **Evidencia**:
  - `js/web-browser.js` (líneas 59–74)
  - `js/web-search.js` (líneas 23–38)
  - `js/utils.js` (líneas 93–105)
- **Descripción**: Ambos módulos duplican la implementación de `fetchWithTimeout`. Además, las copias en `web-browser` y `web-search` realizan `clearTimeout(timer)` de forma manual tanto en `try` como en `catch`, mientras que `ChatUtils.fetchWithTimeout` utiliza un bloque `finally { clearTimeout(timer); }`, garantizando la limpieza incluso ante excepciones no capturadas.
- **Solución propuesta**:
  Hacer que `web-browser.js` y `web-search.js` consuman `ChatUtils.fetchWithTimeout` mediante resolución dinámica con fallback.
- **Prueba de verificación**: `tests/unit/test_web_tools.js` y `tests/integration/test_security.js`.

---

### Hallazgo 4: Doble escape HTML en el inspector de proveedores
- **Severidad**: **Baja**
- **Riesgo**: Presentación visual.
- **Evidencia**: `js/ui-inspector.js`, líneas 685 y 705:
  ```javascript
  const modelInfoText = m.totalDiscovered > 0
    ? ...
    : (m.selected ? (t('inspector_model_selected', { model: escapeHtml(m.selected) }) || `Modelo: ${escapeHtml(m.selected)}`) : ...);
  ...
  <span class="meta-value">${escapeHtml(modelInfoText)}</span>
  ```
- **Descripción**: `escapeHtml(m.selected)` se introduce en la plantilla de traducción, y posteriormente todo el bloque `modelInfoText` vuelve a ser escapado con `escapeHtml(modelInfoText)`, lo que provoca doble escape (`&amp;amp;`) si el nombre del modelo contiene caracteres reservados.
- **Solución propuesta**:
  Evitar el primer escape al formatear el parámetro del texto o no re-escapar `modelInfoText`.
- **Prueba de verificación**: Test unitario en `tests/unit/test_ui_inspector.js` con nombre de modelo `Qwen & Test`.

---

### Hallazgo 5: Selector CSS sin uso `.welcome-execution-btn`
- **Severidad**: **Baja**
- **Riesgo**: Código muerto residual.
- **Evidencia**: `css/layout.css`, líneas 92 y 107.
- **Descripción**: Clase CSS que formaba parte de una versión anterior del botón de ejecución de la bienvenida; actualmente solo se utiliza `.welcome-help-link`.
- **Solución propuesta**:
  Eliminar la regla `.welcome-execution-btn` de `css/layout.css`.
- **Prueba de verificación**: `npm run test:browser` para verificar estabilidad visual.

---

### Hallazgo 6: Alias obsoletos sin uso en `js/cookies.js` (`setCookie`, `getCookie`, `deleteCookie`)
- **Severidad**: **Baja**
- **Riesgo**: Deuda técnica / Código no utilizado.
- **Evidencia**: `js/cookies.js`, líneas 585–587.
- **Descripción**: Exportación de alias obsoletos de la época en que el módulo se llamaba `ChatCookies`. No existen llamadas en el proyecto.
- **Solución propuesta**:
  Retirar los alias del contrato de retorno de `ChatStorage` o marcarlos formalmente con comentario `@deprecated` si se desea preservar compatibilidad en la consola de depuración.
- **Prueba de verificación**: `npm test`.

---

### Hallazgo 7: Dispersión en implementaciones locales de `escapeHtml`
- **Severidad**: **Baja**
- **Riesgo**: Deuda técnica / Inconsistencia menor.
- **Evidencia**: `charts.js:30`, `markdown.js:29`, `rag-ui.js:26`, `ui-inspector.js:39`, `ui-settings.js:34`, `ui-sidebar.js:30`.
- **Descripción**: Cada módulo declara su propia variante de `escapeHtml` (algunas usan `&#39;` y otras `&#039;`) en lugar de delegar prioritariamente en `ChatUtils.escapeHtml`.
- **Solución propuesta**:
  Estandarizar en todos los módulos la delegación en `ChatUtils.escapeHtml` cuando esté disponible en el entorno de ejecución.
- **Prueba de verificación**: `npm run test:unit`.

---

## 4. Plan de Acción y Prioridades

Para solventar estos hallazgos preservando la estabilidad del proyecto y respetando la política de cambios pequeños e independientes de `AGENTS.md`, se define la siguiente secuencia de intervenciones:

```
[Fase 1: Seguridad y Correctitud]
├── 1. Sanitizar img.dataUrl y estructuración DOM en ui-conversation.js (Hallazgo 1)
└── 2. Añadir clave app_description en i18n.js (es y en) (Hallazgo 2)

[Fase 2: Unificación y Limpieza]
├── 3. Centralizar fetchWithTimeout hacia ChatUtils en web-browser y web-search (Hallazgo 3)
├── 4. Corregir doble escape en ui-inspector.js (Hallazgo 4)
└── 5. Eliminar clase CSS muerta .welcome-execution-btn en layout.css (Hallazgo 5)

[Fase 3: Refactor Menor y Consistencia]
├── 6. Deprecar o sanear alias obsoletos en cookies.js (Hallazgo 6)
└── 7. Estandarizar delegación a ChatUtils.escapeHtml (Hallazgo 7)
```

---

## 5. Conclusión de la Auditoría

El proyecto **ZeroChat (v6.8.2)** demuestra un estándar sobresaliente de arquitectura, robustez en sus pruebas automatizadas y estricta adherencia a sus principios rectores (UMD, IndexedDB, separación de slices canónicos en `ChatState`, sanitización de markdown y cero emojis en controles).

Los hallazgos identificados están claramente localizados, no comprometen la integridad estructural del producto y cuentan con planes de mitigación y verificación automatizable listos para su ejecución.

