const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const AgentCore = require('../js/agent-core.js');

test('ToolDispatcher - dispatchToolCall ejecuta JavaScript de forma resiliente', async () => {
  const toolCall = {
    id: 'call_js_1',
    type: 'function',
    function: {
      name: 'execute_javascript',
      arguments: JSON.stringify({ code: 'const a = 10; const b = 20; return a + b;' })
    }
  };

  const logs = [];
  const res = await AgentCore.dispatchToolCall(toolCall, {
    onLog: (type, text) => logs.push({ type, text })
  });

  assert.ok(res.success);
  assert.equal(res.resultText, '30');
  assert.ok(res.markdownBlock.includes('execute_javascript'));
  assert.ok(logs.length >= 2);
  assert.equal(logs[0].type, 'tool');
});

test('ToolDispatcher - dispatchToolCall maneja JSON corrupto o texto plano en argumentos', async () => {
  const toolCall = {
    id: 'call_js_raw',
    type: 'function',
    function: {
      name: 'execute_javascript',
      arguments: 'code: return 5 * 5;'
    }
  };

  const res = await AgentCore.dispatchToolCall(toolCall);
  assert.ok(res.success);
  assert.equal(res.resultText, '25');
});

test('ToolDispatcher - dispatchToolCall ejecuta search_web con alias searchweb', async () => {
  const toolCall = {
    id: 'call_search_1',
    type: 'function',
    function: {
      name: 'searchweb',
      arguments: JSON.stringify({ query: 'DeepSeek R1' })
    }
  };

  const mockWebSearch = {
    search: async (query) => ({
      success: true,
      count: 1,
      results: [{ title: 'DeepSeek R1', url: 'https://example.com', snippet: 'AI model' }],
      markdown: `Resultados simulados para ${query}`
    })
  };

  const res = await AgentCore.dispatchToolCall(toolCall, {
    services: { webSearch: mockWebSearch }
  });
  assert.ok(res.success);
  assert.equal(res.resultText, 'Resultados simulados para DeepSeek R1');
});

test('ToolDispatcher - dispatchToolCall ejecuta render_chart y genera salida estructurada', async () => {
  const toolCall = {
    id: 'call_chart_1',
    type: 'function',
    function: {
      name: 'render_chart',
      arguments: JSON.stringify({
        type: 'bar',
        title: 'Ventas Mensuales',
        labels: ['Ene', 'Feb'],
        datasets: [{ label: '2026', data: [100, 200] }]
      })
    }
  };

  const res = await AgentCore.dispatchToolCall(toolCall);
  assert.ok(res.success);
  const parsedRes = JSON.parse(res.resultText);
  assert.equal(parsedRes.type, 'bar');
  assert.equal(parsedRes.title, 'Ventas Mensuales');
});

test('ToolDispatcher - dispatchToolCall maneja herramienta inexistente de forma segura', async () => {
  const toolCall = {
    id: 'call_unknown',
    type: 'function',
    function: {
      name: 'non_existent_tool_xyz',
      arguments: '{}'
    }
  };

  const res = await AgentCore.dispatchToolCall(toolCall);
  assert.equal(res.success, false);
  assert.ok(res.error.includes('no encontrada'));
});

test('ToolDispatcher - getDefinitions excluye todas las herramientas RAG si RAG no está activo', () => {
  const defsWithoutRag = AgentCore.registry.getDefinitions({
    enableAgentJs: true,
    enableAgentWeb: true,
    enableAgentSearch: true,
    enableAgentChart: true,
    activeRagBranchId: ''
  });

  const listDocsTool = defsWithoutRag.find(d => d.function?.name === 'list_documents');
  const searchKbTool = defsWithoutRag.find(d => d.function?.name === 'search_knowledge_base');
  const readChunkTool = defsWithoutRag.find(d => d.function?.name === 'read_knowledge_chunk');

  assert.equal(listDocsTool, undefined, 'list_documents NO debe enviarse si RAG está inactivo');
  assert.equal(searchKbTool, undefined, 'search_knowledge_base NO debe enviarse si RAG está inactivo');
  assert.equal(readChunkTool, undefined, 'read_knowledge_chunk NO debe enviarse si RAG está inactivo');

  const defsWithRag = AgentCore.registry.getDefinitions({
    enableAgentJs: true,
    enableAgentWeb: true,
    enableAgentSearch: true,
    enableAgentChart: true,
    activeRagBranchId: 'branch_123'
  });

  const listDocsActive = defsWithRag.find(d => d.function?.name === 'list_documents');
  const searchKbActive = defsWithRag.find(d => d.function?.name === 'search_knowledge_base');
  const readChunkActive = defsWithRag.find(d => d.function?.name === 'read_knowledge_chunk');

  assert.ok(listDocsActive, 'list_documents DEBE enviarse cuando RAG está activo');
  assert.ok(searchKbActive, 'search_knowledge_base DEBE enviarse cuando RAG está activo');
  assert.ok(readChunkActive, 'read_knowledge_chunk DEBE enviarse cuando RAG está activo');
});

