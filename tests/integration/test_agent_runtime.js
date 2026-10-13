const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCoreModule = require('../../js/agent-core.js');
const { AgentRuntime, Tool, ToolRegistry, ToolExecutor } = AgentCoreModule;
const ChatAPI = require('../../js/api.js');
// La aplicación filtra las herramientas con la configuración normalizada.
const TOOL_CONFIG = require('../../js/config-store.js').normalize({});

const makeTool = ({ name, description, parameters, ...options }) => new Tool({ definition: { name, description, parameters }, ...options });

/** Ejecuta el runtime con la red sustituida por `api` y las herramientas activas del registro. */
function runAgent(t, registry, { api, ...params }) {
  t.mock.method(ChatAPI, 'streamChatCompletion', params2 => api.streamChatCompletion(params2));
  return new AgentRuntime({ registry }).execute({ resolveToolDefinitions: () => registry.getActiveDefinitions(TOOL_CONFIG), ...params });
}

test('AgentRuntime - la ejecución directa de tools no omite su política', async t => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.registerTool(makeTool({
    name: 'mcp_test_sensitive_action',
    category: 'mcp',
    execute: async () => {
      executions++;
      return { success: true };
    }
  }));

  let step = 0;
  const result = await runAgent(t, registry, {
    api: { streamChatCompletion: async () => step++ === 0
      ? { accumulatedText: '', toolCalls: [{ id: 'call_1', function: { name: 'mcp_test_sensitive_action', arguments: '{}' } }] }
      : { accumulatedText: 'Hecho.', toolCalls: [] } },
    messages: [{ role: 'user', content: 'Actúa.' }]
  });

  assert.equal(result.toolExecutions[0].success, false);
  assert.match(result.toolExecutions[0].error, /explicit user authorization/i);
  assert.equal(executions, 0);
});

test('AgentRuntime - cancelar mientras se autoriza no guarda un permiso permanente', async t => {
  const security = require('../../js/tool-security.js');
  const registry = new ToolRegistry();
  const controller = new AbortController();
  registry.registerTool(makeTool({ name: 'mcp_test_cancelled', category: 'mcp', execute: async () => assert.fail('Cancelled tool executed') }));
  const previous = security.manager.setToolPolicy;
  let saved = false;
  security.manager.setToolPolicy = () => { saved = true; };
  try {
    const result = await new ToolExecutor(registry).executeToolCall({ function: { name: 'mcp_test_cancelled', arguments: '{}' } }, {
      signal: controller.signal,
      requestToolAuthorization: async () => { controller.abort(); return 'allow_always'; }
    });
    assert.equal(result.success, false);
    assert.equal(saved, false);
  } finally { security.manager.setToolPolicy = previous; }
});

test('AgentRuntime - compacta con el límite de contexto configurado y conserva el checkpoint', async t => {
  const history = [];
  for (let index = 0; index < 4; index++) {
    history.push(
      { role: 'user', content: `Pregunta ${index}: ${'detalle '.repeat(30)}` },
      { role: 'assistant', content: `Respuesta ${index}: ${'resultado '.repeat(30)}` }
    );
  }

  let summaryCalls = 0;
  const events = [];
  const registry = new ToolRegistry();
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        assert.equal(params.messages.length, 1);
        assert.equal(params.messages[0]._isSummaryBlock, true);
        return { accumulatedText: 'Respuesta final.', toolCalls: [], stats: { tokens: 12 } };
      }
    },
    messages: history,
    appendFinalMessage: true,
    contextOptions: { totalContextLimit: 300, compressionThresholdRatio: 0.5 },
    summarizeHistory: async ({ messages }) => {
      summaryCalls++;
      events.push('summarize');
      assert.equal(messages.length, history.length);
      return 'Checkpoint acumulativo.';
    },
    callbacks: {
      onCompactionStart: stepIndex => events.push(`start:${stepIndex}`)
    }
  });

  assert.equal(summaryCalls, 1);
  assert.deepEqual(events, ['start:0', 'summarize']);
  assert.equal(result.history[0]._isSummaryBlock, true);
  assert.equal(result.history[1].content, 'Respuesta final.');
});

