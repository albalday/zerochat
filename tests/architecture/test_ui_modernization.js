const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = relPath => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

test('UI Modernization - los tokens de tema y de formularios están definidos en claro y oscuro', () => {
  const tokensCss = read('css/tokens.css');
  assert.ok(tokensCss.includes('--bg-surface-rgb: 255, 255, 255'), 'Debe definir --bg-surface-rgb para modo claro');
  assert.ok(tokensCss.includes('--bg-surface-rgb: 19, 27, 46'), 'Debe definir --bg-surface-rgb para modo oscuro');
  for (const token of ['--header-bg-alpha', '--input-bg:', '--input-border-focus:', '--input-focus-ring:']) {
    assert.ok(tokensCss.includes(token), token);
  }
  assert.ok(read('css/components/modals.css').includes('var(--input-focus-ring)'), 'Los campos deben aplicar el anillo de foco accesible');
});

test('UI Modernization - La interfaz desactiva transiciones y animaciones decorativas', () => {
  const baseCss = read('css/base.css');
  assert.match(baseCss, /animation:\s*none\s*!important/, 'base.css debe desactivar animaciones');
  assert.match(baseCss, /transition:\s*none\s*!important/, 'base.css debe desactivar transiciones');
  assert.equal(read('css/components/modals.css').includes('@starting-style'), false, 'modals.css no debe animar la apertura de diálogos');
  assert.equal(read('css/components/composer.css').includes('@starting-style'), false, 'composer.css no debe animar el menú de razonamiento');
});

test('UI Modernization - zerochat.html declara orden de carga, diálogos descartables y enlaces seguros', () => {
  const indexHtml = read('zerochat.html');
  assert.match(indexHtml, /src="js\/defaults\.js"[\s\S]*src="js\/state\.js"/, 'Debe cargar los valores predeterminados antes del estado');
  assert.match(indexHtml, /id="settings-dialog"[^>]*closedby="any"/, 'settings-dialog debe tener closedby="any"');
  assert.match(indexHtml, /id="profiles-dialog"[^>]*closedby="any"/, 'profiles-dialog debe tener closedby="any"');
  assert.match(indexHtml, /id="btn-sidebar-new-tab"[^>]*target="_blank"/, 'Debe incluir un enlace para abrir ZeroChat en una pestaña nueva');
  assert.match(indexHtml, /id="notice-input"[^>]*class="form-input"/, 'notice-input debe usar el estilo unificado de formularios');
});

test('UI Modernization - Imágenes en chat redimensionadas como máximo al ancho del chat', () => {
  const baseCss = read('css/base.css');
  assert.match(baseCss, /img\s*\{[^}]*max-width:\s*100%/);

  const messagesCss = read('css/components/messages.css');
  assert.ok(messagesCss.includes('.message-content img'), 'messages.css debe definir selector para imágenes en mensaje');
  assert.ok(messagesCss.includes('.message-image-thumb'), 'messages.css debe definir selector para miniaturas adjuntas');
  assert.match(messagesCss, /\.message-image-thumb\s*\{[^}]*max-width:\s*100%/);

  const markdownCss = read('css/components/markdown.css');
  assert.match(markdownCss, /\.chat-embedded-image\s*\{[^}]*max-width:\s*100%/);
  assert.match(markdownCss, /\.chat-image-figure\s*\{[^}]*max-width:\s*100%/);
});

test('UI Modernization - El banner de importación y el resumen de razonamiento no usan emojis', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const markdownJs = read('js/markdown.js');
  assert.equal(emoji.test(markdownJs), false, 'markdown.js no debe contener emojis (summary de razonamiento)');

  const appJs = read('js/app.js');
  const banner = appJs.match(/banner\.innerHTML = `([\s\S]*?)`;/);
  assert.ok(banner, 'app.js debe construir el banner de importación');
  assert.equal(emoji.test(banner[1]), false, 'El banner de importación no debe contener emojis');
  assert.ok(banner[1].includes("ChatIcons.get('download'"), 'El banner de importación debe usar ChatIcons');
});

test('UI Modernization - zerochat.html optimiza carga con defer y CSS paralelos', () => {
  const htmlContent = read('zerochat.html');
  assert.match(htmlContent, /<link rel="manifest" href="manifest\.webmanifest">/, 'Debe declarar manifest.webmanifest');
  assert.match(htmlContent, /<meta name="theme-color" content="#0d1117">/, 'Debe declarar theme-color');
  assert.ok(!htmlContent.includes('<link rel="stylesheet" href="css/styles.css">'), 'No debe usar la cascada de styles.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/tokens\.css">/, 'Debe enlazar tokens.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/base\.css">/, 'Debe enlazar base.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/print\.css" media="print">/, 'print.css debe tener media="print"');
  assert.equal([...htmlContent.matchAll(/<script\s+src="js\/([^"]+)"/g)].length, 0, 'Todos los scripts de la aplicación deben declarar defer');
  assert.match(htmlContent, /<script defer src="js\/app\.js"><\/script>/, 'js/app.js debe declarar defer');

});
