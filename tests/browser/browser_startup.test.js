const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { version } = require('../../package.json');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');
const bundleTitle = `ZeroChat v${version}`;

async function startStaticServer() {
  const rootDir = path.resolve(__dirname, '../..');
  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const relPath = parsedUrl.pathname === '/' ? 'zerochat.html' : parsedUrl.pathname.replace(/^\//, '');
    const target = path.join(rootDir, relPath);
    if (!target.startsWith(rootDir + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'content-type': contentTypes[path.extname(target)] || 'application/octet-stream' });
    res.end(fs.readFileSync(target));
  });
  server.keepAliveTimeout = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function stopStaticServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

describe('Browser UI - startup', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - informa del alcance de almacenamiento en HTTP', async () => {
  const server = await startStaticServer();
  const { port } = server.address();
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/zerochat.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatApp);
    await page.evaluate(() => window.ChatApp.openExecutionInfo());

    const state = await page.evaluate(() => ({
      open: document.getElementById('execution-info-dialog').open,
      scope: document.getElementById('execution-storage-scope').textContent
    }));

    assert.equal(state.open, true);
    assert.match(state.scope, /protocol|protocolo/i);
  } finally {
    await browser.close();
    await stopStaticServer(server);
  }
});

test('Browser UI - informa del alcance de almacenamiento en file://', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatApp);
    await page.evaluate(() => window.ChatApp.openExecutionInfo());
    const state = await page.evaluate(() => ({
      open: document.getElementById('execution-info-dialog').open,
      scope: document.getElementById('execution-storage-scope').textContent
    }));
    assert.equal(state.open, true);
    assert.match(state.scope, /file|archivo/i);
  } finally {
    await browser.close();
  }
});

test('Browser UI - el chat vacío incluye enlace a la ayuda online según el idioma', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForSelector('#welcome-help-link');

    const statusBox = await page.locator('.welcome-status-badge:not(.welcome-help-link)').boundingBox();
    const helpBox = await page.locator('#welcome-help-link').boundingBox();
    assert.ok(statusBox && helpBox, 'Ambos elementos deben tener boundingBox');
    assert.ok(helpBox.y >= (statusBox.y + statusBox.height), 'El enlace de ayuda debe estar situado debajo del estado de chat vacío');
    const statusCenterX = statusBox.x + statusBox.width / 2;
    const helpCenterX = helpBox.x + helpBox.width / 2;
    assert.ok(Math.abs(statusCenterX - helpCenterX) <= 2, 'El enlace de ayuda debe estar centrado horizontalmente respecto al estado de chat vacío');

    const stateEs = await page.$eval('#welcome-help-link', el => ({
      href: el.href,
      target: el.target,
      rel: el.rel,
      text: el.textContent.trim(),
      title: el.title
    }));

    assert.equal(stateEs.href, 'file://' + path.resolve(__dirname, '../../help/index.html'));
    assert.equal(stateEs.target, '_blank');
    assert.match(stateEs.rel, /noopener/);
    assert.match(stateEs.text, /Ayuda|Help/);

    // Cambiar idioma a inglés
    await page.evaluate(() => window.ChatApp.applyLanguage('en'));

    const stateEn = await page.$eval('#welcome-help-link', el => ({
      href: el.href,
      text: el.textContent.trim(),
      title: el.title
    }));

    assert.equal(stateEn.href, 'file://' + path.resolve(__dirname, '../../help/en/index.html'));
    assert.match(stateEn.text, /Help & Documentation/);
  } finally {
    await browser.close();
  }
});

test('Browser help - el comando de descarga de zerochat.py usa la URL oficial y se puede copiar', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../help/index.html'), { waitUntil: 'load' });
    await page.waitForSelector('.code-wrapper .btn-copy');

    const command = await page.$eval('.code-wrapper pre code', el => el.textContent.trim());
    const button = await page.$eval('.code-wrapper .btn-copy', el => ({ type: el.type, text: el.textContent.trim() }));
    assert.equal(command, 'curl -sL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py && python3 zerochat.py');
    assert.deepEqual(button, { type: 'button', text: 'Copiar' });
  } finally {
    await browser.close();
  }
});

