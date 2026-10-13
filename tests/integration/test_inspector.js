const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos necesarios
const Providers = require('../../js/providers.js');
const API = require('../../js/api.js');

test('ProviderInspector - Capacidades declaradas por defecto y seguridad de API Keys', async () => {
  const adapter = new Providers.BaseProviderAdapter({ id: 'openai', label: 'OpenAI Test' });
  const secretKey = 'sk-secret-key-that-must-never-leak';

  const report = await adapter.inspect({
    apiUrl: 'http://localhost:1234/v1',
    apiKey: secretKey,
    model: 'gpt-4o-mini',
    runProbes: false
  });

  // Verificar que el informe no incluye ni expone la apiKey
  assert.equal(report.apiKey, undefined, 'El informe de inspección nunca debe exponer apiKey');
  assert.equal(JSON.stringify(report).includes(secretKey), false, 'La clave de API no debe aparecer serializada en el resultado');

  // Verificar estructura del informe
  assert.equal(report.provider.id, 'openai');
  assert.equal(report.endpoint.normalized, 'http://localhost:1234/v1/chat/completions');
  assert.ok(report.capabilities);

  // Capacidades declaradas
  assert.equal(report.capabilities.streaming.status, 'declared');
  assert.equal(report.capabilities.tools.status, 'declared');
  assert.equal(report.capabilities.jsonMode.status, 'declared');
});

test('ProviderInspector - Inferencia de capacidades a partir del identificador de modelo', async () => {
  const adapter = new Providers.BaseProviderAdapter();

  // 1. Modelo con visión
  const visionReport = await adapter.inspect({
    apiUrl: 'http://localhost:1234/v1',
    model: 'qwen2-vl-7b-instruct',
    runProbes: false
  });
  assert.equal(visionReport.capabilities.vision.status, 'inferred');
  assert.equal(visionReport.capabilities.vision.source, 'model_name');

  // 2. Modelo con razonamiento (R1 / QwQ / Thinking)
  const reasoningReport = await adapter.inspect({
    apiUrl: 'http://localhost:1234/v1',
    model: 'deepseek-r1-distill-llama-8b',
    runProbes: false
  });
  assert.equal(reasoningReport.capabilities.reasoning.status, 'inferred');
  assert.equal(reasoningReport.capabilities.reasoning.source, 'model_name');

  // 3. Modelo de embeddings
  const embReport = await adapter.inspect({
    apiUrl: 'http://localhost:1234/v1',
    model: 'text-embedding-3-small',
    runProbes: false
  });
  assert.equal(embReport.capabilities.embeddings.status, 'inferred');
  assert.equal(embReport.capabilities.embeddings.source, 'model_name');
});

