const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

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

describe('Browser UI - Sandbox Security & Iframe Isolation', () => {
  let server;
  let baseUrl;
  let browser;

  test('setup test environment', async () => {
    server = await startStaticServer();
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/zerochat.html`;
    browser = await createTestBrowser();
  });

  after(async () => {
    if (server) await stopStaticServer(server);
    await closeGlobalBrowser();
  });

  test('Sandbox - Ejecución básica en navegador real mediante iframe aislado', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatSandbox);

      const res = await page.evaluate(async () => {
        return await window.ChatSandbox.execute('const a = 12; const b = 8; return a * b;');
      });

      assert.equal(res.success, true);
      assert.equal(res.result, '96');
      assert.ok(typeof res.executionTimeMs === 'number');
    } finally {
      await page.close();
    }
  });

  test('Sandbox - Bloqueo de acceso al almacenamiento y DOM de la ventana principal (SecurityError)', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatSandbox);

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
    } finally {
      await page.close();
    }
  });

  test('Sandbox - Bloqueo de llamadas de red por política CSP (connect-src none)', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatSandbox);

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
    } finally {
      await page.close();
    }
  });

  test('Sandbox - Bloqueo de acceso a IndexedDB por origen opaco', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatSandbox);

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
    } finally {
      await page.close();
    }
  });

  test('Sandbox - Terminación forzada y limpieza de recursos ante bucle infinito', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatSandbox);

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
    } finally {
      await page.close();
    }
  });
});

