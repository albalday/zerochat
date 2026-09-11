const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('UI Modernization - CSS tokens y glassmorphism tokens definidos', () => {
  const tokensCss = fs.readFileSync(path.resolve(__dirname, '../css/tokens.css'), 'utf8');
  assert.ok(tokensCss.includes('--bg-surface-rgb: 255, 255, 255'), 'Debe definir --bg-surface-rgb para modo claro');
  assert.ok(tokensCss.includes('--bg-surface-rgb: 19, 27, 46'), 'Debe definir --bg-surface-rgb para modo oscuro');
  assert.ok(tokensCss.includes('--header-bg-alpha'), 'Debe definir --header-bg-alpha');
});

test('UI Modernization - Composer textarea usa field-sizing: content', () => {
  const composerCss = fs.readFileSync(path.resolve(__dirname, '../css/components/composer.css'), 'utf8');
  assert.ok(composerCss.includes('field-sizing: content'), 'El textarea debe declarar field-sizing: content');
});

test('UI Modernization - Modales y mensajes usan @starting-style para animaciones modernas', () => {
  const modalsCss = fs.readFileSync(path.resolve(__dirname, '../css/components/modals.css'), 'utf8');
  assert.ok(modalsCss.includes('@starting-style'), 'modals.css debe usar @starting-style');

  const composerCss = fs.readFileSync(path.resolve(__dirname, '../css/components/composer.css'), 'utf8');
  assert.ok(composerCss.includes('@starting-style'), 'composer.css debe usar @starting-style en reasoning-menu');

  const messagesCss = fs.readFileSync(path.resolve(__dirname, '../css/components/messages.css'), 'utf8');
  assert.ok(messagesCss.includes('.is-new-message'), 'messages.css debe animar únicamente mensajes con .is-new-message');
  assert.ok(messagesCss.includes('.typing-indicator'), 'messages.css debe declarar el typing indicator');
  assert.ok(messagesCss.includes('interpolate-size: allow-keywords'), 'messages.css debe soportar interpolate-size');
});

test('UI Modernization - Header incluye acciones superiores limpias y safe-area', () => {
  const headerCss = fs.readFileSync(path.resolve(__dirname, '../css/components/header.css'), 'utf8');
  assert.ok(headerCss.includes('env(safe-area-inset-top'), 'header.css debe soportar safe-area-inset-top');

  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(!indexHtml.includes('id="btn-quick-export"'), 'index.html no debe incluir #btn-quick-export en la barra superior');
  assert.ok(!indexHtml.includes('id="btn-clear-chat"'), 'index.html no debe incluir #btn-clear-chat');
  assert.ok(indexHtml.includes('id="btn-toggle-debug"'), 'index.html debe incluir #btn-toggle-debug en la barra superior');
  assert.ok(!indexHtml.includes('class="sidebar-header-title"'), 'index.html no debe incluir un título textual en la cabecera del sidebar');
  assert.ok(indexHtml.includes('.sidebar-header #btn-open-settings') || indexHtml.includes('id="btn-open-settings" class="btn-sidebar-icon"'), 'index.html debe incluir #btn-open-settings en la cabecera del sidebar');
  assert.ok(!indexHtml.includes('id="btn-open-export-modal"'), 'index.html no debe incluir #btn-open-export-modal en el pie de la barra lateral');
  assert.ok(indexHtml.includes('id="btn-sidebar-new-chat"'), 'index.html debe incluir #btn-sidebar-new-chat como icono en la cabecera del sidebar');
  assert.match(indexHtml, /id="btn-sidebar-new-tab"[^>]*target="_blank"/, 'index.html debe incluir un enlace seguro para abrir ZeroChat en una pestaña nueva');
  assert.ok(indexHtml.includes('href="#icon-external-link"'), 'El enlace de nueva pestaña debe usar un icono SVG vectorial');
  assert.ok(!indexHtml.includes('app-brand-title'), 'index.html no debe incluir título en la barra superior');
});

