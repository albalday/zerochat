const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sandbox = require('../../js/sandbox.js');

test('Sandbox - devuelve resultados de sentencias, expresiones, objetos, promesas y BigInt (también con opciones vacías)', async () => {
  {
    const res = await Sandbox.execute('const a = 10; const b = 20; return a + b;');
    assert.equal(res.success, true);
    assert.equal(res.result, '30');
  }

  {
    const res = await Sandbox.execute('Math.sqrt(144)');
    assert.equal(res.success, true);
    assert.equal(res.result, '12');

    const objRes = await Sandbox.execute('({ nombre: "ZeroChat", version: 5 })');
    assert.equal(objRes.success, true);
    assert.ok(objRes.result.includes('"nombre": "ZeroChat"'));
  }

  {
    const code = `
function factorial(n) {
  let result = 1n;
  for (let i = 2n; i <= BigInt(n); i++) {
    result *= i;
  }
  return result;
}

const fact100 = factorial(100);
console.log(fact100.toString());
return fact100.toString();
  `;

    const res = await Sandbox.execute(code, {});
    assert.equal(res.success, true);
    assert.ok(res.result.startsWith('93326215443944152681699238856266700490715968264381621468592963895217599993229915608941463976156518286253697920827223758251185210916864000000000000000000000000'));
  }

  {
    const res = await Sandbox.execute('return Promise.resolve(12345);');
    assert.equal(res.success, true);
    assert.equal(res.result, '12345');

    const resAsync = await Sandbox.execute('return (async () => { return "resultado asíncrono"; })()');
    assert.equal(resAsync.success, true);
    assert.equal(resAsync.result, 'resultado asíncrono');
  }

  {
    const code = `
function factorial(n) {
  let res = BigInt(1);
  for (let i = 2; i <= n; i++) res *= BigInt(i);
  return res;
}

const numbers = [22, 23, 24, 25, 26];
const results = numbers.map(n => {
  return factorial(n) + 333n;
});

console.log(results.map(r => r.toString()));
`;
    const res = await Sandbox.execute(code);
    assert.equal(res.success, true);
    assert.ok(res.logs.length > 0);
    assert.ok(res.logs[0].includes('1124000727777607680333'));
  }
});

test('Sandbox - Captura de logs de consola (log, info, warn, error)', async () => {
  const code = `
    console.log("Mensaje normal");
    console.info("Info log");
    console.warn("Alerta advertencia");
    console.error("Mensaje error");
    return 100;
  `;
  const res = await Sandbox.execute(code);
  assert.equal(res.success, true);
  assert.equal(res.result, '100');
  assert.equal(res.logs.length, 4);
  assert.ok(res.logs[0].includes('Mensaje normal'));
  assert.ok(res.logs[1].includes('[INFO] Info log'));
  assert.ok(res.logs[2].includes('[WARN] Alerta advertencia'));
  assert.ok(res.logs[3].includes('[ERROR] Mensaje error'));
});

test('Sandbox - Manejo de errores de sintaxis o runtime', async () => {
  const res = await Sandbox.execute('throw new Error("Fallo de prueba");');
  assert.equal(res.success, false);
  assert.match(res.error, /Fallo de prueba/);
});

test('Sandbox - acota la salida a 30.000 caracteres y la consola a 200 entradas', async () => {
  {
    // Una cadena mayor que el límite de salida (30.000 caracteres)
    const code = 'return "A".repeat(40000);';
    const res = await Sandbox.execute(code);
    assert.equal(res.success, true);
    assert.ok(res.result.length <= 30000 + 50, 'El resultado debe estar truncado');
    assert.ok(res.result.includes('[output truncated]'), 'Debe incluir indicador de truncamiento');
  }

  {
    const code = `
    for (let i = 0; i < 500; i++) {
      console.log("Log número " + i);
    }
    return "done";
  `;
    const res = await Sandbox.execute(code);
    assert.equal(res.success, true);
    assert.equal(res.logs.length, 200);
  }
});

test('Sandbox - un plazo vencido termina la ejecución; timeoutMs solo admite números finitos positivos', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const neverEnds = 'return new Promise(() => {});';
  for (const invalid of [{ timeoutMs: 50 }, NaN, -1, 0, Infinity, '50']) {
    const pending = Sandbox.execute(neverEnds, invalid);
    t.mock.timers.tick(2500);
    const res = await pending;
    assert.equal(res.success, false);
    assert.match(res.error, /timed out after 2500ms/, `valor ${String(invalid)}`);
  }

  const pending = Sandbox.execute(neverEnds, 75);
  t.mock.timers.tick(75);
  assert.match((await pending).error, /timed out after 75ms/);
});

test('Sandbox - sin DOM el código no recibe las APIs de la ventana ni de red', async () => {
  const res = await Sandbox.execute('return [typeof fetch, typeof window, typeof localStorage, typeof postMessage].join(",");');
  assert.equal(res.success, true);
  assert.equal(res.result, 'undefined,undefined,undefined,undefined');
});

test('Sandbox - no se escapa creando funciones desde el constructor de un objeto', async () => {
  const res = await Sandbox.execute('return ({}).constructor.constructor("return 42")();');
  assert.equal(res.success, false);
  assert.match(res.error, /Dynamic function creation is not allowed/);
  assert.equal(Function.prototype.constructor, Function, 'El constructor se restaura al terminar');
});

test('Sandbox - rechaza una llamada sin código', async () => {
  assert.match((await Sandbox.execute('')).error, /No JavaScript code was provided/);
  assert.match((await Sandbox.execute(42)).error, /No JavaScript code was provided/);
});