test('Browser UI - zerochat.html declara el mismo runtime que se distribuye', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    assert.equal(await page.title(), `ZeroChat v${version}`, 'El título de zerochat.html debe coincidir con la versión del proyecto');
    const runtime = await page.evaluate(() => ({
      chatIcons: typeof window.ChatIcons?.get === 'function',
      iconStyles: getComputedStyle(document.querySelector('.ui-icon')).display
    }));
    assert.equal(runtime.chatIcons, true, 'El HTML base debe cargar el módulo de iconos usado por la aplicación');
    assert.equal(runtime.iconStyles, 'block', 'El HTML base debe cargar los estilos de iconos');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Carga limpia del bundle zerochat.html sin errores de consola', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    const title = await page.title();
    assert.equal(title, bundleTitle, 'El título de zerochat.html debe coincidir con la versión y canal del proyecto');

    // Verificar que los componentes clave están en el DOM
    const hasChatContainer = await page.$eval('.chat-container', el => !!el);
    assert.ok(hasChatContainer, 'El contenedor de chat debe existir');

    const hasMessagesList = await page.$eval('#messages-list', el => !!el);
    assert.ok(hasMessagesList, 'La lista de mensajes debe existir');

    const hasChatForm = await page.$eval('#chat-form', el => !!el);
    assert.ok(hasChatForm, 'El formulario de chat debe existir');

    // Verificar resolución de variables CSS de diseño
    const styles = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      return {
        bgApp: bodyStyle.backgroundColor,
        color: bodyStyle.color,
        fontFamily: bodyStyle.fontFamily
      };
    });
    assert.ok(styles.bgApp, 'El fondo de la app debe estar computado');
    assert.ok(styles.color, 'El color de texto debe estar computado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - zerochat.html optimiza carga con defer, CSS paralelos y PWA manifest', async () => {
  const htmlPath = path.resolve(__dirname, '../../zerochat.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // Comprobar enlace a manifest
  assert.match(htmlContent, /<link rel="manifest" href="manifest\.webmanifest">/, 'Debe declarar manifest.webmanifest');
  assert.match(htmlContent, /<meta name="theme-color" content="#0d1117">/, 'Debe declarar theme-color');

  // Comprobar que no hay @import en zerochat.html y que los estilos se cargan en paralelo
  assert.ok(!htmlContent.includes('<link rel="stylesheet" href="css/styles.css">'), 'No debe usar la cascada de styles.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/tokens\.css">/, 'Debe enlazar tokens.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/base\.css">/, 'Debe enlazar base.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/components\/composer\.css">/, 'Debe enlazar composer.css');
  assert.match(htmlContent, /<link rel="stylesheet" href="css\/print\.css" media="print">/, 'print.css debe tener media="print"');

  // Comprobar que los scripts usan defer para carga concurrente
  const scriptsWithoutDefer = [...htmlContent.matchAll(/<script\s+src="js\/([^"]+)"/g)];
  assert.equal(scriptsWithoutDefer.length, 0, 'Todos los scripts de la aplicación deben declarar defer');
  assert.match(htmlContent, /<script defer src="js\/app\.js"><\/script>/, 'js/app.js debe declarar defer');

  // Comprobar validez de manifest.webmanifest
  const manifestPath = path.resolve(__dirname, '../../manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest debe existir');
  const manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifestJson.display, 'standalone');
  assert.equal(manifestJson.start_url, './zerochat.html');

  // Comprobar existencia y contenido de sw.js
  const swPath = path.resolve(__dirname, '../../sw.js');
  assert.ok(fs.existsSync(swPath), 'sw.js debe existir');
  const swContent = fs.readFileSync(swPath, 'utf8');
  assert.match(swContent, /CACHE_NAME/, 'sw.js debe declarar CACHE_NAME');
  assert.match(swContent, /caches\.open/, 'sw.js debe gestionar la Cache API');
});

