const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, startStaticServer, stopStaticServer } = require('../helpers/browser-env.js');

describe('Browser UI - Sandbox Security & Iframe Isolation', () => {
  // Los casos comparten una página: cada ejecución crea y destruye su propio iframe aislado.
  let server;
  let browser;
  let page;

  before(async () => {
    server = await startStaticServer();
    browser = await createTestBrowser();
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatSandbox);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await stopStaticServer(server);
    await closeGlobalBrowser();
  });

  test('Sandbox - Ejecución básica en navegador real mediante iframe aislado', async () => {
    const res = await page.evaluate(async () => {
      return await window.ChatSandbox.execute('const a = 12; const b = 8; return a * b;');
    });

    assert.equal(res.success, true);
    assert.equal(res.result, '96');
    assert.ok(typeof res.executionTimeMs === 'number');
  });

  test('Sandbox - Bloqueo de acceso al almacenamiento y DOM de la ventana principal (SecurityError)', async () => {
    // Simular almacenamiento de secreto en la ventana principal
    await page.evaluate(() => {
      localStorage.setItem('zerochat_test_secret', 'token-12345');
    });

    // Intentar leer desde el código del sandbox
    const probeResult = await page.evaluate(async () => {
      const code = `
        let report = {};
        try {
          report.parentStorage = window.parent.localStorage.getItem('zerochat_test_secret');
        } catch(e) {
          report.parentStorage = 'BLOCKED: ' + e.message;
        }
        try {
          report.parentDoc = window.parent.document.title;
        } catch(e) {
          report.parentDoc = 'BLOCKED: ' + e.message;
        }
        return report;
      `;
      return await window.ChatSandbox.execute(code);
    });

    assert.equal(probeResult.success, true);
    assert.ok(probeResult.result.includes('BLOCKED'), 'El acceso al parent debe ser bloqueado');
    assert.ok(!probeResult.result.includes('token-12345'), 'El secreto no debe ser accesible');
  });

  test('Sandbox - Bloqueo de llamadas de red por política CSP (connect-src none)', async () => {
    const netResult = await page.evaluate(async () => {
      const code = `
        try {
          await fetch('https://example.com/api/leak');
          return 'ALLOWED';
        } catch(e) {
          return 'BLOCKED: ' + e.message;
        }
      `;
      return await window.ChatSandbox.execute(code);
    });

    assert.equal(netResult.success, true);
    assert.ok(netResult.result.includes('BLOCKED'), 'Las peticiones de red deben estar bloqueadas por CSP');
  });

  test('Sandbox - Bloqueo de acceso a IndexedDB por origen opaco', async () => {
    const dbResult = await page.evaluate(async () => {
      const code = `
        try {
          indexedDB.open('malicious_db', 1);
          return 'ALLOWED';
        } catch(e) {
          return 'BLOCKED: ' + e.message;
        }
      `;
      return await window.ChatSandbox.execute(code);
    });

    assert.equal(dbResult.success, true);
    assert.ok(dbResult.result.includes('BLOCKED'), 'IndexedDB debe ser denegado en contexto opaco');
  });

  test('Sandbox - Terminación forzada y limpieza de recursos ante bucle infinito', async () => {
    const timeoutResult = await page.evaluate(async () => {
      return await window.ChatSandbox.execute('while(true) {}', 150);
    });

    assert.equal(timeoutResult.success, false);
    assert.match(timeoutResult.error, /Timeout|excedido/i);

    // Verificar que el iframe fue removido del DOM
    const lingeringIframes = await page.evaluate(() => {
      return document.querySelectorAll('iframe[sandbox="allow-scripts"]').length;
    });
    assert.equal(lingeringIframes, 0, 'No deben quedar iframes residuales tras el timeout');
  });
});

