const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIInspector = require('../../js/ui-inspector.js');
const UISettings = require('../../js/ui-settings.js');
const Storage = require('../../js/storage.js');
const API = require('../../js/api.js');
const State = require('../../js/state.js');
const WebLLM = require('../../js/providers-webllm.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Editor de perfiles real, sin caché de modelos ni modelos WebLLM descargados. */
function setup(t, { apiType = 'openai', apiUrl = 'http://localhost:1234/v1', model = '' } = {}) {
  const dom = installDom({ app: true });
  UISettings.ensureDialogMarkup();
  State.reset();
  Storage.deleteStorageItem('cached_models');
  Storage.deleteStorageItem(WebLLM.COMPLETED_MODELS_STORAGE_KEY);
  const elements = getAppElements(document);
  require('../../js/debug.js').setElements(elements);
  elements.settingApiType.value = apiType;
  elements.settingApiUrl.value = apiUrl;
  elements.settingModel.value = model;
  t.after(() => dom.restore());
  return elements;
}

/** Sustituye la consulta de modelos del servidor; devuelve las URL consultadas. */
function stubModels(t, models, extra = {}) {
  const urls = [];
  t.mock.method(API, 'fetchServerModels', async url => {
    urls.push(url);
    return { success: true, count: models.length, endpoint: `${url}/models`, models, ...extra };
  });
  return urls;
}

const optionValues = select => [...select.querySelectorAll('option')].map(option => option.value);

test('UIInspector - consultar el servidor rellena la lista, elige el primero y usa el endpoint por defecto', async t => {
  const elements = setup(t, { apiUrl: '' });
  const urls = stubModels(t, [{ id: 'gpt-4o' }, { id: 'claude-3-7-sonnet' }]);

  assert.equal(await UIInspector.handleQueryServer(elements, {}), true);
  assert.deepEqual(urls, ['http://localhost:1234/v1']);
  assert.equal(elements.settingApiUrl.value, 'http://localhost:1234/v1');
  assert.deepEqual(optionValues(elements.modelDatalist), ['gpt-4o', 'claude-3-7-sonnet']);
  assert.deepEqual(optionValues(elements.modelSelectHelper), ['', 'gpt-4o', 'claude-3-7-sonnet']);
  assert.equal(elements.settingModel.value, 'gpt-4o');
  assert.match(elements.serverQueryStatus.className, /status-success/);
  assert.equal(elements.btnQueryServer.disabled, false);
});

test('UIInspector - un bloqueo CORS de Ollama muestra cómo permitir el origen', async t => {
  const elements = setup(t, { apiType: 'ollama', apiUrl: 'http://localhost:11434' });
  t.mock.method(API, 'fetchServerModels', async () => ({ success: false, error: 'NetworkError when attempting to fetch resource.' }));
  assert.equal(await UIInspector.handleQueryServer(elements, {}), false);
  assert.match(elements.serverQueryStatus.textContent, /OLLAMA_ORIGINS=\*/);

  elements.settingApiType.value = 'openai';
  assert.equal(await UIInspector.handleQueryServer(elements, {}), false);
  assert.doesNotMatch(elements.serverQueryStatus.textContent, /OLLAMA_ORIGINS/);
});

test('UIInspector - la caché de modelos es propia de cada conexión y conserva el contexto cargado', async t => {
  const elements = setup(t);
  const local = { apiType: 'openai', apiUrl: 'http://localhost:1234/v1' };
  const remote = { apiType: 'openai', apiUrl: 'https://api.example.test/v1' };
  stubModels(t, [{ id: 'same-model', details: { max_context_length: 262144, loaded_context_length: 90112 } }]);
  await UIInspector.handleQueryServer(elements, {});

  UIInspector.loadCachedModels(elements, remote);
  assert.equal(UIInspector.getModelContextLimit('same-model'), null);
  UIInspector.loadCachedModels(elements, local);
  assert.equal(UIInspector.getModelContextLimit('same-model'), 90112, 'El contexto cargado manda sobre el nominal');
});

test('UIInspector - getModelContextLimit reconoce los formatos de contexto sin recortar por max_tokens', () => {
  const catalog = [
    { id: 'model-openrouter', details: { context_length: 128000 } },
    { id: 'model-vllm', details: { max_model_len: 65536 } },
    { id: 'model-window', details: { context_window: 16384 } },
    { id: 'gemma', details: { meta: { n_ctx: 128000, n_ctx_train: 262144 } } },
    { id: 'solo-train', details: { meta: { n_ctx_train: 262144 } } },
    { id: 'ambos', details: { context_length: 200000, meta: { n_ctx: 128000 } } },
    { id: 'con-max-tokens', details: { max_context_length: 131072, max_tokens: 4096 } },
    { id: 'solo-max-tokens', details: { max_tokens: 8192 } },
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', details: { webllmCache: 'cached' } }
  ];
  const expected = {
    'model-openrouter': 128000, 'model-vllm': 65536, 'model-window': 16384, gemma: 128000, 'solo-train': 262144,
    ambos: 128000, 'con-max-tokens': 131072, 'solo-max-tokens': 8192, 'Llama-3.2-1B-Instruct-q4f16_1-MLC': 4096, 'Other-Model-MLC': 4096, unknown: null
  };
  for (const [model, limit] of Object.entries(expected)) {
    assert.equal(UIInspector.getModelContextLimit(model, catalog), limit, model);
  }
});

test('UIInspector - con WebLLM solo se eligen modelos descargados y estos aparecen primero', async t => {
  const elements = setup(t, { apiType: 'webllm', apiUrl: 'webllm://local', model: 'not-downloaded' });
  stubModels(t, [
    { id: 'not-downloaded', details: { webllmCache: 'missing', webllmVramMB: 1536 } },
    { id: 'downloaded', details: { webllmCache: 'cached' } }
  ]);
  assert.equal(await UIInspector.handleQueryServer(elements, {}), true);
  assert.deepEqual(optionValues(elements.modelDatalist), ['downloaded']);
  assert.equal(elements.settingModel.value, 'downloaded');

  const rows = [...elements.serverQueryStatus.querySelectorAll('.webllm-model-row span')].map(span => span.textContent);
  assert.match(rows[0], /^downloaded · /);
  assert.match(rows[1], /^not-downloaded · .* · VRAM aprox\. 1\.5 GB$/);
});

test('UIInspector - descargar un modelo WebLLM muestra el progreso y lo deja elegible', async t => {
  const elements = setup(t, { apiType: 'webllm', apiUrl: 'webllm://local' });
  stubModels(t, [{ id: 'model-a', details: { webllmCache: 'missing' } }]);
  await UIInspector.handleQueryServer(elements, {});
  let finish;
  const progressTexts = [];
  t.mock.method(API, 'downloadLocalModel', (id, onProgress) => new Promise(resolve => {
    onProgress({ text: 'Loading GPU shader modules [35/38]: 92% completed, 3 secs elapsed.' });
    progressTexts.push(elements.serverQueryStatus.querySelector('.webllm-model-row span').textContent);
    finish = resolve;
  }));

  elements.serverQueryStatus.querySelector('.webllm-model-action').click();
  await settle();
  assert.deepEqual(progressTexts, ['model-a · Compilando módulos GPU 35/38 · 92 % · 3 s']);
  assert.equal(elements.serverQueryStatus.querySelector('.webllm-model-progress').value, 92);

  finish(true);
  await settle();
  assert.match(elements.serverQueryStatus.querySelector('.webllm-model-row span').textContent, /^model-a · Descargado/);
  assert.deepEqual(optionValues(elements.modelDatalist), ['model-a']);
  assert.equal(State.get('ui').webllm.operation, null);
});

test('UIInspector - un error de WebLLM sin mensaje legible muestra el texto predeterminado', async t => {
  const elements = setup(t, { apiType: 'webllm', apiUrl: 'webllm://local' });
  stubModels(t, [{ id: 'model-a', details: { webllmCache: 'incomplete' } }]);
  await UIInspector.handleQueryServer(elements, {});
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { confirm: async () => true };
  t.after(() => { globalThis.ChatDialogs = previousDialogs; });
  t.mock.method(console, 'error', () => {});

  t.mock.method(API, 'deleteLocalModel', async () => { throw new Error('[object Object]'); });
  elements.serverQueryStatus.querySelectorAll('.webllm-model-action')[1].click();
  await settle();
  assert.equal(elements.serverQueryStatus.querySelector('.webllm-model-row span').textContent, 'model-a · No se pudo borrar el modelo.');

  // Tras un fallo, las demás acciones siguen bloqueadas hasta volver a consultar.
  await UIInspector.handleQueryServer(elements, {});
  t.mock.method(API, 'downloadLocalModel', async () => { throw new Error('', { cause: new Error('Error: WebGPU device lost') }); });
  elements.serverQueryStatus.querySelector('.webllm-model-action').click();
  await settle();
  assert.equal(elements.serverQueryStatus.querySelector('.webllm-model-row span').textContent, 'model-a · WebGPU device lost');
});

test('UIInspector - el inspector localiza el modelo por id, sin prefijo models/ ni :latest y por ruta', async t => {
  const elements = setup(t);
  stubModels(t, [{ id: 'google/gemma-4-26b-a4b-qat' }, { id: 'llama3.2:latest' }, { id: 'models/gemini-2.5-flash' }, { id: 'Qwen/Qwen2.5-Coder-7B' }]);
  t.mock.method(API, 'inspectProvider', async () => ({ success: true, capabilities: {} }));
  const cases = {
    'llama3.2': 'llama3.2:latest',
    'gemini-2.5-flash': 'models/gemini-2.5-flash',
    'qwen/qwen2.5-coder-7b': 'Qwen/Qwen2.5-Coder-7B',
    'gemma-4-26b-a4b-qat': 'google/gemma-4-26b-a4b-qat'
  };
  for (const [requested, found] of Object.entries(cases)) {
    assert.equal(await UIInspector.handleRunInspector(elements, {}, { settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: requested } }), true, requested);
    assert.equal(elements.inspectorResults.querySelector('.inspector-model-title strong').textContent, found);
  }
  assert.equal(await UIInspector.handleRunInspector(elements, {}, { settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'inexistente' } }), false);
  assert.match(elements.inspectorResults.querySelector('.status-error').textContent, /inexistente/);
});