test('Browser UI - el fragmento inicial persiste la sesión del backend en cookie y limpia la URL', async () => {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));

    const testToken = 'startup-token-test-12345';
    const testPort = '6388';
    const targetUrl = `http://127.0.0.1:${server.address().port}/zerochat.html#token=${testToken}&host=127.0.0.1&port=${testPort}`;

    await page.goto(targetUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    assert.equal(pageErrors.length, 0, 'No deben producirse errores en tiempo de ejecución: ' + pageErrors.join(' | '));

    const state = await page.evaluate(() => ({
      hasChatApp: typeof window.ChatApp === 'object' && window.ChatApp !== null,
      hasStartServerHeartbeat: typeof window.ChatApp?.startServerHeartbeat === 'function',
      hasStopServerHeartbeat: typeof window.ChatApp?.stopServerHeartbeat === 'function',
      backendSession: window.ChatStorage.getBackendSession(),
      href: window.location.href,
      isReady: document.documentElement.classList.contains('zerochat-ready'),
      hasOldLifecycle: typeof window.__zerochat_heartbeat_lifecycle !== 'undefined'
    }));

    assert.equal(state.hasChatApp, true, 'window.ChatApp debe estar definido');
    assert.equal(state.hasStartServerHeartbeat, true, 'window.ChatApp.startServerHeartbeat debe ser función');
    assert.equal(state.hasStopServerHeartbeat, true, 'window.ChatApp.stopServerHeartbeat debe ser función');
    assert.deepEqual(state.backendSession, { token: testToken, host: '127.0.0.1', port: Number(testPort) }, 'La sesión debe haberse guardado exclusivamente en la cookie');
    assert.equal(state.href.includes(testToken), false, 'La URL no debe conservar el token');
    assert.equal(state.isReady, true, 'La página debe haber completado init()');
    assert.equal(state.hasOldLifecycle, false, 'No deben existir variables obsoletas de ciclo de vida');

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const reloadedSession = await page.evaluate(() => window.ChatStorage.getBackendSession());
    assert.deepEqual(reloadedSession, { token: testToken, host: '127.0.0.1', port: Number(testPort) }, 'F5 debe recuperar la sesión desde la cookie');

    // Verificar que stopServerHeartbeat y re-startServerHeartbeat funcionan limpiamente
    await page.evaluate(() => {
      window.ChatApp.stopServerHeartbeat();
      window.ChatApp.startServerHeartbeat('127.0.0.1', 6388, 'startup-token-test-12345');
      window.ChatApp.stopServerHeartbeat();
    });
  } finally {
    await browser.close();
    await stopStaticServer(server);
  }
});

test('Browser UI - una nueva pestaña usa la cookie sin propagar el token en la URL', async () => {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const testToken = 'new-tab-token-abcde-67890';
    const testPort = '6388';
    const targetUrl = `http://127.0.0.1:${server.address().port}/zerochat.html#token=${testToken}&host=127.0.0.1&port=${testPort}`;

    await page.goto(targetUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // El enlace no contiene secretos: la nueva pestaña leerá la cookie del mismo origen.
    const linkHref = await page.$eval('#btn-sidebar-new-tab', el => el.getAttribute('href'));
    assert.equal(linkHref.includes(testToken), false, 'El href de nueva pestaña no debe incluir el token');
    assert.equal(linkHref.includes(`port=${testPort}`), false, 'El href de nueva pestaña no debe incluir el puerto');

    // Hacer clic en el enlace y esperar a que se abra la nueva pestaña
    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#btn-sidebar-new-tab')
    ]);

    await newPage.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    const newPageState = await newPage.evaluate(() => ({
      hasChatApp: typeof window.ChatApp === 'object' && window.ChatApp !== null,
      backendSession: window.ChatStorage.getBackendSession(),
      newTabHref: document.getElementById('btn-sidebar-new-tab')?.getAttribute('href')
    }));

    assert.equal(newPageState.hasChatApp, true, 'La nueva pestaña debe tener ChatApp inicializado');
    assert.deepEqual(newPageState.backendSession, { token: testToken, host: '127.0.0.1', port: Number(testPort) }, 'La nueva pestaña debe recuperar la sesión desde la cookie');
    assert.equal(newPageState.newTabHref.includes(testToken), false, 'Las pestañas posteriores tampoco deben propagar el token');

    await newPage.close();
  } finally {
    await context.close();
    await browser.close();
    await stopStaticServer(server);
  }
});
});
