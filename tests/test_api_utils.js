const { test } = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../js/api.js');

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

test('Api - Extracción de Tool Calls emitidas como texto', () => {
  // Llama 3 / Hermes syntax
  const llamaText = 'Voy a calcular: call:execute_javascript{"code":"2+2"}';
  const llamaCalls = Api.extractToolCallsFromText(llamaText);
  assert.ok(llamaCalls && llamaCalls.length === 1);
  assert.equal(llamaCalls[0].function.name, 'execute_javascript');

  // XML syntax
  const xmlText = '<tool_call>{"name":"search_web","arguments":{"query":"noticias"}}</tool_call>';
  const xmlCalls = Api.extractToolCallsFromText(xmlText);
  assert.ok(xmlCalls && xmlCalls.length === 1);
  assert.equal(xmlCalls[0].function.name, 'search_web');
});

test('Api - Estimación aproximada de tokens', () => {
  const shortText = 'Hola mundo';
  const count = Api.estimateTokens(shortText);
  assert.ok(count > 0 && count < 10);
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

