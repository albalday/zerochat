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

  // Campos de workingMessages antes de buildEffectiveMessages: images, commandNotes y reasoningReplay.text
  const toolWithImage = { role: 'tool', content: 'ok', images: [{ dataUrl: 'data:image/png;base64,AA==' }] };
  assert.ok(ChatContextManager.estimateMessageTokens(toolWithImage) >= 1200, 'Debe contar imágenes en message.images');
  const userWithNotes = { role: 'user', content: 'hola', commandNotes: 'Comando terminado '.repeat(30) };
  assert.ok(ChatContextManager.estimateMessageTokens(userWithNotes) > ChatContextManager.estimateMessageTokens({ role: 'user', content: 'hola' }) + 100);
  const assistantWithReplay = { role: 'assistant', content: null, reasoningReplay: { field: 'reasoning_content', text: 'pensamiento '.repeat(40) } };
  assert.ok(ChatContextManager.estimateMessageTokens(assistantWithReplay) > ChatContextManager.estimateMessageTokens(base) + 50);

  // Definiciones de herramientas: cuentan en shouldCompress y en buildOptimizedContext
  const heavyTools = Array.from({ length: 10 }, (_, i) => ({
    type: 'function',
    function: { name: `mcp_tool_${i}`, description: 'desc '.repeat(80), parameters: { type: 'object', properties: { a: { type: 'string' } } } }
  }));
  const defsTokens = ChatContextManager.estimateToolDefinitionsTokens(heavyTools);
  assert.ok(defsTokens > 1000);
  const smallClosedHistory = [
    { role: 'user', content: 'u1 '.repeat(120) }, { role: 'assistant', content: 'a1 '.repeat(120) },
    { role: 'user', content: 'u2 '.repeat(120) }, { role: 'assistant', content: 'a2 '.repeat(120) },
    { role: 'user', content: 'u3 '.repeat(120) }, { role: 'assistant', content: 'a3 '.repeat(120) },
    { role: 'user', content: 'u4 '.repeat(120) }, { role: 'assistant', content: 'a4 '.repeat(120) },
    { role: 'user', content: 'actual' }
  ];
  assert.equal(ChatContextManager.shouldCompress(smallClosedHistory, { maxInputTokens: 2000, compressionThresholdRatio: 0.7 }), false);
  assert.equal(ChatContextManager.shouldCompress(smallClosedHistory, { maxInputTokens: 2000, compressionThresholdRatio: 0.7, toolDefinitions: heavyTools }), true);

  // Si los turnos cerrados ocupan menos del 20% del presupuesto, no se compacta aunque el turno activo sea grande.
  const tinyClosedBigActive = [
    { role: 'user', content: 'hola' }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'analiza' },
    ...Array.from({ length: 3 }, (_, i) => ([
      { role: 'assistant', content: null, tool_calls: [{ id: `tb_${i}`, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `tb_${i}`, name: 'read_file', content: 'X'.repeat(5000) }
    ])).flat()
  ];
  assert.equal(ChatContextManager.shouldCompress(tinyClosedBigActive, { maxInputTokens: 2000, compressionThresholdRatio: 0.7 }), false);
});

