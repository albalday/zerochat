const test = require('node:test');
const assert = require('node:assert');
const ChatContextManager = require('../js/context-manager.js');

test('ContextManager - Estimación de tokens para texto, código y multimodales', () => {
  const shortText = 'Hola, ¿cómo estás?';
  const tokens = ChatContextManager.estimateTextTokens(shortText);
  assert.ok(tokens > 0 && tokens < 10);

  const codeText = 'function calculate(x) { return x * 42; }';
  const codeTokens = ChatContextManager.estimateTextTokens(codeText);
  assert.ok(codeTokens > 0);

  const multimodalMsg = {
    role: 'user',
    content: [
      { type: 'text', text: 'Mira esta foto' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } }
    ]
  };
  const multiTokens = ChatContextManager.estimateMessageTokens(multimodalMsg);
  assert.ok(multiTokens > 1000, 'Debe incluir la estimación de tokens para la imagen');
});

test('ContextManager - Conversaciones cortas que caben en el presupuesto', () => {
  const messages = [
    { role: 'system', content: 'Eres un asistente útil.' },
    { role: 'user', content: '¿Qué es JavaScript?' },
    { role: 'assistant', content: 'Es un lenguaje de programación.' },
    { role: 'user', content: '¿Y Python?' }
  ];

  const result = ChatContextManager.buildOptimizedContext(messages, {
    maxInputTokens: 4000,
    model: 'configured-model'
  });

  assert.equal(result.messages.length, 4);
  assert.equal(result.diagnostics.includedCount, 4);
  assert.equal(result.diagnostics.excludedCount, 0);
  assert.equal(result.diagnostics.strategy, 'full_history');
});

test('ContextManager - Preservación obligatoria de System Prompt y Último Mensaje con presupuesto pequeño', () => {
  const messages = [
    { role: 'system', content: 'INSTRUCCIÓN CRÍTICA DE SISTEMA' },
    { role: 'user', content: 'Mensaje antiguo 1' },
    { role: 'assistant', content: 'Respuesta antigua 1' },
    { role: 'user', content: 'Mensaje antiguo 2' },
    { role: 'assistant', content: 'Respuesta antigua 2' },
    { role: 'user', content: 'PREGUNTA ACTUAL DEL USUARIO' }
  ];

  // Presupuesto muy restrictivo (ej. solo 60 tokens)
  const result = ChatContextManager.buildOptimizedContext(messages, {
    maxInputTokens: 60
  });

  // Debe contener el System Prompt y la Pregunta Actual
  const roles = result.messages.map(m => m.role);
  assert.ok(roles.includes('system'), 'Debe preservar el System Prompt');
  assert.equal(result.messages[0].content, 'INSTRUCCIÓN CRÍTICA DE SISTEMA');
  assert.equal(result.messages[result.messages.length - 1].content, 'PREGUNTA ACTUAL DEL USUARIO');
  assert.ok(result.diagnostics.excludedCount > 0, 'Debe haber excluido mensajes antiguos');
  assert.equal(result.diagnostics.strategy, 'sliding_window_truncated');
});

test('ContextManager - Preservación de pares atómicos tool_calls <-> tool', () => {
  const messages = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Primer mensaje de usuario' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_abc', function: { name: 'search_web', arguments: '{"q":"test"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_abc', name: 'search_web', content: 'Resultados de prueba' },
    { role: 'assistant', content: 'Aquí está tu respuesta basada en la búsqueda.' },
    { role: 'user', content: 'Segundo mensaje' }
  ];

  const result = ChatContextManager.buildOptimizedContext(messages, {
    maxInputTokens: 2000
  });

  // Verificar que el assistant con tool_calls y su tool respectivo permanecen juntos
  const toolIdx = result.messages.findIndex(m => m.role === 'tool');
  assert.ok(toolIdx > 0);
  assert.equal(result.messages[toolIdx - 1].role, 'assistant');
  assert.ok(result.messages[toolIdx - 1].tool_calls);
});

test('ContextManager - Truncamiento y Poda de resultados gigantescos de herramientas', () => {
  const hugeContent = 'A'.repeat(50000); // 50 KB de contenido

  const messages = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Descarga un PDF' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_pdf', function: { name: 'download_pdf', arguments: '{"url":"..."}' } }]
    },
    { role: 'tool', tool_call_id: 'call_pdf', name: 'download_pdf', content: hugeContent },
    { role: 'assistant', content: 'El PDF trata de X temas.' },
    { role: 'user', content: '¿Qué más dice?' }
  ];

  const result = ChatContextManager.buildOptimizedContext(messages, {
    maxInputTokens: 4000,
    maxHistoricalToolChars: 500
  });

  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg);
  assert.ok(toolMsg.content.length <= 1000, `El contenido de la tool histórica debe ser podado (actual: ${toolMsg.content.length})`);
  assert.ok(toolMsg.content.includes('Truncado por ChatContextManager'));
  assert.equal(result.diagnostics.prunedToolsCount, 1);
});

