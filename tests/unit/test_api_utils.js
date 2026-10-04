const { test } = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../../js/api.js');
const Storage = require('../../js/cookies.js');

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
  assert.equal(Api.normalizeToolName('composio_COMPOSIO_SEARCH_TOOLS'), 'composio_COMPOSIO_SEARCH_TOOLS');
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
  const I18n = require('../../js/i18n.js');
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
    assert.match(responseEn.accumulatedText, /\]\(help\/en\/index\.html\)/);

    I18n.setLanguage('es', false);
    const responseEs = await Api.streamChatCompletion({
      apiUrl: 'mirror://local', apiType: 'mirror', model: 'mirror', messages: []
    });
    assert.match(responseEs.accumulatedText, /^# Bienvenido a ZeroChat/m);
    assert.match(responseEs.accumulatedText, /## Continúa con un perfil/);
    assert.match(responseEs.accumulatedText, /\]\(help\/index\.html\)/);
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
    assert.equal(network, 0);
  } finally { global.fetch = originalFetch; }
});

test('Api - onBeforeRequest puede modificar el payload o cancelar el envío sin invocar fetch (Debug Messages)', async () => {
  {
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
  }

  {
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

test('Api - estimateTokens delega en el estimador de ChatContextManager', () => {
  const ContextManager = require('../../js/context-manager.js');
  const prose = 'Texto de prueba en prosa para estimar tokens de salida.';
  const code = 'const value = { answer: 42 };';
  assert.equal(Api.estimateTokens(prose), ContextManager.estimateTextTokens(prose));
  assert.equal(Api.estimateTokens(code), ContextManager.estimateTextTokens(code));
  assert.equal(Api.estimateTokens('abc', 50), 50);
  assert.equal(Api.estimateTokens(''), 0);
});

test('ChatAPI - streamChatCompletion interpreta <tool_call> en texto sin mostrarlo durante el streaming', async () => {
  const originalFetch = global.fetch;
  const pieces = ['Voy a buscar. <tool', '_call>\n{"name": "search_web", ', '"arguments": {"query": "webgpu"}}\n</tool_call>'];
  const sseData = pieces.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(sseData)); controller.close(); } })
  });
  const visibleChunks = [];
  let doneArgs = null;
  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: {} } } }],
      onChunk: text => visibleChunks.push(text),
      onDone: (...args) => { doneArgs = args; }
    });
    assert.ok(visibleChunks.every(text => !text.includes('<tool')));
    assert.equal(visibleChunks.at(-1), 'Voy a buscar. ');
    assert.equal(res.accumulatedText, 'Voy a buscar.');
    assert.equal(res.toolCalls.length, 1);
    assert.deepEqual(res.toolCalls[0].function, { name: 'search_web', arguments: '{"query":"webgpu"}' });
    assert.equal(doneArgs[0], 'Voy a buscar.');
    assert.equal(doneArgs[2], res.toolCalls);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatAPI - streamChatCompletion descarta al terminar un <tool_call> inválido igual que en el streaming', async () => {
  const originalFetch = global.fetch;
  const pieces = ['Respuesta. ', '<tool_call>\n{"name": "search_web", "arguments": '];
  const sseData = pieces.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(sseData)); controller.close(); } })
  });
  const logs = [];
  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: {} } } }],
      onLog: entry => logs.push(entry)
    });
    assert.equal(res.toolCalls, null);
    assert.equal(res.accumulatedText, 'Respuesta.');
    assert.ok(logs.some(entry => entry.type === 'warning' && entry.text.includes('<tool_call>')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatAPI - streamChatCompletion no interpreta <tool_call> si la petición no lleva herramientas', async () => {
  const originalFetch = global.fetch;
  const content = 'Ejemplo: <tool_call>{"name": "search_web", "arguments": {}}</tool_call>';
  const sseData = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(sseData)); controller.close(); } })
  });
  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model',
      messages: [{ role: 'user', content: 'test' }], enableTools: false
    });
    assert.equal(res.accumulatedText, content);
    assert.equal(res.toolCalls, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - registra los fragmentos SSE ilegibles sin interrumpir la respuesta', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const originalFetch = global.fetch;
  const logs = [];
  global.fetch = async () => new Response('data: {broken\n\ndata: {"choices":[{"delta":{"content":"Visible"}}]}\n\ndata: [DONE]\n\n');
  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [],
      onLog: entry => logs.push(entry)
    });
    assert.equal(res.accumulatedText, 'Visible');
    assert.ok(logs.some(entry => entry.type === 'warning' && /Ignored unreadable stream chunk/.test(entry.text)));
    assert.equal(console.warn.mock.callCount(), 1);
  } finally {
    global.fetch = originalFetch;
  }
});
