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

test('UI Modernization - Header incluye las 3 acciones superiores y safe-area', () => {
  const headerCss = fs.readFileSync(path.resolve(__dirname, '../css/components/header.css'), 'utf8');
  assert.ok(headerCss.includes('env(safe-area-inset-top'), 'header.css debe soportar safe-area-inset-top');

  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="btn-quick-export"'), 'index.html debe incluir #btn-quick-export en la barra superior');
  assert.ok(indexHtml.includes('id="btn-clear-chat"'), 'index.html debe incluir #btn-clear-chat en la barra superior');
  assert.ok(indexHtml.includes('id="btn-toggle-debug"'), 'index.html debe incluir #btn-toggle-debug en la barra superior');
});

test('UI Modernization - Pantalla de bienvenida limpia sin sugerencias intrusivas', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('class="welcome-banner"'), 'index.html debe incluir .welcome-banner');
  assert.ok(indexHtml.includes('class="welcome-icon"'), 'index.html debe incluir .welcome-icon');
  assert.ok(!indexHtml.includes('id="welcome-suggestions"'), 'index.html no debe incluir sugerencias de bienvenida');
});


test('UI Modernization - Modales soportan atributo closedby="any"', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="settings-dialog" class="settings-modal" closedby="any"'), 'settings-dialog debe tener closedby="any"');
  assert.ok(indexHtml.includes('id="profiles-dialog" class="settings-modal profiles-modal" closedby="any"'), 'profiles-dialog debe tener closedby="any"');
});

test('UI Modernization - Sidebar incluye backdrop y trampa accesible para móvil', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="sidebar-backdrop"'), 'index.html debe incluir #sidebar-backdrop');

  const sidebarJs = fs.readFileSync(path.resolve(__dirname, '../js/ui-sidebar.js'), 'utf8');
  assert.ok(sidebarJs.includes('sidebar-backdrop'), 'ui-sidebar.js debe manipular el backdrop en móvil');
  assert.ok(sidebarJs.includes('inert'), 'ui-sidebar.js debe usar el atributo inert para WCAG');
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