test('AgentRuntime - no reintenta una compactación fallida durante el mismo ciclo', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'lookup', execute: async () => 'dato' }));
  const history = [];
  for (let index = 0; index < 4; index++) {
    history.push(
      { role: 'user', content: `Pregunta ${index}: ${'detalle '.repeat(30)}` },
      { role: 'assistant', content: `Respuesta ${index}: ${'resultado '.repeat(30)}` }
    );
  }

  let apiCalls = 0;
  let summaryCalls = 0;
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => {
        apiCalls++;
        return apiCalls === 1
          ? { accumulatedText: '', toolCalls: [{ id: 'call_lookup', function: { name: 'lookup', arguments: '{}' } }] }
          : { accumulatedText: 'Respuesta final.', toolCalls: [] };
      }
    },
    messages: history,
    contextOptions: { totalContextLimit: 300, compressionThresholdRatio: 0.5 },
    summarizeHistory: async () => {
      summaryCalls++;
      return '';
    }
  });

  assert.equal(result.success, true);
  assert.equal(summaryCalls, 1);
});

test('AgentRuntime - Tool call normal con resolución y respuesta final', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({
    name: 'calculate_sum',
    description: 'Suma dos números',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' }
      },
      required: ['a', 'b']
    },
    execute: async (args) => {
      return { sum: Number(args.a) + Number(args.b) };
    }
  }));

  // Simular mock de API
  let callCount = 0;
  const mockApi = {
    streamChatCompletion: async (params) => {
      callCount++;
      if (callCount === 1) {
        // Paso 1: El modelo decide llamar a la herramienta
        const toolCall = {
          id: 'call_sum_123',
          type: 'function',
          function: {
            name: 'calculate_sum',
            arguments: JSON.stringify({ a: 15, b: 27 })
          }
        };
        if (params.onChunk) params.onChunk('Calculando la suma...', 'Calculando la suma...', { tokens: 10 });
        return { accumulatedText: 'Calculando la suma...', toolCalls: [toolCall], stats: { tokens: 10 } };
      } else {
        // Paso 2: El modelo recibe el resultado y redacta la respuesta final
        const lastToolMsg = params.messages.find(m => m.role === 'tool');
        assert.ok(lastToolMsg, 'El mensaje de la herramienta debe estar en el contexto');
        const toolRes = JSON.parse(lastToolMsg.content);
        assert.equal(toolRes.sum, 42);

        const finalText = `El resultado de la suma es ${toolRes.sum}.`;
        if (params.onChunk) params.onChunk(finalText, finalText, { tokens: 25 });
        return { accumulatedText: finalText, toolCalls: [], stats: { tokens: 25 } };
      }
    }
  };
  const result = await runAgent(t, registry, {
    api: mockApi,
    messages: [{ role: 'user', content: '¿Cuánto es 15 + 27?' }]
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.stepsCount, 1);
  assert.equal(result.toolExecutions.length, 1);
  assert.equal(result.toolExecutions[0].toolName, 'calculate_sum');
  assert.equal(result.toolExecutions[0].result.sum, 42);
  assert.match(result.finalText, /42/);
  assert.equal(result.history.length, 3); // user, assistant(call), tool(res)
});

