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

test('UI Modernization - Header incluye menú overflow y safe-area', () => {
  const headerCss = fs.readFileSync(path.resolve(__dirname, '../css/components/header.css'), 'utf8');
  assert.ok(headerCss.includes('.header-overflow-menu'), 'header.css debe definir estilos de overflow menu');
  assert.ok(headerCss.includes('env(safe-area-inset-top'), 'header.css debe soportar safe-area-inset-top');

  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="btn-header-overflow"'), 'index.html debe incluir el botón de menú overflow');
  assert.ok(indexHtml.includes('id="header-overflow-popover"'), 'index.html debe incluir el popover de overflow');
});

test('UI Modernization - Pantalla de bienvenida incluye contenedor de sugerencias y estilos dedicados', () => {
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="welcome-suggestions"'), 'index.html debe incluir el contenedor de sugerencias');

  const welcomeCss = fs.readFileSync(path.resolve(__dirname, '../css/components/welcome.css'), 'utf8');
  assert.ok(welcomeCss.includes('.welcome-suggestions'), 'welcome.css debe definir el grid de sugerencias');
  assert.ok(welcomeCss.includes('.welcome-card'), 'welcome.css debe definir las tarjetas de sugerencia');

  const stylesCss = fs.readFileSync(path.resolve(__dirname, '../css/styles.css'), 'utf8');
  assert.ok(stylesCss.includes('components/welcome.css'), 'styles.css maestro debe importar welcome.css');
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
