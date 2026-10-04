const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../../package.json');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady, startStaticServer, stopStaticServer } = require('../helpers/browser-env.js');

describe('Browser UI - startup', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - informa del alcance de almacenamiento en HTTP y file://', async () => {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    for (const [url, scope] of [[`http://127.0.0.1:${server.address().port}/zerochat.html`, /protocol|protocolo/i], [getIndexUrl(), /file|archivo/i]]) {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatApp);
      await page.evaluate(() => window.ChatApp.openExecutionInfo());
      const state = await page.evaluate(() => ({
        open: document.getElementById('execution-info-dialog').open,
        scope: document.getElementById('execution-storage-scope').textContent
      }));
      assert.equal(state.open, true, url);
      assert.match(state.scope, scope, url);
    }
  } finally {
    await browser.close();
    await stopStaticServer(server);
  }
});

test('Browser UI - el chat vacío incluye enlace a la ayuda online según el idioma', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
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

    assert.equal(await page.$eval('#welcome-version', el => el.textContent.trim()), `(v${version})`);
    assert.ok(stateEs.text.includes(`(v${version})`), 'El enlace de ayuda debe mostrar la versión en español');
    assert.ok(stateEn.text.includes(`(v${version})`), 'El enlace de ayuda debe mostrar la versión en inglés');
  } finally {
    await browser.close();
  }
});

test('Browser help - PyPI y descarga directa tienen bloques copiables independientes en ambos idiomas', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const commands = [
      'pip install zerochat && zerochat',
      'curl https://albalday.github.io/zerochat/zerochat.py -o zerochat.py ; python3 zerochat.py'
    ];
    for (const helpPath of ['help/index.html', 'help/en/index.html', 'help/mcp.html', 'help/en/mcp.html']) {
      await page.goto('file://' + path.resolve(__dirname, '../..', helpPath), { waitUntil: 'load' });
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true, value: { writeText: async text => { window.copiedHelpText = text; } }
        });
      });
      const wrappers = page.locator('.code-wrapper');
      for (let index = 0; index < commands.length; index += 1) {
        const wrapper = wrappers.nth(index);
        assert.equal((await wrapper.locator('pre code').textContent()).trim(), commands[index]);
        const button = wrapper.locator('.btn-copy');
        assert.equal(await button.getAttribute('type'), 'button');
        assert.equal(await button.textContent(), helpPath.includes('/en/') ? 'Copy' : 'Copiar');
        await button.click();
        assert.equal(await page.evaluate(() => window.copiedHelpText), commands[index]);
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - zerochat.html carga sin errores de consola y con el runtime distribuido', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    assert.deepEqual(consoleErrors, []);
    assert.equal(await page.title(), `ZeroChat v${version}`, 'El título de zerochat.html debe coincidir con la versión del proyecto');
    const runtime = await page.evaluate(() => ({
      chatIcons: typeof window.ChatIcons?.get === 'function',
      iconStyles: getComputedStyle(document.querySelector('.ui-icon')).display,
      shell: ['.chat-container', '#messages-list', '#chat-form'].every(selector => !!document.querySelector(selector))
    }));
    assert.deepEqual(runtime, { chatIcons: true, iconStyles: 'block', shell: true });
  } finally {
    await browser.close();
  }
});

