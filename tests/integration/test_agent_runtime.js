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
  return new AgentRuntime({ registry, executor: new ToolExecutor(registry) }).execute({ resolveToolDefinitions: () => registry.getActiveDefinitions(TOOL_CONFIG), ...params });
}

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

test('AgentRuntime - la pausa del servidor en una ejecución desatendida cierra el turno sin preguntar y deja la llamada pendiente', async t => {
  const registry = new ToolRegistry();
  let asked = false;
  registry.registerTool(makeTool({
    name: 'mcp_test_pause_action',
    category: 'mcp',
    // El servidor de una ejecución desatendida no emite un reto: responde que la llamada espera a la persona.
    execute: async () => ({ awaitingApproval: true, toolName: 'mcp_test_pause_action', ruleOffer: { rule: 'RW:/x/**' } })
  }));
  registry.registerTool(makeTool({ name: 'second_tool', execute: async () => assert.fail('El turno termina con la pausa') }));

  const executor = new ToolExecutor(registry);
  let steps = 0;
  const result = await runAgent(t, registry, {
    dispatchToolCall: (toolCall, context) => executor.executeToolCall(toolCall, { ...context, requestToolAuthorization: async () => { asked = true; return 'allow_once'; } }),
    api: {
      streamChatCompletion: async () => {
        steps += 1;
        return {
          accumulatedText: 'Voy a ejecutar la herramienta.',
          toolCalls: [{ id: 'call_p1', function: { name: 'mcp_test_pause_action', arguments: '{}' } }]
        };
      }
    },
    messages: [{ role: 'user', content: 'Ejecuta.' }]
  });

  assert.equal(asked, false, 'No se responde con la tarjeta: lo decide la persona en la interfaz');
  assert.equal(steps, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.history.length, 3); // user, assistant, tool
  assert.equal(result.history[1].tool_calls[0].function.name, 'mcp_test_pause_action');
  const toolPayload = JSON.parse(result.history[2].content);
  assert.deepEqual(toolPayload, { success: false, error: 'Execution paused waiting for user authorization.', awaitingApproval: true, ruleOffer: { rule: 'RW:/x/**' } });
});