test('ContextManager - shouldCompress mide los turnos cerrados podados como se envían, en el borde exacto del umbral', () => {
  const history = [];
  for (let turn = 0; turn < 4; turn++) {
    history.push(
      { role: 'user', content: `Pregunta ${turn}` },
      { role: 'assistant', content: null, tool_calls: [{ id: `r${turn}`, function: { name: 'read_file', arguments: `{"n":${turn}}` } }] },
      { role: 'tool', tool_call_id: `r${turn}`, name: 'read_file', content: 'X'.repeat(60000), images: [{ dataUrl: 'data:image/png;base64,AA==' }] },
      { role: 'assistant', content: `Respuesta ${turn}` }
    );
  }
  history.push({ role: 'user', content: 'Pregunta actual' });

  // Lo que se envía: resultados cerrados a DEFAULT_MAX_HISTORICAL_TOOL_CHARS (4000) y sin sus imágenes.
  const sent = history.map(m => (m.role === 'tool'
    ? { role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content: ChatContextManager.truncateToolContent(m.content, 4000, m.name) }
    : m));
  const sentTokens = ChatContextManager.estimateHistoryTokens(sent);
  assert.ok(ChatContextManager.estimateHistoryTokens(history) > sentTokens * 5, 'El historial crudo sobrestima mucho lo enviado');

  // Umbral 0.7 * presupuesto: N (justo alcanzado) compacta y N+1 (un token de presupuesto más) no.
  const atThreshold = Math.floor(sentTokens / 0.7);
  assert.equal(ChatContextManager.shouldCompress(history, { maxInputTokens: atThreshold }), true);
  assert.equal(ChatContextManager.shouldCompress(history, { maxInputTokens: atThreshold + 1 }), false);
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

test('ContextManager - preserva salidas intactas entre pasos del turno activo y poda solo turnos cerrados en bordes exactos', () => {
  // 1. Varios pasos dentro del mismo turno (ej. controlador leyendo 3 agentes en serie de 5000 chars) no se podan a 4000
  const closedTurnTool = 'H'.repeat(4001);
  const closedTurnExact = 'E'.repeat(4000);
  const step1Output = 'A'.repeat(5000);
  const step2Output = 'B'.repeat(5000);
  const step3Exact = 'C'.repeat(64000);
  const step3Over = 'D'.repeat(64001);

  const multiStep = ChatContextManager.buildOptimizedContext([
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Turno 1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c0', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c0', name: 'read_file', content: closedTurnTool },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c0b', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c0b', name: 'read_file', content: closedTurnExact },
    { role: 'assistant', content: 'Turno 1 cerrado.' },
    { role: 'user', content: 'Turno 2 (controlador en serie)' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'check_agents', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'check_agents', content: step1Output },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', function: { name: 'check_agents', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'check_agents', content: step2Output },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', function: { name: 'check_agents', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c3', name: 'check_agents', content: step3Exact },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c4', function: { name: 'check_agents', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c4', name: 'check_agents', content: step3Over }
  ], { totalContextLimit: 150000 });

  const byId = Object.fromEntries(multiStep.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]));
  // Turno pasado cerrado: borde exacto N=4000 intacto, N+1=4001 truncado
  assert.match(byId.c0, /Truncado por ChatContextManager/);
  assert.equal(byId.c0b, closedTurnExact);
  assert.equal(multiStep.diagnostics.prunedToolsCount, 1);
  // Turno en curso: pasos previos (c1, c2) intactos y paso activo en borde exacto N=64000 intacto, N+1=64001 truncado
  assert.equal(byId.c1, step1Output);
  assert.equal(byId.c2, step2Output);
  assert.equal(byId.c3, step3Exact);
  assert.match(byId.c4, /Truncado por ChatContextManager: 1 caracteres omitidos/);

  // 2. Modelo pequeño (WebLLM 4K): el techo activo se acota por inputBudget sin exceder la ventana
  const smallModel = ChatContextManager.buildOptimizedContext([
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Lee' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'cs', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'cs', name: 'read_file', content: 'X'.repeat(10000) }
  ], { maxInputTokens: 3000 });
  const smallTool = smallModel.messages.find(m => m.role === 'tool');
  assert.match(smallTool.content, /Truncado por ChatContextManager/);
});