test('ProviderInspector - Micro-sondas activas con fetch simulado', async () => {
  const adapter = new Providers.BaseProviderAdapter({ id: 'openai' });

  // Mock global de fetch para simular respuestas del servidor
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const body = options.body ? JSON.parse(options.body) : {};

      // 1. Endpoint de modelos
      if (urlStr.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'llama-3.2-vision', name: 'llama-3.2-vision' },
              { id: 'deepseek-r1', name: 'deepseek-r1' }
            ]
          })
        };
      }

      // 2. Endpoint de embeddings
      if (urlStr.endsWith('/embeddings')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
        };
      }

      // 3. Endpoint de chat con streaming
      if (body.stream === true) {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null)
          },
          body: {}
        };
      }

      // 4. Endpoint de chat con tools
      if (body.tools) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }] })
        };
      }

      // 5. Endpoint de chat con jsonMode
      if (body.response_format) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{}' } }] })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'hi' } }] })
      };
    };

    const report = await adapter.inspect({
      apiUrl: 'http://localhost:1234/v1',
      model: 'my-model',
      runProbes: true
    });

    assert.equal(report.capabilities.modelListing.status, 'confirmed');
    assert.equal(report.model.totalDiscovered, 2);
    assert.equal(report.capabilities.streaming.status, 'confirmed');
    assert.equal(report.capabilities.tools.status, 'confirmed');
    assert.equal(report.capabilities.jsonMode.status, 'confirmed');
    assert.equal(report.capabilities.embeddings.status, 'confirmed');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ProviderInspector - Detección de rechazo en sondas (unsupported)', async () => {
  const adapter = new Providers.BaseProviderAdapter({ id: 'openai' });

  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      const body = options.body ? JSON.parse(options.body) : {};

      if (urlStr.endsWith('/models')) {
        return { ok: false, status: 404, text: async () => 'Not found' };
      }
      if (urlStr.endsWith('/embeddings')) {
        return { ok: false, status: 404, text: async () => 'Not found' };
      }
      if (body.tools) {
        return {
          ok: false,
          status: 400,
          text: async () => 'This model does not support tools or function calling.'
        };
      }
      if (body.response_format) {
        return {
          ok: false,
          status: 400,
          text: async () => 'Unrecognized parameter: response_format'
        };
      }
      return { ok: true, status: 200, headers: { get: () => 'text/event-stream' } };
    };

    const report = await adapter.inspect({
      apiUrl: 'http://localhost:1234/v1',
      model: 'basic-model',
      runProbes: true
    });

    assert.equal(report.capabilities.tools.status, 'unsupported');
    assert.equal(report.capabilities.jsonMode.status, 'unsupported');
    assert.equal(report.capabilities.embeddings.status, 'unsupported');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatAPI.inspectProvider - Delegación e integración a través de ChatAPI', async () => {
  assert.equal(typeof API.inspectProvider, 'function', 'ChatAPI.inspectProvider debe ser una función exportada');

  const report = await API.inspectProvider({
    apiUrl: 'https://api.anthropic.com/v1',
    apiType: 'claude',
    model: 'claude-3-5-sonnet-20241022'
  }, { runProbes: false });

  assert.equal(report.provider.id, 'claude');
  assert.equal(report.capabilities.promptCaching.status, 'declared');
  assert.equal(report.capabilities.jsonMode.status, 'unsupported');
});

test('ProviderInspector - Detección de fallo de conexión (servidor caído o error de red)', async () => {
  const adapter = new Providers.BaseProviderAdapter({ id: 'openai' });

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:9999');
    };

    const report = await adapter.inspect({
      apiUrl: 'http://localhost:9999/v1',
      model: 'my-model',
      runProbes: true
    });

    assert.equal(report.success, false, 'El informe debe indicar success: false si no se pudo conectar');
    assert.equal(report.connected, false, 'El informe debe indicar connected: false');
    assert.ok(report.error, 'Debe incluir un mensaje de error descriptivo');
    assert.ok(report.error.includes('Connection error'), 'El mensaje debe indicar fallo de conexión');
    assert.equal(report.capabilities.streaming.status, 'unknown', 'Las capacidades no deben aparecer como declaradas si la conexión falló');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ProviderInspector - Detección de fallo de conexión por error de autenticación HTTP 401', async () => {
  const adapter = new Providers.BaseProviderAdapter({ id: 'openai' });

  const originalFetch = global.fetch;
  try {
    global.fetch = async () => {
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Incorrect API key provided'
      };
    };

    const report = await adapter.inspect({
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-invalid-key',
      model: 'gpt-4o',
      runProbes: true
    });

    assert.equal(report.success, false);
    assert.equal(report.connected, false);
    assert.match(report.error, /Authentication error \(HTTP 401\)/);
  } finally {
    global.fetch = originalFetch;
  }
});


/** Sustituye fetch con respuestas por URL y método; lo no previsto falla como un servidor caído. */
function stubFetch(t, routes) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method, body });
    const route = routes.find(item => item.match(url, body));
    if (!route) throw new TypeError('fetch failed');
    const { status = 200, json = {}, text = '' } = route.response;
    return new Response(status === 200 && !route.response.text ? JSON.stringify(json) : text, { status, headers: { 'content-type': route.response.contentType || 'application/json' } });
  });
  return requests;
}

