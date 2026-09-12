const { test } = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../js/api.js');
const Storage = require('../js/cookies.js');

test('Api - Detección automática de tipo de proveedor', () => {
  assert.equal(Api.detectApiType('http://localhost:11434'), 'ollama');
  assert.equal(Api.detectApiType('https://api.anthropic.com/v1'), 'claude');
  assert.equal(Api.detectApiType('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(Api.detectApiType('https://generativelanguage.googleapis.com/v1beta/openai'), 'gemini');
  assert.equal(Api.detectApiType('http://localhost:1234/v1'), 'openai');
});

test('Api - Normalización de nombres de herramientas', () => {
  assert.equal(Api.normalizeToolName('search_web'), 'search_web');
  assert.equal(Api.normalizeToolName('duckduckgo'), 'search_web');
  assert.equal(Api.normalizeToolName('eval_javascript'), 'execute_javascript');
  assert.equal(Api.normalizeToolName('downloadpdf'), 'download_pdf');
  assert.equal(Api.normalizeToolName('render_chart'), 'render_chart');
});

test('Api - Espejo construye una petición OpenAI y la devuelve sin usar la red', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('Espejo no debe llamar a fetch');
  };
  try {
    const response = await Api.streamChatCompletion({
      apiUrl: 'mirror://local',
      apiType: 'mirror',
      model: 'mirror',
      messages: [{ role: 'user', content: 'Refleja esta petición' }]
    });
    const payloadText = response.accumulatedText.match(/```json\n([^\n]+)\n```$/)[1];
    const payload = JSON.parse(payloadText);
    assert.equal(fetchCalled, false);
    assert.equal(payload.model, 'mirror');
    assert.equal(payload.messages[0].content, 'Refleja esta petición');
    assert.equal(payload.stream, true);
    assert.equal(payloadText.includes('\n'), false, 'Espejo debe reflejar el mismo JSON compacto enviado al servidor');
    assert.match(response.accumulatedText, /^# Bienvenido a ZeroChat/m);
    assert.match(response.accumulatedText, /## Continúa con un perfil/);
    assert.match(response.accumulatedText, /> \*\*WebLLM \(experimental\):\*\*/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - Espejo localiza su mensaje de orientación', async () => {
  const I18n = require('../js/i18n.js');
  const previousLanguage = I18n.getLanguage();
  try {
    I18n.setLanguage('en', false);
    const responseEn = await Api.streamChatCompletion({
      apiUrl: 'mirror://local', apiType: 'mirror', model: 'mirror', messages: []
    });
    assert.match(responseEn.accumulatedText, /^# Welcome to ZeroChat/m);
    assert.match(responseEn.accumulatedText, /## Continue with a profile/);
    assert.match(responseEn.accumulatedText, /> \*\*WebLLM \(experimental\):\*\*/);
    assert.match(responseEn.accumulatedText, /## Prepared request \(not sent\)/);
    assert.match(responseEn.accumulatedText, /http:\/\/albalday\.github\.io\/zerochat\/help\/en\/index\.html/);

    I18n.setLanguage('es', false);
    const responseEs = await Api.streamChatCompletion({
      apiUrl: 'mirror://local', apiType: 'mirror', model: 'mirror', messages: []
    });
    assert.match(responseEs.accumulatedText, /^# Bienvenido a ZeroChat/m);
    assert.match(responseEs.accumulatedText, /## Continúa con un perfil/);
    assert.match(responseEs.accumulatedText, /http:\/\/albalday\.github\.io\/zerochat\/help\/index\.html/);
  } finally {
    I18n.setLanguage(previousLanguage, false);
  }
});

test('Api - publica estados de conexión, pensamiento y generación sin exponer el contenido', async () => {
  const originalFetch = global.fetch;
  const states = [];
  global.fetch = async () => new Response('data: {"choices":[{"delta":{"reasoning":"private chain"}}]}\n\ndata: {"choices":[{"delta":{"content":"Visible"}}]}\n\ndata: [DONE]\n\n');
  try {
    await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [],
      onGenerationStatus: status => states.push(status)
    });
    assert.deepEqual(states.map(status => status.phase), ['connecting', 'thinking', 'generating']);
    assert.equal(states.some(status => JSON.stringify(status).includes('private chain')), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - Free Tier usa la clave de almacenamiento y no usa la red si no existe', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; };
  try {
    Storage.deleteStorageItem(Api.FREE_TIER_API_KEY_STORAGE_KEY);
    const response = await Api.streamChatCompletion({
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiType: 'gemini', apiKey: 'FREE-TIER', model: 'gemini-test', messages: []
    });
    assert.equal(fetchCalled, false);
    assert.match(response.error.message, /Free Tier no está configurado/);
    Storage.setStorageItem(Api.FREE_TIER_API_KEY_STORAGE_KEY, 'stored-free-tier-key');
    assert.equal(Api.freeApi(), 'stored-free-tier-key');
    assert.equal(Api.resolveApiKey('FREE-TIER'), 'stored-free-tier-key');
  } finally {
    Storage.deleteStorageItem(Api.FREE_TIER_API_KEY_STORAGE_KEY);
    global.fetch = originalFetch;
  }
});

test('Api - Espejo respeta callbacks, cancelación y consultas sin red', async () => {
  const originalFetch = global.fetch;
  let network = 0;
  global.fetch = async () => { network++; throw new Error('Unexpected network'); };
  try {
    const input = { apiType: 'mirror', model: 'mirror', messages: [{ role: 'user', content: '<script>test</script>' }] };
    let chunk;
    const response = await Api.streamChatCompletion({ ...input, onChunk: (...args) => { chunk = args; } });
    assert.equal(chunk[0], response.accumulatedText);
    assert.equal(chunk[1], response.accumulatedText);
    assert.equal(chunk[2], response.stats);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await Api.streamChatCompletion({ ...input, signal: controller.signal, onChunk: () => assert.fail('Cancelled callback') });
    assert.equal(cancelled.cancelled, true);
    assert.equal((await Api.fetchServerModels('mirror://local', '', 'mirror')).success, false);
    assert.equal((await Api.inspectProvider(input)).success, false);
    for (const apiType of ['openai', 'gemini', 'claude']) {
      assert.equal((await Api.fetchServerModels('https://example.test', 'FREE-TIER', apiType)).success, false);
      assert.equal((await Api.inspectProvider({ apiType, apiKey: 'FREE-TIER' })).success, false);
    }
    assert.equal(network, 0);
  } finally { global.fetch = originalFetch; }
});

test('Api - Intercepción y modificación de payload con onBeforeRequest (Debug Messages)', async () => {
  let interceptedEndpoint = '';
  const originalFetch = global.fetch;
  let fetchBodySent = null;

  global.fetch = async (url, options) => {
    fetchBodySent = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => {
          let called = false;
          return {
            read: async () => {
              if (!called) {
                called = true;
                const chunk = 'data: {"choices":[{"delta":{"content":"Respuesta"}}]}\n\ndata: [DONE]\n\n';
                return { done: false, value: new TextEncoder().encode(chunk) };
              }
              return { done: true, value: undefined };
            }
          };
        }
      }
    };
  };

  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'Pregunta original' }],
      onBeforeRequest: async ({ endpoint, payload }) => {
        interceptedEndpoint = endpoint;
        return {
          cancel: false,
          modifiedPayload: {
            ...payload,
            messages: [{ role: 'user', content: 'Pregunta editada en Debug' }]
          }
        };
      }
    });

    assert.ok(interceptedEndpoint.includes('/chat/completions'));
    assert.equal(fetchBodySent.messages[0].content, 'Pregunta editada en Debug');
    assert.equal(res.accumulatedText, 'Respuesta');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - Cancelación de envío desde onBeforeRequest sin invocar fetch (Debug Messages)', async () => {
  let fetchCalled = false;
  const originalFetch = global.fetch;

  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('No debe realizar fetch si fue cancelado');
  };

  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'Prueba cancelada' }],
      onBeforeRequest: async () => {
        return { cancel: true };
      }
    });

    assert.equal(fetchCalled, false);
    assert.equal(res.cancelled, true);
    assert.equal(res.aborted, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatAPI - streamChatCompletion no duplica tokens de razonamiento en onLog cuando existe onReasoningChunk', async () => {
  const originalFetch = global.fetch;
  const sseData = [
    'data: {"choices":[{"delta":{"reasoning_content":"Pol"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"itely"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
    'data: [DONE]\n\n'
  ].join('');

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseData));
      controller.close();
    }
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null)
    },
    body: stream
  });

  const reasoningChunks = [];
  const logEvents = [];

  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      onReasoningChunk: (chunk) => {
        reasoningChunks.push(chunk);
      },
      onLog: (logData) => {
        logEvents.push(logData);
      }
    });

    assert.equal(res.accumulatedText, 'OK');
    assert.deepEqual(reasoningChunks, ['Pol', 'itely']);
    const thinkingLogs = logEvents.filter(l => l.type === 'thinking');
    assert.equal(thinkingLogs.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
