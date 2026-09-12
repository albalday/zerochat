const { test } = require('node:test');
const assert = require('node:assert/strict');

const previousNavigator = global.navigator;
const previousIndexedDB = global.indexedDB;
const previousCaches = global.caches;
const previousChatStorage = global.ChatStorage;
Object.defineProperty(global, 'navigator', { value: { gpu: {} }, configurable: true });
Object.defineProperty(global, 'indexedDB', { value: undefined, configurable: true });
Object.defineProperty(global, 'caches', { value: {}, configurable: true });
const storageValues = new Map([['webllm_completed_models_v1', '["test-model"]']]);
global.ChatStorage = {
  getStorageItem: key => storageValues.get(key) || null,
  setStorageItem: (key, value) => storageValues.set(key, value)
};
const WebLLM = require('../js/providers-webllm.js');
const API = require('../js/api.js');

function fakeModule(overrides = {}) {
  return {
  prebuiltAppConfig: { model_list: [{ model_id: 'test-model', vram_required_MB: 1536 }] },
    hasModelInCache: async () => false,
    CreateMLCEngine: async () => ({ unload: async () => {} }),
    ...overrides
  };
}

let cached = true;
let observedAppConfig = null;
let createdEngines = 0;
const completionPayloads = [];

async function drain(body) {
  const reader = body.getReader();
  while (!(await reader.read()).done) { /* consume the complete stream */ }
}

test.after(() => {
  Object.defineProperty(global, 'navigator', { value: previousNavigator, configurable: true });
  Object.defineProperty(global, 'indexedDB', { value: previousIndexedDB, configurable: true });
  Object.defineProperty(global, 'caches', { value: previousCaches, configurable: true });
  global.ChatStorage = previousChatStorage;
});

test('WebLLM - el catálogo usa Cache Storage por defecto sin requerir IndexedDB', async () => {
  const result = await WebLLM.listModels({ loader: async () => fakeModule({
    hasModelInCache: async (_model, appConfig) => {
      observedAppConfig = appConfig;
      return cached;
    },
    deleteModelAllInfoInCache: async () => { cached = false; },
    CreateMLCEngine: async () => ({
      unload: async () => {},
      chat: { completions: { create: async function* (payload) {
        completionPayloads.push(payload);
        yield { choices: [{ delta: { content: 'ok' } }] };
      } } }
    })
  }) });
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(observedAppConfig, 'useIndexedDBCache'), false);
  assert.equal(result.endpoint, 'webllm://local');
  assert.deepEqual(result.models[0], {
    id: 'test-model', name: 'test-model', details: { webllmCache: 'cached', webllmVramMB: 1536 }
  });
});

test('WebLLM - borrar un modelo elimina su caché y no lo declara disponible', async () => {
  cached = true;
  assert.equal(await WebLLM.adapter.deleteModel('test-model'), true);
  assert.equal(cached, false);
});

test('WebLLM - el catálogo exige una descarga confirmada antes de ofrecer el modelo', async () => {
  const originalStorage = global.ChatStorage;
  const values = new Map([[WebLLM.COMPLETED_MODELS_STORAGE_KEY, '[]']]);
  global.ChatStorage = {
    getStorageItem: key => values.get(key) || null,
    setStorageItem: (key, value) => values.set(key, value)
  };
  try {
    cached = true;
    let result = await WebLLM.listModels();
    assert.equal(result.models[0].details.webllmCache, 'incomplete');
    values.set(WebLLM.COMPLETED_MODELS_STORAGE_KEY, '["test-model"]');
    result = await WebLLM.listModels();
    assert.equal(result.models[0].details.webllmCache, 'cached');
  } finally {
    global.ChatStorage = originalStorage;
  }
});