test('AgentRuntime - compacta solo turnos cerrados conservando el turno en curso y no reintenta si falla en el mismo ciclo', async t => {
  const history = [];
  for (let index = 0; index < 4; index++) {
    history.push(
      { role: 'user', content: `Pregunta ${index}: ${'detalle '.repeat(30)}` },
      { role: 'assistant', content: `Respuesta ${index}: ${'resultado '.repeat(30)}` }
    );
  }
  history.push({ role: 'user', content: 'Petición actual que debe conservarse.' });

  let summaryCalls = 0;
  const events = [];
  const registry = new ToolRegistry();
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        assert.equal(params.messages.length, 2);
        assert.equal(params.messages[0]._isSummaryBlock, true);
        assert.equal(params.messages[1].role, 'user');
        assert.equal(params.messages[1].content, 'Petición actual que debe conservarse.');
        return { accumulatedText: 'Respuesta final.', toolCalls: [], stats: { tokens: 12 } };
      }
    },
    messages: history,
    contextOptions: { totalContextLimit: 300, compressionThresholdRatio: 0.5 },
    summarizeHistory: async ({ messages }) => {
      summaryCalls++;
      events.push('summarize');
      assert.equal(messages.length, history.length - 1);
      return 'Checkpoint acumulativo.';
    },
    callbacks: {
      onCompactionStart: stepIndex => events.push(`start:${stepIndex}`)
    }
  });

  assert.equal(summaryCalls, 1);
  assert.deepEqual(events, ['start:0', 'summarize']);
  assert.equal(result.history[0]._isSummaryBlock, true);
  assert.equal(result.history[1].role, 'user');
  assert.equal(result.history[2].content, 'Respuesta final.');

  // Si la compactación devuelve vacío, no la repite en el siguiente paso del mismo turno
  registry.registerTool(makeTool({ name: 'lookup', execute: async () => 'dato' }));
  let apiCalls = 0;
  let failedSummaryCalls = 0;
  const failedRes = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => (++apiCalls === 1
        ? { accumulatedText: '', toolCalls: [{ id: 'call_lookup', function: { name: 'lookup', arguments: '{}' } }] }
        : { accumulatedText: 'Respuesta final.', toolCalls: [] })
    },
    messages: history,
    contextOptions: { totalContextLimit: 300, compressionThresholdRatio: 0.5 },
    summarizeHistory: async () => { failedSummaryCalls++; return ''; }
  });
  assert.equal(failedRes.status, 'completed');
  assert.equal(failedSummaryCalls, 1);

  // Un turno largo sin turnos cerrados previos no dispara compactación destructiva que borre el user
  let singleTurnSummaryCalls = 0;
  const singleTurnHistory = [
    { role: 'user', content: 'Investiga varios archivos.' },
    ...Array.from({ length: 4 }, (_, i) => ([
      { role: 'assistant', content: null, tool_calls: [{ id: `c_${i}`, function: { name: 'lookup', arguments: `{"i":${i}}` } }] },
      { role: 'tool', tool_call_id: `c_${i}`, name: 'lookup', content: 'datos '.repeat(200) }
    ])).flat()
  ];
  const singleTurnRes = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        assert.equal(params.messages[0].role, 'user');
        return { accumulatedText: 'Resumen listo.', toolCalls: [] };
      }
    },
    messages: singleTurnHistory,
    contextOptions: { totalContextLimit: 300, compressionThresholdRatio: 0.5 },
    summarizeHistory: async () => { singleTurnSummaryCalls++; return 'No debería llamarse'; }
  });
  assert.equal(singleTurnRes.status, 'completed');
  assert.equal(singleTurnSummaryCalls, 0);

  // Calibración con promptTokens reales del servidor: aunque el estimador local vea pocos tokens, si el paso 1
  // informa un promptTokens real muy por encima del umbral, el paso 2 compacta los turnos cerrados.
  const shortClosedHistory = [
    { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' }, { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' }, { role: 'assistant', content: 'a4' },
    { role: 'user', content: 'actual' }
  ];
  let calibratedStep = 0;
  let calibratedSummaries = 0;
  const calibratedRes = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => (++calibratedStep === 1
        ? { accumulatedText: '', toolCalls: [{ id: 'c_cal', function: { name: 'lookup', arguments: '{}' } }], stats: { promptTokens: 1800, completionTokens: 10, isEstimated: false } }
        : { accumulatedText: 'Listo.', toolCalls: [], stats: { promptTokens: 500, completionTokens: 10, isEstimated: false } })
    },
    messages: shortClosedHistory,
    contextOptions: { maxInputTokens: 2000, compressionThresholdRatio: 0.7 },
    summarizeHistory: async () => { calibratedSummaries++; return 'Checkpoint calibrado.'; }
  });
  assert.equal(calibratedRes.status, 'completed');
  assert.equal(calibratedSummaries, 1);
  assert.equal(calibratedRes.history[0]._isSummaryBlock, true);
});