test('ContextManager - ventana deslizante contigua sin huecos y tope agregado por lote en borde exacto N y N+1', () => {
  // 1. Ventana deslizante contigua: si un bloque grande no cabe, detiene el recorrido sin meter bloques más antiguos
  //    y conserva siempre el mensaje user del turno en curso.
  const contiguous = ChatContextManager.buildOptimizedContext([
    { role: 'system', content: 'Sys' },
    { role: 'user', content: 'Antiguo pequeño' },
    { role: 'assistant', content: 'Respuesta antigua pequeña' },
    { role: 'user', content: 'Petición actual' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'big', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'big', name: 'read_file', content: 'B'.repeat(4000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'small', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'small', name: 'read_file', content: 'reciente' }
  ], { maxInputTokens: 600, maxHistoricalToolChars: 4000, maxActiveToolChars: 4000 });
  const contents = contiguous.messages.map(m => m.content);
  assert.equal(contents.includes('Antiguo pequeño'), false, 'No debe saltar el bloque grande para colar turnos más antiguos');
  assert.equal(contents.some(c => typeof c === 'string' && c.startsWith('Petición actual')), true, 'Debe preservar siempre el mensaje user del turno en curso');
  assert.equal(contiguous.messages.at(-1).content, 'reciente');

  // 2. Tope agregado por lote de herramientas paralelas en borde exacto N y N+1 (en 150K: inputBudget=130904 -> batchMax=117813)
  const makeBatch = (len1, len2) => ChatContextManager.buildOptimizedContext([
    { role: 'system', content: 'Sys' },
    { role: 'user', content: 'Lee dos archivos en paralelo' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'b1', function: { name: 'read_file', arguments: '{"p":"1"}' } },
      { id: 'b2', function: { name: 'read_file', arguments: '{"p":"2"}' } }
    ] },
    { role: 'tool', tool_call_id: 'b1', name: 'read_file', content: 'A'.repeat(len1) },
    { role: 'tool', tool_call_id: 'b2', name: 'read_file', content: 'B'.repeat(len2) }
  ], { totalContextLimit: 150000 });

  // Presupuesto de lote para 150K: floor(130904 * 0.30 * 3) = 117813 chars.
  // Borde exacto N = 58906 + 58907 = 117813 -> ambos intactos.
  const atLimit = makeBatch(58906, 58907);
  const atLimitTools = atLimit.messages.filter(m => m.role === 'tool');
  assert.equal(atLimitTools[0].content.length, 58906);
  assert.equal(atLimitTools[1].content.length, 58907);

  // Borde N+1 = 58907 + 58907 = 117814 -> ambos se truncan al reparto proporcional (58906) con aviso.
  const overLimit = makeBatch(58907, 58907);
  const overLimitTools = overLimit.messages.filter(m => m.role === 'tool');
  assert.match(overLimitTools[0].content, /Truncado por ChatContextManager/);
  assert.match(overLimitTools[1].content, /Truncado por ChatContextManager/);

  // Un resultado corto en el mismo lote se conserva entero y cede su cuota al grande.
  const uneven = makeBatch(1000, 64000);
  const unevenTools = uneven.messages.filter(m => m.role === 'tool');
  assert.equal(unevenTools[0].content.length, 1000);
  assert.equal(unevenTools[1].content.length, 64000);
});

