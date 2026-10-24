const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../../package.json');
const { createTestBrowser, withTestApp, closeGlobalBrowser, getIndexUrl, waitForAppReady, startStaticServer, stopStaticServer } = require('../helpers/browser-env.js');

describe('Browser UI - startup', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - sin preferencia guardada la interfaz usa el idioma del navegador', async () => {
  const browser = await createTestBrowser();
  try {
    for (const [locale, lang] of [['en-US', 'en'], ['fr-FR', 'es'], ['es-ES', 'es']]) {
      const page = await browser.newPage({ locale });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);
      assert.equal(await page.evaluate(() => document.documentElement.lang), lang, locale);
      assert.equal(await page.evaluate(() => window.ChatConfig.getActive().language), lang, locale);
    }
  } finally {
    await browser.close();
  }
});

// Prueba de humo: recorre lo que se ejecuta en cada uso normal de la aplicación. Lo que ella cubre
// no necesita prueba propia (tests/README.md, sección 6).
test('Browser UI - humo: arranca, conversa con Espejo, gestiona conversaciones y abre los ajustes sin errores de consola', { timeout: 20000 }, async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(5000);
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    assert.equal(await page.title(), `ZeroChat v${version}`);

    const send = async text => {
      await page.fill('#user-input', text);
      await page.click('#btn-send');
      await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
    };
    const titles = () => page.$$eval('.sidebar-chat-item .sidebar-chat-title', items => items.map(item => item.textContent.trim()));
    const answerNotice = async (input) => {
      await page.waitForFunction(() => document.getElementById('notice-dialog').open);
      if (input !== undefined) await page.fill('#notice-input', input);
      await page.click('#notice-accept');
      await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    };

    await send('Primera');
    assert.equal(await page.locator('#messages-list .message-wrapper.assistant').count(), 1);
    const firstId = await page.evaluate(() => window.ChatState.get('sessions').activeId);
    await page.click('#btn-sidebar-new-chat');
    await page.waitForFunction(id => window.ChatState.get('sessions').activeId !== id && window.ChatState.get('messages').length === 1, firstId);
    await send('Segunda');
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-chat-item').length === 2);

    const first = page.locator('.sidebar-chat-item', { hasText: 'Primera' });
    await first.locator('.btn-chat-menu').click();
    await first.locator('.btn-rename').click();
    await answerNotice('Renombrada');
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-chat-title')].some(title => title.textContent.trim() === 'Renombrada'));
    const renamed = page.locator('.sidebar-chat-item', { hasText: 'Renombrada' });
    await renamed.locator('.btn-chat-menu').click();
    await renamed.locator('.btn-delete').click();
    await answerNotice();
    await page.waitForFunction(() => document.querySelectorAll('.sidebar-chat-item').length === 1);
    assert.deepEqual(await titles(), ['Segunda']);

    await page.click('#btn-open-settings');
    for (const section of ['model', 'agent', 'mcp', 'permissions']) {
      await page.locator(`#sidebar-settings-nav [data-section="${section}"]`).evaluate(item => item.click());
      await page.waitForFunction(id => document.getElementById('settings-dialog').open && document.getElementById(`settings-${id}`).classList.contains('active'), section);
    }
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
    for (const [section, nav, back] of [['rag', '#sidebar-rag-nav', '#btn-rag-back'], ['encryption', '#sidebar-encryption-nav', '#btn-encryption-back']]) {
      await page.locator(`#sidebar-settings-nav [data-section="${section}"]`).evaluate(item => item.click());
      await page.waitForSelector(`${nav}:not([hidden])`);
      await page.locator(back).evaluate(button => button.click());
    }
    await page.locator('#sidebar-choice-language .btn-lang-toggle[data-lang="en"]').evaluate(button => button.click());
    await page.locator('#sidebar-choice-theme .btn-theme-toggle:not(.active)').evaluate(button => button.click());
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');

    assert.deepEqual(consoleErrors, []);
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
    // Sin servidor local: un zerochat real en el 6388 respondería 401 al token de la prueba y abriría la identificación.
    await context.route('http://127.0.0.1:6388/**', route => route.abort());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    const testToken = 'startup-token-test-12345';
    const expectedSession = { token: testToken, url: 'http://127.0.0.1:6388' };

    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#token=${testToken}&host=127.0.0.1&port=6388`, { waitUntil: 'load' });
    await waitForAppReady(page);
    const state = await page.evaluate(() => ({
      backendSession: window.ChatStorage.getBackendSession(),
      href: window.location.href,
      newTabHref: document.getElementById('btn-sidebar-new-tab').getAttribute('href')
    }));
    assert.deepEqual(state.backendSession, expectedSession, 'La sesión debe haberse guardado en la cookie');
    assert.equal(state.href.includes(testToken), false, 'La URL no debe conservar el token');
    assert.equal(state.newTabHref.includes(testToken) || state.newTabHref.includes('port='), false, 'El enlace de nueva pestaña no debe propagar la sesión');

    await page.reload({ waitUntil: 'load' });
    await waitForAppReady(page);
    assert.deepEqual(await page.evaluate(() => window.ChatStorage.getBackendSession()), expectedSession, 'F5 debe recuperar la sesión desde la cookie');

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
          window.ChatMCP.manager.connectProxy = async () => {
            window.ChatState.set('mcp', { status: 'connected', externalServers: [
              { id: 'memory', enabled: true, status: 'stopped' }
            ] });
            return { success: true };
          };
          window.ChatDialogs.confirm = async (message, options) => {
            if (options.items) {
              window.__recordStartup('mcp');
              window.__mcpOfferItems = options.items;
              return null;
            }
            window.__updateNotice = { message, options };
            window.__recordStartup('update');
            return new Promise(resolve => { window.__resolveUpdate = resolve; });
          };
        ` + source });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html#token=test-startup&host=127.0.0.1&port=6388`, { waitUntil: 'load' });
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
      assert.deepEqual(await page.evaluate(() => window.__mcpOfferItems), [{ id: 'memory', label: 'memory' }]);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stopStaticServer(server);
    }
  });
}

test('Browser - ChatVendorLoader inyecta los bundles una vez en file:// y explica el fallo sin conexión', async () => {
  await withTestApp(async page => {
    const loaded = await page.evaluate(async () => {
      window.ZeroChatOrama = undefined;
      const [a, b] = await Promise.all([ChatVendorLoader.load('orama'), ChatVendorLoader.load('orama')]);
      return {
        same: a === b && a === window.ZeroChatOrama,
        hasSearch: typeof a.search === 'function',
        injected: document.querySelectorAll('script[src="js/vendor/orama.browser.js"]').length
      };
    });
    assert.deepEqual(loaded, { same: true, hasSearch: true, injected: 2 });

    const office = await page.evaluate(async () => {
      const [mammoth, fflate] = await Promise.all(['mammoth', 'fflate'].map(id => ChatVendorLoader.load(id)));
      return { mammoth: typeof mammoth.convertToHtml, fflate: typeof fflate.unzipSync };
    });
    assert.deepEqual(office, { mammoth: 'function', fflate: 'function' });

    const failure = await page.evaluate(async () => {
      try {
        await ChatVendorLoader.load('missing-library');
        return null;
      } catch (error) {
        return { code: error.code, message: error.message, leftover: document.querySelectorAll('script[src*="missing-library"]').length };
      }
    });
    assert.equal(failure.code, 'VENDOR_UNAVAILABLE');
    assert.match(failure.message, /first use/);
    assert.equal(failure.leftover, 0);
  });
});

});