test('AgentRuntime - la conexión del agente solo llega a las herramientas de categoría agent', async t => {
  const registry = new ToolRegistry();
  registry.unregisterProvider('builtin');
  const seen = {};
  const spy = (name, category) => makeTool({ name, category, execute: async (_args, context) => { seen[name] = context; return { success: true }; } });
  registry.registerTool(spy('plain_tool', 'general'));
  registry.registerTool(spy('mcp_tool', 'mcp'));
  registry.registerTool(spy('spawning_tool', 'agent'));
  const toolCalls = ['plain_tool', 'mcp_tool', 'spawning_tool'].map(name => ({ id: `call_${name}`, type: 'function', function: { name, arguments: '{}' } }));
  let requests = 0;
  const controller = new AbortController();

  await runAgent(t, registry, {
    api: { streamChatCompletion: async () => (++requests === 1 ? { accumulatedText: '', toolCalls } : { accumulatedText: 'Hecho', toolCalls: [] }) },
    apiUrl: 'http://main/v1', apiKey: 'secret-key', model: 'main-model',
    signal: controller.signal,
    messages: [{ role: 'user', content: 'Conversación privada' }]
  });

  for (const name of ['plain_tool', 'mcp_tool']) {
    assert.equal(seen[name].signal, controller.signal);
    assert.equal(seen[name].agent, undefined);
    assert.equal(JSON.stringify(seen[name]).includes('secret-key'), false, `${name} no recibe la API key`);
    assert.equal(seen[name].messages, undefined, `${name} no recibe el historial`);
  }
  assert.equal(seen.spawning_tool.agent.apiKey, 'secret-key');
  assert.equal(seen.spawning_tool.agent.model, 'main-model');
});

test('AgentRuntime - pasos secuenciales, error de herramienta con recuperación y fin limpio si el modelo devuelve vacío', async t => {
  const registry = new ToolRegistry();
  let attempts = 0;
  registry.registerTool(makeTool({ name: 'get_user_id', execute: async () => ({ userId: 'usr_8899' }) }));
  registry.registerTool(makeTool({ name: 'get_user_orders', execute: async args => ({ orders: [`order_1_for_${args.userId}`, `order_2_for_${args.userId}`] }) }));
  registry.registerTool(makeTool({ name: 'unstable_tool', execute: async () => { attempts++; throw new Error('Servicio de base de datos no disponible'); } }));

  let step = 0;
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        step++;
        if (step === 1) return { accumulatedText: 'Buscando...', toolCalls: [{ id: 'call_uid', function: { name: 'get_user_id', arguments: '{}' } }], stats: { tokens: 8 } };
        if (step === 2) return { accumulatedText: '', toolCalls: [{ id: 'call_orders', function: { name: 'get_user_orders', arguments: '{"userId":"usr_8899"}' } }], stats: { tokens: 16 } };
        if (step === 3) return { accumulatedText: '', toolCalls: [{ id: 'call_err_1', function: { name: 'unstable_tool', arguments: '{}' } }], stats: { tokens: 10 } };
        const errTool = params.messages.filter(m => m.role === 'tool').at(-1);
        assert.equal(JSON.parse(errTool.content).success, false);
        assert.match(JSON.parse(errTool.content).error, /base de datos/);
        return { accumulatedText: 'El usuario tiene 2 pedidos, aunque un servicio secundario falló.', toolCalls: [], stats: { tokens: 24 } };
      }
    },
    messages: [{ role: 'user', content: 'Dame los pedidos del usuario activo' }]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.stepsCount, 3);
  assert.equal(result.toolCallCount, 3);
  assert.equal(attempts, 1);
  assert.deepEqual(result.history.filter(m => m.role === 'tool').map(m => m.name), ['get_user_id', 'get_user_orders', 'unstable_tool']);
  assert.match(result.finalText, /2 pedidos/);

  // Si el modelo devuelve texto vacío y sin herramientas tras un paso, termina limpiamente sin pedir síntesis
  let emptySteps = 0;
  const emptyRes = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => (++emptySteps === 1
        ? { accumulatedText: '', toolCalls: [{ id: 'c1', function: { name: 'get_user_id', arguments: '{}' } }], stats: { tokens: 10 } }
        : { accumulatedText: '', toolCalls: [], stats: { tokens: 5 } })
    },
    messages: [{ role: 'user', content: 'ID' }]
  });
  assert.equal(emptyRes.status, 'completed');
  assert.equal(emptySteps, 2);
});

