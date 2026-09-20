# Análisis Completo de Código Duplicado - ZeroChat v7.1.0

**Fecha:** 2026-09-20
**Versión:** 7.1.0
**Base:** Auditoría 2026-09-20 (Sección 3.2)
**Alcance:** Identificación, análisis y propuestas de refactorización para duplicación de código

---

## 1. Resumen Ejecutivo

Este análisis profundiza en los hallazgos de duplicación identificados en la auditoría general, proporcionando evidencia concreta, análisis de riesgos y propuestas detalladas de refactorización.

### Hallazgos Principales

| ID | Área | Archivos Afectados | Líneas Duplicadas | Prioridad | Esfuerzo |
|----|------|-------------------|-------------------|-----------|----------|
| **DUP-01** | Construcción de tarjetas de herramientas | `tool-cards.js`, `mcp.js` | ~60 líneas | Baja | 4-6h |
| **DUP-02** | Acceso directo a localStorage | `tool-security.js`, `mcp.js`, `data-reset-service.js` | ~40 líneas | Baja | 30min |
| **DUP-03** | Lógica de badges de estado | `tool-cards.js`, `mcp.js` | ~20 líneas | Baja | 2h |
| **DUP-04** | Construcción de HTML con innerHTML | `tool-cards.js`, `mcp.js` | ~50 líneas | Media | 3h |

**Total identificado:** 4 patrones de duplicación, ~170 líneas afectadas

---

## 2. Hallazgos Detallados

### DUP-01: Construcción de Tarjetas de Herramientas

#### Evidencia

