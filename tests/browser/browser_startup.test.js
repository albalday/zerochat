const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { version } = require('../../package.json');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');
const bundleTitle = `ZeroChat v${version}`;

describe('Browser UI - startup', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - informa del alcance de almacenamiento y deriva la descarga HTTP', async () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, '../../zerochat.html'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(bundle);
  });
  server.keepAliveTimeout = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html?preview=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatApp);
    await page.evaluate(() => window.ChatApp.openExecutionInfo());

    const state = await page.evaluate(() => ({
      open: document.getElementById('execution-info-dialog').open,
      href: document.getElementById('btn-download-standalone').href,
      hidden: document.getElementById('btn-download-standalone').hidden,
      display: getComputedStyle(document.getElementById('btn-download-standalone')).display,
      scope: document.getElementById('execution-storage-scope').textContent
    }));

    assert.equal(state.open, true);
    assert.equal(state.href, `http://127.0.0.1:${port}/zerochat.html`);
    assert.equal(state.hidden, false);
    assert.notEqual(state.display, 'none');
    assert.match(state.scope, /protocol|protocolo/i);
  } finally {
    await browser.close();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise(resolve => server.close(resolve));
  }
});

test('Browser UI - no ofrece descarga desde file://', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatApp);
    await page.evaluate(() => window.ChatApp.openExecutionInfo());
    const state = await page.evaluate(() => ({
      hidden: document.getElementById('btn-download-standalone').hidden,
      href: document.getElementById('btn-download-standalone').getAttribute('href'),
      display: getComputedStyle(document.getElementById('btn-download-standalone')).display
    }));
    assert.equal(state.hidden, true);
    assert.equal(state.href, null);
    assert.equal(state.display, 'none');
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

    assert.equal(stateEs.href, 'http://albalday.github.io/zerochat/help/index.html');
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

    assert.equal(stateEn.href, 'http://albalday.github.io/zerochat/help/en/index.html');
    assert.match(stateEn.text, /Help & Documentation/);
  } finally {
    await browser.close();
  }
});

test('Browser UI - index.html declara el mismo runtime que se distribuye', async () => {
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

    await page.goto('file://' + path.resolve(__dirname, '../../index.html'), { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    assert.equal(await page.title(), `ZeroChat v${version}`, 'El título de index.html debe coincidir con la versión del proyecto');
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
});