test('AgentRuntime - suma el consumo de todas las llamadas al modelo del turno y lo avisa tras cada una', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'get_user_id', execute: async () => ({ userId: 'usr_1' }) }));
  const steps = [
    { accumulatedText: '', toolCalls: [{ id: 'c1', function: { name: 'get_user_id', arguments: '{}' } }],
      stats: { promptTokens: 1000, completionTokens: 40, cachedTokens: 800, reasoningTokens: 10, isEstimated: false } },
    { accumulatedText: 'Listo.', toolCalls: [], stats: { promptTokens: 1200, completionTokens: 15, cachedTokens: 1000, reasoningTokens: 0, isEstimated: false } }
  ];
  const updates = [];
  const result = await runAgent(t, registry, {
    api: { streamChatCompletion: async () => steps.shift() },
    messages: [{ role: 'user', content: 'ID' }],
    callbacks: { onUsage: usage => updates.push(usage) }
  });
  const total = { modelCalls: 2, promptTokens: 2200, completionTokens: 55, cachedTokens: 1800, reasoningTokens: 10, estimated: false };
  assert.deepEqual(updates.map(usage => usage.modelCalls), [1, 2]);
  assert.deepEqual(updates.at(-1), total);
  assert.deepEqual(result.usage, total);

  // Un paso sin cifras del servidor cuenta como llamada y deja el total como estimado.
  const estimated = await runAgent(t, registry, {
    api: { streamChatCompletion: async () => ({ accumulatedText: 'Hola.', toolCalls: [], stats: { tokens: 7 } }) },
    messages: [{ role: 'user', content: 'Hola' }]
  });
  assert.deepEqual(estimated.usage, { modelCalls: 1, promptTokens: 0, completionTokens: 7, cachedTokens: 0, reasoningTokens: 0, estimated: true });
});

test('AgentRuntime - reenvía el razonamiento de cada paso dentro del turno, no lo guarda y si se rechaza deja de enviarlo', async t => {
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
    prepareMessages: messages => ChatEngine.buildEffectiveMessages(messages, require('../../js/config-store.js').normalize({})),
    messages: [{ role: 'user', content: 'Busca.' }]
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(sent[2].filter(m => m.role === 'assistant').map(m => m.reasoning_content), ['plan 1', 'plan 2']);
  assert.equal(result.history.some(m => 'reasoningReplay' in m), false);

  const efforts = [];
  const logs = [];
  const rejectedRes = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        efforts.push(params.reasoningEffort);
        if (efforts.length === 1) return { accumulatedText: '', recoveredReason: 'reasoning_rejected', toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] };
        if (efforts.length === 2) return { accumulatedText: '', toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"again":true}' } }] };
        return { accumulatedText: 'Hecho.', toolCalls: [] };
      }
    },
    reasoningEffort: 'xhigh',
    callbacks: { onLog: entry => logs.push(entry) },
    messages: [{ role: 'user', content: 'Busca.' }]
  });
  assert.equal(rejectedRes.status, 'completed');
  assert.deepEqual(efforts, ['xhigh', '', '']);
  assert.equal(logs.filter(entry => entry.type === 'warning' && /reasoning parameter/.test(entry.text)).length, 1);
});

