const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ChatState = require('../js/state.js');

test('ChatState - Inicialización con valores por defecto', () => {
  const store = ChatState.createStore();
  const state = store.getState();

  assert.ok(state.config);
  assert.equal(state.config.apiUrl, 'http://localhost:1234/v1');
  assert.equal(state.config.temperature, '0.7');
  assert.equal(state.streaming.isGenerating, false);
  assert.equal(state.streaming.status, 'idle');
  assert.ok(Array.isArray(state.messages));
  assert.equal(state.messages.length, 0);
  assert.ok(state.sessions.activeId);
});

test('ChatState - app.js no mantiene una copia mutable del estado de generación', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /let\s+isGenerating\s*=/);
  assert.match(appSource, /State\.isConversationBusy/);
});

test('ChatState - Actualizaciones parciales y atómicas', () => {
  const store = ChatState.createStore();

  // Actualizar slice con store.set()
  store.set('streaming', { isGenerating: true, status: 'streaming' });
  const s1 = store.get('streaming');
  assert.equal(s1.isGenerating, true);
  assert.equal(s1.status, 'streaming');
  assert.equal(s1.error, null); // Debe preservar el resto del slice

  // Actualizar varios slices con store.setState()
  store.setState({
    config: { model: 'llama-3.3' },
    ui: { sidebarOpen: true }
  });

  const full = store.getState();
  assert.equal(full.config.model, 'llama-3.3');
  assert.equal(full.config.apiUrl, 'http://localhost:1234/v1'); // Preservado
  assert.equal(full.ui.sidebarOpen, true);
  assert.equal(full.ui.reasoningMenuOpen, false); // Preservado
});

test('ChatState - Actualización funcional con prevState', () => {
  const store = ChatState.createStore();

  store.set('messages', (prevMessages) => [
    ...prevMessages,
    { id: 'm1', role: 'user', content: 'Hola' }
  ]);

  assert.equal(store.get('messages').length, 1);
  assert.equal(store.get('messages')[0].content, 'Hola');
});

test('ChatState - Aislamiento e inmutabilidad del estado interno', () => {
  const store = ChatState.createStore();

  const state1 = store.getState();
  // Mutación externa maliciosa o accidental
  state1.config.apiUrl = 'http://hacked.com';
  state1.messages.push({ role: 'fake' });

  // El store interno debe permanecer intacto
  const state2 = store.getState();
  assert.equal(state2.config.apiUrl, 'http://localhost:1234/v1');
  assert.equal(state2.messages.length, 0);
});

test('ChatState - Suscripciones globales, por slice y por selector', () => {
  const store = ChatState.createStore();
  let globalCalls = 0;
  let sliceCalls = 0;
  let selectorCalls = 0;
  let lastIsGenerating = null;

  // 1. Suscriptor global
  const unsubGlobal = store.subscribe((newState, prevState) => {
    globalCalls++;
    assert.ok(newState);
    assert.ok(prevState);
  });

  // 2. Suscriptor por clave de slice ('streaming')
  const unsubSlice = store.subscribe('streaming', (newStreaming, prevStreaming) => {
    sliceCalls++;
    assert.equal(typeof newStreaming.isGenerating, 'boolean');
  });

  // 3. Suscriptor por selector derivado
  const unsubSelector = store.subscribe(
    state => state.streaming.isGenerating,
    (isGen, prevIsGen) => {
      selectorCalls++;
      lastIsGenerating = isGen;
      assert.notEqual(isGen, prevIsGen);
    }
  );

  // Primer cambio relevante
  store.set('streaming', { isGenerating: true, status: 'streaming' });
  assert.equal(globalCalls, 1);
  assert.equal(sliceCalls, 1);
  assert.equal(selectorCalls, 1);
  assert.equal(lastIsGenerating, true);

  // Cambio en otro slice (no afecta al selector de isGenerating)
  store.set('ui', { sidebarOpen: true });
  assert.equal(globalCalls, 2);
  assert.equal(sliceCalls, 1); // No debe llamarse
  assert.equal(selectorCalls, 1); // No debe llamarse

  // Cancelar suscripción
  unsubGlobal();
  unsubSlice();
  unsubSelector();

  store.set('streaming', { isGenerating: false, status: 'idle' });
  assert.equal(globalCalls, 2);
  assert.equal(sliceCalls, 1);
  assert.equal(selectorCalls, 1);
});

test('ChatState - Prevención de notificaciones innecesarias (Shallow Equality Check)', () => {
  const store = ChatState.createStore();
  let callCount = 0;

  store.subscribe(() => {
    callCount++;
  });

  // Aplicar mismo valor existente en config
  store.setState({
    config: { apiUrl: 'http://localhost:1234/v1' }
  });

  // No debe haber emitido eventos porque el valor es idéntico
  assert.equal(callCount, 0);
});