test('ProviderInspector - confirma capacidades con sondas, infiere por el nombre y explica cada estado con una clave i18n', async t => {
  const isChat = (url, body) => url.endsWith('/chat/completions');
  stubFetch(t, [
    { match: url => url.endsWith('/models'), response: { json: { data: [{ id: 'qwen2.5-vl-7b' }, { id: 'nomic-embed-text' }] } } },
    { match: (url, body) => isChat(url) && body.stream === true, response: { text: 'data: {}\n\n', contentType: 'text/event-stream' } },
    { match: (url, body) => isChat(url) && body.tools, response: { status: 400, text: 'tools are not supported by this model' } },
    { match: (url, body) => isChat(url) && body.response_format, response: { json: {} } },
    { match: url => url.endsWith('/embeddings'), response: { status: 404, text: 'not found' } }
  ]);

  const report = await Providers.registry.inspect('http://localhost:1234/v1', '', '', 'openai');

  assert.equal(report.success, true);
  assert.deepEqual(report.model, { selected: 'qwen2.5-vl-7b', totalDiscovered: 2, discovered: report.model.discovered });
  const caps = report.capabilities;
  assert.deepEqual([caps.modelListing.status, caps.modelListing.detailKey, caps.modelListing.detailParams.count], ['confirmed', 'inspector_detail_models_found', 2]);
  assert.deepEqual([caps.streaming.status, caps.streaming.detailKey], ['confirmed', 'inspector_detail_streaming_confirmed']);
  assert.deepEqual([caps.tools.status, caps.tools.detailKey], ['unsupported', 'inspector_detail_rejected']);
  assert.match(caps.tools.detailParams.error, /tools are not supported/);
  assert.equal(caps.jsonMode.status, 'confirmed');
  assert.deepEqual([caps.vision.status, caps.vision.detailKey], ['inferred', 'inspector_detail_vision_inferred']);
  assert.equal(caps.embeddings.status, 'unsupported', 'El 404 de la sonda manda sobre la inferencia');
  for (const capability of Object.values(caps)) {
    assert.notEqual(require('../../js/i18n.js').t(capability.detailKey, capability.detailParams), capability.detailKey, capability.detailKey);
  }
});


test('ProviderInspector - la visión que declara el servidor manda sobre el nombre del modelo', async t => {
  const chat = { match: url => url.endsWith('/chat/completions'), response: { json: {} } };
  const vision = async (type, model, routes) => {
    const requests = stubFetch(t, [...routes, chat]);
    const report = await Providers.registry.inspect('http://localhost:1234/v1', '', model, type);
    t.mock.restoreAll();
    const { status, detailKey, source } = report.capabilities.vision;
    return { status, detailKey, source, requests: requests.map(item => item.url) };
  };

  // llama.cpp y OpenRouter: architecture.input_modalities en /v1/models.
  const llamaCpp = await vision('openai', 'local-27b', [
    { match: url => url.endsWith('/v1/models'), response: { json: { data: [{ id: 'local-27b', architecture: { input_modalities: ['text', 'image'] } }] } } }
  ]);
  assert.deepEqual([llamaCpp.status, llamaCpp.detailKey, llamaCpp.source], ['confirmed', 'inspector_detail_vision_server', 'server']);

  // LM Studio: type de /api/v0/models; un modelo de texto no queda inferido por su nombre.
  const lmStudio = await vision('openai', 'vision-coder', [
    { match: url => url.endsWith('/api/v0/models'), response: { json: { data: [{ id: 'vision-coder', type: 'llm' }] } } }
  ]);
  assert.deepEqual([lmStudio.status, lmStudio.detailKey], ['unsupported', 'inspector_detail_vision_text_only']);

  // Ollama: /api/tags no trae capacidades y se piden a /api/show.
  const ollama = await vision('ollama', 'gemma3:27b', [
    { match: url => url.endsWith('/api/tags'), response: { json: { models: [{ name: 'gemma3:27b' }] } } },
    { match: (url, body) => url.endsWith('/api/show') && body.model === 'gemma3:27b', response: { json: { capabilities: ['completion', 'vision'] } } }
  ]);
  assert.equal(ollama.status, 'confirmed');
  assert.ok(ollama.requests.includes('http://localhost:1234/api/show'));

  // Un servidor que no la declara deja la declaración del adaptador, sin peticiones de más.
  const silent = await vision('openai', 'plain-model', [
    { match: url => url.endsWith('/v1/models'), response: { json: { data: [{ id: 'plain-model' }] } } }
  ]);
  assert.deepEqual([silent.status, silent.source], ['declared', 'adapter']);
  assert.equal(silent.requests.some(url => url.endsWith('/api/show')), false);
});
