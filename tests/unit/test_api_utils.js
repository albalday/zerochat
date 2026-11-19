const { test } = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../../js/api.js');

test('Api - streamChatCompletion publica estados sin exponer el pensamiento, reenvía solo reasoningReplay de campo y respeta AbortSignal', async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = await Api.streamChatCompletion({
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test',
    messages: [{ role: 'user', content: 'test' }], signal: controller.signal
  });
  assert.deepEqual(aborted, {
    accumulatedText: '', accumulatedReasoning: '', reasoningReplay: null,
    stats: null, toolCalls: null, truncated: false, recoveredReason: ''
  });

  const originalFetch = global.fetch;
  try {
    const states = [];
    const reasoningChunks = [];
    const logEvents = [];
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"reasoning":"private "}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"chain"}}]}\n\ndata: {"choices":[{"delta":{"content":"Visible"}}]}\n\ndata: [DONE]\n\n');
    const res = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [],
      onGenerationStatus: status => states.push(status),
      onReasoningChunk: chunk => reasoningChunks.push(chunk),
      onLog: entry => logEvents.push(entry)
    });
    assert.equal(res.accumulatedText, 'Visible');
    assert.deepEqual(states.map(status => status.phase), ['connecting', 'thinking', 'generating']);
    assert.equal(states.some(status => JSON.stringify(status).includes('private')), false);
    assert.deepEqual(reasoningChunks, ['private ', 'chain']);
    assert.equal(logEvents.filter(l => l.type === 'thinking').length, 0);
    assert.deepEqual(res.reasoningReplay, { field: 'reasoning_content', text: 'private chain' });

    // Las etiquetas <think> en el texto no tienen campo en el que devolverlas.
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"<think>oculto</think>Hecho"}}]}\n\ndata: [DONE]\n\n');
    const fromTags = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [] });
    assert.equal(fromTags.accumulatedReasoning, 'oculto');
    assert.equal(fromTags.reasoningReplay, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Api - createReasoningTagSplitter separa los bloques de razonamiento aunque abarquen varios trozos', () => {
  const text = value => ({ reasoning: false, text: value });
  const thought = value => ({ reasoning: true, text: value });
  const rows = [
    [['Hola'], [[text('Hola')]]],
    [['a<think>b</think>c'], [[text('a'), thought(''), thought('b'), text('c')]]],
    // Abre en un trozo y cierra en otro, con la etiqueta en mayúsculas
    [['pre<THOUGHT>uno', ' dos', '</thought>fin'], [[text('pre'), thought(''), thought('uno')], [thought(' dos')], [text('fin')]]],
    // Solo cierra la etiqueta que abrió: </think> dentro de <reasoning> es razonamiento
    [['<reasoning>x</think>y</reasoning>'], [[thought(''), thought('x</think>y')]]],
    [['<think>', '</think>', 'z'], [[thought('')], [], [text('z')]]]
  ];
  for (const [chunks, expected] of rows) {
    const split = Api.createReasoningTagSplitter();
    assert.deepEqual(chunks.map(split), expected, JSON.stringify(chunks));
  }
});

test('Api - corta en límite de salida, ignora chunks ilegibles, reintenta parámetros rechazados y entrega errores del stream', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const originalFetch = global.fetch;
  try {
    // 1. finish_reason: length vs stop
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Texto"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
    const logs = [];
    const cut = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [], onLog: entry => logs.push(entry) });
    assert.equal(cut.truncated, true);
    assert.equal(cut.accumulatedText, 'Texto');
    assert.ok(logs.some(entry => entry.type === 'warning' && /output token limit/.test(entry.text)));

    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Texto"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    assert.equal((await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [] })).truncated, false);

    // 2. Fragmentos SSE ilegibles se ignoran con warning sin abortar
    logs.length = 0;
    global.fetch = async () => new Response('data: {broken\n\ndata: {"choices":[{"delta":{"content":"Visible"}}]}\n\ndata: [DONE]\n\n');
    const okRes = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [], onLog: entry => logs.push(entry) });
    assert.equal(okRes.accumulatedText, 'Visible');
    assert.ok(logs.some(entry => entry.type === 'warning' && /Ignored unreadable stream chunk/.test(entry.text)));

    // 3. Reintento ante 400 por reasoning_effort
    const bodies = [];
    global.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return bodies.length === 1
        ? new Response(JSON.stringify({ error: { message: 'Invalid value for reasoning_effort: xhigh' } }), { status: 400 })
        : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    };
    const retried = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [], reasoningEffort: 'xhigh' });
    assert.equal(retried.recoveredReason, 'reasoning_rejected');
    assert.equal(bodies[0].reasoning_effort, 'xhigh');
    assert.equal('reasoning_effort' in bodies[1], false);

    // 4. Error dentro del stream va a onError
    logs.length = 0;
    global.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Medio"}}]}\n\ndata: {"error":{"message":"Upstream timeout"}}\n\ndata: {"choices":[{"delta":{"content":" no llega"}}]}\n\n');
    let received = null;
    const failed = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test', messages: [],
      onError: err => { received = err; }, onLog: entry => logs.push(entry)
    });
    assert.equal(failed, null);
    assert.equal(received.name, 'StreamServerError');
    assert.equal(received.serverMessage, 'Upstream timeout');
    assert.equal(logs.some(entry => entry.type === 'warning' && /unreadable/.test(entry.text)), false);
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