test('ContextManager - poda intra-turno con histéresis, presupuesto de pasos recientes y nota sintética en borde exacto N/N+1', () => {
  // Simulación de un turno largo (1 user + 60 pasos de read_file de 60.000 chars en modelo de 150K):
  // 1. La reserva de pasos recientes (~45% de inputBudget) deja espacio para decenas de pasos antiguos podados
  //    (no se excluyen pasos en el paso 14).
  // 2. La histéresis mantiene el prefijo enviado (caché KV) durante varios pasos tras cada corte, también cuando los
  //    pasos podados acumulados superan por sí solos el objetivo de histéresis y el corte de exclusión avanza.
  // 3. Si aun así se excluyen pasos, aparece la nota sintética determinista tras el user con las llamadas omitidas.
  const messages = [
    { role: 'system', content: 'Sistema de agente' },
    { id: 'u_long_turn', role: 'user', content: 'Revisa los 60 ficheros del proyecto.' }
  ];
  const changedSteps = [];
  let prevSent = null;
  let step14Result = null;
  let lastResult = null;
  const activeTurnCut = { cut: null };
  for (let step = 0; step < 60; step++) {
    messages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `c_${step}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/file_${step}.js` }) } }] },
      { role: 'tool', tool_call_id: `c_${step}`, name: 'read_file', content: `// file ${step}\n` + 'x'.repeat(59980) }
    );
    const out = ChatContextManager.buildOptimizedContext(messages, { totalContextLimit: 150000, activeTurnCut });
    // El prefijo se conserva si lo enviado en el paso anterior sigue siendo el principio de lo que se envía ahora.
    const sent = JSON.stringify(out.messages);
    if (prevSent !== null && !sent.startsWith(prevSent.slice(0, -1))) changedSteps.push(step);
    prevSent = sent;
    if (step === 14) step14Result = out;
    lastResult = out;
  }
  // En el paso 14 (~15 pasos de 60 KB), todos los pasos siguen presentes gracias a la poda (0 excluidos).
  assert.equal(step14Result.diagnostics.excludedCount, 0);
  assert.ok(step14Result.diagnostics.prunedToolsCount >= 10);
  // Tras cada corte el prefijo se mantiene al menos un paso: nunca cambia en dos pasos seguidos.
  const consecutive = changedSteps.filter((step, i) => i > 0 && step === changedSteps[i - 1] + 1);
  assert.deepEqual(consecutive, [], `Cambios de prefijo en pasos seguidos: ${changedSteps.join(',')}`);
  assert.ok(lastResult.diagnostics.excludedCount > 0, 'Con 60 pasos el corte de exclusión ha avanzado');
  assert.ok(lastResult.diagnostics.totalTokens <= lastResult.diagnostics.budget);
  assert.ok(activeTurnCut.cut, 'El corte del turno queda en el estado de la ejecución');

  // El corte es de la ejecución que lo guardó: otra con el mismo mensaje y sus primeros pasos no lo hereda.
  const retry = messages.slice(0, 2 + 3 * 2);
  const retryOut = ChatContextManager.buildOptimizedContext(retry, { totalContextLimit: 150000, activeTurnCut: { cut: null } });
  assert.equal(retryOut.diagnostics.excludedCount, 0);
  assert.equal(retryOut.diagnostics.prunedToolsCount, 0);

  // Nota sintética determinista cuando la ventana excluye pasos del turno activo (presupuesto estrecho)
  // y prueba en borde exacto N / N+1 sobre el tope real (EXCLUDED_STEPS_NOTE_MAX_CHARS = 4000).
  const tightMessages = [
    { role: 'system', content: 'Sys' },
    { id: 'u_tight_note', role: 'user', content: 'Analiza todo.' }
  ];
  for (let i = 0; i < 6; i++) {
    tightMessages.push(
      { role: 'assistant', content: null, tool_calls: [{ id: `tc_${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `f${i}.js` }) } }] },
      { role: 'tool', tool_call_id: `tc_${i}`, name: 'read_file', content: 'Z'.repeat(2000) }
    );
  }
  const withNote = ChatContextManager.buildOptimizedContext(tightMessages, {
    maxInputTokens: 1500,
    maxHistoricalToolChars: 1200,
    maxActiveToolChars: 2000
  });
  assert.ok(withNote.diagnostics.excludedCount > 0);
  assert.equal(withNote.messages[1].role, 'user');
  assert.match(withNote.messages[1].content, /Earlier tool calls in this turn omitted/);
  assert.match(withNote.messages[1].content, /read_file\(\{"path":"f0\.js"\}\)/);

  // Borde exacto N=4000 y N+1=4001 sobre el tope real de la nota sintética (sin opción exclusiva de test).
  const buildNoteOverflowTurn = (id, count) => {
    const msgs = [{ role: 'system', content: 'Sys' }, { id, role: 'user', content: 'Analiza.' }];
    for (let i = 0; i < count; i++) {
      msgs.push(
        { role: 'assistant', content: null, tool_calls: [{ id: `ov_${i}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `src/module_${String(i).padStart(2, '0')}_${'a'.repeat(110)}.js` }) } }] },
        { role: 'tool', tool_call_id: `ov_${i}`, name: 'read_file', content: 'Z'.repeat(3000) }
      );
    }
    return ChatContextManager.buildOptimizedContext(msgs, { maxInputTokens: 2000, maxHistoricalToolChars: 1200, maxActiveToolChars: 2000 });
  };
  const under4000 = buildNoteOverflowTurn('u_note_under', 25);
  assert.doesNotMatch(under4000.messages[1].content, /omitted from this summary due to size limit/);
  const over4000 = buildNoteOverflowTurn('u_note_over', 35);
  assert.match(over4000.messages[1].content, /omitted from this summary due to size limit/);
  const noteTextOver = over4000.messages[1].content.slice('Analiza.\n\n'.length);
  assert.ok(noteTextOver.length <= 4000, `La nota sintética no debe superar 4000 chars (obtenido: ${noteTextOver.length})`);
});