test('ChatState - Reset del estado', () => {
  const store = ChatState.createStore();
  store.set('config', { model: 'gpt-4o' });
  store.set('streaming', { isGenerating: true });

  store.reset();
  const state = store.getState();
  assert.equal(state.config.model, '');
  assert.equal(state.streaming.isGenerating, false);
});

test('ChatState - Inicializa una conversación y limpia todo el estado transitorio de turnos', () => {
  const store = ChatState.createStore();
  store.setState({
    sessions: { activeId: 'session_old', list: [{ id: 'session_old' }] },
    messages: [{ id: 'old_user', role: 'user', content: 'Anterior' }],
    streaming: { stats: { tokens: 40 }, status: 'done', error: new Error('previous error') },
    agent: { activeTurnIndex: 4, currentTool: 'search_web', loopWarning: true, ragSystemContext: 'old RAG context' },
    telemetry: { stats: { tokens: 40 }, diagnostics: { used: 40 }, lastTurnStats: { tokens: 20 } },
    ui: { reasoningMenuOpen: true, activeModal: 'debug_interceptor', attachedFiles: [{ name: 'old.txt' }] }
  });

  const messages = [{ id: 'system_root', role: 'system', content: 'Nuevo sistema' }];
  const result = store.initializeConversation({ sessionId: 'session_new', sessions: [{ id: 'session_old' }], messages });

  assert.equal(result.ok, true);
  const state = store.getState();
  assert.equal(state.sessions.activeId, 'session_new');
  assert.deepEqual(state.messages, messages);
  assert.deepEqual(state.streaming, { isGenerating: false, stats: null, status: 'idle', error: null });
  assert.deepEqual(state.agent, { activeTurnIndex: 0, currentTool: null, loopWarning: false, ragSystemContext: '' });
  assert.deepEqual(state.telemetry, { stats: null, diagnostics: null, lastTurnStats: null });
  assert.equal(state.ui.reasoningMenuOpen, false);
  assert.equal(state.ui.debugPanelOpen, false);
  assert.equal(state.ui.activeModal, null);
  assert.deepEqual(state.ui.attachedFiles, []);
});

test('ChatState - Deniega inicializar una conversación durante una generación', () => {
  const store = ChatState.createStore();
  store.setState({
    sessions: { activeId: 'session_active' },
    messages: [{ id: 'active_message', role: 'user', content: 'En curso' }],
    streaming: { isGenerating: true, status: 'streaming' }
  });

  const result = store.initializeConversation({ sessionId: 'session_new', sessions: [], messages: [] });

  assert.deepEqual(result, { ok: false, reason: 'generation-active' });
  assert.equal(store.isConversationBusy(), true);
  assert.equal(store.get('sessions').activeId, 'session_active');
  assert.equal(store.get('messages')[0].id, 'active_message');
});

test('ChatState - Contrato de slices canónicos y rechazo de escrituras no autorizadas', () => {
  const store = ChatState.createStore();
  assert.ok(Array.isArray(store.CANONICAL_SLICES));
  assert.ok(store.CANONICAL_SLICES.includes('toolSecurity'));

  const initialState = store.getState();
  assert.deepEqual(initialState.toolSecurity, {
    globalMcpPolicy: 'ask',
    authorizedCount: 0,
    tools: {}
  });

  // set con slice no canónico debe lanzar error
  assert.throws(() => {
    store.set('arbitrarySlice', { foo: 'bar' });
  }, /slice no canónico/i);

  // setState con slice no canónico debe lanzar error
  assert.throws(() => {
    store.setState({ illegalProp: true });
  }, /slice no canónico/i);

  // createInitialState con slice no canónico en overrides debe lanzar error
  assert.throws(() => {
    ChatState.createInitialState({ unknownSlice: 123 });
  }, /slice no canónico/i);
});

test('ChatState - Mutadores de mensajes: appendMessage y replaceMessages', () => {
  const store = ChatState.createStore();

  assert.throws(() => store.appendMessage(null), /objeto válido/);
  assert.throws(() => store.appendMessage({ content: 'sin role' }), /role/);

  const appended = store.appendMessage({ role: 'user', content: 'Pregunta 1' });
  assert.ok(appended.id);
  assert.equal(appended.content, 'Pregunta 1');
  assert.equal(store.get('messages').length, 1);

  // replaceMessages
  assert.throws(() => store.replaceMessages('no array'), /Array/);
  const newMessages = [
    { id: 'm1', role: 'user', content: 'A' },
    { id: 'm2', role: 'assistant', content: 'B' }
  ];
  store.replaceMessages(newMessages);
  assert.equal(store.get('messages').length, 2);
  assert.equal(store.get('messages')[1].content, 'B');

  // Asegurar inmutabilidad
  newMessages.push({ id: 'm3', role: 'user', content: 'C' });
  assert.equal(store.get('messages').length, 2);
});