test('AgentRuntime - cancelación manual con AbortSignal conserva el texto recibido sin ejecutar herramientas', async t => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.registerTool(makeTool({ name: 'dummy_tool', execute: async () => { executed = true; return { ok: true }; } }));

  const abortedController = new AbortController();
  const thrown = await runAgent(t, registry, {
    api: { streamChatCompletion: async () => { abortedController.abort(); throw new Error('Petición abortada'); } },
    signal: abortedController.signal,
    messages: [{ role: 'user', content: 'Hola' }]
  });
  assert.equal(thrown.status, 'cancelled');

  const stopAfter = text => {
    const controller = new AbortController();
    const api = {
      streamChatCompletion: async () => {
        controller.abort();
        return { accumulatedText: text, toolCalls: [{ id: 'c1', function: { name: 'dummy_tool', arguments: '{}' } }], stats: null };
      }
    };
    return runAgent(t, registry, { api, signal: controller.signal, messages: [{ role: 'user', content: 'Hola' }] });
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

test('AgentRuntime - detección de bucles: quinto lote idéntico o alternado se detiene incluso con narración distinta, pero argumentos distintos continúan sin límite de pasos', async t => {
  // 1. Ciclos de programación test -> editar -> test con edición distinta y lectura de 60 páginas
  const { registry: progReg, counts: progCounts } = countingRegistry(['run_tests', 'apply_change', 'read_page']);
  const progSteps = [];
  for (let i = 0; i < 8; i++) {
    progSteps.push({ tool: 'run_tests', args: { suite: 'unit' } }, { tool: 'apply_change', args: { target: 'app.js', patch: i } });
  }
  const progRes = await runAgent(t, progReg, { api: scriptedApi(progSteps), messages: [{ role: 'user', content: 'Corrige.' }] });
  assert.equal(progRes.status, 'completed');
  assert.equal(progCounts.run_tests, 8);
  assert.equal(progCounts.apply_change, 8);

  const longApi = scriptedApi(Array.from({ length: 60 }, (_, page) => ({ tool: 'read_page', args: { page } })), 'Documento leído.');
  const longRes = await runAgent(t, progReg, { api: longApi, messages: [{ role: 'user', content: 'Lee todo.' }] });
  assert.equal(longRes.status, 'completed');
  assert.equal(progCounts.read_page, 60);
  assertNoSynthesis(longApi);

  // 2. Quinto lote idéntico consecutivo se detiene sin ejecutarlo ni sintetizar
  const { registry: repReg, counts: repCounts } = countingRegistry(['repeat']);
  const repApi = scriptedApi(Array.from({ length: 10 }, () => ({ tool: 'repeat', args: { value: 1 } })));
  const repRes = await runAgent(t, repReg, { api: repApi, loopNotice: 'Aviso de bucle', messages: [{ role: 'user', content: 'Repite.' }] });
  assert.equal(repRes.status, 'loop_detected');
  assert.equal(repCounts.repeat, 4);
  assert.equal(repApi.requests.length, 5);
  assert.equal(repRes.finalText, 'Aviso de bucle');
  assertNoSynthesis(repApi);

  // 3. Dos lotes alternados tras cinco ciclos se detienen; serie interrumpida o ciclo de tres lotes no
  const { registry: altReg, counts: altCounts } = countingRegistry(['a', 'b', 'c']);
  const altSteps = [];
  for (let i = 0; i < 8; i++) altSteps.push({ tool: 'a', args: { n: 1 } }, { tool: 'b', args: { n: 2 } });
  const altApi = scriptedApi(altSteps);
  const altRes = await runAgent(t, altReg, { api: altApi, messages: [{ role: 'user', content: 'Alterna.' }] });
  assert.equal(altRes.status, 'loop_detected');
  assert.equal(altApi.requests.length, 10);
  assert.equal(altCounts.a, 5);
  assert.equal(altCounts.b, 4);
  assertNoSynthesis(altApi);

  const interrupted = [1, 2, 3, 4].map(() => ({ tool: 'a' })).concat([{ tool: 'b' }], [1, 2, 3, 4].map(() => ({ tool: 'a' })));
  const threeCycle = [];
  for (let i = 0; i < 6; i++) threeCycle.push({ tool: 'a' }, { tool: 'b' }, { tool: 'c' });
  for (const steps of [interrupted, threeCycle]) {
    const res = await runAgent(t, altReg, { api: scriptedApi(steps), messages: [{ role: 'user', content: 'Trabaja.' }] });
    assert.equal(res.status, 'completed');
  }

  // 4. El texto narrativo que acompaña a llamadas repetidas (aunque cambie en cada paso) no reinicia el control
  const { registry: txtReg, counts: txtCounts } = countingRegistry(['repeat']);
  for (const steps of [
    Array.from({ length: 8 }, (_, i) => ({ tool: 'repeat', text: `Ahora reviso el paso ${i + 1}...` })),
    Array.from({ length: 8 }, (_, i) => ({ tool: 'repeat', text: i % 2 ? 'Voy a  buscar...' : 'voy a buscar...' })),
    Array.from({ length: 8 }, (_, i) => ({ tool: 'repeat', text: `<tool_call>{"name":"repeat","n":${i}}</tool_call>` }))
  ]) {
    txtCounts.repeat = 0;
    const res = await runAgent(t, txtReg, { api: scriptedApi(steps), messages: [{ role: 'user', content: 'Busca.' }] });
    assert.equal(res.status, 'loop_detected');
    assert.equal(txtCounts.repeat, 4);
  }
});

test('AgentRuntime - repetir check_command o check_agents mientras lo vigilado avanza no es un bucle; sin avance, la quinta se detiene', async t => {
  /** Registro con la espera `name`, que devuelve en orden los resultados de `results` (el último se repite). */
  const waitRegistry = (name, results) => {
    const registry = new ToolRegistry();
    let calls = 0;
    registry.registerTool(makeTool({ name, execute: async () => results[Math.min(calls++, results.length - 1)] }));
    return { registry, count: () => calls };
  };
  const repeat = (tool, times, args = { job_id: 4, wait_seconds: 240 }) => scriptedApi(Array.from({ length: times }, () => ({ tool, args })), 'Hecho.');
  const run = async (name, results, times, args) => {
    const { registry, count } = waitRegistry(name, results);
    const res = await runAgent(t, registry, { api: repeat(name, times, args), messages: [{ role: 'user', content: 'Sigue el trabajo.' }] });
    return { status: res.status, executed: count() };
  };
  const command = (status, newOutput = '', exitCode = null, extra = {}) => ({ success: true, status, new_output: newOutput, exit_code: exitCode, ...extra });

  // check_command: salida nueva en cada espera (o el paso de en marcha a terminado) es avance.
  assert.deepEqual(await run('check_command', Array.from({ length: 8 }, (_, i) => command('running', `línea ${i}\n`)), 8), { status: 'completed', executed: 8 });
  // Sondeos inmediatos sin espera real (sin wait_elapsed o wait_seconds < 10), o comando ya terminado: la quinta se detiene.
  assert.deepEqual(await run('check_command', [command('running')], 10), { status: 'loop_detected', executed: 4 });
  assert.deepEqual(await run('check_command', [command('running', '', null, { returned_because: 'wait_elapsed' })], 10, { job_id: 4, wait_seconds: 5 }), { status: 'loop_detected', executed: 4 });
  assert.deepEqual(await run('check_command', [command('exited', '', 0)], 10), { status: 'loop_detected', executed: 4 });
  // Comando silencioso en marcha con espera real (wait_elapsed y wait_seconds >= 10): margen acotado de 6 esperas + 4 repeticiones = 10 ejecutadas antes de cortar en la 11.ª.
  assert.deepEqual(await run('check_command', [command('running', '', null, { returned_because: 'wait_elapsed' })], 10, { job_id: 4, wait_seconds: 60 }), { status: 'completed', executed: 10 });
  assert.deepEqual(await run('check_command', [command('running', '', null, { returned_because: 'wait_elapsed' })], 15, { job_id: 4, wait_seconds: 60 }), { status: 'loop_detected', executed: 10 });
  // Tres esperas sin salida y luego termina: el final es avance y hacen falta cinco más iguales para detenerse.
  const transition = [command('running'), command('running'), command('running'), command('exited', '', 0)];
  assert.deepEqual(await run('check_command', transition, 8), { status: 'completed', executed: 8 });
  assert.deepEqual(await run('check_command', transition, 12), { status: 'loop_detected', executed: 8 });

  // check_agents: un agente en marcha cuya actividad avanza (updated_at, paso, consumo) no es un bucle.
  const agents = (updatedAt, status = 'running', stepText = 'paso') => ({
    success: true, returned_because: 'wait_elapsed', agents: [{ agent: 'a.b', conversation_id: 'c1', status, updated_at: updatedAt, step_text: stepText, usage: null }]
  });
  assert.deepEqual(await run('check_agents', Array.from({ length: 8 }, (_, i) => agents(1000 + i)), 8), { status: 'completed', executed: 8 });
  assert.deepEqual(await run('check_agents', Array.from({ length: 8 }, (_, i) => agents(1000, 'running', `paso ${i}`)), 8), { status: 'completed', executed: 8 });
  // Sin ningún avance (en marcha quieto o ya terminado), como cualquier otra llamada repetida.
  assert.deepEqual(await run('check_agents', [agents(1000)], 10), { status: 'loop_detected', executed: 4 });
  assert.deepEqual(await run('check_agents', [agents(2000, 'completed')], 10), { status: 'loop_detected', executed: 4 });
  // Otra herramienta con el mismo resultado cambiante sigue contando como repetición.
  assert.deepEqual(await run('read_status', Array.from({ length: 8 }, (_, i) => command('running', `línea ${i}\n`)), 8), { status: 'loop_detected', executed: 4 });
});

test('AgentRuntime - maxSteps detiene el turno en el borde exacto sin cerrarlo, con los resultados del último paso en el historial', async t => {
  const { registry, counts } = countingRegistry(['read_page']);
  const pages = () => scriptedApi(Array.from({ length: 5 }, (_, page) => ({ tool: 'read_page', args: { page } })), 'Leído.');
  const atLimit = pages();
  const done = await runAgent(t, registry, { api: atLimit, maxSteps: 6, messages: [{ role: 'user', content: 'Lee.' }] });
  assert.equal(done.status, 'completed');
  assert.equal(atLimit.requests.length, 6);

  const overLimit = pages();
  const stopped = await runAgent(t, registry, { api: overLimit, maxSteps: 5, messages: [{ role: 'user', content: 'Lee.' }] });
  assert.equal(stopped.status, 'step_limit');
  assert.equal(overLimit.requests.length, 5);
  assert.equal(counts.read_page, 10);
  assert.equal(stopped.finalText, '');
  assert.equal(stopped.history.at(-1).role, 'tool');
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

  assert.equal(result.status, 'completed');
  assert.equal(executedCalls.length, 2);
  assert.deepEqual(executedCalls[0], { tool: 'a', args: { year: 2019 } });
  assert.deepEqual(executedCalls[1], { tool: 'b', args: { year: 2020 } });
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.finalText, 'Métricas recuperadas: 100 y 200.');
});

test('AgentRuntime - una herramienta con endTurn cede el turno sin más peticiones, salvo que sus argumentos sean inválidos', async t => {
  const registry = new ToolRegistry();
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
    messages: [{ role: 'user', content: 'Revisa el proyecto' }]
  });
  assert.equal(requests, 1, 'no hay más pasos tras ceder el turno');
  assert.equal(result.status, 'completed');
  assert.equal(result.history.at(-1).name, 'ask_user');
  assert.equal(result.history.at(-2).content, 'Necesito tu decisión.');

  let badRequests = 0;
  const recovered = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => (++badRequests === 1
        ? { accumulatedText: '', toolCalls: [{ id: 'call_bad', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '¿?', options: ['Solo'] }) } }], stats: null }
        : { accumulatedText: 'Respuesta directa.', toolCalls: [], stats: null })
    },
    messages: [{ role: 'user', content: 'Hola' }]
  });
  assert.equal(badRequests, 2);
  assert.equal(recovered.finalText, 'Respuesta directa.');
});

