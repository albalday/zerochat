const { test } = require('node:test');
const assert = require('node:assert/strict');
const ChatSandbox = require('../../js/sandbox.js');

test('Sandbox Node - devuelve resultados de sentencias, expresiones, objetos, promesas y BigInt', async () => {
  const statement = await ChatSandbox.execute('const a = 10; const b = 20; return a + b;');
  assert.equal(statement.success, true);
  assert.equal(statement.result, '30');
  assert.equal(typeof statement.executionTimeMs, 'number');

  const expression = await ChatSandbox.execute('Math.sqrt(144)');
  assert.equal(expression.success, true);
  assert.equal(expression.result, '12');

  const obj = await ChatSandbox.execute('({ nombre: "ZeroChat", version: 5 })');
  assert.equal(obj.success, true);
  assert.ok(obj.result.includes('"nombre": "ZeroChat"'));

  const bigint = await ChatSandbox.execute(`
    function factorial(n) {
      let result = 1n;
      for (let i = 2n; i <= BigInt(n); i++) result *= i;
      return result;
    }
    return factorial(100).toString();
  `);
  assert.equal(bigint.success, true);
  assert.ok(bigint.result.startsWith('93326215443944152681699238856266700490715968264381621468592963895217599993229915608941463976156518286253697920827223758251185210916864000000000000000000000000'));

  const promise = await ChatSandbox.execute('return Promise.resolve(12345);');
  assert.equal(promise.success, true);
  assert.equal(promise.result, '12345');

  const asyncRes = await ChatSandbox.execute('return (async () => "resultado asíncrono")();');
  assert.equal(asyncRes.success, true);
  assert.equal(asyncRes.result, 'resultado asíncrono');
});

test('Sandbox Node - captura la consola con su nivel y devuelve errores de ejecución', async () => {
  const logs = await ChatSandbox.execute('console.log("Mensaje normal");\nconsole.info("Info log");\nconsole.warn("Alerta advertencia");\nconsole.error("Mensaje error");\nreturn 100;');
  assert.equal(logs.success, true);
  assert.equal(logs.result, '100');
  assert.deepEqual(logs.logs, ['Mensaje normal', '[INFO] Info log', '[WARN] Alerta advertencia', '[ERROR] Mensaje error']);

  const failed = await ChatSandbox.execute('throw new Error("Fallo de prueba");');
  assert.equal(failed.success, false);
  assert.match(failed.error, /Fallo de prueba/);
});

test('Sandbox Node - acota la salida a 30.000 caracteres y la consola a 200 entradas en el borde exacto', async () => {
  const atLimit = await ChatSandbox.execute('return "A".repeat(30000);');
  assert.equal(atLimit.result.length, 30000);
  assert.doesNotMatch(atLimit.result, /output truncated/);

  const overLimit = await ChatSandbox.execute('return "A".repeat(30001);');
  assert.equal(overLimit.result, `${'A'.repeat(30000)}... [output truncated]`);

  const logsAtLimit = await ChatSandbox.execute('for (let i = 0; i < 200; i++) console.log("Log " + i);\nreturn "done";');
  assert.equal(logsAtLimit.logs.length, 200);

  const logsOverLimit = await ChatSandbox.execute('for (let i = 0; i < 201; i++) console.log("Log " + i);\nreturn "done";');
  assert.equal(logsOverLimit.logs.length, 200);
  assert.equal(logsOverLimit.logs.at(-1), 'Log 199');
});

test('Sandbox Node - un plazo vencido termina la ejecución y devuelve error consistente', async () => {
  const syncLoop = await ChatSandbox.execute('while (true) {}', 100);
  assert.equal(syncLoop.success, false);
  assert.match(syncLoop.error, /timed out after 100ms/);

  const asyncHang = await ChatSandbox.execute('return new Promise(() => {});', 100);
  assert.equal(asyncHang.success, false);
  assert.match(asyncHang.error, /timed out after 100ms/);

  const asyncLoop = await ChatSandbox.execute('while (true) { await Promise.resolve(); }', 100);
  assert.equal(asyncLoop.success, false);
  assert.match(asyncLoop.error, /timed out after 100ms/);
});

test('Sandbox Node - aísla el entorno de Node (sin process ni require), bloquea escapes de constructor y valida código', async () => {
  const probe = await ChatSandbox.execute('return [typeof process, typeof require, typeof fetch].join(",");');
  assert.equal(probe.success, true);
  assert.equal(probe.result, 'undefined,undefined,undefined');

  const escape = await ChatSandbox.execute('return ({}).constructor.constructor("return 42")();');
  assert.equal(escape.success, false);
  assert.match(escape.error, /Dynamic function creation is not allowed/);

  assert.match((await ChatSandbox.execute('')).error, /No JavaScript code was provided/);
  assert.match((await ChatSandbox.execute(42)).error, /No JavaScript code was provided/);
});