test('UIInspector - el inspector usa la conexión indicada y muestra contexto, razonamiento y capacidades', async t => {
  const elements = setup(t, { apiUrl: 'http://editor.invalid/v1' });
  stubModels(t, [{ id: 'qwen2.5-coder-32b', details: { context_length: 32768 } }]);
  let received = null;
  t.mock.method(API, 'inspectProvider', async config => {
    received = config;
    return {
      success: true,
      provider: { id: 'openai', label: 'Custom & Provider' },
      endpoint: { normalized: config.apiUrl },
      model: { selected: 'Model & <Name>', totalDiscovered: 0 },
      capabilities: { streaming: { status: 'confirmed', detail: 'SSE verified' }, tools: { status: 'odd' } },
      inspectionTimeMs: 42
    };
  });

  const ok = await UIInspector.handleRunInspector(elements, {}, {
    settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', apiKey: 'profile-key', model: 'qwen2.5-coder-32b', reasoningEffort: 'high' }
  });

  assert.equal(ok, true);
  assert.deepEqual(received, { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', apiKey: 'profile-key', model: 'qwen2.5-coder-32b' });
  const results = elements.inspectorResults;
  const values = [...results.querySelectorAll('.inspector-model-section .meta-value')].map(value => value.textContent);
  assert.match(values[0], new RegExp(`${(32768).toLocaleString()} tokens`));
  assert.match(values[1], /Alto/);
  assert.equal(results.querySelector('.inspector-header-meta .meta-value').textContent, 'Custom & Provider');
  assert.ok(results.textContent.includes('Model & <Name>'), 'Los datos del informe se muestran como texto');
  assert.ok(results.textContent.includes('42 ms'));
  assert.ok(results.querySelector('.cap-badge-confirmed'));
  assert.equal(results.querySelectorAll('.inspector-cap-card .cap-badge-unknown').length, 7, 'Un estado desconocido o ausente cuenta como desconocido');
});

test('UIInspector - el inspector informa de un modelo ausente, una consulta fallida o un endpoint que no responde', async t => {
  const elements = setup(t);
  const run = model => UIInspector.handleRunInspector(elements, {}, { settings: { apiUrl: 'http://localhost:9999/v1', apiType: 'openai', model } });

  assert.equal(await run(''), false);
  assert.ok(elements.inspectorResults.querySelector('.status-error'));

  t.mock.method(API, 'fetchServerModels', async () => ({ success: false, error: 'ECONNREFUSED: Server is offline' }));
  assert.equal(await run('llama3'), false);
  assert.match(elements.inspectorResults.querySelector('.status-error').textContent, /ECONNREFUSED/);

  stubModels(t, [{ id: 'llama3' }]);
  t.mock.method(API, 'inspectProvider', async () => ({ success: false, connected: false, error: 'Endpoint unreachable' }));
  assert.equal(await run('llama3'), true);
  assert.ok(elements.inspectorResults.querySelector('.inspector-model-section'));
  assert.match(elements.inspectorResults.querySelector('.status-error').textContent, /Endpoint unreachable/);
  assert.equal(elements.inspectorResults.querySelector('.inspector-cap-grid'), null);
});