test('AgentRuntime - execute_javascript y render_chart ejecutan en Node sin DOM', async t => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool(require('../../js/tools/builtin/execute-javascript.tool.js')));
  registry.registerTool(new Tool(require('../../js/tools/builtin/render-chart.tool.js')));

  let step = 0;
  const chartArgs = { type: 'pie', title: 'Distribución', labels: ['A', 'B'], datasets: [{ label: 'Total', data: [60, 40] }] };
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async () => {
        step++;
        if (step === 1) {
          return {
            accumulatedText: 'Calculando y graficando.',
            toolCalls: [
              { id: 'call_calc_1', type: 'function', function: { name: 'execute_javascript', arguments: JSON.stringify({ code: 'return Math.pow(2, 8);' }) } },
              { id: 'call_chart_1', type: 'function', function: { name: 'render_chart', arguments: JSON.stringify(chartArgs) } }
            ],
            stats: null
          };
        }
        return { accumulatedText: 'El resultado es 256.', toolCalls: [], stats: null };
      }
    },
    messages: [{ role: 'user', content: 'Calcula y grafica' }]
  });

  assert.equal(step, 2);
  assert.equal(result.toolCallCount, 2);
  const tools = result.history.filter(m => m.role === 'tool');
  assert.equal(tools[0].content, '256');
  assert.equal(tools[1].content, JSON.stringify({ success: true, type: 'pie', title: 'Distribución' }));
});


