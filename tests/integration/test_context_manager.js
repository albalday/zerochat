const test = require('node:test');
const assert = require('node:assert');
const ChatContextManager = require('../../js/context-manager.js');
const ChatEngine = require('../../js/chat-engine.js');

test('ContextManager - estimación de tokens para texto, código, razonamiento e imágenes', () => {
  const shortText = 'Hola, ¿cómo estás?';
  const tokens = ChatContextManager.estimateTextTokens(shortText);
  assert.ok(tokens > 0 && tokens < 10);
  assert.ok(ChatContextManager.estimateTextTokens('function calculate(x) { return x * 42; }') > 0);

  const base = { role: 'assistant', content: null, tool_calls: [] };
  const withReasoning = { ...base, reasoning_content: 'razonamiento '.repeat(40) };
  assert.ok(ChatContextManager.estimateMessageTokens(withReasoning) > ChatContextManager.estimateMessageTokens(base) + 50);

  const multimodalMsg = {
    role: 'user',
    content: [
      { type: 'text', text: 'Mira esta foto' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } }
    ]
  };
  assert.ok(ChatContextManager.estimateMessageTokens(multimodalMsg) > 1000, 'Debe incluir la estimación de tokens para la imagen');
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

test('ContextManager - buildOptimizedContext preserva pares atómicos, poda tools históricas y da margen al turno activo RAG', () => {
  const atomicMessages = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Primer mensaje de usuario' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', function: { name: 'search_web', arguments: '{"q":"test"}' } }] },
    { role: 'tool', tool_call_id: 'call_abc', name: 'search_web', content: 'Resultados de prueba' },
    { role: 'assistant', content: 'Aquí está tu respuesta basada en la búsqueda.' },
    { role: 'user', content: 'Segundo mensaje' }
  ];
  const atomic = ChatContextManager.buildOptimizedContext(atomicMessages, { maxInputTokens: 2000 });
  const toolIdx = atomic.messages.findIndex(m => m.role === 'tool');
  assert.ok(toolIdx > 0);
  assert.equal(atomic.messages[toolIdx - 1].role, 'assistant');
  assert.ok(atomic.messages[toolIdx - 1].tool_calls);

  const hugeMessages = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Descarga un PDF' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_pdf', function: { name: 'download_doc', arguments: '{"url":"..."}' } }] },
    { role: 'tool', tool_call_id: 'call_pdf', name: 'download_doc', content: 'A'.repeat(50000) },
    { role: 'assistant', content: 'El PDF trata de X temas.' },
    { role: 'user', content: '¿Qué más dice?' }
  ];
  const pruned = ChatContextManager.buildOptimizedContext(hugeMessages, { maxInputTokens: 4000, maxHistoricalToolChars: 500 });
  const prunedTool = pruned.messages.find(m => m.role === 'tool');
  assert.ok(prunedTool.content.length <= 1000);
  assert.ok(prunedTool.content.includes('Truncado por ChatContextManager'));
  assert.equal(pruned.diagnostics.prunedToolsCount, 1);

  const tableContent = '### Financials\n\n' + 'FILA_CONTABLE_'.repeat(2000);
  const activeRag = ChatContextManager.buildOptimizedContext([
    { role: 'system', content: 'Eres un analista.' },
    { role: 'user', content: 'Dame el EBITDA de Walmart.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_read', function: { name: 'read_knowledge_chunk', arguments: '{"chunkIds":["c1"]}' } }] },
    { role: 'tool', tool_call_id: 'call_read', name: 'read_knowledge_chunk', content: tableContent }
  ], { model: 'configured-model', providerType: 'openai' });
  const ragTool = activeRag.messages.find(m => m.role === 'tool');
  assert.ok(!ragTool.content.includes('Truncado por ChatContextManager'));
  assert.equal(ragTool.content.length, tableContent.length);
});

test('ContextManager - usa metadatos explícitos y no heurísticas por nombre', () => {
  assert.equal(ChatContextManager.calculateInputBudget({ model: 'gpt-4o-mini' }), 1000000 - 4096 - 100000);
  const budget = ChatContextManager.calculateInputBudget({ totalContextLimit: 90112 });
  assert.ok(budget > 75000 && budget < 80000);
});

test('ContextManager - shouldCompress evalúa umbrales y evita recomponer checkpoints sin diálogo suficiente', () => {
  const shortHistory = [
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Pregunta 1' },
    { role: 'assistant', content: 'Respuesta 1' }
  ];
  assert.equal(ChatContextManager.shouldCompress(shortHistory), false);

  const longHistory = [{ role: 'system', content: 'Sistema' }];
  for (let i = 1; i <= 12; i++) {
    longHistory.push({ role: 'user', content: `Pregunta ${i}: ` + 'detalles '.repeat(40) });
    longHistory.push({ role: 'assistant', content: `Respuesta ${i}: ` + 'explicación '.repeat(40) });
  }
  assert.equal(ChatContextManager.shouldCompress(longHistory, { maxInputTokens: 2000, compressionThresholdRatio: 0.50 }), true);

  const withRecentCheckpoint = Array.from({ length: 6 }, (_, index) => ({ role: 'system', content: `Sys ${index}` })).concat([
    { role: 'system', content: 'Memoria previa', _isSummaryBlock: true, _compressedMetadata: { timestamp: Date.now(), endIndexInHistory: 8 } },
    { role: 'user', content: 'Turno 9' },
    { role: 'assistant', content: 'Respuesta 9' }
  ]);
  assert.equal(ChatContextManager.shouldCompress(withRecentCheckpoint, {
    maxInputTokens: 20, compressionThresholdRatio: 0.1, minMessagesToCompress: 3
  }), false);
});