test('AgentRuntime - reenvía el razonamiento de cada paso dentro del turno y no lo guarda en el historial', async t => {
  const ChatEngine = require('../../js/chat-engine.js');
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'lookup', execute: async () => ({ ok: true }) }));

  const sent = [];
  let step = 0;
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        sent.push(params.messages);
        step++;
        if (step < 3) {
          return {
            accumulatedText: '',
            reasoningReplay: { field: 'reasoning_content', text: `plan ${step}` },
            toolCalls: [{ id: `call_${step}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ step }) } }]
          };
        }
        return { accumulatedText: 'Hecho.', toolCalls: [] };
      }
    },
    prepareMessages: messages => ({ messages: ChatEngine.buildEffectiveMessages(messages, require('../../js/config-store.js').normalize({})) }),
    messages: [{ role: 'user', content: 'Busca.' }]
  });

  assert.equal(result.status, 'completed');
  const replayed = sent[2].filter(m => m.role === 'assistant').map(m => m.reasoning_content);
  assert.deepEqual(replayed, ['plan 1', 'plan 2']);
  assert.equal(result.history.some(m => 'reasoningReplay' in m), false);
});

test('AgentRuntime - tras un rechazo del razonamiento, el resto del turno se envía sin él', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'lookup', execute: async () => ({ ok: true }) }));

  const efforts = [];
  const logs = [];
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        efforts.push(params.reasoningEffort);
        if (efforts.length === 1) {
          return { accumulatedText: '', recoveredReason: 'reasoning_rejected', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] };
        }
        if (efforts.length === 2) {
          return { accumulatedText: '', toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"again":true}' } }] };
        }
        return { accumulatedText: 'Hecho.', toolCalls: [] };
      }
    },
    reasoningEffort: 'xhigh',
    callbacks: { onLog: entry => logs.push(entry) },
    messages: [{ role: 'user', content: 'Busca.' }]
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(efforts, ['xhigh', '', '']);
  assert.equal(logs.filter(entry => entry.type === 'warning' && /reasoning parameter/.test(entry.text)).length, 1);
});

test('AgentRuntime - serializa el resultado para el modelo a través del contrato de la tool', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({
    name: 'contract_serialized_result',
    description: 'Devuelve un resultado con una representación específica para el modelo.',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    execute: async ({ value }) => ({ internalValue: value }),
    result: {
      toModel: (args, result) => `modelo:${args.value}:${result.internalValue}`
    }
  }));

  let step = 0;
  const mockApi = {
    streamChatCompletion: async (params) => {
      step++;
      if (step === 1) {
        return {
          accumulatedText: '',
          toolCalls: [{
            id: 'call_contract_serialized_result',
            function: { name: 'contract_serialized_result', arguments: '{"value":"hola"}' }
          }]
        };
      }

      const toolMessage = params.messages.find(message => message.role === 'tool');
      assert.equal(toolMessage.content, 'modelo:hola:hola');
      return { accumulatedText: 'Resultado recibido.', toolCalls: [] };
    }
  };

  const result = await runAgent(t, registry, {
    api: mockApi,
    messages: [{ role: 'user', content: 'Prueba el contrato.' }]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.history.find(message => message.role === 'tool').content, 'modelo:hola:hola');
});

test('AgentRuntime - Múltiples pasos agénticos secuenciales', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({
    name: 'get_user_id',
    execute: async () => ({ userId: 'usr_8899' })
  }));
  registry.registerTool(makeTool({
    name: 'get_user_orders',
    execute: async (args) => ({ orders: [`order_1_for_${args.userId}`, `order_2_for_${args.userId}`] })
  }));

  let step = 0;
  const mockApi = {
    streamChatCompletion: async (params) => {
      step++;
      if (step === 1) {
        const tc = { id: 'call_uid', function: { name: 'get_user_id', arguments: '{}' } };
        return { accumulatedText: '', toolCalls: [tc], stats: { tokens: 8 } };
      } else if (step === 2) {
        const tc = { id: 'call_orders', function: { name: 'get_user_orders', arguments: '{"userId":"usr_8899"}' } };
        return { accumulatedText: '', toolCalls: [tc], stats: { tokens: 16 } };
      } else {
        return { accumulatedText: 'El usuario tiene 2 pedidos registrados.', toolCalls: [], stats: { tokens: 24 } };
      }
    }
  };
  const result = await runAgent(t, registry, {
    api: mockApi,
    messages: [{ role: 'user', content: 'Dame los pedidos del usuario activo' }]
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.stepsCount, 2);
  assert.equal(result.toolExecutions.length, 2);
  assert.equal(result.toolExecutions[0].toolName, 'get_user_id');
  assert.equal(result.toolExecutions[1].toolName, 'get_user_orders');
  assert.equal(result.finalText, 'El usuario tiene 2 pedidos registrados.');
});

test('AgentRuntime - Error de herramienta capturado y recuperación en siguiente paso', async t => {
  const registry = new ToolRegistry();
  let attempts = 0;
  registry.registerTool(makeTool({
    name: 'unstable_tool',
    execute: async () => {
      attempts++;
      throw new Error('Servicio de base de datos no disponible');
    }
  }));

  let step = 0;
  const mockApi = {
    streamChatCompletion: async (params) => {
      step++;
      if (step === 1) {
        const tc = { id: 'call_err_1', function: { name: 'unstable_tool', arguments: '{}' } };
        return { accumulatedText: '', toolCalls: [tc], stats: { tokens: 10 } };
      } else {
        const toolMsg = params.messages.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        const parsed = JSON.parse(toolMsg.content);
        assert.equal(parsed.success, false);
        assert.match(parsed.error, /base de datos/);

        return { accumulatedText: 'No pude obtener los datos debido a un error en el servicio.', toolCalls: [], stats: { tokens: 30 } };
      }
    }
  };
  const result = await runAgent(t, registry, {
    api: mockApi,
    messages: [{ role: 'user', content: 'Consulta la base de datos' }]
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.toolExecutions[0].success, false);
  assert.match(result.toolExecutions[0].error, /base de datos/);
  assert.equal(attempts, 1);
  assert.match(result.finalText, /error en el servicio/);
});

test('AgentRuntime - Cancelación manual mediante AbortSignal', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({
    name: 'dummy_tool',
    execute: async () => ({ ok: true })
  }));

  const controller = new AbortController();
  const mockApi = {
    streamChatCompletion: async (params) => {
      controller.abort(); // Cancelar durante la petición
      throw new Error('Petición abortada');
    }
  };
  const result = await runAgent(t, registry, {
    api: mockApi,
    signal: controller.signal,
    messages: [{ role: 'user', content: 'Hola' }]
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'cancelled');
  assert.match(result.error.message, /cancelled/);
});

test('AgentRuntime - detener durante el stream conserva el texto recibido sin ejecutar herramientas', async t => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'dummy_tool', execute: async () => { executed = true; return { ok: true }; } }));
  const stopAfter = text => {
    const controller = new AbortController();
    const api = {
      streamChatCompletion: async () => {
        controller.abort();
        return { accumulatedText: text, toolCalls: [{ id: 'c1', function: { name: 'dummy_tool', arguments: '{}' } }], stats: null };
      }
    };
    return runAgent(t, registry, { api, signal: controller.signal, appendFinalMessage: true, messages: [{ role: 'user', content: 'Hola' }] });
  };

  const partial = await stopAfter('Respuesta a medias');
  assert.equal(partial.status, 'completed');
  assert.equal(partial.finalText, 'Respuesta a medias');
  assert.equal(partial.history.at(-1).content, 'Respuesta a medias');
  assert.equal(partial.history.some(message => message.tool_calls), false);

  const empty = await stopAfter('');
  assert.equal(empty.status, 'cancelled');
  assert.equal(executed, false);
});

// Simula un modelo que pide los pasos indicados y después responde sin herramientas.
// Cada paso es { tool, args, text }; registra las peticiones para comprobar que no hay síntesis.
function scriptedApi(steps, finalText = 'Trabajo terminado.') {
  const requests = [];
  let index = 0;
  return {
    requests,
    streamChatCompletion: async params => {
      requests.push(params);
      const step = steps[index++];
      if (!step) return { accumulatedText: finalText, toolCalls: [] };
      return {
        accumulatedText: step.text || '',
        toolCalls: [{ id: `call_${index}`, function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }]
      };
    }
  };
}

function countingRegistry(names) {
  const registry = new ToolRegistry();
  const counts = {};
  for (const name of names) {
    counts[name] = 0;
    registry.registerTool(makeTool({ name, execute: async () => { counts[name]++; return { ok: true }; } }));
  }
  return { registry, counts };
}

function assertNoSynthesis(api) {
  assert.ok(api.requests.every(params => params.tools.length > 0 && params.toolChoice !== 'none'),
    'El runtime nunca pide una síntesis sin herramientas');
}

test('AgentRuntime - permite ciclos de programación test -> editar -> test cuando la edición cambia', async t => {
  const { registry, counts } = countingRegistry(['run_tests', 'apply_change']);
  const steps = [];
  for (let i = 0; i < 8; i++) {
    steps.push({ tool: 'run_tests', args: { suite: 'unit' } }, { tool: 'apply_change', args: { target: 'app.js', patch: i } });
  }
  const api = scriptedApi(steps);
  const result = await runAgent(t, registry, { api, messages: [{ role: 'user', content: 'Corrige el proyecto.' }] });

  assert.equal(result.status, 'completed');
  assert.equal(counts.run_tests, 8);
  assert.equal(counts.apply_change, 8);
});

test('AgentRuntime - detiene el quinto lote idéntico consecutivo sin ejecutarlo ni sintetizar', async t => {
  const { registry, counts } = countingRegistry(['repeat']);
  const api = scriptedApi(Array.from({ length: 10 }, () => ({ tool: 'repeat', args: { value: 1 } })));
  let loopPeriod = null;
  const result = await runAgent(t, registry, {
    api,
    messages: [{ role: 'user', content: 'Repite.' }],
    appendFinalMessage: true,
    callbacks: { onLoopDetected: (_call, period) => { loopPeriod = period; } }
  });

  assert.equal(result.status, 'loop_detected');
  assert.equal(result.loopDetected, true);
  assert.equal(result.success, true);
  assert.equal(loopPeriod, 1);
  assert.equal(counts.repeat, 4);
  assert.equal(api.requests.length, 5);
  assert.match(result.finalText, /Infinite Loop Protection/);
  assert.equal(result.history.at(-1).role, 'assistant');
  assertNoSynthesis(api);
});

test('AgentRuntime - detiene dos lotes alternados tras cinco ciclos', async t => {
  const { registry, counts } = countingRegistry(['a', 'b']);
  const steps = [];
  for (let i = 0; i < 8; i++) steps.push({ tool: 'a', args: { n: 1 } }, { tool: 'b', args: { n: 2 } });
  const api = scriptedApi(steps);
  let loopPeriod = null;
  const result = await runAgent(t, registry, {
    api,
    messages: [{ role: 'user', content: 'Alterna.' }],
    callbacks: { onLoopDetected: (_call, period) => { loopPeriod = period; } }
  });

  assert.equal(result.status, 'loop_detected');
  assert.equal(loopPeriod, 2);
  assert.equal(api.requests.length, 10);
  assert.equal(counts.a, 5);
  assert.equal(counts.b, 4);
  assertNoSynthesis(api);
});

test('AgentRuntime - no considera bucle una serie interrumpida ni un ciclo de tres lotes', async t => {
  const { registry } = countingRegistry(['a', 'b', 'c']);
  const interrupted = [1, 2, 3, 4].map(() => ({ tool: 'a' })).concat([{ tool: 'b' }], [1, 2, 3, 4].map(() => ({ tool: 'a' })));
  const threeCycle = [];
  for (let i = 0; i < 6; i++) threeCycle.push({ tool: 'a' }, { tool: 'b' }, { tool: 'c' });

  for (const steps of [interrupted, threeCycle]) {
    const result = await runAgent(t, registry, { api: scriptedApi(steps), messages: [{ role: 'user', content: 'Trabaja.' }] });
    assert.equal(result.status, 'completed');
    assert.equal(result.stepsCount, steps.length);
  }
});

test('AgentRuntime - no limita el número de pasos', async t => {
  const { registry, counts } = countingRegistry(['read_page']);
  const steps = Array.from({ length: 60 }, (_, page) => ({ tool: 'read_page', args: { page } }));
  const api = scriptedApi(steps, 'Documento leído.');
  const result = await runAgent(t, registry, { api, messages: [{ role: 'user', content: 'Lee todo.' }] });

  assert.equal(result.status, 'completed');
  assert.equal(counts.read_page, 60);
  assert.equal(result.finalText, 'Documento leído.');
  assertNoSynthesis(api);
});

test('AgentRuntime - un texto nuevo para el usuario reinicia el control de bucles', async t => {
  const { registry, counts } = countingRegistry(['repeat']);
  const steps = [1, 2, 3, 4].map(() => ({ tool: 'repeat' }))
    .concat([{ tool: 'repeat', text: 'Sigo esperando a que el servicio responda.' }], [1, 2, 3].map(() => ({ tool: 'repeat' })));
  const result = await runAgent(t, registry, { api: scriptedApi(steps), messages: [{ role: 'user', content: 'Espera.' }] });

  assert.equal(result.status, 'completed');
  assert.equal(counts.repeat, 8);
});

test('AgentRuntime - la misma frase repetida en cada paso no reinicia el control de bucles', async t => {
  const { registry, counts } = countingRegistry(['repeat']);
  const steps = Array.from({ length: 8 }, (_, i) => ({ tool: 'repeat', text: i % 2 ? 'Voy a  buscar...' : 'voy a buscar...' }));
  const result = await runAgent(t, registry, { api: scriptedApi(steps), messages: [{ role: 'user', content: 'Busca.' }] });

  assert.equal(result.status, 'loop_detected');
  assert.equal(counts.repeat, 4);
});

test('AgentRuntime - una tool call emitida como texto no reinicia el control de bucles', async t => {
  const { registry, counts } = countingRegistry(['repeat']);
  const steps = Array.from({ length: 8 }, (_, i) => ({ tool: 'repeat', text: `<tool_call>{"name":"repeat","n":${i}}</tool_call>` }));
  const result = await runAgent(t, registry, { api: scriptedApi(steps), messages: [{ role: 'user', content: 'Repite.' }] });

  assert.equal(result.status, 'loop_detected');
  assert.equal(counts.repeat, 4);
});

test('AgentRuntime - Clean termination when model returns empty text after tools', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({
    name: 'fetch_stock',
    execute: async () => ({ price: 215.4 })
  }));

  let step = 0;

  const mockApi = {
    streamChatCompletion: async (params) => {
      step++;
      if (step === 1) {
        const tc = { id: 'call_stock', function: { name: 'fetch_stock', arguments: '{}' } };
        return { accumulatedText: '', toolCalls: [tc], stats: { tokens: 10 } };
      } else if (step === 2) {
        // Model returns empty text and no tool calls — clean termination expected
        return { accumulatedText: '', toolCalls: [], stats: { tokens: 5 } };
      }
    }
  };
  const result = await runAgent(t, registry, {
    api: mockApi,
    messages: [{ role: 'user', content: 'Get the stock price' }]
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  // No third API call — model terminated abruptly, no synthesis
  assert.equal(step, 2);
});

test('AgentRuntime - Ejecución de múltiples tool calls simultáneas en el mismo turno', async t => {
  const registry = new ToolRegistry();
  const executedCalls = [];

  registry.registerTool(makeTool({
    name: 'fetch_metric_a',
    execute: async (args) => {
      executedCalls.push({ tool: 'a', args });
      return { value: 100 };
    }
  }));

  registry.registerTool(makeTool({
    name: 'fetch_metric_b',
    execute: async (args) => {
      executedCalls.push({ tool: 'b', args });
      return { value: 200 };
    }
  }));

  let stepCount = 0;
  const mockApi = {
    streamChatCompletion: async (params) => {
      stepCount++;
      if (stepCount === 1) {
        return {
          accumulatedText: '',
          toolCalls: [
            { id: 'call_1', function: { name: 'fetch_metric_a', arguments: '{"year":2019}' } },
            { id: 'call_2', function: { name: 'fetch_metric_b', arguments: '{"year":2020}' } }
          ],
          stats: { tokens: 15 }
        };
      }
      // Paso 2: El modelo recibe ambas respuestas y sintetiza
      assert.equal(params.messages.length, 4); // user, assistant(with 2 tool_calls), tool1, tool2
      assert.equal(params.messages[1].role, 'assistant');
      assert.equal(params.messages[1].tool_calls.length, 2);
      assert.equal(params.messages[2].role, 'tool');
      assert.equal(params.messages[2].tool_call_id, 'call_1');
      assert.equal(params.messages[3].role, 'tool');
      assert.equal(params.messages[3].tool_call_id, 'call_2');

      return {
        accumulatedText: 'Métricas recuperadas: 100 y 200.',
        toolCalls: [],
        stats: { tokens: 25 }
      };
    }
  };
  const result = await runAgent(t, registry, {
    api: mockApi,
    messages: [{ role: 'user', content: 'Dame métricas A y B' }]
  });

  assert.equal(result.success, true);
  assert.equal(executedCalls.length, 2);
  assert.deepEqual(executedCalls[0], { tool: 'a', args: { year: 2019 } });
  assert.deepEqual(executedCalls[1], { tool: 'b', args: { year: 2020 } });
  assert.equal(result.toolExecutions.length, 2);
  assert.equal(result.finalText, 'Métricas recuperadas: 100 y 200.');
});

test('AgentRuntime - una herramienta con endTurn cede el turno sin más peticiones', async t => {
  const registry = new ToolRegistry();
  {
    let requests = 0;
    const result = await runAgent(t, registry, {
      api: {
        streamChatCompletion: async () => {
          requests++;
          return {
            accumulatedText: 'Necesito tu decisión.',
            toolCalls: [{ id: 'call_ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '¿Aplico?', options: ['Sí', 'No'] }) } }],
            stats: null
          };
        }
      },
      messages: [{ role: 'user', content: 'Revisa el proyecto' }],
      appendFinalMessage: true
    });
    assert.equal(requests, 1, 'no hay más pasos tras ceder el turno');
    assert.equal(result.status, 'completed');
    assert.equal(result.awaitingUser, true);
    assert.equal(result.success, true);
    const last = result.history[result.history.length - 1];
    assert.equal(last.role, 'tool');
    assert.equal(last.name, 'ask_user');
    assert.equal(result.history[result.history.length - 2].content, 'Necesito tu decisión.');
  }
});

test('AgentRuntime - una pregunta inválida no cede el turno y el modelo puede corregirla', async t => {
  const registry = new ToolRegistry();
  let requests = 0;
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => {
        requests++;
        if (requests === 1) {
          return { accumulatedText: '', toolCalls: [{ id: 'call_bad', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '¿?', options: ['Solo'] }) } }], stats: null };
        }
        return { accumulatedText: 'Respuesta directa.', toolCalls: [], stats: null };
      }
    },
    messages: [{ role: 'user', content: 'Hola' }],
    appendFinalMessage: true
  });
  assert.equal(requests, 2);
  assert.equal(result.awaitingUser, false);
  assert.equal(result.finalText, 'Respuesta directa.');
});