test('ContextManager - recorta evidencia visual (image_url) de turnos cerrados y pasos podados conservando la del turno activo', () => {
  const ConfigStore = require('../../js/config-store.js');
  const img = tag => ({ dataUrl: `data:image/png;base64,${tag}`, mimeType: 'image/png', url: `https://example.com/${tag}` });
  const hasImagePart = message => Array.isArray(message.content) && message.content.some(p => p.type === 'image_url');

  // 1. Turno cerrado con captura + turno activo con captura: solo sobrevive la imagen del turno activo.
  const twoTurns = [
    { role: 'user', content: 'Mira la página 1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 's1', function: { name: 'browser_action', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 's1', name: 'browser_action', content: 'Captura 1', images: [img('OLD')] },
    { role: 'assistant', content: 'Vista la página 1.' },
    { role: 'user', content: 'Mira la página 2' },
    { role: 'assistant', content: null, tool_calls: [{ id: 's2', function: { name: 'browser_action', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 's2', name: 'browser_action', content: 'Captura 2', images: [img('NEW')] }
  ];
  const preparedTwo = ChatEngine.buildEffectiveMessages(twoTurns, ConfigStore.normalize({}), { totalContextLimit: 150000 });
  const imageMessagesTwo = preparedTwo.filter(hasImagePart);
  assert.equal(imageMessagesTwo.length, 1);
  assert.ok(imageMessagesTwo[0].content.some(p => p.image_url?.url.includes('NEW')));

  // 2. Dentro de un mismo turno largo que activa poda intra-turno, los pasos podados pierden su bloque de imagen
  //    y el paso reciente intacto la conserva.
  const longVisualTurn = [
    { id: 'u_visual_prune', role: 'user', content: 'Inspecciona tres pantallas.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'v1', function: { name: 'browser_action', arguments: '{"p":1}' } }] },
    { role: 'tool', tool_call_id: 'v1', name: 'browser_action', content: 'A'.repeat(12000), images: [img('STEP1')] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'v2', function: { name: 'browser_action', arguments: '{"p":2}' } }] },
    { role: 'tool', tool_call_id: 'v2', name: 'browser_action', content: 'B'.repeat(12000), images: [img('STEP2')] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'v3', function: { name: 'browser_action', arguments: '{"p":3}' } }] },
    { role: 'tool', tool_call_id: 'v3', name: 'browser_action', content: 'C'.repeat(4000), images: [img('STEP3')] }
  ];
  const preparedLong = ChatEngine.buildEffectiveMessages(longVisualTurn, ConfigStore.normalize({}), {
    maxInputTokens: 6000,
    maxHistoricalToolChars: 1000,
    maxActiveToolChars: 20000
  });
  const imageUrls = preparedLong.filter(hasImagePart)
    .flatMap(m => m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url));
  assert.equal(imageUrls.some(u => u.includes('STEP1')), false, 'La imagen del paso podado debe omitirse');
  assert.equal(imageUrls.some(u => u.includes('STEP3')), true, 'La imagen del paso reciente intacto debe conservarse');
});