test('Browser PWA - no ofrece instalación al abrir directamente ni desde la ayuda', async () => {
  const browser = await createTestBrowser();
  try {
    for (const helpPath of [null, 'help/index.html', 'help/en/index.html']) {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', err => pageErrors.push(err.message));
      if (helpPath) {
        await page.goto('file://' + path.resolve(__dirname, '../../', helpPath), { waitUntil: 'load' });
        await page.click('#btn-open-app');
      } else {
        await page.goto(getIndexUrl(), { waitUntil: 'load' });
      }
      await waitForAppReady(page);

      const eventState = await page.evaluate(() => {
        let prompted = false;
        const event = new Event('beforeinstallprompt', { cancelable: true });
        event.prompt = async () => { prompted = true; };
        window.dispatchEvent(event);
        return {
          prevented: event.defaultPrevented,
          hasButton: Boolean(document.getElementById('btn-install-pwa')),
          hasManifest: Boolean(document.querySelector('link[rel="manifest"]')),
          prompted
        };
      });
      assert.deepEqual(eventState, { prevented: true, hasButton: false, hasManifest: true, prompted: false });
      assert.deepEqual(pageErrors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('Browser UI - el fragmento inicial persiste la sesión en cookie, limpia la URL y la reutiliza en nuevas pestañas', async () => {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    const testToken = 'startup-token-test-12345';
    const expectedSession = { token: testToken, host: '127.0.0.1', port: 6388 };

    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#token=${testToken}&host=127.0.0.1&port=6388`, { waitUntil: 'load' });
    await waitForAppReady(page);
    const state = await page.evaluate(() => ({
      backendSession: window.ChatStorage.getBackendSession(),
      href: window.location.href,
      newTabHref: document.getElementById('btn-sidebar-new-tab').getAttribute('href'),
      hasOldLifecycle: typeof window.__zerochat_heartbeat_lifecycle !== 'undefined'
    }));
    assert.deepEqual(state.backendSession, expectedSession, 'La sesión debe haberse guardado en la cookie');
    assert.equal(state.href.includes(testToken), false, 'La URL no debe conservar el token');
    assert.equal(state.newTabHref.includes(testToken) || state.newTabHref.includes('port='), false, 'El enlace de nueva pestaña no debe propagar la sesión');
    assert.equal(state.hasOldLifecycle, false, 'No deben existir variables obsoletas de ciclo de vida');

    await page.reload({ waitUntil: 'load' });
    await waitForAppReady(page);
    assert.deepEqual(await page.evaluate(() => window.ChatStorage.getBackendSession()), expectedSession, 'F5 debe recuperar la sesión desde la cookie');
    await page.evaluate(() => {
      window.ChatApp.stopServerHeartbeat();
      window.ChatApp.startServerHeartbeat('127.0.0.1', 6388, 'startup-token-test-12345');
      window.ChatApp.stopServerHeartbeat();
    });

    const [newPage] = await Promise.all([context.waitForEvent('page'), page.click('#btn-sidebar-new-tab')]);
    await newPage.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    assert.deepEqual(await newPage.evaluate(() => window.ChatStorage.getBackendSession()), expectedSession, 'La nueva pestaña debe recuperar la sesión desde la cookie');
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
    await browser.close();
    await stopStaticServer(server);
  }
});

for (const outcome of ['later', 'reload', 'none', 'offline']) {
  test(`Browser PWA - aviso MCP posterior al control de actualización (${outcome})`, async () => {
    const server = await startStaticServer();
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('http://127.0.0.1:6388/**', route => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ success: true })
      }));
      await page.addInitScript(({ outcome }) => {
        const events = JSON.parse(sessionStorage.getItem('startup-events') || '[]');
        window.__startupEvents = events;
        window.__recordStartup = event => {
          events.push(event);
          sessionStorage.setItem('startup-events', JSON.stringify(events));
        };
        const secondLoad = events.includes('update');
        const listeners = [];
        const worker = {
          state: 'installing',
          addEventListener: (type, listener) => listeners.push(listener)
        };
        const registration = {
          waiting: null,
          installing: !secondLoad && ['later', 'reload'].includes(outcome) ? worker : null,
          addEventListener: () => {},
          update: async () => {
            window.__recordStartup('check');
            if (outcome === 'offline') throw new Error('offline');
          }
        };
        window.__finishUpdate = () => {
          worker.state = 'installed';
          registration.waiting = worker;
          listeners.forEach(listener => listener());
        };
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: { controller: {}, register: async () => registration }
        });
      }, { outcome });
      await page.route('**/js/app.js', async route => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../js/app.js'), 'utf8');
        await route.fulfill({ contentType: 'application/javascript', body: `
          window.ChatMCP.manager.connectProxy = async options => {
            if (options.notifyStartup !== false) throw new Error('MCP notice must be deferred');
            window.ChatState.set('mcp', { status: 'connected', externalServers: [
              { id: 'memory', enabled: true, status: 'stopped' }
            ] });
            return { success: true };
          };
          window.ChatDialogs.confirm = async (message, options) => {
            window.__updateNotice = { message, options };
            window.__recordStartup('update');
            return new Promise(resolve => { window.__resolveUpdate = resolve; });
          };
          window.ChatDialogs.alert = async () => window.__recordStartup('mcp');
        ` + source });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#token=test-startup`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__startupEvents.includes('check'));
      if (['later', 'reload'].includes(outcome)) {
        assert.deepEqual(await page.evaluate(() => window.__startupEvents), ['check']);
        await page.evaluate(() => window.__finishUpdate());
        await page.waitForFunction(() => !!window.__resolveUpdate);
        assert.deepEqual(await page.evaluate(() => window.__startupEvents), ['check', 'update']);
        assert.deepEqual(await page.evaluate(() => window.__updateNotice), {
          message: 'Hay una nueva versión de ZeroChat lista para aplicar.',
          options: { type: 'info', title: 'Actualización disponible', acceptText: 'Recargar ahora', cancelText: 'Más tarde' }
        });
        if (outcome === 'reload') {
          await Promise.all([
            page.waitForEvent('load'),
            page.evaluate(() => window.__resolveUpdate(true))
          ]);
        } else {
          await page.evaluate(() => window.__resolveUpdate(false));
        }
      }
      await page.waitForFunction(() => window.__startupEvents.includes('mcp'));
      const expected = outcome === 'reload' ? ['check', 'update', 'check', 'mcp'] :
        outcome === 'later' ? ['check', 'update', 'mcp'] : ['check', 'mcp'];
      assert.deepEqual(await page.evaluate(() => window.__startupEvents), expected);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });
}

});
