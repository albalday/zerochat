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
    // El tiempo corre con normalidad salvo cuando un caso lo adelanta con runFor.
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.address().port}/zerochat.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatSandbox);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await stopStaticServer(server);
    await closeGlobalBrowser();
  });

  test('Vista previa HTML/SVG - el documento corre con origen opaco y no lee cookies ni almacenamiento de ZeroChat', async () => {
    const isolation = await page.evaluate(async () => {
      document.cookie = 'zerochat_preview_probe=1;Path=/';
      localStorage.setItem('zerochat_preview_probe', '1');
      let viewerUrl = null;
      const open = window.open;
      window.open = url => { viewerUrl = url; return null; };
      window.ChatUtils.openDocumentInNewTab(`<script>
        const read = get => { try { return String(get()); } catch (_) { return 'blocked'; } };
        top.postMessage({ origin, cookie: read(() => document.cookie), storage: read(() => localStorage.length) }, '*');
      <\/script>`);
      window.open = open;
      const report = new Promise(resolve => window.addEventListener('message', event => resolve(event.data), { once: true }));
      const frame = document.createElement('iframe');
      frame.src = viewerUrl;
      document.body.appendChild(frame);
      const data = await report;
      frame.remove();
      return data;
    });
    assert.deepEqual(isolation, { origin: 'null', cookie: 'blocked', storage: 'blocked' });
  });

  /** Ejecuta código en el sandbox real de la página. */
  const run = (code, timeoutMs) => page.evaluate(({ code, timeoutMs }) => window.ChatSandbox.execute(code, timeoutMs), { code, timeoutMs });

  test('Sandbox - devuelve resultados de sentencias, expresiones, objetos, promesas y BigInt', async () => {
    const results = await page.evaluate(async () => {
      const execute = window.ChatSandbox.execute;
      return {
        statement: await execute('const a = 10; const b = 20; return a + b;'),
        expression: await execute('Math.sqrt(144)'),
        object: await execute('({ nombre: "ZeroChat", version: 5 })'),
        bigint: await execute('function factorial(n) {\n  let result = 1n;\n  for (let i = 2n; i <= BigInt(n); i++) result *= i;\n  return result;\n}\nreturn factorial(100).toString();', {}),
        promise: await execute('return Promise.resolve(12345);'),
        asyncResult: await execute('return (async () => { return "resultado asíncrono"; })()'),
        bigintLogs: await execute('const f = n => { let r = 1n; for (let i = 2; i <= n; i++) r *= BigInt(i); return r; };\nconsole.log([22].map(n => f(n) + 333n).map(r => r.toString()));')
      };
    });
    assert.deepEqual([results.statement.success, results.statement.result, typeof results.statement.executionTimeMs], [true, '30', 'number']);
    assert.deepEqual([results.expression.success, results.expression.result], [true, '12']);
    assert.ok(results.object.result.includes('"nombre": "ZeroChat"'));
    assert.ok(results.bigint.result.startsWith('93326215443944152681699238856266700490715968264381621468592963895217599993229915608941463976156518286253697920827223758251185210916864000000000000000000000000'));
    assert.deepEqual([results.promise.result, results.asyncResult.result], ['12345', 'resultado asíncrono']);
    assert.ok(results.bigintLogs.logs[0].includes('1124000727777607680333'));
  });

  test('Sandbox - captura la consola con su nivel y devuelve los errores de ejecución', async () => {
    const logs = await run('console.log("Mensaje normal");\nconsole.info("Info log");\nconsole.warn("Alerta advertencia");\nconsole.error("Mensaje error");\nreturn 100;');
    assert.equal(logs.result, '100');
    assert.deepEqual(logs.logs, ['Mensaje normal', '[INFO] Info log', '[WARN] Alerta advertencia', '[ERROR] Mensaje error']);

    const failed = await run('throw new Error("Fallo de prueba");');
    assert.equal(failed.success, false);
    assert.match(failed.error, /Fallo de prueba/);
  });

  test('Sandbox - acota la salida a 30.000 caracteres y la consola a 200 entradas, en el borde exacto', async () => {
    const atLimit = await run('return "A".repeat(30000);');
    assert.equal(atLimit.result.length, 30000, 'En el tope exacto la salida se conserva entera');
    assert.doesNotMatch(atLimit.result, /output truncated/);
    const overLimit = await run('return "A".repeat(30001);');
    assert.equal(overLimit.result, `${'A'.repeat(30000)}... [output truncated]`);

    const logsAtLimit = await run('for (let i = 0; i < 200; i++) console.log("Log " + i);\nreturn "done";');
    assert.equal(logsAtLimit.logs.length, 200);
    const logsOverLimit = await run('for (let i = 0; i < 201; i++) console.log("Log " + i);\nreturn "done";');
    assert.equal(logsOverLimit.logs.length, 200);
    assert.equal(logsOverLimit.logs.at(-1), 'Log 199', 'Las entradas que superan el tope se descartan');
  });

  test('Sandbox - un plazo vencido termina la ejecución y retira su iframe; timeoutMs solo admite números finitos positivos', async () => {
    const loop = await run('while (true) {}', 150);
    assert.equal(loop.success, false);
    assert.match(loop.error, /timed out after 150ms/);
    assert.equal(await page.evaluate(() => document.querySelectorAll('iframe[sandbox="allow-scripts"]').length), 0,
      'No deben quedar iframes residuales tras el plazo');

    await page.evaluate(() => {
      const neverEnds = 'return new Promise(() => {});';
      const invalid = [{ timeoutMs: 50 }, NaN, -1, 0, Infinity, '50'];
      window.__timeouts = Promise.all(invalid.map(value => window.ChatSandbox.execute(neverEnds, value)));
    });
    await page.clock.runFor(2500);
    for (const result of await page.evaluate(() => window.__timeouts)) {
      assert.equal(result.success, false);
      assert.match(result.error, /timed out after 2500ms/);
    }
  });

  test('Sandbox - el código no recibe la red, la ventana, el almacenamiento ni la mensajería, no crea funciones desde un constructor y rechaza llamadas sin código', async () => {
    const globals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'window', 'parent', 'document', 'localStorage', 'postMessage'];
    const probe = await run(`return [${globals.map(name => `typeof ${name}`).join(', ')}, typeof self.fetch].join(",");`);
    assert.equal(probe.result, Array(globals.length + 1).fill('undefined').join(','));
    const escape = await run('return ({}).constructor.constructor("return 42")();');
    assert.equal(escape.success, false);
    assert.match(escape.error, /Dynamic function creation is not allowed/);
    assert.equal(await page.evaluate(() => Function.prototype.constructor === Function), true, 'El constructor de la página no cambia');
    assert.match((await run('')).error, /No JavaScript code was provided/);
    assert.match((await run(42)).error, /No JavaScript code was provided/);
  });
});