test('ContextManager - usa metadatos explícitos y no heurísticas por nombre', () => {
  assert.equal(ChatContextManager.getModelContextLimit('', '', 90112), 90112);
  assert.equal(ChatContextManager.getModelContextLimit(), 1000000);

  const budget = ChatContextManager.calculateInputBudget({
    totalContextLimit: 90112
  });
  assert.ok(budget > 75000 && budget < 80000);
});

test('ContextManager - shouldCompress detecta cuándo una conversación supera los umbrales', () => {
  const shortHistory = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Pregunta 1' },
    { role: 'assistant', content: 'Respuesta 1' }
  ];
  assert.equal(ChatContextManager.shouldCompress(shortHistory), false, 'No debe comprimir historiales muy cortos');

  // Historial largo que supera el ratio de presupuesto
  const longHistory = [
    { role: 'system', content: 'Sistema' }
  ];
  for (let i = 1; i <= 12; i++) {
    longHistory.push({ role: 'user', content: `Pregunta de usuario número ${i}: ` + 'detalles '.repeat(40) });
    longHistory.push({ role: 'assistant', content: `Respuesta del asistente número ${i}: ` + 'explicación '.repeat(40) });
  }

  const should = ChatContextManager.shouldCompress(longHistory, {
    maxInputTokens: 2000,
    compressionThresholdRatio: 0.50
  });
  assert.equal(should, true, 'Debe activar compresión para historiales densos que superan el umbral');
});

test('ContextManager - compressHistory consolida mensajes antiguos con summarizeFn simulada', async () => {
  const history = [
    { role: 'system', content: 'Eres un tutor de programación.' },
    { role: 'user', content: 'Quiero crear una API REST con Node.js y SQLite.' },
    { role: 'assistant', content: 'Perfecto, utilizaremos Express y better-sqlite3.' },
    { role: 'user', content: 'Añadamos autenticación con JWT.' },
    { role: 'assistant', content: 'Implementaremos bcrypt y jsonwebtoken para emitir tokens seguros.' },
    { role: 'user', content: '¿Cómo creamos la tabla de usuarios?' },
    { role: 'assistant', content: 'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE);' },
    { role: 'user', content: 'Ahora implementemos el endpoint de login.' }
  ];

  let simulatedSummarizeCalled = false;
  const mockSummarizeFn = async ({ systemPrompt, userPrompt }) => {
    simulatedSummarizeCalled = true;
    assert.ok(systemPrompt.includes('MEMORIA ESTRUCTURADA'));
    assert.ok(userPrompt.includes('API REST'));
    return `### [MEMORIA ESTRUCTURADA DE TURNOS ANTERIORES]
- **Requisitos y Objetivos:** API REST Node.js con SQLite y auth JWT.
- **Decisiones Clave:** Express, better-sqlite3, bcrypt y jsonwebtoken.
- **Datos y Hechos Establecidos:** Tabla users con id y email.
- **Tareas Pendientes:** Endpoint de login.
- **Contexto Técnico:** Node.js, Express, SQLite.`;
  };

  const res = await ChatContextManager.compressHistory({
    messages: history,
    summarizeFn: mockSummarizeFn,
    options: { recentTurnsToKeep: 2 }
  });

  assert.equal(res.compressed, true);
  assert.equal(simulatedSummarizeCalled, true);
  assert.ok(res.memoryBlock);
  assert.equal(res.memoryBlock._isSummaryBlock, true);
  assert.ok(res.diagnostics.savedTokens > 0);

  // Verificar preservación de System Prompt y turnos recientes
  assert.equal(res.messages[0].content, 'Eres un tutor de programación.');
  assert.equal(res.messages[1]._isSummaryBlock, true);
  assert.equal(res.messages[res.messages.length - 1].content, 'Ahora implementemos el endpoint de login.');
});

test('ContextManager - compressHistory fallback determinista sin llamadas de red', async () => {
  const history = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Buscar información de vuelos' },
    { role: 'assistant', content: 'Buscando...', tool_calls: [{ id: '1', function: { name: 'search_web' } }] },
    { role: 'tool', name: 'search_web', content: 'Resultados de vuelos' },
    { role: 'assistant', content: 'Encontré 3 vuelos disponibles.' },
    { role: 'user', content: 'Reservar el primero.' }
  ];

  const res = await ChatContextManager.compressHistory({
    messages: history,
    summarizeFn: null, // Sin LLM
    options: { recentTurnsToKeep: 1 }
  });

  assert.equal(res.compressed, true);
  assert.ok(res.memoryBlock);
  assert.ok(res.memoryBlock.content.includes('MEMORIA ESTRUCTURADA'));
  assert.ok(res.memoryBlock.content.includes('search_web'));
});