test('ChatState - Mutador removeTurn elimina turno y sanea tool calls huérfanos', () => {
  const store = ChatState.createStore();
  store.replaceMessages([
    { id: 'u1', role: 'user', content: 'Consulta' },
    { id: 'a1', role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_web' } }] },
    { id: 't1', role: 'tool', tool_call_id: 'call_1', name: 'search_web', content: 'Resultados' },
    { id: 'a1_final', role: 'assistant', content: 'Respuesta basada en búsqueda' },
    { id: 'u2', role: 'user', content: 'Siguiente pregunta' }
  ]);

  // Intentar eliminar turno a1_final indicando baseId 'a1'
  const res = store.removeTurn({ baseId: 'a1' });
  assert.equal(res.ok, true);
  // Debe haber eliminado a1, t1 y a1_final (3 mensajes)
  assert.equal(res.removedCount, 3);
  const remaining = store.get('messages');
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].id, 'u1');
  assert.equal(remaining[1].id, 'u2');
});

test('ChatState - Mutadores de sesiones: saveSessionMetadata y removeSession', () => {
  const store = ChatState.createStore();
  const meta1 = { id: 'sess_1', title: 'Primera', messageCount: 2 };
  store.saveSessionMetadata(meta1);

  assert.equal(store.get('sessions').list.length, 1);
  assert.equal(store.get('sessions').list[0].title, 'Primera');

  // Actualizar metadata existente
  store.saveSessionMetadata({ id: 'sess_1', title: 'Primera renombrada' });
  assert.equal(store.get('sessions').list.length, 1);
  assert.equal(store.get('sessions').list[0].title, 'Primera renombrada');

  // Agregar segunda sesión
  store.saveSessionMetadata({ id: 'sess_2', title: 'Segunda' });
  assert.equal(store.get('sessions').list.length, 2);

  // removeSession
  const rem = store.removeSession('sess_1');
  assert.equal(rem.ok, true);
  assert.equal(store.get('sessions').list.length, 1);
  assert.equal(store.get('sessions').list[0].id, 'sess_2');
});

test('ChatState - Mutador replaceConversation y guardas de concurrencia', () => {
  const store = ChatState.createStore();
  const history = [{ id: 'm1', role: 'user', content: 'Historial' }];
  const sessions = [{ id: 's1', title: 'S1' }];

  const res = store.replaceConversation({ sessionId: 's1', messages: history, sessions });
  assert.equal(res.ok, true);
  assert.equal(store.get('sessions').activeId, 's1');
  assert.equal(store.get('messages').length, 1);

  // Bloqueo durante generación
  store.set('streaming', { isGenerating: true });
  const blocked = store.replaceConversation({ sessionId: 's2', messages: [] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'generation-active');
  assert.equal(store.get('sessions').activeId, 's1');
});

test('ChatState - Mutador importConversation y reinicio transitorio', () => {
  const store = ChatState.createStore();
  store.set('ui', { attachedFiles: [{ name: 'file.txt' }], reasoningMenuOpen: true });
  store.set('agent', { ragSystemContext: 'rag viejo' });

  const sessionMeta = { id: 'imported_sess', title: 'Chat Importado' };
  const history = [{ id: 'm_imp', role: 'user', content: 'Importado' }];

  const res = store.importConversation(sessionMeta, history);
  assert.equal(res.ok, true);
  assert.equal(store.get('sessions').activeId, 'imported_sess');
  assert.equal(store.get('messages')[0].content, 'Importado');
  // Slices transitorios deben haberse reiniciado
  assert.deepEqual(store.get('ui').attachedFiles, []);
  assert.equal(store.get('ui').reasoningMenuOpen, false);
  assert.equal(store.get('agent').ragSystemContext, '');
});

test('ChatState - Mutadores de adjuntos: setAttachments y clearAttachments', () => {
  const store = ChatState.createStore();
  assert.throws(() => store.setAttachments('invalid'), /Array/);

  const files = [{ name: 'img.png', type: 'image' }, { name: 'doc.pdf', type: 'pdf' }];
  store.setAttachments(files);
  assert.equal(store.get('ui').attachedFiles.length, 2);

  // Inmutabilidad
  files.push({ name: 'extra.txt' });
  assert.equal(store.get('ui').attachedFiles.length, 2);

  store.clearAttachments();
  assert.equal(store.get('ui').attachedFiles.length, 0);
});
