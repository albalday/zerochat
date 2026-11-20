const test = require('node:test');
const assert = require('node:assert');
const ChatState = require('../../js/state.js');

test('ChatState - Aislamiento, slices canónicos y prevención de notificaciones innecesarias', () => {
  const store = ChatState.createStore();

  const state1 = store.getState();
  state1.config.apiUrl = 'http://hacked.com';
  state1.messages.push({ role: 'fake' });
  const state2 = store.getState();
  assert.equal(state2.config.apiUrl, 'http://localhost:1234/v1');
  assert.equal(state2.messages.length, 0);

  let callCount = 0;
  store.subscribe(() => { callCount++; });
  store.setState({ config: { apiUrl: 'http://localhost:1234/v1' } });
  assert.equal(callCount, 0);

  assert.ok(Array.isArray(store.CANONICAL_SLICES) && store.CANONICAL_SLICES.includes('project'));
  assert.throws(() => store.set('arbitrarySlice', { foo: 'bar' }), /non-canonical slice/i);
  assert.throws(() => store.setState({ illegalProp: true }), /non-canonical slice/i);
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
  store.set('streaming', { isGenerating: true });
  assert.equal(globalCalls, 1);
  assert.equal(sliceCalls, 1);
  assert.equal(selectorCalls, 1);
  assert.equal(lastIsGenerating, true);

  // Cambio en otro slice (no afecta al selector de isGenerating)
  store.set('ui', { attachedFiles: [{ name: 'a.txt' }] });
  assert.equal(globalCalls, 2);
  assert.equal(sliceCalls, 1); // No debe llamarse
  assert.equal(selectorCalls, 1); // No debe llamarse

  // Cancelar suscripción
  unsubGlobal();
  unsubSlice();
  unsubSelector();

  store.set('streaming', { isGenerating: false });
  assert.equal(globalCalls, 2);
  assert.equal(sliceCalls, 1);
  assert.equal(selectorCalls, 1);
});

test('ChatState - replaceConversation e importConversation activan una conversación, reinician transitorios y bloquean durante generación', () => {
  const store = ChatState.createStore();
  store.setState({
    sessions: { activeId: 'session_old', list: [{ id: 'session_old' }] },
    messages: [{ id: 'old_user', role: 'user', content: 'Anterior' }],
    telemetry: { stats: { tokens: 40 } },
    ui: { attachedFiles: [{ name: 'old.txt' }] }
  });

  const messages = [{ id: 'system_root', role: 'system', content: 'Nuevo sistema' }];
  assert.equal(store.replaceConversation({ sessionId: 'session_new', sessions: [{ id: 'session_old' }, { id: 'session_other' }], messages }).ok, true);
  assert.equal(store.get('sessions').activeId, 'session_new');
  assert.equal(store.get('sessions').list.length, 2);
  assert.deepEqual(store.get('messages'), messages);
  assert.deepEqual(store.get('streaming'), { isGenerating: false });
  assert.deepEqual(store.get('telemetry'), { stats: null });
  assert.deepEqual(store.get('ui').attachedFiles, []);

  store.set('ui', { attachedFiles: [{ name: 'file.txt' }] });
  store.set('telemetry', { stats: { tokens: 5 } });
  assert.equal(store.importConversation({ id: 'imported_sess', title: 'Chat Importado' }, [{ id: 'm_imp', role: 'user', content: 'Importado' }]).ok, true);
  assert.equal(store.get('sessions').activeId, 'imported_sess');
  assert.deepEqual(store.get('ui').attachedFiles, []);
  assert.equal(store.get('telemetry').stats, null);

  store.set('streaming', { isGenerating: true });
  assert.deepEqual(store.replaceConversation({ sessionId: 's2', sessions: [], messages: [] }), { ok: false, reason: 'generation-active' });
  assert.equal(store.isConversationBusy(), true);
  assert.equal(store.get('sessions').activeId, 'imported_sess');
});

test('ChatState - removeLastTurn y removeSession respetan estado ocupado y retiran el último turno entero', () => {
  const store = ChatState.createStore();
  store.replaceMessages([
    { id: 'u1', role: 'user', content: 'Consulta' },
    { id: 'a1', role: 'assistant', content: 'Primera respuesta' },
    { id: 'u2', role: 'user', content: 'Siguiente pregunta' },
    { id: 'a2', role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_web' } }] },
    { id: 't2', role: 'tool', tool_call_id: 'call_1', name: 'search_web', content: 'Resultados' },
    { id: 'a2_final', role: 'assistant', content: 'Respuesta basada en búsqueda' }
  ]);
  const res = store.removeLastTurn();
  assert.equal(res.ok, true);
  assert.equal(res.removedCount, 4);
  assert.equal(res.removedPrompt, 'Siguiente pregunta');
  assert.deepEqual(store.get('messages').map(m => m.id), ['u1', 'a1']);

  store.set('streaming', { isGenerating: true });
  assert.deepEqual(store.removeLastTurn(), { ok: false, reason: 'generation-active', removedCount: 0, removedPrompt: '' });
  assert.equal(store.get('messages').length, 2);
  store.set('streaming', { isGenerating: false });

  store.setState({
    sessions: { activeId: 'draft_unsaved', list: [{ id: 'saved_1', title: 'Previo' }] },
    messages: [{ id: 'm_sys', role: 'system', content: 'sys' }]
  });
  assert.equal(store.removeSession('draft_unsaved').ok, true);
  assert.equal(store.get('sessions').activeId, 'draft_unsaved');
  assert.equal(store.get('sessions').list.length, 1);

  assert.equal(store.removeSession('saved_1').ok, true);
  assert.equal(store.get('sessions').list.length, 0);
  assert.equal(store.get('sessions').activeId, 'draft_unsaved');
});

test('ChatState - setProjectContext valida el estado y el cambio de conversación no reinicia el proyecto', () => {
  const store = ChatState.createStore();
  assert.equal(store.get('project').status, 'disabled');
  assert.throws(() => store.setProjectContext({ status: 'unknown' }), /invalid status/);
  assert.throws(() => store.setProjectContext(null), /objeto/);

  store.setProjectContext({ status: 'ready', cwd: '/repo', rules: { content: 'r', truncated: 'yes' } });
  assert.deepEqual(store.get('project').rules, { content: 'r', truncated: false });
  assert.deepEqual(store.get('project').state, { content: '', truncated: false });

  store.replaceConversation({ sessionId: 'session_next', sessions: [], messages: [] });
  assert.equal(store.get('project').status, 'ready');
  assert.equal(store.get('project').cwd, '/repo');
});

test('ChatState - notificaciones reentrantes entre slices entregan el cambio y cortan bucles infinitos', () => {
  const store = ChatState.createStore();
  const seenProjects = [];
  store.subscribe(state => state.mcp.serverInfo?.cwd || '', cwd => {
    if (cwd) store.setProjectContext({ cwd, status: 'no_project' });
  });
  store.subscribe('project', project => {
    seenProjects.push({ cwd: project.cwd, status: project.status });
  });

  store.set('mcp', { status: 'connected', serverInfo: { cwd: '/home/u/zerochat/general' } });
  assert.deepEqual(seenProjects, [{ cwd: '/home/u/zerochat/general', status: 'no_project' }]);

  let loopCount = 0;
  const loopStore = ChatState.createStore();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    loopStore.subscribe('ui', () => {
      loopCount++;
      loopStore.set('ui', { noticeSequence: loopCount + 1 });
    });
    loopStore.set('ui', { noticeSequence: 1 });
    assert.equal(loopCount, 10);
  } finally {
    console.warn = origWarn;
  }
});
