const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIInspector = require('../../js/ui-inspector.js');
const Storage = require('../../js/cookies.js');
const API = require('../../js/api.js');
const State = require('../../js/state.js');

test('UIInspector - getBadgeClass, getBadgeIcon y getStatusLabel', () => {
  assert.equal(UIInspector.getBadgeClass('confirmed'), 'cap-badge cap-badge-confirmed');
  assert.equal(UIInspector.getBadgeClass('unsupported'), 'cap-badge cap-badge-unsupported');
  assert.equal(UIInspector.getBadgeClass('other'), 'cap-badge cap-badge-unknown');

  assert.equal(UIInspector.getBadgeIcon('confirmed'), '✓');
  assert.equal(UIInspector.getBadgeIcon('unsupported'), '✕');

  assert.ok(UIInspector.getStatusLabel('confirmed'));
});

test('UIInspector - formatea VRAM y progreso de shaders de WebLLM', () => {
  assert.equal(UIInspector.formatWebLLMVram({ details: { webllmVramMB: 1536 } }), ' · VRAM aprox. 1.5 GB');
  assert.equal(UIInspector.formatWebLLMVram({ details: { webllmVramMB: null } }), '');

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

test('UIInspector - sortWebLLMModels y loadCachedModels sitúan los modelos descargados en primer lugar', () => {
  const models = [
    { id: 'model-x', details: { webllmCache: 'missing' } },
    { id: 'model-y', details: { webllmCache: 'cached' } },
    { id: 'model-z', details: { webllmCache: 'incomplete' } }
  ];
  const sorted = UIInspector.sortWebLLMModels(models);
  assert.equal(sorted[0].id, 'model-y');
  assert.equal(sorted[0].details.webllmCache, 'cached');
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

test('UIInspector - getModelContextLimit reconoce WebLLM, context_length, max_model_len y n_ctx sin recortar por max_tokens', () => {
  {
    UIInspector.saveCachedModels([{
      id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      details: { webllmCache: 'cached', loaded_context_length: 4096 }
    }], { apiType: 'webllm', apiUrl: 'webllm://local' });

    assert.equal(UIInspector.getModelContextLimit('Llama-3.2-1B-Instruct-q4f16_1-MLC'), 4096);
    assert.equal(UIInspector.getModelContextLimit('Other-Model-MLC'), 4096);
  }

  {
    const catalog = [
      { id: 'model-openrouter', details: { context_length: 128000 } },
      { id: 'model-vllm', details: { max_model_len: 65536 } },
      { id: 'model-window', details: { context_window: 16384 } }
    ];

    assert.equal(UIInspector.getModelContextLimit('model-openrouter', catalog), 128000);
    assert.equal(UIInspector.getModelContextLimit('model-vllm', catalog), 65536);
    assert.equal(UIInspector.getModelContextLimit('model-window', catalog), 16384);
  }

  {
    const catalog = [
      {
        id: 'gemma-4-26B-A4B-it-QAT-Q4_0',
        details: {
          meta: { n_ctx: 128000, n_ctx_train: 262144, n_params: 25233142046 }
        }
      },
      {
        id: 'solo-train',
        details: { meta: { n_ctx_train: 262144 } }
      },
      {
        id: 'ambos-formatos',
        details: { context_length: 200000, meta: { n_ctx: 128000 } }
      }
    ];

    assert.equal(UIInspector.getModelContextLimit('gemma-4-26B-A4B-it-QAT-Q4_0', catalog), 128000);
    assert.equal(UIInspector.getModelContextLimit('solo-train', catalog), 262144);
    // Con ambos presentes, el contexto activo del servidor tiene precedencia
    assert.equal(UIInspector.getModelContextLimit('ambos-formatos', catalog), 128000);
  }

  {
    const catalog = [
      {
        id: 'model-with-max-tokens',
        details: { max_context_length: 131072, max_tokens: 4096 }
      },
      {
        id: 'model-with-context-and-tokens',
        details: { context_length: 65536, max_tokens: 2048 }
      },
      {
        id: 'model-with-train-and-tokens',
        details: { meta: { n_ctx_train: 128000 }, max_tokens: 4096 }
      },
      {
        id: 'model-only-max-tokens',
        details: { max_tokens: 8192 }
      }
    ];

    assert.equal(UIInspector.getModelContextLimit('model-with-max-tokens', catalog), 131072);
    assert.equal(UIInspector.getModelContextLimit('model-with-context-and-tokens', catalog), 65536);
    assert.equal(UIInspector.getModelContextLimit('model-with-train-and-tokens', catalog), 128000);
    assert.equal(UIInspector.getModelContextLimit('model-only-max-tokens', catalog), 8192);
  }
});

test('UIInspector - handleQueryServer informa del resultado y usa el endpoint por defecto si apiUrl está vacío', async () => {
  {
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
  }

  {
    let queriedUrl = '';
    const originalFetch = API.fetchServerModels;
    API.fetchServerModels = async (url) => {
      queriedUrl = url;
      return {
        success: true,
        count: 1,
        endpoint: url,
        models: [{ id: 'model-fallback' }]
      };
    };
    const elements = {
      btnQueryServer: {
        disabled: false,
        classList: { add() {}, remove() {} },
        querySelector: () => ({ textContent: '' })
      },
      settingApiUrl: { value: '' },
      settingApiKey: { value: '' },
      settingApiType: { value: 'openai' },
      serverQueryStatus: { style: {}, className: '', innerHTML: '', textContent: '' }
    };

    try {
      const result = await UIInspector.handleQueryServer(elements, {});
      assert.equal(result, true);
      assert.equal(elements.settingApiUrl.value, 'http://localhost:1234/v1');
      assert.equal(queriedUrl, 'http://localhost:1234/v1');
    } finally {
      API.fetchServerModels = originalFetch;
    }
  }
});

test('UIInspector - inspecciona la conexión proporcionada sin usar los campos del editor', async () => {
  const originalInspect = API.inspectProvider;
  const originalFetch = API.fetchServerModels;
  let receivedConfig = null;
  API.fetchServerModels = async () => ({
    success: true,
    models: [{ id: 'profile-model', details: { context_length: 8192 } }]
  });
  API.inspectProvider = async (config) => {
    receivedConfig = config;
    return {
      success: true,
      provider: 'openai',
      endpoint: { normalized: config.apiUrl },
      model: { selected: config.model, totalDiscovered: 1 },
      capabilities: {},
      inspectionTimeMs: 1
    };
  };
  const elements = {
    settingApiUrl: { value: 'http://editor.invalid/v1' },
    inspectorResults: { style: {}, innerHTML: '' }
  };

  try {
    await UIInspector.handleRunInspector(elements, {}, {
      settings: { apiUrl: 'https://profile.example/v1', apiType: 'openai', apiKey: 'profile-key', model: 'profile-model' }
    });
    assert.deepEqual(receivedConfig, {
      apiUrl: 'https://profile.example/v1', apiType: 'openai', apiKey: 'profile-key', model: 'profile-model'
    });
    assert.ok(elements.inspectorResults.innerHTML.includes('inspector-model-section'));
    assert.ok(elements.inspectorResults.innerHTML.includes('profile-model'));
  } finally {
    API.inspectProvider = originalInspect;
    API.fetchServerModels = originalFetch;
  }
});

test('UIInspector - handleRunInspector muestra error si falta modelo, falla la consulta o el modelo no existe', async () => {
  {
    const elements = {
      inspectorResults: { style: {}, innerHTML: '' }
    };
    const result = await UIInspector.handleRunInspector(elements, {}, {
      settings: { apiUrl: 'https://profile.example/v1', apiType: 'openai', model: '' }
    });
    assert.equal(result, false);
    assert.ok(elements.inspectorResults.innerHTML.includes('status-error'));
  }

  {
    const originalFetch = API.fetchServerModels;
    API.fetchServerModels = async () => ({
      success: false,
      error: 'ECONNREFUSED: Server is offline'
    });
    const elements = {
      inspectorResults: { style: {}, innerHTML: '' }
    };
    try {
      const result = await UIInspector.handleRunInspector(elements, {}, {
        settings: { apiUrl: 'http://localhost:9999/v1', apiType: 'openai', model: 'llama3' }
      });
      assert.equal(result, false);
      assert.ok(elements.inspectorResults.innerHTML.includes('status-error'));
      assert.ok(elements.inspectorResults.innerHTML.includes('ECONNREFUSED'));
    } finally {
      API.fetchServerModels = originalFetch;
    }
  }

  {
    const originalFetch = API.fetchServerModels;
    API.fetchServerModels = async () => ({
      success: true,
      models: [{ id: 'mistral-7b' }, { id: 'qwen2.5' }]
    });
    const elements = {
      inspectorResults: { style: {}, innerHTML: '' }
    };
    try {
      const result = await UIInspector.handleRunInspector(elements, {}, {
        settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'non-existent-model' }
      });
      assert.equal(result, false);
      assert.ok(elements.inspectorResults.innerHTML.includes('status-error'));
      assert.ok(elements.inspectorResults.innerHTML.includes('non-existent-model'));
    } finally {
      API.fetchServerModels = originalFetch;
    }
  }
});

test('UIInspector - handleRunInspector consulta primero, captura contexto y razonamiento, muestra resultados abreviados y resumen general', async () => {
  const originalFetch = API.fetchServerModels;
  const originalInspect = API.inspectProvider;
  let queryCalled = false;
  let inspectCalled = false;

  API.fetchServerModels = async (url) => {
    queryCalled = true;
    return {
      success: true,
      count: 1,
      endpoint: `${url}/models`,
      models: [
        {
          id: 'qwen2.5-coder-32b',
          details: { context_length: 32768 }
        }
      ]
    };
  };

  API.inspectProvider = async (config) => {
    inspectCalled = true;
    assert.equal(queryCalled, true, 'El query debe ejecutarse antes de la inspección general');
    return {
      success: true,
      provider: { id: 'openai', label: 'OpenAI / LM Studio' },
      endpoint: { normalized: config.apiUrl },
      model: { selected: config.model, totalDiscovered: 1 },
      capabilities: {
        streaming: { status: 'confirmed', detail: 'OK' }
      },
      inspectionTimeMs: 42
    };
  };

  const elements = {
    inspectorResults: { style: {}, innerHTML: '' }
  };

  try {
    const res = await UIInspector.handleRunInspector(elements, {}, {
      settings: {
        apiUrl: 'http://localhost:1234/v1',
        apiType: 'openai',
        model: 'qwen2.5-coder-32b',
        reasoningEffort: 'high'
      }
    });

    assert.equal(res, true);
    assert.equal(queryCalled, true);
    assert.equal(inspectCalled, true);
    // Verificamos resultados abreviados del modelo
    assert.ok(elements.inspectorResults.innerHTML.includes('inspector-model-section'), 'Debe incluir la sección abreviada del modelo');
    assert.ok(elements.inspectorResults.innerHTML.includes('qwen2.5-coder-32b'), 'Debe mostrar el nombre del modelo');
    assert.ok(elements.inspectorResults.innerHTML.includes(`${(32768).toLocaleString()} tokens`), 'Debe mostrar el tamaño de contexto capturado');
    // Verificamos el resumen general del endpoint posterior
    assert.ok(elements.inspectorResults.innerHTML.includes('inspector-endpoint-section'), 'Debe incluir la sección del endpoint');
    assert.ok(elements.inspectorResults.innerHTML.includes('inspector-cap-grid'), 'Debe incluir la cuadrícula de capacidades');
  } finally {
    API.fetchServerModels = originalFetch;
    API.inspectProvider = originalInspect;
  }
});

test('UIInspector - findModelInCatalog resuelve coincidencias exactas, insensibles a mayúsculas y prefijos', () => {
  const catalog = [
    { id: 'google/gemma-4-26b-a4b-qat' },
    { id: 'llama3.2:latest' },
    { id: 'models/gemini-2.5-flash' },
    { id: 'Qwen/Qwen2.5-Coder-7B' }
  ];

  assert.equal(UIInspector.findModelInCatalog(catalog, 'google/gemma-4-26b-a4b-qat')?.id, 'google/gemma-4-26b-a4b-qat');
  assert.equal(UIInspector.findModelInCatalog(catalog, 'llama3.2')?.id, 'llama3.2:latest');
  assert.equal(UIInspector.findModelInCatalog(catalog, 'gemini-2.5-flash')?.id, 'models/gemini-2.5-flash');
  assert.equal(UIInspector.findModelInCatalog(catalog, 'qwen/qwen2.5-coder-7b')?.id, 'Qwen/Qwen2.5-Coder-7B');
  assert.equal(UIInspector.findModelInCatalog(catalog, 'gemma-4-26b-a4b-qat')?.id, 'google/gemma-4-26b-a4b-qat');
  assert.equal(UIInspector.findModelInCatalog(catalog, 'inexistente'), null);
});

test('UIInspector - populateModelList puebla, limpia por conexión y para WebLLM solo ofrece descargados', () => {
  {
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
  }

  {
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
  }

  {
    const datalistOptions = [];
    const selectOptions = [];
    const ownerDocument = {
      createElement: tag => ({ tagName: tag, value: '', textContent: '', disabled: false, selected: false })
    };
    const fakeSettingApiType = { value: 'webllm' };
    const fakeSettingModel = { value: 'not-downloaded-model' };
    const elements = {
      settingApiType: fakeSettingApiType,
      settingModel: fakeSettingModel,
      modelDatalist: {
        innerHTML: '',
        ownerDocument,
        appendChild: option => datalistOptions.push(option)
      },
      modelSelectHelper: {
        innerHTML: '',
        ownerDocument,
        appendChild: option => selectOptions.push(option)
      }
    };

    const models = [
      { id: 'not-downloaded-model', details: { webllmCache: 'missing' } },
      { id: 'downloaded-model', details: { webllmCache: 'cached' } }
    ];

    UIInspector.populateModelList(elements, { apiType: 'webllm' }, models, false);

    assert.equal(datalistOptions.length, 1);
    assert.equal(datalistOptions[0].value, 'downloaded-model');
    assert.equal(selectOptions.length, 2);
    assert.equal(selectOptions[1].value, 'downloaded-model');
    assert.equal(fakeSettingModel.value, 'downloaded-model');
  }
});

test('UIInspector - renderInspectorReport genera metadatos y capacidades, escapa el modelo y muestra errores sin badges', () => {
  {
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
  }

  {
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
  }

  {
    const fakeResultsContainer = { innerHTML: '' };
    const elements = { inspectorResults: fakeResultsContainer };
    const report = {
      success: true,
      connected: true,
      provider: { label: 'Custom & Provider' },
      endpoint: { normalized: 'http://localhost:1234/v1' },
      model: { selected: 'Model & Special <Name>' },
      capabilities: {}
    };

    UIInspector.renderInspectorReport(elements, report);
    assert.ok(fakeResultsContainer.innerHTML.includes('Model &amp; Special &lt;Name&gt;'));
    assert.equal(fakeResultsContainer.innerHTML.includes('&amp;amp;'), false, 'No debe haber doble escape HTML');
  }
});

test('UIInspector - formatWebLLMErrorMessage descarta [object Object] y extrae mensajes legibles', () => {
  assert.equal(UIInspector.formatWebLLMErrorMessage(new Error('GPU memory exhausted')), 'GPU memory exhausted');
  assert.equal(UIInspector.formatWebLLMErrorMessage('Shader compilation error'), 'Shader compilation error');
  assert.equal(UIInspector.formatWebLLMErrorMessage({ error: { message: 'WebGPU device lost' } }), 'WebGPU device lost');
  assert.equal(UIInspector.formatWebLLMErrorMessage({ error: 'Direct failure string' }), 'Direct failure string');
  assert.equal(UIInspector.formatWebLLMErrorMessage(new Error('', { cause: new Error('Root cause detail') })), 'Root cause detail');

  // Pruebas críticas de descarte de [object Object]
  const incompleteFallback = 'La descarga no está completa. Vuelve a intentarlo.';
  assert.equal(UIInspector.formatWebLLMErrorMessage(new Error('[object Object]')), incompleteFallback);
  assert.equal(UIInspector.formatWebLLMErrorMessage('[object Object]'), incompleteFallback);
  assert.equal(UIInspector.formatWebLLMErrorMessage({}), incompleteFallback);
  assert.equal(UIInspector.formatWebLLMErrorMessage(null), incompleteFallback);
  assert.equal(UIInspector.formatWebLLMErrorMessage(new Error('   [object Object]   ')), incompleteFallback);
  assert.equal(UIInspector.formatWebLLMErrorMessage(new Error('[object Object]'), 'webllm_delete_failed'), 'No se pudo borrar el modelo.');

  // Limpieza de prefijo Error:
  assert.equal(UIInspector.formatWebLLMErrorMessage('Error: Program terminated with exit(1)'), 'Program terminated with exit(1)');
  assert.equal(UIInspector.formatWebLLMErrorMessage(new Error('Error: Program terminated with exit(1)')), 'Program terminated with exit(1)');
});
