const test = require('node:test');
const assert = require('node:assert/strict');

const AgentCoreModule = require('../js/agent-core.js');
const { AgentRuntime, Tool, ToolRegistry, ToolExecutor } = AgentCoreModule;

test('AgentRuntime - el camino directo de reintentos no omite la política de tools', async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.registerTool(new Tool({
    name: 'mcp__test__sensitive_action',
    category: 'mcp',
    execute: async () => {
      executions++;
      return { success: true };
    }
  }));

  const result = await new AgentRuntime({ registry }).executeToolWithRetries({
    function: { name: 'mcp__test__sensitive_action', arguments: '{}' }
  });

  assert.equal(result.success, false);
  assert.match(result.error, /autorización explícita/i);
  assert.equal(executions, 0);
});

test('AgentRuntime - compacta con el límite de contexto configurado y conserva el checkpoint', async () => {
  const history = [];
  for (let index = 0; index < 4; index++) {
    history.push(
      { role: 'user', content: `Pregunta ${index}: ${'detalle '.repeat(30)}` },
      { role: 'assistant', content: `Respuesta ${index}: ${'resultado '.repeat(30)}` }
    );
  }

  let summaryCalls = 0;
  const runtime = new AgentRuntime({ registry: new ToolRegistry() });
  const result = await runtime.execute({
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
      assert.equal(messages.length, history.length);
      return 'Checkpoint acumulativo.';
    }
  });

  assert.equal(summaryCalls, 1);
  assert.equal(result.history[0]._isSummaryBlock, true);
  assert.equal(result.history[1].content, 'Respuesta final.');
});

test('AgentRuntime - no reintenta una compactación fallida durante el mismo ciclo', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({ name: 'lookup', execute: async () => 'dato' }));
  const history = [];
  for (let index = 0; index < 4; index++) {
    history.push(
      { role: 'user', content: `Pregunta ${index}: ${'detalle '.repeat(30)}` },
      { role: 'assistant', content: `Respuesta ${index}: ${'resultado '.repeat(30)}` }
    );
  }

  let apiCalls = 0;
  let summaryCalls = 0;
  const result = await new AgentRuntime({ registry }).execute({
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

test('AgentRuntime - Tool call normal con resolución y respuesta final', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
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
        if (params.onDone) await params.onDone('Calculando la suma...', { tokens: 10 }, [toolCall]);
        return { accumulatedText: 'Calculando la suma...', toolCalls: [toolCall], stats: { tokens: 10 } };
      } else {
        // Paso 2: El modelo recibe el resultado y redacta la respuesta final
        const lastToolMsg = params.messages.find(m => m.role === 'tool');
        assert.ok(lastToolMsg, 'El mensaje de la herramienta debe estar en el contexto');
        const toolRes = JSON.parse(lastToolMsg.content);
        assert.equal(toolRes.sum, 42);

        const finalText = `El resultado de la suma es ${toolRes.sum}.`;
        if (params.onChunk) params.onChunk(finalText, finalText, { tokens: 25 });
        if (params.onDone) await params.onDone(finalText, { tokens: 25 }, []);
        return { accumulatedText: finalText, toolCalls: [], stats: { tokens: 25 } };
      }
    }
  };

  const runtime = new AgentRuntime({ registry });
  const result = await runtime.execute({
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

test('AgentRuntime - serializa el resultado para el modelo a través del contrato de la tool', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
    name: 'contract_serialized_result',
    description: 'Devuelve un resultado con una representación específica para el modelo.',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    execute: async ({ value }) => ({ internalValue: value }),
    result: {
      toModel: (args, result, outcome) => `modelo:${args.value}:${result.internalValue}:${outcome.ok}`
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
      assert.equal(toolMessage.content, 'modelo:hola:hola:true');
      return { accumulatedText: 'Resultado recibido.', toolCalls: [] };
    }
  };

  const result = await new AgentRuntime({ registry }).execute({
    api: mockApi,
    messages: [{ role: 'user', content: 'Prueba el contrato.' }]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.history.find(message => message.role === 'tool').content, 'modelo:hola:hola:true');
});

test('AgentRuntime - Múltiples pasos agénticos secuenciales', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
    name: 'get_user_id',
    execute: async () => ({ userId: 'usr_8899' })
  }));
  registry.registerTool(new Tool({
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

  const runtime = new AgentRuntime({ registry, maxSteps: 5 });
  const result = await runtime.execute({
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

test('AgentRuntime - Error de herramienta capturado y recuperación en siguiente paso', async () => {
  const registry = new ToolRegistry();
  let attempts = 0;
  registry.registerTool(new Tool({
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

  const runtime = new AgentRuntime({ registry, maxRetries: 1 });
  const result = await runtime.execute({
    api: mockApi,
    messages: [{ role: 'user', content: 'Consulta la base de datos' }]
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.toolExecutions[0].success, false);
  assert.match(result.toolExecutions[0].error, /base de datos/);
  assert.equal(attempts, 2); // 1 original + 1 retry
  assert.match(result.finalText, /error en el servicio/);
});

test('AgentRuntime - Timeout global de ejecución agéntica', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
    name: 'slow_query',
    execute: async (args, ctx) => {
      await new Promise(r => setTimeout(r, 200));
      return { data: 'ok' };
    }
  }));

  const mockApi = {
    streamChatCompletion: async (params) => {
      // Simular latencia de red en streaming
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ accumulatedText: '', toolCalls: [{ function: { name: 'slow_query', arguments: '{}' } }] }), 100);
        if (params.signal) {
          params.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Abortado'));
          });
        }
      });
    }
  };

  const runtime = new AgentRuntime({ registry, timeoutMs: 30 });
  const result = await runtime.execute({
    api: mockApi,
    messages: [{ role: 'user', content: 'Haz algo muy lento' }]
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'timeout');
  assert.match(result.error.message, /Tiempo límite/);
});