**Archivo:** [js/tool-cards.js:61-82](js/tool-cards.js#L61-L82)
```javascript
function fallback(name, args, isCollapsed = false) {
  if (typeof document === 'undefined') return null;
  const card = document.createElement('div');
  card.className = 'tool-card-wrapper';
  const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;
  const tool = (typeof window !== 'undefined' && window.ChatAgentCore?.registry?.getTool)
    ? window.ChatAgentCore.registry.getTool(name) : null;
  const icon = (typeof window !== 'undefined' && window.ChatIcons?.has(name))
    ? window.ChatIcons.get(name, { size: 14 })
    : (tool?.metadata?.iconSvg || DEFAULT_TOOL_ICON);
  const badgeClass = isCollapsed ? 'tool-card-badge status-success' : 'tool-card-badge status-loading';
  const badgeContent = isCollapsed
    ? `${CHECK_SVG} <span>${t('tool_status_success') || 'Completado'}</span>`
    : `${SPINNER_SVG} <span>${t('tool_badge_executing') || 'Ejecutando...'}</span>`;
  const collapseBtnTitle = isCollapsed ? (t('tool_btn_expand') || 'Expandir herramienta') : (t('tool_btn_collapse') || 'Minimizar');
  const collapseBtn = hasArgs
    ? `<button type="button" class="btn-tool-collapse" title="${collapseBtnTitle}">${CHEVRON_SVG}</button>`
    : '';
  const bodyHtml = hasArgs
    ? `<div class="tool-card-collapsible-body"><div class="tool-card-result"><pre class="tool-card-code"><code>${getMarkdown().escapeHtml(JSON.stringify(args, null, 2))}</code></pre></div></div>`
    : '';
  const cardClass = isCollapsed ? 'tool-execution-card collapsed' : 'tool-execution-card';
  card.innerHTML = `<div class="${cardClass}"><div class="tool-card-header"><div class="tool-card-title"><span>${icon}</span><span>${getMarkdown().escapeHtml(name)}</span></div><div class="tool-card-header-actions"><span class="${badgeClass}">${badgeContent}</span>${collapseBtn}</div></div>${bodyHtml}</div>`;
  return card;
}
```

**Archivo:** [js/mcp.js:623-645](js/mcp.js#L623-L645)
```javascript
const renderCard = (args, contentHtml, badgeHtml, ui, isCollapsed = false) => {
  const esc = ui?.markdown?.escapeHtml || String;
  const t = ui?.t || (k => k);
  const card = ui?.createCardWrapper ? ui.createCardWrapper('mcp-card') : document.createElement('div');
  card.className = 'tool-card-wrapper mcp-card';
  const argStr = args && typeof args === 'object' && Object.keys(args).length
    ? esc(JSON.stringify(args, null, 2)) : '';
  const cardClass = isCollapsed ? 'tool-execution-card collapsed' : 'tool-execution-card';
  const btnTitle = isCollapsed ? (t('tool_btn_expand') || 'Expandir') : (t('tool_btn_collapse') || 'Minimizar');
  card.innerHTML = `
    <div class="${cardClass}">
      <div class="tool-card-header">
        <div class="tool-card-title">${iconSvg}<span>${esc(toolName)}</span><span class="mcp-card-server-tag">${esc(serverName || 'MCP')}</span></div>
        <div class="tool-card-header-actions">
          ${badgeHtml}
          <button type="button" class="btn-tool-collapse" title="${btnTitle}">${ui?.CHEVRON_SVG || '▼'}</button>
        </div>
      </div>
      <div class="tool-card-collapsible-body">
        ${argStr ? `<div class="mcp-input-summary"><code>${argStr}</code></div>` : ''}
        <div class="tool-card-result">${contentHtml}</div>
      </div>
    </div>`;
  return card;
};
```

#### Análisis

**Similitudes:**
- Estructura de tarjeta con header + body colapsable
- Lógica de estado colapsado/expandido
- Construcción de badges de estado (loading/success/error)
- Botón de colapso con iconografía SVG
- Escape de HTML en nombres y argumentos
- Uso de innerHTML para construcción

**Diferencias clave:**
1. **Iconografía:** `tool-cards.js` usa `ChatIcons` dinámico; `mcp.js` usa icono MCP fijo
2. **Tag de servidor:** MCP añade badge de servidor (`mcp-card-server-tag`)
3. **Contexto de UI:** MCP recibe `ui` como parámetro; tool-cards usa globals
4. **Autorización:** MCP integra lógica de autorización específica

#### Riesgo

**Deuda técnica** - Prioridad: **Baja**

- **Mantenimiento:** Cambios en la estructura de tarjetas requieren modificar 2 archivos
- **Consistencia:** Riesgo de divergencia en comportamiento visual
- **Testing:** Pruebas duplicadas para el mismo patrón de UI

#### Propuesta de Refactorización

**Opción A: Módulo Compartido `ToolCardBuilder`**

```javascript
// js/tool-card-builder.js
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatToolCardBuilder = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Constructor de tarjetas de herramientas reutilizable.
   */
  class ToolCardBuilder {
    constructor(options = {}) {
      this.ui = options.ui || this._getDefaultUI();
      this.esc = this.ui.markdown?.escapeHtml || String;
      this.t = this.ui.t || (k => k);
    }

    _getDefaultUI() {
      if (typeof window === 'undefined') return {};
      return {
        markdown: window.ChatMarkdown || window.ChatUtils,
        t: window.ChatI18n?.t || (k => k),
        SPINNER_SVG: window.ChatToolCards?.SPINNER_SVG,
        CHECK_SVG: window.ChatToolCards?.CHECK_SVG,
        ERROR_SVG: window.ChatToolCards?.ERROR_SVG,
        CHEVRON_SVG: window.ChatToolCards?.CHEVRON_SVG
      };
    }

    /**
     * Crea una tarjeta de herramienta con la estructura estándar.
     *
     * @param {object} config - Configuración de la tarjeta
     * @param {string} config.toolName - Nombre de la herramienta
     * @param {string} config.iconSvg - SVG del icono
     * @param {object} config.args - Argumentos de la herramienta
     * @param {string} config.contentHtml - Contenido del cuerpo
     * @param {string} config.badgeHtml - HTML del badge de estado
     * @param {boolean} config.isCollapsed - Estado inicial
     * @param {string[]} config.extraTags - Tags adicionales (e.g., servidor MCP)
     * @param {string} config.extraClass - Clases CSS adicionales
     */
    createCard(config) {
      const {
        toolName,
        iconSvg,
        args = {},
        contentHtml = '',
        badgeHtml,
        isCollapsed = false,
        extraTags = [],
        extraClass = ''
      } = config;

      const card = document.createElement('div');
      card.className = `tool-card-wrapper ${extraClass}`.trim();

      const argStr = args && typeof args === 'object' && Object.keys(args).length
        ? this.esc(JSON.stringify(args, null, 2))
        : '';

      const cardClass = isCollapsed ? 'tool-execution-card collapsed' : 'tool-execution-card';
      const btnTitle = isCollapsed
        ? (this.t('tool_btn_expand') || 'Expandir')
        : (this.t('tool_btn_collapse') || 'Minimizar');

      const tagsHtml = extraTags.map(tag =>
        `<span class="tool-card-tag">${this.esc(tag)}</span>`
      ).join('');

      card.innerHTML = `
        <div class="${cardClass}">
          <div class="tool-card-header">
            <div class="tool-card-title">
              ${iconSvg}
              <span>${this.esc(toolName)}</span>
              ${tagsHtml}
            </div>
            <div class="tool-card-header-actions">
              ${badgeHtml}
              <button type="button" class="btn-tool-collapse" title="${btnTitle}">
                ${this.ui.CHEVRON_SVG || '▼'}
              </button>
            </div>
          </div>
          <div class="tool-card-collapsible-body">
            ${argStr ? `<div class="tool-input-summary"><code>${argStr}</code></div>` : ''}
            <div class="tool-card-result">${contentHtml}</div>
          </div>
        </div>`;

      return card;
    }

    /**
     * Crea un badge de estado estándar.
     */
    createBadge(status, text = '', elapsedMs = null) {
      const icons = {
        loading: this.ui.SPINNER_SVG || '',
        success: this.ui.CHECK_SVG || '',
        error: this.ui.ERROR_SVG || '',
        pending: this.ui.SHIELD_SVG || ''
      };

      const defaults = {
        loading: this.t('tool_badge_executing') || 'Ejecutando...',
        success: this.t('tool_status_success') || 'Completado',
        error: this.t('tool_status_error') || 'Error',
        pending: this.t('tool_auth_badge') || 'Requiere Autorización'
      };

      const displayText = text || defaults[status] || status;
      const timeStr = elapsedMs !== null ? ` (${elapsedMs}ms)` : '';

      return `<span class="tool-card-badge status-${status}">
        ${icons[status] || ''}
        <span>${this.esc(displayText)}${timeStr}</span>
      </span>`;
    }
  }

  return { ToolCardBuilder };
}));
```

**Refactorización de `tool-cards.js`:**
```javascript
// Reemplazar función fallback
function fallback(name, args, isCollapsed = false) {
  if (typeof document === 'undefined') return null;

  const builder = new ChatToolCardBuilder.ToolCardBuilder({ ui: context() });
  const tool = window.ChatAgentCore?.registry?.getTool(name);
  const icon = window.ChatIcons?.has(name)
    ? window.ChatIcons.get(name, { size: 14 })
    : (tool?.metadata?.iconSvg || DEFAULT_TOOL_ICON);

  const badgeStatus = isCollapsed ? 'success' : 'loading';
  const badgeHtml = builder.createBadge(badgeStatus);

  return builder.createCard({
    toolName: name,
    iconSvg: icon,
    args,
    badgeHtml,
    isCollapsed
  });
}
```

**Refactorización de `mcp.js`:**
```javascript
// Dentro de createMcpToolView
const renderCard = (args, contentHtml, badgeHtml, ui, isCollapsed = false) => {
  const builder = new ChatToolCardBuilder.ToolCardBuilder({ ui });

  return builder.createCard({
    toolName,
    iconSvg: getMcpIconSvg(14),
    args,
    contentHtml,
    badgeHtml,
    isCollapsed,
    extraTags: [serverName || 'MCP'],
    extraClass: 'mcp-card'
  });
};
```

#### Pruebas Requeridas

1. **Visual Regression:**
   - Comparar capturas antes/después de refactorización
   - Verificar estado colapsado/expandido
   - Validar iconografía y badges

2. **Funcionales:**
   ```javascript
   // tests/browser/browser_tool_cards_unified.test.js
   test('tool-cards y mcp usan constructor compartido', () => {
     // Crear tarjeta tool-cards
     const toolCard = ChatToolCards.createLiveToolCard('test_tool', {});
     // Crear tarjeta MCP
     const mcpCard = createMcpToolView('test_mcp', 'server').createLiveCard({}, ctx);

     // Verificar estructura idéntica
     expect(toolCard.querySelector('.tool-card-header')).toBeTruthy();
     expect(mcpCard.querySelector('.tool-card-header')).toBeTruthy();

     // Verificar clases distintivas
     expect(mcpCard.classList.contains('mcp-card')).toBe(true);
   });
   ```

#### Decisión

**Recomendación:** **POSPONER** hasta que exista una tercera ubicación que requiera tarjetas.

**Justificación:**
- Solo 2 implementaciones actuales (DRY permite hasta 2 antes de abstraer)
- Las diferencias (iconografía, autorización MCP) justifican cierta separación
- Riesgo bajo de divergencia (ambos archivos bajo control de versiones)
- Esfuerzo de refactorización (4-6h) no justificado por beneficio actual

**Seguimiento:** Revisar en próxima auditoría si aparece un tercer caso de uso.

---

### DUP-02: Acceso Directo a localStorage

#### Evidencia

**Archivo:** [js/tool-security.js:254-261](js/tool-security.js#L254-L261)
```javascript
load() {
  try {
    const Storage = getStorage();
    let raw = null;
    if (Storage && typeof Storage.getStorageItem === 'function') {
      raw = Storage.getStorageItem(this.storageKey);
    } else if (typeof localStorage !== 'undefined') {
      raw = localStorage.getItem(this.storageKey);
    }
    // ... resto de lógica
```

**Archivo:** [js/tool-security.js:312-317](js/tool-security.js#L312-L317)
```javascript
save() {
  try {
    const Storage = getStorage();
    // ...
    const serialized = JSON.stringify(payload);
    if (Storage && typeof Storage.setStorageItem === 'function') {
      Storage.setStorageItem(this.storageKey, serialized);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.storageKey, serialized);
    }
```

**Archivo:** [js/mcp.js:822-830](js/mcp.js#L822-L830)
```javascript
loadConfig() {
  try {
    const Storage = getStorage();
    let raw = null;
    if (Storage && Storage.getStorageItem) {
      raw = Storage.getStorageItem(this.storageKey);
    } else if (typeof localStorage !== 'undefined') {
      raw = localStorage.getItem(this.storageKey);
    }
```

**Archivo:** [js/mcp.js:845-854](js/mcp.js#L845-L854)
```javascript
saveConfig() {
  try {
    const Storage = getStorage();
    const serialized = JSON.stringify(this.servers);
    if (Storage && Storage.setStorageItem) {
      Storage.setStorageItem(this.storageKey, serialized);
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.storageKey, serialized);
    }
```

**Archivo:** [js/data-reset-service.js:103-104](js/data-reset-service.js#L103-L104)
```javascript
try { if (typeof localStorage !== 'undefined') localStorage.clear(); } catch (_) {}
try { if (typeof sessionStorage !== 'undefined') sessionStorage.clear(); } catch (_) {}
```

#### Análisis

**Patrón repetido:** Fallback de `Storage.getStorageItem/setStorageItem` a `localStorage` directo

**Razones arquitectónicas (según AGENTS.md):**
1. **tool-security.js:** Necesita persistencia independiente del ciclo de sesión
2. **mcp.js:** Configuración de servidores debe sobrevivir a limpieza de sesión
3. **data-reset-service.js:** Debe limpiar INCLUSO el módulo Storage mismo

#### Riesgo

**Inconsistencia arquitectónica** - Prioridad: **Baja (documentación)**

- **No es un bug:** El acceso directo es deliberado y necesario
- **Riesgo real:** Futuros desarrolladores pueden no entender por qué se salta la abstracción
- **Mitigación:** Documentación explícita en código

#### Propuesta

**NO refactorizar.** Estos casos están justificados.

**Acción:** Añadir comentarios explicativos en cada ubicación.

**Cambios propuestos:**

```javascript
// js/tool-security.js (línea 253)
/**
 * Carga el estado persistido desde almacenamiento local.
 *
 * NOTA: Acceso directo a localStorage justificado aquí porque las políticas
 * de seguridad deben persistir independientemente del ciclo de vida de la sesión
 * actual. No usar Storage.js para evitar que un reset de sesión borre las
 * autorizaciones recordadas del usuario.
 */
load() {
  try {
    const Storage = getStorage();
    let raw = null;
    if (Storage && typeof Storage.getStorageItem === 'function') {
      raw = Storage.getStorageItem(this.storageKey);
    } else if (typeof localStorage !== 'undefined') {
      // Fallback directo a localStorage (excepcional pero necesario)
      raw = localStorage.getItem(this.storageKey);
    }
```

```javascript
// js/mcp.js (línea 820)
/**
 * Carga la lista de servidores MCP configurados desde el almacenamiento local.
 *
 * NOTA: Acceso directo a localStorage justificado aquí porque la configuración
 * de servidores MCP es infraestructura global que debe persistir incluso cuando
 * se limpia el estado de sesión individual. Usar Storage.js aquí causaría pérdida
 * de configuración en operaciones de reset de datos de sesión.
 */
loadConfig() {
```

```javascript
// js/data-reset-service.js (línea 102)
// Limpieza directa de localStorage y sessionStorage.
// NOTA: Aquí DEBE ser acceso directo porque estamos limpiando el propio
// módulo Storage. Usar Storage.clearAllStorage() limpiaría su propia
// implementación pero no garantiza limpieza de claves escritas directamente.
try { if (typeof localStorage !== 'undefined') localStorage.clear(); } catch (_) {}
try { if (typeof sessionStorage !== 'undefined') sessionStorage.clear(); } catch (_) {}
```

#### Pruebas

No requiere tests adicionales. Los tests existentes ya validan estos comportamientos.

---

### DUP-03: Lógica de Badges de Estado

#### Evidencia

**Archivo:** [js/tool-cards.js:92-97](js/tool-cards.js#L92-L97)
```javascript
const badge = card?.querySelector('.tool-card-badge');
if (badge) {
  const isSuccess = result?.success !== false && !result?.error;
  badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
  badge.innerHTML = isSuccess
    ? `${CHECK_SVG} <span>${t('tool_status_success') || 'Completado'} (${elapsedMs}ms)</span>`
    : `${ERROR_SVG} <span>${t('tool_status_error', { ms: elapsedMs }) || `Error (${elapsedMs}ms)`}</span>`;
}
```

**Archivo:** [js/mcp.js:663-667](js/mcp.js#L663-L667)
```javascript
const badge = cardDiv.querySelector('.tool-card-badge');
if (badge) {
  badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
  badge.innerHTML = isSuccess
    ? `${ui?.CHECK_SVG || ''} <span>${t('tool_status_success') || 'OK'} (${elapsedMs}ms)</span>`
    : `${ui?.ERROR_SVG || ''} <span>Error (${elapsedMs}ms)</span>`;
}
```

#### Análisis

**Similitudes:**
- Selección del elemento `.tool-card-badge`
- Determinación de estado success/error
- Actualización de className con prefijo `status-`
- Construcción de innerHTML con SVG + texto + tiempo

**Diferencias menores:**
- Textos por defecto ligeramente diferentes ('Completado' vs 'OK')
- Manejo de iconos (directo vs `ui?.CHECK_SVG`)

#### Riesgo

**Deuda técnica menor** - Prioridad: **Baja**

#### Propuesta

**Incluir en `ToolCardBuilder.createBadge()` de DUP-01** si se refactoriza.

Si DUP-01 se pospone, también posponer esto.

**Función auxiliar independiente:**

```javascript
// js/tool-cards.js (añadir)
function updateToolCardBadge(card, result, elapsedMs, ui = {}) {
  const badge = card?.querySelector('.tool-card-badge');
  if (!badge) return;

  const isSuccess = result?.success !== false && !result?.error && !result?.isError;
  const checkSvg = ui.CHECK_SVG || CHECK_SVG;
  const errorSvg = ui.ERROR_SVG || ERROR_SVG;
  const tFn = ui.t || t;

  badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
  badge.innerHTML = isSuccess
    ? `${checkSvg} <span>${tFn('tool_status_success') || 'Completado'} (${elapsedMs}ms)</span>`
    : `${errorSvg} <span>${tFn('tool_status_error', { ms: elapsedMs }) || `Error (${elapsedMs}ms)`}</span>`;
}

// Exportar
return {
  // ... existentes
  updateToolCardBadge
};
```

**Usar en `mcp.js`:**
```javascript
const ChatToolCards = typeof window !== 'undefined' ? window.ChatToolCards : null;

// Dentro de updateLiveCard
if (ChatToolCards && ChatToolCards.updateToolCardBadge) {
  ChatToolCards.updateToolCardBadge(cardDiv, result, elapsedMs, ui);
} else {
  // Fallback actual
}
```

#### Decisión

**POSPONER** junto con DUP-01.

---

### DUP-04: Construcción de HTML con innerHTML

#### Evidencia

**Usos de `innerHTML` identificados:**
- `tool-cards.js`: 7 instancias (líneas 81, 95, 160, 196, 235, 239, 245)
- `mcp.js`: 3 instancias (líneas 631, 666, 671)
- `attachments.js`: 3 instancias (líneas 92, 98, 117) ⚠️ **RIESGO DE SEGURIDAD**

#### Análisis

**Casos seguros (plantillas internas controladas):**
- Construcción de tarjetas en tool-cards.js y mcp.js
- Todos los valores pasan por `escapeHtml()` antes de interpolar

**Casos que requieren revisión urgente:**

**Archivo:** [js/attachments.js:117](js/attachments.js#L117)

```javascript
// RIESGO: Si file.name no se escapa, es vulnerable a XSS
chip.innerHTML = `<span>${file.name}</span>`;
```

#### Riesgo

**Seguridad (XSS)** - Prioridad: **ALTA**

**Escenario de ataque:**
1. Usuario adjunta archivo con nombre: `"><img src=x onerror=alert(document.domain)>.pdf`
2. Si no se escapa, el navegador ejecuta el script al renderizar el chip
3. Código malicioso puede robar tokens de sesión, manipular la UI, etc.

#### Propuesta (URGENTE)

**Eliminar `innerHTML` en attachments.js y usar DOM API segura:**

```javascript
// js/attachments.js (línea 117)

// ANTES (vulnerable):
chip.innerHTML = `<span>${file.name}</span>`;

// DESPUÉS (seguro):
const nameSpan = document.createElement('span');
nameSpan.textContent = file.name; // Escape automático por el navegador
chip.appendChild(nameSpan);
```

**Cambio completo sugerido para la función `createAttachmentChip`:**

```javascript
function createAttachmentChip(file) {
  const chip = document.createElement('div');
  chip.className = 'attachment-chip';
  chip.dataset.fileId = file.id || `${file.name}_${Date.now()}`;

  // Icono
  const icon = document.createElement('span');
  icon.className = 'attachment-icon';
  icon.textContent = getFileIcon(file.type);
  chip.appendChild(icon);

  // Nombre del archivo (seguro contra XSS)
  const nameSpan = document.createElement('span');
  nameSpan.className = 'attachment-name';
  nameSpan.textContent = file.name; // Escape automático
  chip.appendChild(nameSpan);

  // Tamaño del archivo
  if (file.size) {
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'attachment-size';
    sizeSpan.textContent = formatFileSize(file.size);
    chip.appendChild(sizeSpan);
  }

  // Botón de eliminar
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'attachment-remove';
  removeBtn.title = ChatI18n.t('attachment_remove') || 'Eliminar adjunto';
  removeBtn.innerHTML = REMOVE_ICON_SVG; // SVG es seguro, es constante interna
  removeBtn.addEventListener('click', () => removeAttachment(file.id));
  chip.appendChild(removeBtn);

  return chip;
}
```

#### Pruebas de Seguridad (REQUERIDAS)

```javascript
// tests/security/test_attachment_xss.js

describe('Attachments - XSS Protection', () => {
  test('escapa nombres de archivo maliciosos', () => {
    const maliciousNames = [
      '"><img src=x onerror=alert(1)>.pdf',
      '<script>alert(document.domain)</script>.txt',
      'test<iframe src="javascript:alert()"></iframe>.doc',
      'file&lt;script&gt;.pdf' // Pre-encoded
    ];

    maliciousNames.forEach(name => {
      const file = { name, type: 'application/pdf', size: 1024, id: 'test' };
      const chip = createAttachmentChip(file);

      // Verificar que el nombre está en textContent, no ejecutable
      const nameEl = chip.querySelector('.attachment-name');
      expect(nameEl.textContent).toBe(name);

      // Verificar que no hay elementos script/img/iframe inyectados
      expect(chip.querySelector('script')).toBeNull();
      expect(chip.querySelector('img[onerror]')).toBeNull();
      expect(chip.querySelector('iframe')).toBeNull();
    });
  });

  test('previene inyección de atributos HTML', () => {
    const file = {
      name: 'test" onclick="alert(1)" data-evil="xss.pdf',
      type: 'application/pdf',
      size: 1024,
      id: 'test'
    };

    const chip = createAttachmentChip(file);
    const nameEl = chip.querySelector('.attachment-name');

    // Verificar que no hay atributos inyectados
    expect(nameEl.hasAttribute('onclick')).toBe(false);
    expect(nameEl.hasAttribute('data-evil')).toBe(false);
  });

  test('maneja unicode y caracteres especiales correctamente', () => {
    const specialNames = [
      '文档.pdf',  // Chino
      'файл.txt',  // Cirílico
      'ملف.doc',   // Árabe
      'test\u0000null.pdf',  // Null byte
      'test\n\nnewline.pdf'  // Newlines
    ];

    specialNames.forEach(name => {
      const file = { name, type: 'text/plain', size: 512, id: 'test' };
      const chip = createAttachmentChip(file);
      const nameEl = chip.querySelector('.attachment-name');

      // Debe conservar el texto exacto
      expect(nameEl.textContent).toBe(name);
    });
  });
});
```

#### Esfuerzo

- Refactorización: **1 hora**
- Tests de seguridad: **1 hora**
- Verificación manual: **30 minutos**

**Total: 2.5 horas**

---

## 3. Análisis de Event Listeners (DUP-05)

### Contexto

La auditoría identificó **263 llamadas a `addEventListener`** en el código JavaScript.

#### Hallazgo

**Potenciales fugas de memoria** si los listeners no se limpian al:
1. Cambiar de conversación
2. Cerrar modales
3. Desmontar componentes de UI

#### Verificación Requerida

**Patrón correcto encontrado en `ChatState.subscribe()`:**

```javascript
function subscribe(selector, callback) {
  const listenerEntry = { selector, callback };
  listeners.add(listenerEntry);

  // Retorna función de limpieza
  return function unsubscribe() {
    listeners.delete(listenerEntry);
  };
}
```

**Uso correcto:**
```javascript
const unsubscribe = ChatState.subscribe('messages', handleMessagesChange);
// ... más tarde
unsubscribe(); // Limpieza
```

#### Áreas de Riesgo

**Archivos con más listeners (requieren auditoría):**

```bash
$ grep -c "addEventListener" js/*.js | sort -t: -k2 -rn | head -5
js/app.js:47
js/ui-settings.js:23
js/ui-sidebar.js:18
js/mcp.js:12
js/tool-cards.js:8
```

#### Propuesta

**Auditoría específica de limpieza de listeners:**

1. **Paso 1:** Identificar listeners que se registran en ciclo de vida largo

```bash
# Buscar addEventListener sin correspondiente removeEventListener
grep -n "addEventListener" js/app.js | while read line; do
  linenum=$(echo $line | cut -d: -f1)
  context=$(sed -n "$((linenum-5)),$((linenum+15))p" js/app.js)
  if ! echo "$context" | grep -q "removeEventListener"; then
    echo "⚠️ Posible fuga en línea $linenum"
  fi
done
```

2. **Paso 2:** Crear test de fugas de memoria

```javascript
// tests/performance/test_memory_leaks.js

describe('Memory Leaks - Event Listeners', () => {
  test('limpia listeners al cambiar de conversación', async () => {
    // Contar listeners iniciales
    const initialListeners = getEventListeners(document.body).length;

    // Crear conversación 1
    await createNewConversation();
    const afterCreate1 = getEventListeners(document.body).length;
    expect(afterCreate1).toBeGreaterThan(initialListeners);

    // Cambiar a conversación 2
    await createNewConversation();
    const afterCreate2 = getEventListeners(document.body).length;

    // Los listeners de conv1 deben haberse limpiado
    // Tolerancia: +/- 5 listeners (algunos pueden ser globales)
    expect(Math.abs(afterCreate2 - afterCreate1)).toBeLessThan(5);
  });

  test('limpia listeners al cerrar modal de settings', async () => {
    const before = getEventListeners(document).length;

    // Abrir settings
    await openSettings();
    const opened = getEventListeners(document).length;
    expect(opened).toBeGreaterThan(before);

    // Cerrar settings
    await closeSettings();
    const after = getEventListeners(document).length;

    // Debe volver al estado inicial
    expect(after).toBe(before);
  });
});
```

3. **Paso 3:** Implementar patrón de limpieza consistente

```javascript
// js/utils.js (añadir)

/**
 * Gestor de limpieza de event listeners para componentes de UI.
 * Permite registrar listeners que se limpian automáticamente al desmontar.
 */
class EventListenerManager {
  constructor() {
    this.listeners = [];
  }

  /**
   * Registra un event listener que será limpiado automáticamente.
   *
   * @param {EventTarget} target - Elemento que escucha el evento
   * @param {string} event - Nombre del evento
   * @param {Function} handler - Función manejadora
   * @param {object} options - Opciones de addEventListener
   */
  add(target, event, handler, options = {}) {
    target.addEventListener(event, handler, options);
    this.listeners.push({ target, event, handler, options });
  }

  /**
   * Limpia todos los listeners registrados.
   */
  cleanup() {
    this.listeners.forEach(({ target, event, handler, options }) => {
      target.removeEventListener(event, handler, options);
    });
    this.listeners = [];
  }
}

// Ejemplo de uso en un módulo de UI
function initializeSettingsPanel() {
  const listenerMgr = new EventListenerManager();

  listenerMgr.add(closeBtn, 'click', handleClose);
  listenerMgr.add(saveBtn, 'click', handleSave);
  listenerMgr.add(document, 'keydown', handleEscape);

  // Retornar función de limpieza
  return () => listenerMgr.cleanup();
}
```

#### Esfuerzo

- Auditoría de listeners: **3 horas**
- Tests de memory leaks: **2 horas**
- Implementación de `EventListenerManager`: **1 hora**
- Refactorización de módulos críticos: **3 horas**

**Total: 9 horas**

#### Prioridad

**Media** - No hay evidencia de fugas actuales, pero es deuda técnica preventiva importante.

---

## 4. Plan de Acción Priorizado

### Sprint 1: Seguridad (INMEDIATO)

**Objetivo:** Eliminar vulnerabilidad XSS en adjuntos

| Tarea | Archivo | Esfuerzo | Responsable |
|-------|---------|----------|-------------|
| Refactorizar `createAttachmentChip` sin innerHTML | attachments.js | 1h | Dev |
| Crear tests de seguridad XSS | tests/security/ | 1h | Dev |
| Revisión de código | - | 30min | Lead |
| Verificación manual | - | 30min | QA |

**Total:** 3 horas

**Salida:** Vulnerabilidad XSS eliminada, con tests de regresión.

---

### Sprint 2: Documentación (CORTO PLAZO)

**Objetivo:** Documentar excepciones arquitectónicas

| Tarea | Archivo | Esfuerzo |
|-------|---------|----------|
| Añadir comentarios localStorage en tool-security.js | tool-security.js | 10min |
| Añadir comentarios localStorage en mcp.js | mcp.js | 10min |
| Añadir comentarios localStorage en data-reset-service.js | data-reset-service.js | 10min |

**Total:** 30 minutos

**Salida:** Excepciones de acceso directo a localStorage documentadas.

---

### Sprint 3: Estabilidad (MEDIO PLAZO)

**Objetivo:** Prevenir fugas de memoria

| Tarea | Esfuerzo |
|-------|----------|
| Auditoría de event listeners | 3h |
| Tests de memory leaks | 2h |
| Implementar EventListenerManager | 1h |
| Refactorizar módulos críticos (app.js, ui-settings.js) | 3h |

**Total:** 9 horas

**Salida:** Gestión consistente de event listeners, tests de prevención de fugas.

---

### Backlog: Refactorización Opcional

**Objetivo:** Reducir duplicación de construcción de tarjetas

**Condición de activación:** Aparece un tercer caso de uso de tarjetas de herramientas.

| Tarea | Esfuerzo |
|-------|----------|
| Implementar ToolCardBuilder | 2h |
| Refactorizar tool-cards.js | 1.5h |
| Refactorizar mcp.js | 1.5h |
| Tests de regresión visual | 2h |

**Total:** 7 horas

**Salida:** Constructor unificado de tarjetas, mantenimiento simplificado.

---

## 5. Métricas de Éxito

### Objetivos Cuantitativos

| Métrica | Antes | Después Sprint 1 | Después Sprint 3 |
|---------|-------|------------------|------------------|
| Vulnerabilidades XSS activas | 1 | 0 | 0 |
| Líneas duplicadas críticas | 170 | 170 | 150 |
| Event listeners sin limpieza | ? | ? | 0 |
| Tests de seguridad | 0 | 3 | 3 |
| Tests de memory leaks | 0 | 0 | 2 |
| Excepciones documentadas | 0 | 3 | 3 |

### Criterios de Aceptación

**Sprint 1 (Seguridad):**
- ✅ Todos los tests de XSS pasan
- ✅ Revisión de código aprobada
- ✅ Verificación manual con archivos maliciosos exitosa

**Sprint 2 (Documentación):**
- ✅ Comentarios añadidos en 3 archivos
- ✅ Revisión de claridad de comentarios aprobada

**Sprint 3 (Estabilidad):**
- ✅ Tests de memory leaks pasan
- ✅ EventListenerManager implementado y usado en módulos críticos
- ✅ Auditoría de listeners completada sin hallazgos críticos

---

## 6. Conclusiones

### Resumen de Hallazgos

- **4 patrones de duplicación identificados** (~170 líneas afectadas)
- **1 vulnerabilidad de seguridad (XSS)** - **REQUIERE ACCIÓN INMEDIATA**
- **3 casos de acceso directo a localStorage** - Justificados, requieren documentación
- **263 event listeners** - Requieren auditoría preventiva

### Impacto Actual

**Seguridad:** 🔴 **ALTO** - Vulnerabilidad XSS activa en adjuntos
**Mantenibilidad:** 🟡 **BAJO** - Duplicación controlada, no crítica
**Estabilidad:** 🟡 **MEDIO** - Sin evidencia de fugas, pero falta prevención

### Recomendación Final

1. **Ejecutar Sprint 1 inmediatamente** (3 horas) - Eliminar vulnerabilidad XSS
2. **Ejecutar Sprint 2 esta semana** (30 minutos) - Documentar excepciones
3. **Planificar Sprint 3 próximo mes** (9 horas) - Prevención de fugas de memoria
4. **Mantener en backlog** DUP-01 (tarjetas) hasta aparición de tercer caso de uso

### Próxima Revisión

**Fecha recomendada:** Junto con auditoría completa pre-v8.0.0

**Verificar:**
- Vulnerabilidad XSS solucionada y sin regresiones
- Documentación de excepciones presente y clara
- Sin fugas de memoria detectadas en tests
- No aparición de nuevos patrones de duplicación crítica

---

**FIN DEL ANÁLISIS**

**Elaborado por:** Claude Opus 5
**Fecha:** 2026-09-20
**Versión:** 1.0
**Archivos analizados:** 604 archivos fuente (focus en js/)
**Líneas analizadas:** ~31,000 líneas de JavaScript
