const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sandbox = require('../js/sandbox.js');

test('Sandbox - Ejecución normal y retorno', async () => {
  const res = await Sandbox.execute('const a = 10; const b = 20; return a + b;');
  assert.equal(res.success, true);
  assert.equal(res.result, '30');
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

test('Sandbox - Manejo de expresiones matemáticas y estructuras', async () => {
  const res = await Sandbox.execute('Math.sqrt(144)');
  assert.equal(res.success, true);
  assert.equal(res.result, '12');

  const objRes = await Sandbox.execute('({ nombre: "ZeroChat", version: 5 })');
  assert.equal(objRes.success, true);
  assert.ok(objRes.result.includes('"nombre": "ZeroChat"'));
});

test('Sandbox - Protección contra salida excesiva (MAX_OUTPUT_LENGTH)', async () => {
  // Generar un string gigante que supere MAX_OUTPUT_LENGTH (30.000 caracteres)
  const code = 'return "A".repeat(40000);';
  const res = await Sandbox.execute(code);
  assert.equal(res.success, true);
  assert.ok(res.result.length <= Sandbox.MAX_OUTPUT_LENGTH + 50, 'El resultado debe estar truncado');
  assert.ok(res.result.includes('[Salida truncada'), 'Debe incluir indicador de truncamiento');
});

test('Sandbox - Protección contra exceso de llamadas a consola (MAX_LOG_ENTRIES)', async () => {
  const code = `
    for (let i = 0; i < 500; i++) {
      console.log("Log número " + i);
    }
    return "done";
  `;
  const res = await Sandbox.execute(code);
  assert.equal(res.success, true);
  assert.ok(res.logs.length <= Sandbox.MAX_LOG_ENTRIES, `No debe superar ${Sandbox.MAX_LOG_ENTRIES} entradas`);
});

test('Sandbox - Límite de tiempo (Timeout) y terminación forzada del Worker', async () => {
  let terminated = false;

  global.Blob = class MockBlob {
    constructor(chunks, options) {
      this.chunks = chunks;
      this.options = options;
    }
  };

  global.URL = {
    createObjectURL: () => 'blob:mock-worker-url',
    revokeObjectURL: () => {}
  };

  global.Worker = class MockWorker {
    constructor(url) {
      this.url = url;
    }
    postMessage(data) {
      // Simular Worker atascado en un bucle infinito que nunca responde
    }
    terminate() {
      terminated = true;
    }
  };

  try {
    const res = await Sandbox.execute('while (true) {}', 50);
    assert.equal(res.success, false);
    assert.match(res.error, /Timeout/i);
    assert.equal(terminated, true, 'El Worker debe ser terminado forzosamente con worker.terminate() al expirar el timeout');
  } finally {
    delete global.Worker;
    delete global.Blob;
  }
});

test('Sandbox - Aislamiento y terminación de Web Worker cuando está disponible', async () => {
  let terminated = false;
  let postedMessage = null;

  // Mock de Worker y Blob para verificar el ciclo de vida del Web Worker
  global.Blob = class MockBlob {
    constructor(chunks, options) {
      this.chunks = chunks;
      this.options = options;
    }
  };

  global.URL = {
    createObjectURL: () => 'blob:mock-worker-url',
    revokeObjectURL: () => {}
  };

  global.Worker = class MockWorker {
    constructor(url) {
      this.url = url;
    }
    postMessage(data) {
      postedMessage = data;
      // Simular respuesta asíncrona del Worker
      setTimeout(() => {
        if (!terminated && this.onmessage) {
          this.onmessage({
            data: {
              id: data.id,
              success: true,
              result: '42',
              logs: ['Log desde worker']
            }
          });
        }
      }, 10);
    }
    terminate() {
      terminated = true;
    }
  };

  try {
    const res = await Sandbox.execute('return 42;');
    assert.equal(res.success, true);
    assert.equal(res.result, '42');
    assert.equal(terminated, true, 'El Worker debe ser terminado tras completar la ejecución');
    assert.ok(postedMessage && postedMessage.code === 'return 42;');
  } finally {
    delete global.Worker;
    delete global.Blob;
  }
});

test('Sandbox - Factorial 100 con BigInt y paso de opciones sin TimeoutNaNWarning', async () => {
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
});

test('Sandbox - Soporte de resolución de Promesas y expresiones asíncronas', async () => {
  const res = await Sandbox.execute('return Promise.resolve(12345);');
  assert.equal(res.success, true);
  assert.equal(res.result, '12345');

  const resAsync = await Sandbox.execute('return (async () => { return "resultado asíncrono"; })()');
  assert.equal(resAsync.success, true);
  assert.equal(resAsync.result, 'resultado asíncrono');
});

test('Sandbox - Factorial con BigInt y array map en console.log (código del usuario)', async () => {
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
});

test('Sandbox - Ejecución de WORKER_CODE real dentro de un Worker con postMessage activo', async () => {
  let workerBlobCode = '';
  global.Blob = class MockBlob {
    constructor(chunks) {
      workerBlobCode = chunks.join('');
      this.chunks = chunks;
    }
  };

  global.URL = {
    createObjectURL: () => 'blob:mock-worker-url',
    revokeObjectURL: () => {}
  };

  let terminated = false;
  global.Worker = class MockWorker {
    constructor() {
      const mockSelf = {
        onmessage: null,
        postMessage: (data) => {
          if (this.onmessage) this.onmessage({ data });
        }
      };
      const initWorker = new Function('self', workerBlobCode);
      initWorker(mockSelf);
      this._mockSelf = mockSelf;
    }
    postMessage(data) {
      if (this._mockSelf.onmessage) {
        this._mockSelf.onmessage({ data });
      }
    }
    terminate() {
      terminated = true;
    }
  };

  try {
    const userCode = `
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
    const res = await Sandbox.execute(userCode);
    assert.equal(res.success, true);
    assert.ok(res.logs.length > 0);
    assert.ok(res.logs[0].includes('1124000727777607680333'));
    assert.equal(terminated, true);
  } finally {
    delete global.Worker;
    delete global.Blob;
    delete global.URL;
  }
});

test('Sandbox - Neutralización de escape por prototipos ({}.constructor.constructor) en Worker', async () => {
  let workerBlobCode = '';
  global.Blob = class MockBlob {
    constructor(chunks) {
      workerBlobCode = chunks.join('');
      this.chunks = chunks;
    }
  };
  global.URL = {
    createObjectURL: () => 'blob:mock-worker-url',
    revokeObjectURL: () => {}
  };

  global.Worker = class MockWorker {
    constructor() {
      const mockSelf = {
        onmessage: null,
        postMessage: (data) => {
          if (this.onmessage) this.onmessage({ data });
        }
      };
      const initWorker = new Function('self', workerBlobCode);
      initWorker(mockSelf);
      this._mockSelf = mockSelf;
    }
    postMessage(data) {
      if (this._mockSelf.onmessage) {
        this._mockSelf.onmessage({ data });
      }
    }
    terminate() {}
  };

  try {
    const escapeCode = 'return ({}).constructor.constructor("return 42")();';
    const res = await Sandbox.execute(escapeCode);
    assert.equal(res.success, false);
    assert.match(res.error, /creación dinámica de funciones está restringida/i);
  } finally {
    delete global.Worker;
    delete global.Blob;
    delete global.URL;
  }
});

test('Sandbox - Neutralización de APIs de red y Worker en prototipo de Worker', async () => {
  let workerBlobCode = '';
  global.Blob = class MockBlob {
    constructor(chunks) {
      workerBlobCode = chunks.join('');
      this.chunks = chunks;
    }
  };
  global.URL = {
    createObjectURL: () => 'blob:mock-worker-url',
    revokeObjectURL: () => {}
  };

  const mockSelf = {
    fetch: () => 'leak',
    importScripts: () => 'leak',
    onmessage: null,
    postMessage: (data) => {}
  };
  global.self = mockSelf;

  global.Worker = class MockWorker {
    constructor() {
      mockSelf.postMessage = (data) => {
        if (this.onmessage) this.onmessage({ data });
      };
      const initWorker = new Function('self', workerBlobCode);
      initWorker(mockSelf);
      this._mockSelf = mockSelf;
    }
    postMessage(data) {
      if (this._mockSelf.onmessage) {
        this._mockSelf.onmessage({ data });
      }
    }
    terminate() {}
  };

  try {
    const probeCode = 'return { fetchType: typeof fetch, importScriptsType: typeof importScripts, selfFetch: typeof self.fetch };';
    const res = await Sandbox.execute(probeCode);
    assert.equal(res.success, true);
    assert.match(res.result, /"fetchType":\s*"undefined"/);
    assert.match(res.result, /"importScriptsType":\s*"undefined"/);
    assert.match(res.result, /"selfFetch":\s*"undefined"/);
  } finally {
    delete global.Worker;
    delete global.Blob;
    delete global.URL;
    delete global.self;
  }
});



