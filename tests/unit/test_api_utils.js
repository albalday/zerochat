const { test } = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../../js/api.js');

test('Api - streamChatCompletion con señal cancelada devuelve resultado consistente', async () => {
  const controller = new AbortController();
  controller.abort();
  const response = await Api.streamChatCompletion({
    apiUrl: 'http://localhost:1234/v1',
    apiType: 'openai',
    model: 'test',
    messages: [{ role: 'user', content: 'test' }],
    signal: controller.signal
  });
  assert.deepEqual(response, {
    accumulatedText: '',
    accumulatedReasoning: '',
    reasoningReplay: null,
    stats: null,
    toolCalls: null,
    truncated: false,
    recoveredReason: ''
  });
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

test('Api - devuelve para reenviar solo el razonamiento recibido en un campo propio', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"reasoning_content":"paso "}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"uno"}}]}\n\ndata: {"choices":[{"delta":{"content":"Hecho"}}]}\n\ndata: [DONE]\n\n');
    const fromField = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [] });
    assert.deepEqual(fromField.reasoningReplay, { field: 'reasoning_content', text: 'paso uno' });

    // Las etiquetas <think> en el texto no tienen campo en el que devolverlas.
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"<think>oculto</think>Hecho"}}]}\n\ndata: [DONE]\n\n');
    const fromTags = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [] });
    assert.equal(fromTags.accumulatedReasoning, 'oculto');
    assert.equal(fromTags.reasoningReplay, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - Messages API: llamadas tool_use en streaming y razonamiento con firma para reenviar', async () => {
  const originalFetch = global.fetch;
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'dos ciudades' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Madrid"}' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_b', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
    { type: 'message_stop' }
  ];
  try {
    global.fetch = async () => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    const result = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'claude', model: 'test', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(result.toolCalls.map(call => [call.id, call.function.name, call.function.arguments]), [
      ['toolu_a', 'get_weather', '{"city":"Madrid"}'],
      ['toolu_b', 'get_weather', '{"city":"Paris"}']
    ]);
    assert.deepEqual(result.reasoningReplay, { field: 'thinking', text: 'dos ciudades', signature: 'sig' });
    assert.equal(result.stats.promptTokens, 120);
    assert.equal(result.stats.completionTokens, 30);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - un error dentro del streaming se entrega a onError con el mensaje del servidor', async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Medio"}}]}\n\ndata: {"error":{"message":"Upstream timeout"}}\n\ndata: {"choices":[{"delta":{"content":" no llega"}}]}\n\n');
    let received = null;
    const logs = [];
    const result = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [],
      onError: err => { received = err; }, onLog: entry => logs.push(entry)
    });
    assert.equal(result, null);
    assert.equal(received.name, 'StreamServerError');
    assert.equal(received.serverMessage, 'Upstream timeout');
    assert.equal(logs.some(entry => entry.type === 'warning' && /unreadable/.test(entry.text)), false, 'No se trata como un fragmento ilegible');
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});

test('Api - una respuesta cortada en el límite de salida se marca y se registra', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Texto"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
    const logs = [];
    const cut = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [], onLog: entry => logs.push(entry) });
    assert.equal(cut.truncated, true);
    assert.equal(cut.accumulatedText, 'Texto');
    assert.ok(logs.some(entry => entry.type === 'warning' && /output token limit/.test(entry.text)));

    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Texto"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    const complete = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [] });
    assert.equal(complete.truncated, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - informa del parámetro rechazado tras repetir la petición sin él', async () => {
  const originalFetch = global.fetch;
  const bodies = [];
  try {
    global.fetch = async (url, options) => {
      bodies.push(JSON.parse(options.body));
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: { message: 'Invalid value for reasoning_effort: xhigh' } }), { status: 400 })
        : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    };
    const result = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [], reasoningEffort: 'xhigh' });
    assert.equal(result.recoveredReason, 'reasoning_rejected');
    assert.equal(bodies[0].reasoning_effort, 'xhigh');
    assert.equal('reasoning_effort' in bodies[1], false);
  } finally {
    global.fetch = originalFetch;
  }
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
      let error = null;
      const res = await Api.streamChatCompletion({
        apiUrl: 'http://localhost:1234/v1',
        apiType: 'openai',
        model: 'test-model',
        messages: [{ role: 'user', content: 'Prueba cancelada' }],
        onBeforeRequest: async () => ({ cancel: true }),
        onError: value => { error = value; }
      });

      assert.equal(fetchCalled, false);
      assert.equal(res, null);
      assert.match(error.message, /cancelled in the message debugger/);
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
  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1',
      apiType: 'openai',
      model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: {} } } }],
      onChunk: text => visibleChunks.push(text)
    });
    assert.ok(visibleChunks.every(text => !text.includes('<tool')));
    assert.equal(visibleChunks.at(-1), 'Voy a buscar. ');
    assert.equal(res.accumulatedText, 'Voy a buscar.');
    assert.equal(res.toolCalls.length, 1);
    assert.deepEqual(res.toolCalls[0].function, { name: 'search_web', arguments: '{"query":"webgpu"}' });
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
      messages: [{ role: 'user', content: 'test' }]
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
