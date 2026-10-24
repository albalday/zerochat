const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer, waitForAppReady } = require('../helpers/browser-env.js');

// Ajustes › Conexión y el diálogo de identificación sobre la aplicación real: el servidor local,
// detrás de un proxy inverso, se simula en la red de la página.

const BACKEND = 'https://zerochat.example';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Accept, Authorization, X-ZeroChat-Token, X-ZeroChat-Client, X-ZeroChat-Proxy'
};

after(closeGlobalBrowser);

/** Servidor local falso: exige el token diario salvo para zerochat/login y registra cada petición. */
async function routeBackend(page) {
  const requests = [];
  await page.route(`${BACKEND}/**`, async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const headers = request.headers();
    const { id, method, params } = JSON.parse(request.postData());
    requests.push({ method, headers, params });
    const json = (status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    const reply = result => json(200, { jsonrpc: '2.0', id, result });
    if (method === 'zerochat/login') {
      return params.password === 'buena'
        ? reply({ token: 'token-de-hoy' })
        : json(200, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Usuario o contraseña incorrectos.' } });
    }
    if (headers['x-zerochat-token'] !== 'token-de-hoy') return json(401, { error: 'Unauthorized' });
    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'ZeroChat Local Server', version: '9.10', cwd: '/srv/proyecto', os: 'linux' },
        capabilities: { tools: {} },
        liveState: { cwd: '/srv/proyecto', jobs: [], exit_on_close: false, servers: [] }
      });
    }
    return reply(method === 'tools/list' ? { tools: [] } : {});
  });
  return requests;
}

test('Browser UI - Conectar pide identificarse ante un 401 y guarda el token diario sin la contraseña', { timeout: 30000 }, async () => {
  const server = await startStaticServer();
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const requests = await routeBackend(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html`, { waitUntil: 'load' });
    await waitForAppReady(page);
    assert.deepEqual(requests, [], 'sin sesión guardada no se conecta al arrancar');

    // La conexión se abre con su icono en la cabecera de la lista de chats, no desde las secciones de Ajustes.
    assert.equal(await page.locator('#sidebar-settings-nav [data-section="connection"]').count(), 0);
    await page.locator('#btn-open-connection').evaluate(button => button.click());
    await page.waitForSelector('#settings-connection.active');
    const t = key => page.evaluate(name => window.ChatI18n.t(name), key);

    // Sin configuración, la conexión es la local y oculta los datos de un servidor remoto.
    assert.equal(await page.isChecked('#setting-local-backend'), true);
    assert.equal(await page.isVisible('#setting-backend-url'), false);
    await page.locator('#setting-local-backend').evaluate(input => input.click());
    assert.equal(await page.isVisible('#setting-backend-url'), true);

    // Una URL con ruta o el proxy sin clave no se aplican ni se prueban.
    await page.fill('#setting-backend-url', `${BACKEND}/zerochat`);
    await page.click('#btn-backend-connect');
    assert.equal(await page.textContent('#backend-connection-error'), await t('connection_invalid_url'));
    await page.fill('#setting-backend-url', BACKEND);
    await page.locator('#setting-use-proxy').evaluate(input => input.click());
    assert.equal(await page.isVisible('#setting-proxy-key'), true);
    await page.click('#btn-backend-connect');
    assert.equal(await page.textContent('#backend-connection-error'), await t('connection_proxy_key_missing'));
    assert.deepEqual(requests, []);

    // Sin token, el servidor responde 401 y se abre la identificación.
    await page.fill('#setting-proxy-key', 'clave-caddy');
    await page.click('#btn-backend-connect');
    await page.waitForFunction(() => document.getElementById('login-dialog').open);
    assert.equal(await page.evaluate(() => window.ChatState.get('mcp').status), 'login_required');
    assert.match(await page.textContent('#login-desc'), /zerochat\.example/);

    await page.fill('#login-user', 'ana');
    await page.fill('#login-password', 'mala');
    await page.click('#login-submit');
    await page.waitForFunction(text => document.getElementById('login-error').textContent === text, await t('login_failed'));
    assert.equal(await page.inputValue('#login-password'), '', 'la contraseña no se conserva tras el intento');

    await page.fill('#login-password', 'buena');
    await page.click('#login-submit');
    await page.waitForFunction(() => !document.getElementById('login-dialog').open && window.ChatState.get('mcp').status === 'connected');

    const stored = await page.evaluate(() => ({
      session: window.ChatStorage.getBackendSession(),
      config: window.ChatConfig.getActive(),
      everything: JSON.stringify({ ...localStorage }) + document.cookie
    }));
    assert.deepEqual(stored.session, { token: 'token-de-hoy', url: BACKEND });
    assert.deepEqual([stored.config.localBackend, stored.config.backendUrl, stored.config.useProxy, stored.config.proxyKey], [false, BACKEND, true, 'clave-caddy']);
    assert.equal(stored.everything.includes('buena'), false, 'la contraseña no se guarda');
    // Con el proxy, Authorization lleva su clave y X-ZeroChat-Proxy lo enruta; el token va en X-ZeroChat-Token.
    for (const request of requests) {
      assert.equal(request.headers['x-zerochat-proxy'], '1', request.method);
      assert.equal(request.headers.authorization, 'Bearer clave-caddy', request.method);
    }
    assert.match(await page.textContent('#backend-connection-status'), /ZeroChat Local Server 9\.10/);
  } finally {
    await browser.close();
    await stopStaticServer(server);
  }
});
