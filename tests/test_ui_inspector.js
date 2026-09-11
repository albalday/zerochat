const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIInspector = require('../js/ui-inspector.js');
const Storage = require('../js/cookies.js');
const API = require('../js/api.js');
const State = require('../js/state.js');

test('UIInspector - getBadgeClass, getBadgeIcon y getStatusLabel', () => {
  assert.equal(UIInspector.getBadgeClass('confirmed'), 'cap-badge cap-badge-confirmed');
  assert.equal(UIInspector.getBadgeClass('unsupported'), 'cap-badge cap-badge-unsupported');
  assert.equal(UIInspector.getBadgeClass('other'), 'cap-badge cap-badge-unknown');

  assert.equal(UIInspector.getBadgeIcon('confirmed'), '✓');
  assert.equal(UIInspector.getBadgeIcon('unsupported'), '✕');

  assert.ok(UIInspector.getStatusLabel('confirmed'));
});

test('UIInspector - formatea la VRAM publicada por WebLLM sin presentarla como descarga', () => {
  assert.equal(UIInspector.formatWebLLMVram({ details: { webllmVramMB: 1536 } }), ' · VRAM aprox. 1.5 GB');
  assert.equal(UIInspector.formatWebLLMVram({ details: { webllmVramMB: null } }), '');
});

test('UIInspector - transforma progreso de shaders WebLLM en porcentaje y estado legible', () => {
  assert.deepEqual(UIInspector.parseWebLLMProgress({ text: 'Loading GPU shader modules [35/38]: 92% completed, 3 secs elapsed.' }), {
    text: 'Compilando módulos GPU 35/38 · 92 % · 3 s', percent: 92
  });
});

test('UIInspector - mantiene el catálogo WebLLM canónico al completar varios modelos', () => {
  State.reset();
  UIInspector.setWebLLMState({
    catalog: [
      { id: 'model-a', details: { webllmCache: 'incomplete' } },
      { id: 'model-b', details: { webllmCache: 'cached' } }
    ],
    contextKey: 'profile:webllm|webllm|webllm://local',
    operation: null
  });
  UIInspector.updateWebLLMModel('model-a', 'cached');
  assert.deepEqual(UIInspector.getWebLLMState().catalog.map(model => [model.id, model.details.webllmCache]), [
    ['model-a', 'cached'],
    ['model-b', 'cached']
  ]);
});

test('UIInspector - identifica el bloqueo CORS de Ollama y muestra una solución breve', () => {
  const help = UIInspector.getOllamaConnectionHelp('ollama', new Error('NetworkError when attempting to fetch resource.'));
  assert.ok(help.includes('OLLAMA_ORIGINS=*'));
  assert.equal(UIInspector.getOllamaConnectionHelp('openai', new Error('NetworkError when attempting to fetch resource.')), '');
  assert.equal(UIInspector.getOllamaConnectionHelp('ollama', new Error('HTTP 404')), '');
});

test('UIInspector - conserva el contexto activo publicado por LM Studio', () => {
  UIInspector.saveCachedModels([{
    id: 'google/gemma-4-26b-a4b-qat',
    details: { max_context_length: 262144, loaded_context_length: 90112 }
  }]);

  assert.equal(UIInspector.getModelContextLimit('google/gemma-4-26b-a4b-qat'), 90112);
});

test('UIInspector - aísla la caché de modelos por conexión', () => {
  const local = { apiType: 'openai', apiUrl: 'http://localhost:1234/v1' };
  const remote = { apiType: 'openai', apiUrl: 'https://api.example.test/v1' };
  const model = 'same-model';
  Storage.deleteStorageItem('cached_models');

  UIInspector.saveCachedModels([{ id: model, details: { loaded_context_length: 90112 } }], local);
  UIInspector.loadCachedModels({}, remote);
  assert.equal(UIInspector.getModelContextLimit(model), null);

  UIInspector.saveCachedModels([{ id: model, details: { loaded_context_length: 1048576 } }], remote);

  UIInspector.loadCachedModels({}, local);
  assert.equal(UIInspector.getModelContextLimit(model), 90112);
  UIInspector.loadCachedModels({}, remote);
  assert.equal(UIInspector.getModelContextLimit(model), 1048576);
});

test('UIInspector - handleQueryServer informa si la consulta fue satisfactoria', async () => {
  const originalFetch = API.fetchServerModels;
  API.fetchServerModels = async () => ({
    success: true,
    count: 1,
    endpoint: 'http://localhost:1234/v1/models',
    models: [{ id: 'model-a' }]
  });
  const elements = {
    btnQueryServer: {
      disabled: false,
      classList: { add() {}, remove() {} },
      querySelector: () => ({ textContent: '' })
    },
    settingApiUrl: { value: 'http://localhost:1234/v1' },
    settingApiKey: { value: '' },
    settingApiType: { value: 'openai' },
    serverQueryStatus: { style: {}, className: '', innerHTML: '', textContent: '' }
  };

  try {
    assert.equal(await UIInspector.handleQueryServer(elements, {}), true);
  } finally {
    API.fetchServerModels = originalFetch;
  }
});