test('WebLLM - expone getCompletedModelIds e isModelCompleted y ordena descargados al inicio', async () => {
  const originalStorage = global.ChatStorage;
  const values = new Map([[WebLLM.COMPLETED_MODELS_STORAGE_KEY, '["model-b"]']]);
  global.ChatStorage = {
    getStorageItem: key => values.get(key) || null,
    setStorageItem: (key, value) => values.set(key, value)
  };
  const webllm = await WebLLM.loadWebLLM();
  const previousModelList = webllm.prebuiltAppConfig.model_list;
  const previousHasModel = webllm.hasModelInCache;
  try {
    assert.deepEqual(WebLLM.getCompletedModelIds(), ['model-b']);
    assert.equal(WebLLM.isModelCompleted('model-b'), true);
    assert.equal(WebLLM.isModelCompleted('model-a'), false);

    assert.deepEqual(WebLLM.adapter.getCompletedModelIds(), ['model-b']);
    assert.equal(WebLLM.adapter.isModelCompleted('model-b'), true);
    assert.equal(WebLLM.adapter.isModelCompleted('model-a'), false);

    webllm.prebuiltAppConfig.model_list = [
      { model_id: 'model-a', vram_required_MB: 1024 },
      { model_id: 'model-b', vram_required_MB: 2048 }
    ];
    webllm.hasModelInCache = async (id) => id === 'model-b';

    const result = await WebLLM.listModels();

    assert.equal(result.models.length, 2);
    assert.equal(result.models[0].id, 'model-b');
    assert.equal(result.models[0].details.webllmCache, 'cached');
    assert.equal(result.models[1].id, 'model-a');
  } finally {
    webllm.prebuiltAppConfig.model_list = previousModelList;
    webllm.hasModelInCache = previousHasModel;
    global.ChatStorage = originalStorage;
  }
});

test('WebLLM - la ejecución incompleta falla antes de crear un motor', async () => {
  const webllm = await WebLLM.loadWebLLM();
  const originalCreate = webllm.CreateMLCEngine;
  let engineCreated = false;
  cached = true;
  storageValues.set(WebLLM.COMPLETED_MODELS_STORAGE_KEY, '[]');
  webllm.CreateMLCEngine = async () => {
    engineCreated = true;
    return originalCreate();
  };
  try {
    const adapter = new WebLLM.WebLLMProviderAdapter();
    await assert.rejects(adapter.createStreamResponse({ payload: { model: 'test-model', messages: [] } }), /no está disponible por completo/);
    assert.equal(engineCreated, false);
  } finally {
    webllm.CreateMLCEngine = originalCreate;
    storageValues.set(WebLLM.COMPLETED_MODELS_STORAGE_KEY, '["test-model"]');
  }
});

test('WebLLM - omite por defecto parámetros no garantizados y permite probar none explícitamente', () => {
  const adapter = new WebLLM.WebLLMProviderAdapter();
  const payload = adapter.buildPayload({
    model: 'test-model', messages: [{ role: 'user', content: 'hello' }], reasoningEffort: 'high',
    toolsList: [{ type: 'function', function: { name: 'tool' } }]
  });
  assert.equal(adapter.normalizeEndpoint(), 'webllm://local');
  assert.equal(adapter.getCapabilities().tools, false);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(payload.tools, undefined);
  assert.equal(payload.stream_options, undefined);
  assert.equal(adapter.getReasoningConfig().transportOptions.includes('send-none'), true);

  const experimentalPayload = adapter.buildPayload({
    model: 'test-model', messages: [], reasoningEffort: 'none', reasoningTransport: 'send-none'
  });
  assert.equal(experimentalPayload.reasoning_effort, 'none');
});

test('WebLLM - no fuerza valores de razonamiento distintos de none', () => {
  const adapter = new WebLLM.WebLLMProviderAdapter();
  const payload = adapter.buildPayload({
    model: 'test-model', messages: [], reasoningEffort: 'high', reasoningTransport: 'send-none'
  });
  assert.equal(payload.reasoning_effort, undefined);
});

test('WebLLM - reutiliza el motor ya cargado entre turnos del mismo modelo', async () => {
  cached = true;
  storageValues.set(WebLLM.COMPLETED_MODELS_STORAGE_KEY, '["test-model"]');
  const manager = new WebLLM.WebLLMEngineManager(async () => {
    createdEngines += 1;
    return {
      engine: {
        unload: async () => {},
        chat: { completions: { create: async function* (payload) {
          completionPayloads.push(payload);
          yield { choices: [{ delta: { content: 'ok' } }] };
        } } }
      },
      release: async () => {}
    };
  });
  const adapter = new WebLLM.WebLLMProviderAdapter({ engineManager: manager });
  try {
    completionPayloads.length = 0;
    const request = content => adapter.createStreamResponse({ payload: { model: 'test-model', messages: [{ role: 'user', content }] } });
    const first = await request('first conversation');
    await drain(first.body);
    const second = await request('second conversation');
    await drain(second.body);
    assert.equal(createdEngines, 1);
    assert.deepEqual(completionPayloads.map(payload => payload.messages[0].content), ['first conversation', 'second conversation']);
  } finally {
    await adapter.disposeActiveEngine();
  }
});