test('AgentRuntime - resolveConnection cambia de modelo desde el siguiente paso sin reenviarle el razonamiento del anterior', async t => {
  const ChatEngine = require('../../js/chat-engine.js');
  const registry = new ToolRegistry();
  let connection = { model: 'a', reasoningEffort: 'high' };
  registry.registerTool(makeTool({ name: 'switch', execute: async () => { connection = { model: 'b', apiKey: 'kb', reasoningEffort: 'low' }; return { ok: true }; } }));
  registry.registerTool(makeTool({ name: 'lookup', execute: async () => ({ ok: true }) }));

  const sent = [];
  const result = await runAgent(t, registry, {
    api: {
      streamChatCompletion: async params => {
        sent.push(params);
        const name = ['lookup', 'switch'][sent.length - 1];
        if (!name) return { accumulatedText: 'Hecho.', toolCalls: [] };
        return {
          accumulatedText: '',
          reasoningReplay: { field: 'reasoning_content', text: `plan ${sent.length}` },
          toolCalls: [{ id: `call_${sent.length}`, type: 'function', function: { name, arguments: '{}' } }]
        };
      }
    },
    model: 'a',
    apiKey: 'ka',
    reasoningEffort: 'high',
    resolveConnection: () => connection,
    prepareMessages: messages => ChatEngine.buildEffectiveMessages(messages, require('../../js/config-store.js').normalize({})),
    messages: [{ role: 'user', content: 'Busca y cambia.' }]
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(sent.map(params => [params.model, params.apiKey, params.reasoningEffort]), [['a', 'ka', 'high'], ['a', 'ka', 'high'], ['b', 'kb', 'low']]);
  assert.deepEqual(sent[1].messages.filter(m => m.role === 'assistant').map(m => m.reasoning_content), ['plan 1']);
  assert.equal(sent[2].messages.some(m => 'reasoning_content' in m), false);
  // Para el modelo nuevo, lo anterior al cambio es un turno cerrado: un mensaje de usuario que no se guarda.
  const roles = messages => messages.filter(m => m.role !== 'system').map(m => m.role);
  assert.deepEqual(roles(sent[1].messages), ['user', 'assistant', 'tool']);
  assert.deepEqual(roles(sent[2].messages), ['user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
  assert.match(sent[2].messages.at(-1).content, /switched the model/);
  assert.deepEqual(result.history.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
});