test('ContextManager - usa metadatos explícitos y no heurísticas por nombre', () => {
  assert.equal(ChatContextManager.calculateInputBudget({ model: 'gpt-4o-mini' }), 128000 - 4096 - 12800);
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

test('ContextManager - compressHistory encadena checkpoints acumulativos conservando el turno en curso', async () => {
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
  assert.equal(firstInput.dialogue.length, 2);
  assert.deepEqual(firstInput.messages, firstInput.dialogue);
  assert.equal(firstRes.messages.length, 3);
  assert.equal(firstRes.messages[1]._isSummaryBlock, true);
  assert.equal(firstRes.messages[2].role, 'user');
  assert.equal(firstRes.messages[2].content, 'Añadamos autenticación con JWT.');

  const toolResult = 'resultado completo '.repeat(500);
  const checkpoint = firstRes.messages[1];
  const nextHistory = [
    { role: 'system', content: 'Sistema permanente' },
    checkpoint,
    { role: 'user', content: 'Consulta anterior' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'any_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'any_tool', content: toolResult },
    { role: 'assistant', content: 'Resultado analizado' },
    { role: 'user', content: 'Consulta en curso' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_2', name: 'read_file', content: 'datos recientes del turno activo' }
  ];
  let secondInput;
  const secondRes = await ChatContextManager.compressHistory({
    messages: nextHistory,
    summarizeFn: async input => { secondInput = input; return 'Checkpoint 2'; }
  });
  assert.equal(secondInput.checkpoint, checkpoint);
  assert.deepEqual(secondInput.dialogue, nextHistory.slice(2, 6));
  assert.equal(secondInput.dialogue[2].content, toolResult);
  assert.deepEqual(secondInput.messages, [checkpoint, ...nextHistory.slice(2, 6)]);
  assert.equal(secondRes.messages[1].content, 'Checkpoint 2');
  assert.deepEqual(secondRes.messages.slice(2), nextHistory.slice(6));

  // keepActiveTurn: false (usado en ramas resumidas) comprime todo el historial suministrado
  const fullRes = await ChatContextManager.compressHistory({
    messages: history,
    summarizeFn: async () => 'Checkpoint rama',
    options: { keepActiveTurn: false }
  });
  assert.equal(fullRes.compressed, true);
  assert.equal(fullRes.messages.length, 2);

  const prepared = ChatEngine.buildEffectiveMessages(
    [{ role: 'system', content: 'Checkpoint acumulativo', _isSummaryBlock: true }],
    require('../../js/config-store.js').normalize({ systemPrompt: 'Sistema de la aplicación' })
  );
  assert.ok(prepared[0].content.includes('Sistema de la aplicación'));
  assert.equal(prepared[1].content, 'Checkpoint acumulativo');
  assert.equal(prepared[1]._isSummaryBlock, true);
});

test('ContextManager - compressHistory rechaza summarizeFn nulo, vacíos o llamadas JSON a herramientas', async () => {
  const messages = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'mundo' },
    { role: 'user', content: 'turno actual' }
  ];

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
  assert.equal(okResult.messages.at(-1).content, 'turno actual');

  // Poda progresiva intra-turno: cuando el turno activo supera inputBudget por sí solo, poda pasos antiguos del turno
  // conservando el mensaje user y el paso más reciente intacto.
  const activeOverflow = ChatContextManager.buildOptimizedContext([
    { role: 'system', content: 'Sistema' },
    { role: 'user', content: 'Analiza los tres archivos.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{"p":"1"}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'read_file', content: 'A'.repeat(12000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 't2', function: { name: 'read_file', arguments: '{"p":"2"}' } }] },
    { role: 'tool', tool_call_id: 't2', name: 'read_file', content: 'B'.repeat(12000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 't3', function: { name: 'read_file', arguments: '{"p":"3"}' } }] },
    { role: 'tool', tool_call_id: 't3', name: 'read_file', content: 'C'.repeat(6000) }
  ], { maxInputTokens: 6000, maxHistoricalToolChars: 1000, maxActiveToolChars: 20000 });
  const overflowById = Object.fromEntries(activeOverflow.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]));
  assert.equal(activeOverflow.messages[1].role, 'user');
  assert.match(overflowById.t1, /Truncado por ChatContextManager/);
  assert.equal(overflowById.t3, 'C'.repeat(6000));
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

  // La transcripción para el resumidor se acota siempre (incluso con totalContextLimit: null usando el respaldo 128K)
  // con aviso propio y en borde exacto N / N+1 (maxInputTokens=1000 -> tope exacto 2000 chars).
  const hugeTranscript = ChatContextManager.formatHistoryTranscript(
    Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `Mensaje ${i}: ${'x'.repeat(500)}` })),
    { maxInputTokens: 1500 }
  );
  assert.match(hugeTranscript, /Transcript truncated: \d+ characters omitted to fit the summarizer budget/);

  const exactEdge = ChatContextManager.formatHistoryTranscript([{ role: 'user', content: 'A'.repeat(1994) }], { maxInputTokens: 1000 });
  assert.equal(exactEdge, `User: ${'A'.repeat(1994)}`);
  const overEdge = ChatContextManager.formatHistoryTranscript([{ role: 'user', content: 'A'.repeat(1995) }], { maxInputTokens: 1000 });
  assert.match(overEdge, /Transcript truncated: 1 characters omitted to fit the summarizer budget/);

  // Con totalContextLimit: null también aplica el respaldo de 128K (calculateInputBudget -> 111104 * 2 = 222208 chars).
  const fallbackBig = ChatContextManager.formatHistoryTranscript(
    Array.from({ length: 250 }, (_, i) => ({ role: 'user', content: `M${i}: ${'y'.repeat(1000)}` })),
    { totalContextLimit: null }
  );
  assert.match(fallbackBig, /Transcript truncated:/);
});