test('WebLLM - no oculta como fallback un error real de preparación', async () => {
  const originalWorker = global.Worker;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let mainThreadEngineCreated = false;
  global.Worker = class {
    addEventListener() {}
    removeEventListener() {}
    terminate() {}
  };
  URL.createObjectURL = () => 'blob:test-webllm-worker';
  URL.revokeObjectURL = () => {};
  try {
    const originalError = new Error('GPU allocation failed');
    await assert.rejects(WebLLM.createWorkerEngine({
      CreateWebWorkerMLCEngine: async () => { throw originalError; },
      CreateMLCEngine: async () => {
        mainThreadEngineCreated = true;
        return { unload: async () => {} };
      }
    }, 'test-model', {}, () => {}), error => error === originalError);
    for (const detail of ['SecurityError: Cache Storage access denied', 'NS_ERROR_FILE_NO_DEVICE_SPACE']) {
      await assert.rejects(WebLLM.createWorkerEngine({
        CreateWebWorkerMLCEngine: async () => { throw detail; }
      }, 'test-model', {}, () => {}), error => {
        assert.equal(error.message, detail);
        assert.equal(error.cause, detail);
        assert.notEqual(error.code, 'WEBLLM_WORKER_UNAVAILABLE');
        return true;
      });
    }
    assert.equal(mainThreadEngineCreated, false);
  } finally {
    global.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('WebLLM - el gestor cancela una preparación pendiente al desactivarse', async () => {
  let cancelled = false;
  const manager = new WebLLM.WebLLMEngineManager((_webllm, _model, _config, _progress, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      cancelled = true;
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    }, { once: true });
  }));
  const pending = manager.acquire({}, 'model-a', {}, () => {});
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await manager.dispose();
  await rejected;
  assert.equal(cancelled, true);
});

test('WebLLM - rechaza sin iniciar un motor principal si no hay Web Worker', async () => {
  const originalWorker = global.Worker;
  let mainThreadEngineCreated = false;
  global.Worker = undefined;
  try {
    await assert.rejects(WebLLM.createWorkerEngine({
      CreateMLCEngine: async () => { mainThreadEngineCreated = true; }
    }, 'test-model', {}, () => {}), error => error.code === 'WEBLLM_WORKER_UNAVAILABLE');
    assert.equal(mainThreadEngineCreated, false);
  } finally {
    global.Worker = originalWorker;
  }
});

test('WebLLM - no usa el motor principal si el worker no puede arrancar', async () => {
  const originalWorker = global.Worker;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let terminated = false;
  global.Worker = class {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
      if (type === 'error') queueMicrotask(() => handler({ message: 'Failed to fetch dynamically imported module' }));
    }
    removeEventListener(type) { this.listeners.delete(type); }
    terminate() { terminated = true; }
  };
  URL.createObjectURL = () => 'blob:test-webllm-worker';
  URL.revokeObjectURL = () => {};
  try {
    let mainThreadEngineCreated = false;
    await assert.rejects(WebLLM.createWorkerEngine({
      CreateWebWorkerMLCEngine: async () => new Promise(() => {}),
      CreateMLCEngine: async () => {
        mainThreadEngineCreated = true;
        return { unload: async () => {} };
      }
    }, 'test-model', {}, () => {}), error => error.code === 'WEBLLM_WORKER_UNAVAILABLE');
    assert.equal(mainThreadEngineCreated, false);
    assert.equal(terminated, true);
  } finally {
    global.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('WebLLM - ChatAPI usa el transporte local sin fetch y conserva el streaming SSE', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('No debe haber tráfico HTTP para WebLLM'); };
  const originalCreate = WebLLM.adapter.createStreamResponse;
  try {
    WebLLM.adapter.createStreamResponse = async () => ({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"local"}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      })
    });
    const result = await API.streamChatCompletion({
      apiType: 'webllm', apiUrl: 'webllm://local', model: 'test-model', messages: [], onDone: async () => {}
    });
    assert.equal(result.accumulatedText, 'local');
  } finally {
    WebLLM.adapter.createStreamResponse = originalCreate;
    global.fetch = originalFetch;
  }
});

test('WebLLM - transformEsmToClassic convierte exportaciones a asignación global self.webllm', () => {
  const esm = 'const x = 1, y = 2;\nexport { x as Chat, y as Engine };\n//# sourceMappingURL=test.map\n';
  const classic = WebLLM.transformEsmToClassic(esm);
  assert.equal(classic.includes('export {'), false);
  assert.equal(classic.includes('"Chat": x'), true);
  assert.equal(classic.includes('"Engine": y'), true);
  assert.equal(classic.includes('self.webllm = exp'), true);

  // Si no hay export, devuelve el código intacto
  assert.equal(WebLLM.transformEsmToClassic('console.log("no export");'), 'console.log("no export");');
});