test('ContextManager - compressHistory encadena checkpoints acumulativos y conserva system + checkpoint al preparar contexto', async () => {
  const history = [
    { role: 'system', content: 'Eres un tutor de programación.' },
    { role: 'user', content: 'Quiero crear una API REST con Node.js y SQLite.' },
    { role: 'assistant', content: 'Perfecto, utilizaremos Express y better-sqlite3.' },
    { role: 'user', content: 'Añadamos autenticación con JWT.' }
  ];
  let firstInput;
  const firstRes = await ChatContextManager.compressHistory({
    messages: history,
    summarizeFn: async input => { firstInput = input; return 'Checkpoint 1'; },
    options: {}
  });
  assert.equal(firstRes.compressed, true);
  assert.ok(firstInput.systemPrompt.includes('cumulative'));
  assert.equal(firstInput.checkpoint, null);
  assert.equal(firstInput.dialogue.length, 3);
  assert.deepEqual(firstInput.messages, firstInput.dialogue);
  assert.equal(firstRes.messages.length, 2);
  assert.equal(firstRes.messages[1]._isSummaryBlock, true);

  const toolResult = 'resultado completo '.repeat(500);
  const checkpoint = firstRes.messages[1];
  const nextHistory = [
    { role: 'system', content: 'Sistema permanente' },
    checkpoint,
    { role: 'user', content: 'Consulta nueva' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'any_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'any_tool', content: toolResult },
    { role: 'assistant', content: 'Resultado analizado' }
  ];
  let secondInput;
  const secondRes = await ChatContextManager.compressHistory({
    messages: nextHistory,
    summarizeFn: async input => { secondInput = input; return 'Checkpoint 2'; }
  });
  assert.equal(secondInput.checkpoint, checkpoint);
  assert.deepEqual(secondInput.dialogue, nextHistory.slice(2));
  assert.equal(secondInput.dialogue[2].content, toolResult);
  assert.deepEqual(secondInput.messages, [checkpoint, ...nextHistory.slice(2)]);
  assert.equal(secondRes.messages[1].content, 'Checkpoint 2');

  const prepared = ChatEngine.buildEffectiveMessages(
    [{ role: 'system', content: 'Checkpoint acumulativo', _isSummaryBlock: true }],
    require('../../js/config-store.js').normalize({ systemPrompt: 'Sistema de la aplicación' })
  );
  assert.ok(prepared[0].content.includes('Sistema de la aplicación'));
  assert.equal(prepared[1].content, 'Checkpoint acumulativo');
  assert.equal(prepared[1]._isSummaryBlock, true);
});

test('ContextManager - compressHistory rechaza summarizeFn nulo, vacíos o llamadas JSON a herramientas', async () => {
  const messages = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'mundo' }];

  const noFn = await ChatContextManager.compressHistory({ messages, summarizeFn: null });
  assert.equal(noFn.compressed, false);
  assert.equal(noFn.reason, 'summarizer_unavailable');
  assert.equal(noFn.messages, messages);

  const jsonResult = await ChatContextManager.compressHistory({
    messages,
    summarizeFn: async () => '{"name": "run_command", "arguments": {"command": "git status"}}'
  });
  assert.equal(jsonResult.compressed, false);
  assert.equal(jsonResult.reason, 'invalid_summary');

  const emptyResult = await ChatContextManager.compressHistory({
    messages,
    summarizeFn: async () => '   \n  '
  });
  assert.equal(emptyResult.compressed, false);
  assert.equal(emptyResult.reason, 'empty_summary');

  const okResult = await ChatContextManager.compressHistory({
    messages,
    summarizeFn: async () => 'Resumen consolidado válido.'
  });
  assert.equal(okResult.compressed, true);
  assert.equal(okResult.memoryBlock.content, 'Resumen consolidado válido.');
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

test('ContextManager - formatHistoryTranscript genera una transcripción neutral y segura del historial', () => {
  const history = [
    { role: 'system', content: 'Eres un asistente' },
    { role: 'system', content: 'Resumen previo', _isSummaryBlock: true },
    { role: 'user', content: 'comprueba git', commandNotes: 'Notas previas' },
    {
      role: 'assistant',
      content: 'Voy a comprobarlo.',
      tool_calls: [{
        id: 'call_1',
        function: { name: 'run_command', arguments: '{"command":"git status"}' }
      }]
    },
    { role: 'tool', name: 'run_command', content: 'salida de comando '.repeat(200) },
    {
      role: 'user',
      content: [{ type: 'text', text: 'mira esta imagen' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]
    }
  ];

  const transcript = ChatContextManager.formatHistoryTranscript(history, { maxHistoricalToolChars: 100 });

  assert.ok(transcript.includes('[Previous Checkpoint Summary]:\nResumen previo'));
  assert.ok(transcript.includes('User: Notas previas\ncomprueba git'));
  assert.ok(transcript.includes('Assistant: Voy a comprobarlo.\n[Called tools: run_command({"command":"git status"})]'));
  assert.ok(transcript.includes('Tool (run_command):'));
  assert.ok(transcript.includes('Truncado por ChatContextManager'));
  assert.ok(transcript.includes('User: mira esta imagen'));
  assert.ok(!transcript.includes('Eres un asistente'), 'No debe incluir el prompt de sistema previo');

  // Los argumentos de las llamadas tienen el mismo tope que los resultados, en el borde exacto.
  const callWithArgs = length => ChatContextManager.formatHistoryTranscript([{
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_w', function: { name: 'write_file', arguments: 'a'.repeat(length) } }]
  }], { maxHistoricalToolChars: 100 });
  assert.equal(callWithArgs(100), `Assistant: [Called tools: write_file(${'a'.repeat(100)})]`);
  assert.match(callWithArgs(101), /Truncado por ChatContextManager: 1 caracteres omitidos de la salida de write_file/);
});