test('ContextManager - Protección contra bucles de summarization y pérdida de memoria previa', () => {
  const historyWithExistingSummary = [
    { role: 'system', content: 'Sistema' },
    {
      role: 'system',
      content: 'Memoria previa',
      _isSummaryBlock: true,
      _compressedMetadata: { timestamp: Date.now(), endIndexInHistory: 8 }
    },
    { role: 'user', content: 'Turno 9' },
    { role: 'assistant', content: 'Respuesta 9' }
  ];

  // Solo han pasado 2 turnos desde el último resumen (< cooldownTurns)
  const should = ChatContextManager.shouldCompress(historyWithExistingSummary, {
    cooldownTurns: 4
  });
  assert.equal(should, false, 'Debe respetar el periodo de enfriamiento (cooldown) para evitar bucles');
});

test('ContextManager - truncateToolContent preserva todos los fragmentos en salidas multisección de RAG', () => {
  const chunk1 = '### WALMART_2020_10K.pdf · TOC (chunkId: doc_1:chunk:36)\n\nTabla de contenidos financiera y notas generales: ' + 'A'.repeat(3000);
  const chunk2 = '### WALMART_2020_10K.pdf · Income Statement (chunkId: doc_1:chunk:37)\n\nConsolidated Statements of Income Revenues Net Sales Operating Income: ' + 'B'.repeat(8000);
  const chunk3 = '### WALMART_2020_10K.pdf · Cash Flows (chunkId: doc_1:chunk:38)\n\nConsolidated Statements of Cash Flows Depreciation and Amortization: ' + 'C'.repeat(8000);
  const chunk4 = '### WALMART_2020_10K.pdf · Segment Info (chunkId: doc_1:chunk:39)\n\nSegment assets, net sales and operational metrics: ' + 'D'.repeat(8000);

  const multiChunkOutput = [chunk1, chunk2, chunk3, chunk4].join('\n\n---\n\n');
  const maxBudget = 10000;

  const truncated = ChatContextManager.truncateToolContent(multiChunkOutput, maxBudget, 'read_knowledge_chunk');

  // 1. Debe respetar el presupuesto máximo (con margen mínimo por separadores)
  assert.ok(truncated.length <= maxBudget + 500, `Debe respetar el límite de caracteres (actual: ${truncated.length})`);

  // 2. Todos los fragmentos deben estar presentes (ningún chunk del medio eliminado por completo)
  assert.ok(truncated.includes('chunk:36'), 'Debe conservar el primer fragmento (TOC)');
  assert.ok(truncated.includes('chunk:37'), 'Debe conservar el segundo fragmento (Income Statement)');
  assert.ok(truncated.includes('chunk:38'), 'Debe conservar el tercer fragmento (Cash Flows)');
  assert.ok(truncated.includes('chunk:39'), 'Debe conservar el cuarto fragmento (Segment Info)');

  // 3. Cada fragmento debe conservar su cabecera descriptiva
  assert.ok(truncated.includes('### WALMART_2020_10K.pdf · Income Statement'));
  assert.ok(truncated.includes('### WALMART_2020_10K.pdf · Cash Flows'));
});

test('ContextManager - buildOptimizedContext otorga presupuesto adaptativo para read_knowledge_chunk en el turno activo', () => {
  const tableContent = '### Financials\n\n' + 'FILA_CONTABLE_'.repeat(2000); // ~28.000 chars

  const messages = [
    { role: 'system', content: 'Eres un analista.' },
    { role: 'user', content: 'Dame el EBITDA de Walmart.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_read', function: { name: 'read_knowledge_chunk', arguments: '{"chunkIds":["c1"]}' } }]
    },
    { role: 'tool', tool_call_id: 'call_read', name: 'read_knowledge_chunk', content: tableContent }
  ];

  const result = ChatContextManager.buildOptimizedContext(messages, {
    model: 'configured-model',
    providerType: 'openai'
  });

  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert.ok(toolMsg);
  // Con un presupuesto amplio, el contenido no debe truncarse destructivamente
  assert.ok(!toolMsg.content.includes('Truncado por ChatContextManager'), 'No debe truncar si el presupuesto del modelo admite las tablas');
  assert.equal(toolMsg.content.length, tableContent.length);
});