test('Api - Messages API y Gemini: tool_use, deltas sin index, firma de razonamiento y <tool_call> en texto', async () => {
  const originalFetch = global.fetch;
  const claudeEvents = [
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
    global.fetch = async () => new Response(claudeEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    const claudeRes = await Api.streamChatCompletion({ apiUrl: 'http://localhost:1234/v1', apiType: 'claude', model: 'test', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(claudeRes.toolCalls.map(call => [call.id, call.function.name, call.function.arguments]), [
      ['toolu_a', 'get_weather', '{"city":"Madrid"}'],
      ['toolu_b', 'get_weather', '{"city":"Paris"}']
    ]);
    assert.deepEqual(claudeRes.reasoningReplay, { field: 'thinking', text: 'dos ciudades', signature: 'sig' });
    assert.equal(claudeRes.stats.promptTokens, 120);
    assert.equal(claudeRes.stats.completionTokens, 30);

    // <tool_call> en texto con herramientas se extrae y no se muestra en streaming; sin herramientas o inválido se respeta/descarta
    const pieces = ['Voy a buscar. <tool', '_call>\n{"name": "search_web", ', '"arguments": {"query": "webgpu"}}\n</tool_call>'];
    global.fetch = async () => new Response(pieces.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + 'data: [DONE]\n\n');
    const visibleChunks = [];
    const textToolRes = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: {} } } }],
      onChunk: text => visibleChunks.push(text)
    });
    assert.ok(visibleChunks.every(text => !text.includes('<tool')));
    assert.equal(visibleChunks.at(-1), 'Voy a buscar. ');
    assert.equal(textToolRes.accumulatedText, 'Voy a buscar.');
    assert.deepEqual(textToolRes.toolCalls[0].function, { name: 'search_web', arguments: '{"query":"webgpu"}' });

    const brokenPieces = ['Respuesta. ', '<tool_call>\n{"name": "search_web", "arguments": '];
    global.fetch = async () => new Response(brokenPieces.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('') + 'data: [DONE]\n\n');
    const logs = [];
    const brokenRes = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: {} } } }],
      onLog: entry => logs.push(entry)
    });
    assert.equal(brokenRes.toolCalls, null);
    assert.equal(brokenRes.accumulatedText, 'Respuesta.');
    assert.ok(logs.some(entry => entry.type === 'warning' && entry.text.includes('<tool_call>')));

    const literal = 'Ejemplo: <tool_call>{"name": "search_web", "arguments": {}}</tool_call>';
    global.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: literal } }] })}\n\ndata: [DONE]\n\n`);
    const plainRes = await Api.streamChatCompletion({
      apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'test-model', messages: [{ role: 'user', content: 'test' }]
    });
    assert.equal(plainRes.accumulatedText, literal);
    assert.equal(plainRes.toolCalls, null);
  } finally {
    global.fetch = originalFetch;
  }
});

/** Respuesta SSE de Gemini (compatibilidad OpenAI) con los chunks dados; devuelve las llamadas acumuladas. */
async function streamGeminiToolCalls(chunks) {
  const originalFetch = global.fetch;
  const sseData = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(sseData)); controller.close(); } })
  });
  try {
    const res = await Api.streamChatCompletion({
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiType: 'gemini',
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'search_web', parameters: { type: 'object', properties: {} } } }]
    });
    return res.toolCalls;
  } finally {
    global.fetch = originalFetch;
  }
}

test('ChatAPI - la firma y deltas de Gemini sin index se asignan por id', async () => {
  const call = (id, query) => ({ id, type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query }) } });
  const fromReasoning = await streamGeminiToolCalls([
    { choices: [{ delta: { reasoning_content: 'plan', extra_content: { google: { thought_signature: 'sig_reasoning' } } } }] },
    { choices: [{ delta: { tool_calls: [call('a', 'uno')] } }] },
    { choices: [{ delta: { tool_calls: [call('b', 'dos')] } }] }
  ]);
  assert.deepEqual(fromReasoning.map(item => item.thought_signature), ['sig_reasoning', undefined]);

  const fromClosingChunk = await streamGeminiToolCalls([
    { choices: [{ delta: { tool_calls: [call('a', 'uno')] } }] },
    { choices: [{ finish_reason: 'tool_calls', thought_signature: 'sig_close' }] }
  ]);
  assert.equal(fromClosingChunk[0].thought_signature, 'sig_close');

  const toolCalls = await streamGeminiToolCalls([
    { choices: [{ delta: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'search_web', arguments: '{"query":"uno"}' }, extra_content: { google: { thought_signature: 'sig_a' } } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'b', type: 'function', function: { name: 'search_web', arguments: '{"query":"dos"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'b', extra_content: { google: { cached: true } } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'a', extra_content: { trace: 'x' } }] } }] }
  ]);
  assert.deepEqual(toolCalls.map(item => item.id), ['a', 'b']);
  assert.deepEqual(toolCalls[0].extra_content, { google: { thought_signature: 'sig_a' }, trace: 'x' });
  assert.deepEqual(toolCalls[1].extra_content, { google: { cached: true } });
  assert.deepEqual(toolCalls.map(item => item.function.arguments), ['{"query":"uno"}', '{"query":"dos"}']);
});