test('AgentRuntime - Cancelación manual mediante AbortSignal', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
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

  const runtime = new AgentRuntime({ registry });
  const result = await runtime.execute({
    api: mockApi,
    signal: controller.signal,
    messages: [{ role: 'user', content: 'Hola' }]
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'cancelled');
  assert.match(result.error.message, /cancelada/);
});

test('AgentRuntime - Detección de bucles infinitos (Loop Detection)', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
    name: 'same_search',
    execute: async () => ({ results: ['noticia 1'] })
  }));

  let loopDetectedEventFired = false;
  const mockApi = {
    streamChatCompletion: async (params) => {
      if (params.enableTools === false) {
        return { accumulatedText: 'Resumen final tras detección de bucle.', toolCalls: [] };
      }
      // El modelo insiste en emitir exactamente la misma llamada
      const tc = { id: 'call_loop', function: { name: 'same_search', arguments: '{"q":"mismo_termino"}' } };
      return { accumulatedText: '', toolCalls: [tc], stats: { tokens: 10 } };
    }
  };

  const runtime = new AgentRuntime({ registry, loopThreshold: 2, maxSteps: 8 });
  const result = await runtime.execute({
    api: mockApi,
    messages: [{ role: 'user', content: 'Busca noticias' }],
    callbacks: {
      onLoopDetected: () => {
        loopDetectedEventFired = true;
      }
    }
  });

  assert.equal(result.status, 'loop_detected');
  assert.equal(result.loopDetected, true);
  assert.equal(loopDetectedEventFired, true);
  assert.match(result.finalText, /Infinite Loop Protection/);
});

test('AgentRuntime - Clean termination when model returns empty text after tools', async () => {
  const registry = new ToolRegistry();
  registry.registerTool(new Tool({
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

  const runtime = new AgentRuntime({ registry, autoSynthesize: true });
  const result = await runtime.execute({
    api: mockApi,
    messages: [{ role: 'user', content: 'Get the stock price' }]
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  // No third API call — model terminated abruptly, no synthesis
  assert.equal(step, 2);
});

test('AgentRuntime - Ejecución de múltiples tool calls simultáneas en el mismo turno', async () => {
  const registry = new ToolRegistry();
  const executedCalls = [];

  registry.registerTool(new Tool({
    name: 'fetch_metric_a',
    execute: async (args) => {
      executedCalls.push({ tool: 'a', args });
      return { value: 100 };
    }
  }));

  registry.registerTool(new Tool({
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

  const runtime = new AgentRuntime({ registry });
  const result = await runtime.execute({
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