test('UI Modernization - Pantalla de bienvenida limpia sin sugerencias intrusivas', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('class="welcome-banner"'), 'index.html debe incluir .welcome-banner');
  assert.ok(indexHtml.includes('class="welcome-icon"'), 'index.html debe incluir .welcome-icon');
  assert.ok(!indexHtml.includes('id="welcome-suggestions"'), 'index.html no debe incluir sugerencias de bienvenida');
});


test('UI Modernization - Modales soportan atributo closedby="any"', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.match(indexHtml, /id="settings-dialog"[^>]*closedby="any"/, 'settings-dialog debe tener closedby="any"');
  assert.match(indexHtml, /id="profiles-dialog"[^>]*closedby="any"/, 'profiles-dialog debe tener closedby="any"');
});

test('UI Modernization - Sidebar incluye backdrop accesible para móvil', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="sidebar-backdrop"'), 'index.html debe incluir #sidebar-backdrop');
});

test('UI Modernization - Imágenes en chat redimensionadas como máximo al ancho del chat', () => {
  const baseCss = fs.readFileSync(path.resolve(__dirname, '../css/base.css'), 'utf8');
  assert.match(baseCss, /img\s*\{[^}]*max-width:\s*100%/);

  const messagesCss = fs.readFileSync(path.resolve(__dirname, '../css/components/messages.css'), 'utf8');
  assert.ok(messagesCss.includes('.message-content img'), 'messages.css debe definir selector para imágenes en mensaje');
  assert.ok(messagesCss.includes('.message-image-thumb'), 'messages.css debe definir selector para miniaturas adjuntas');
  assert.match(messagesCss, /\.message-image-thumb\s*\{[^}]*max-width:\s*100%/);

  const markdownCss = fs.readFileSync(path.resolve(__dirname, '../css/components/markdown.css'), 'utf8');
  assert.match(markdownCss, /\.chat-embedded-image\s*\{[^}]*max-width:\s*100%/);
  assert.match(markdownCss, /\.chat-image-figure\s*\{[^}]*max-width:\s*100%/);
});

test('UI Modernization - Estándar unificado de UI para textboxes y combos', () => {
  const tokensCss = fs.readFileSync(path.resolve(__dirname, '../css/tokens.css'), 'utf8');
  assert.ok(tokensCss.includes('--input-bg:'), 'tokens.css debe definir --input-bg');
  assert.ok(tokensCss.includes('--input-border-focus:'), 'tokens.css debe definir --input-border-focus');
  assert.ok(tokensCss.includes('--input-focus-ring:'), 'tokens.css debe definir --input-focus-ring');

  const modalsCss = fs.readFileSync(path.resolve(__dirname, '../css/components/modals.css'), 'utf8');
  assert.ok(modalsCss.includes('#notice-input'), 'modals.css debe incluir #notice-input en la regla unificada');
  assert.ok(modalsCss.includes('input[type="number"]'), 'modals.css debe incluir input[type="number"]');
  assert.ok(modalsCss.includes('.combobox-select-helper'), 'modals.css debe estilizar .combobox-select-helper');
  assert.ok(modalsCss.includes('var(--input-focus-ring)'), 'modals.css debe aplicar el anillo de foco accesible');
  assert.ok(modalsCss.includes("background-image: url(\"data:image/svg+xml"), 'modals.css debe aplicar chevron SVG en selects');

  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.match(indexHtml, /id="notice-input"[^>]*class="form-input"/, 'index.html debe declarar class="form-input" en notice-input');

  const composerCss = fs.readFileSync(path.resolve(__dirname, '../css/components/composer.css'), 'utf8');
  assert.ok(composerCss.includes('.context-limit-control input:focus'), 'composer.css debe definir foco accesible en context-limit input');

  const sidebarCss = fs.readFileSync(path.resolve(__dirname, '../css/components/sidebar.css'), 'utf8');
  assert.ok(sidebarCss.includes('.sidebar-search-input:focus'), 'sidebar.css debe definir foco accesible en búsqueda de sidebar');
});