test('ToolDispatcher - dispatchToolCall intercepta y respeta la seguridad de herramientas MCP', async () => {
  const ChatToolSecurity = require('../js/tool-security.js');
  const ChatToolCards = require('../js/tool-cards.js');

  // Registrar herramienta MCP ficticia cumpliendo el contrato declarativo
  const fakeMcpTool = new AgentCore.Tool({
    definition: {
      name: 'mcp__test_srv__run_cmd',
      description: '[MCP: test-srv] Ejecuta comando',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } }
      }
    },
    category: 'mcp',
    settings: { showInSettings: true },
    metadata: { mcpServerName: 'test-srv', originalName: 'run_cmd' },
    execute: async (args) => ({ success: true, output: `executed: ${args.cmd}` }),
    result: {
      toModel: (_args, res) => res?.output || '',
      toMarkdown: (_args, res) => `> ${res?.output || ''}`
    }
  });
  AgentCore.registry.registerTool(fakeMcpTool);

  const toolCall = {
    id: 'call_mcp_test_1',
    type: 'function',
    function: {
      name: 'mcp__test_srv__run_cmd',
      arguments: JSON.stringify({ cmd: 'echo hello' })
    }
  };

  // 1. Caso Deny directo por política
  ChatToolSecurity.manager.setToolPolicy('mcp__test_srv__run_cmd', 'deny');
  const resDeny = await AgentCore.dispatchToolCall(toolCall);
  assert.equal(resDeny.success, false);
  assert.ok(resDeny.error.includes('bloqueada'));

  // 2. Caso Ask con Denegación interactiva del usuario
  ChatToolSecurity.manager.setToolPolicy('mcp__test_srv__run_cmd', 'ask');
  
  // Mock de ToolCards.promptToolAuthorization
  const origPrompt = ChatToolCards.promptToolAuthorization;
  ChatToolCards.promptToolAuthorization = async () => 'deny';

  try {
    const resUserDeny = await AgentCore.dispatchToolCall(toolCall, {
      container: { appendChild: () => {} }
    });
    assert.equal(resUserDeny.success, false);
    assert.ok(resUserDeny.error.includes('denegada por el usuario'));
  } finally {
    ChatToolCards.promptToolAuthorization = origPrompt;
  }

  // 3. Caso Ask con Autorización 'allow_always'
  ChatToolCards.promptToolAuthorization = async () => 'allow_always';
  try {
    const resAllowAlways = await AgentCore.dispatchToolCall(toolCall, {
      container: { appendChild: () => {} }
    });
    assert.equal(resAllowAlways.success, true);
    assert.ok(resAllowAlways.resultText.includes('executed: echo hello'));
    // Verificar que se persistió 'allow'
    assert.equal(ChatToolSecurity.manager.getToolPolicy('mcp__test_srv__run_cmd'), 'allow');
  } finally {
    ChatToolCards.promptToolAuthorization = origPrompt;
    ChatToolSecurity.manager.clearAllAuthorizations();
  }

  // 4. Caso Ask con restricciones granulares (allow_always con constraints)
  ChatToolCards.promptToolAuthorization = async () => ({
    decision: 'allow_always',
    constraints: {
      command: { allowedPrefixes: ['echo '], allowChaining: false }
    }
  });

  try {
    const resFirst = await AgentCore.dispatchToolCall(toolCall, {
      container: { appendChild: () => {} }
    });
    assert.equal(resFirst.success, true);
    // Verificar que las restricciones se persistieron
    const savedConstraints = ChatToolSecurity.manager.getToolConstraints('mcp__test_srv__run_cmd');
    assert.ok(savedConstraints);
    assert.deepEqual(savedConstraints.command.allowedPrefixes, ['echo ']);

    // Ejecutar otro comando permitido ('echo second') sin que promptToolAuthorization sea llamado
    let promptCalled = false;
    ChatToolCards.promptToolAuthorization = async () => {
      promptCalled = true;
      return 'deny';
    };

    const toolCallEcho2 = {
      id: 'call_mcp_test_2',
      type: 'function',
      function: {
        name: 'mcp__test_srv__run_cmd',
        arguments: JSON.stringify({ cmd: 'echo second' })
      }
    };

    const resEcho2 = await AgentCore.dispatchToolCall(toolCallEcho2, {
      container: { appendChild: () => {} }
    });
    assert.equal(resEcho2.success, true);
    assert.equal(promptCalled, false, 'No debe pedir autorización para comando autorizado en lista blanca');

    // Ejecutar comando no autorizado ('cat secret.txt') -> debe invocar prompt
    const toolCallCat = {
      id: 'call_mcp_test_3',
      type: 'function',
      function: {
        name: 'mcp__test_srv__run_cmd',
        arguments: JSON.stringify({ cmd: 'cat secret.txt' })
      }
    };

    const resCat = await AgentCore.dispatchToolCall(toolCallCat, {
      container: { appendChild: () => {} }
    });
    assert.equal(promptCalled, true, 'Debe pedir confirmación para comando fuera del prefijo autorizado');
    assert.equal(resCat.success, false);
  } finally {
    ChatToolCards.promptToolAuthorization = origPrompt;
    ChatToolSecurity.manager.clearAllAuthorizations();
  }
});