test('WebLLM - getOrFetchClassicBundle respeta la política de caché semanal (7 días) y fallback offline', async () => {
  const originalFetch = global.fetch;
  const originalCaches = global.caches;
  WebLLM.resetMemoryBundle();

  let fetchCalls = 0;
  let returnedEsm = 'const a = 1; export { a as WebWorkerMLCEngineHandler };';
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => returnedEsm
    };
  };

  const cacheStorageMap = new Map();
  Object.defineProperty(global, 'caches', {
    value: {
      open: async (name) => ({
        match: async (url) => cacheStorageMap.get(`${name}:${url}`) || null,
        put: async (url, response) => {
          const body = await response.text();
          cacheStorageMap.set(`${name}:${url}`, {
            text: async () => body,
            headers: {
              get: (h) => h === 'x-cached-at' ? response.headers.get('x-cached-at') : null
            }
          });
        }
      })
    },
    configurable: true
  });

  try {
    // 1. Primera llamada: debe realizar fetch y guardar en caché
    const first = await WebLLM.getOrFetchClassicBundle({ forceRefresh: true });
    assert.equal(fetchCalls, 1);
    assert.equal(first.includes('self.webllm = exp'), true);

    // 2. Segunda llamada dentro del TTL: debe usar la versión cacheada sin llamar a fetch
    const second = await WebLLM.getOrFetchClassicBundle();
    assert.equal(fetchCalls, 1);
    assert.equal(second, first);

    // 3. Simular expiración de TTL (> 7 días) y limpiar memoria
    WebLLM.resetMemoryBundle();
    const oldTimestamp = (Date.now() - (WebLLM.CACHE_TTL_MS + 10000)).toString();
    const cachedEntry = cacheStorageMap.get(`${WebLLM.BUNDLE_CACHE_NAME}:https://zerochat.local/webllm-runtime-bundle.js`);
    assert.ok(cachedEntry, 'Debe existir la entrada en cacheStorageMap');
    cachedEntry.headers.get = (h) => h === 'x-cached-at' ? oldTimestamp : null;

    // 4. Llamada tras expiración: debe llamar a fetch de nuevo
    returnedEsm = 'const b = 2; export { b as WebWorkerMLCEngineHandler };';
    const refreshed = await WebLLM.getOrFetchClassicBundle();
    assert.equal(fetchCalls, 2);
    assert.equal(refreshed.includes('"WebWorkerMLCEngineHandler": b'), true);

    // 5. Fallback offline: expira el TTL pero la red falla -> debe retornar la versión en caché sin lanzar error
    WebLLM.resetMemoryBundle();
    cachedEntry.headers.get = (h) => h === 'x-cached-at' ? oldTimestamp : null;
    global.fetch = async () => { throw new Error('Offline / Network error'); };
    const offlineFallback = await WebLLM.getOrFetchClassicBundle();
    assert.equal(offlineFallback.includes('"WebWorkerMLCEngineHandler": b'), true);
  } finally {
    global.fetch = originalFetch;
    Object.defineProperty(global, 'caches', { value: originalCaches, configurable: true });
    WebLLM.resetMemoryBundle();
  }
});

test('WebLLM - createWorkerEngine no incluye type: module en el Worker para compatibilidad con file:// en Chrome', async () => {
  const originalWorker = global.Worker;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  let workerConstructorOptions = 'UNSET';
  global.Worker = class {
    constructor(url, options) {
      workerConstructorOptions = options;
      this.listeners = new Map();
    }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    removeEventListener(type) { this.listeners.delete(type); }
    terminate() {}
  };
  URL.createObjectURL = () => 'blob:test-classic-worker';
  URL.revokeObjectURL = () => {};

  try {
    let engineCreated = false;
    await WebLLM.createWorkerEngine({
      CreateWebWorkerMLCEngine: async () => {
        engineCreated = true;
        return { unload: async () => {} };
      }
    }, 'test-model', {}, () => {});

    assert.equal(engineCreated, true);
    assert.equal(workerConstructorOptions, undefined, 'El worker clásico no debe pasar { type: "module" }');
  } finally {
    global.Worker = originalWorker;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