test('UIInspector - populateModelList puebla datalist y selectHelper', () => {
  const datalistOptions = [];
  const selectOptions = [];

  const fakeDatalist = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => ({ tagName: tag, value: '', textContent: '' })
    },
    appendChild: (opt) => datalistOptions.push(opt)
  };

  const fakeSelectHelper = {
    innerHTML: '',
    ownerDocument: {
      createElement: (tag) => ({ tagName: tag, value: '', textContent: '', disabled: false, selected: false })
    },
    appendChild: (opt) => selectOptions.push(opt)
  };

  const fakeSettingModel = { value: '' };

  const elements = {
    modelDatalist: fakeDatalist,
    modelSelectHelper: fakeSelectHelper,
    settingModel: fakeSettingModel
  };

  const models = ['gpt-4o', 'claude-3-7-sonnet', 'gemini-2.5-flash'];
  UIInspector.populateModelList(elements, { model: '' }, models, true);

  assert.equal(datalistOptions.length, 3);
  assert.equal(datalistOptions[0].value, 'gpt-4o');

  // Primer elemento del helper es el placeholder, seguido de los 3 modelos
  assert.equal(selectOptions.length, 4);
  assert.equal(selectOptions[1].value, 'gpt-4o');

  // selectFirstIfEmpty establece el primer modelo si estaba vacío
  assert.equal(fakeSettingModel.value, 'gpt-4o');
});

test('UIInspector - populateModelList limpia opciones al no haber modelos para la conexión', () => {
  const datalistOptions = [];
  const selectOptions = [];
  const ownerDocument = {
    createElement: tag => ({ tagName: tag, value: '', textContent: '', disabled: false, selected: false })
  };
  const elements = {
    modelDatalist: {
      innerHTML: 'old options',
      ownerDocument,
      appendChild: option => datalistOptions.push(option)
    },
    modelSelectHelper: {
      innerHTML: 'old options',
      ownerDocument,
      appendChild: option => selectOptions.push(option)
    }
  };

  UIInspector.populateModelList(elements, {}, []);

  assert.equal(elements.modelDatalist.innerHTML, '');
  assert.equal(elements.modelSelectHelper.innerHTML, '');
  assert.equal(datalistOptions.length, 0);
  assert.equal(selectOptions.length, 1);
});

test('UIInspector - renderInspectorReport genera markup de metadatos y capacidades', () => {
  const fakeResultsContainer = { innerHTML: '' };
  const elements = { inspectorResults: fakeResultsContainer };

  const fakeReport = {
    provider: { id: 'openai', label: 'OpenAI Server' },
    endpoint: { normalized: 'https://api.openai.com/v1/chat/completions' },
    model: { selected: 'gpt-4o', totalDiscovered: 1 },
    inspectionTimeMs: 145,
    capabilities: {
      streaming: { status: 'confirmed', detail: 'SSE Chunks verified' },
      tools: { status: 'confirmed', detail: 'Function Calling supported' }
    }
  };

  UIInspector.renderInspectorReport(elements, fakeReport);

  assert.ok(fakeResultsContainer.innerHTML.includes('OpenAI Server'));
  assert.ok(fakeResultsContainer.innerHTML.includes('https://api.openai.com/v1/chat/completions'));
  assert.ok(fakeResultsContainer.innerHTML.includes('145 ms'));
  assert.ok(fakeResultsContainer.innerHTML.includes('cap-badge-confirmed'));
});

test('UIInspector - renderInspectorReport muestra error y no genera badges si la conexión falló', () => {
  const fakeResultsContainer = { innerHTML: '' };
  const elements = { inspectorResults: fakeResultsContainer };

  const failedReport = {
    success: false,
    connected: false,
    error: 'Error de conexión: No se pudo conectar con http://localhost:9999/v1/chat/completions (ECONNREFUSED)'
  };

  UIInspector.renderInspectorReport(elements, failedReport);

  assert.ok(fakeResultsContainer.innerHTML.includes('status-error'), 'Debe tener contenedor de error');
  assert.ok(fakeResultsContainer.innerHTML.includes('ECONNREFUSED'), 'Debe mostrar el mensaje de error');
  assert.equal(fakeResultsContainer.innerHTML.includes('cap-badge'), false, 'No debe renderizar badges de capacidades');
  assert.equal(fakeResultsContainer.innerHTML.includes('inspector-cap-grid'), false, 'No debe renderizar la cuadrícula de capacidades');
});
