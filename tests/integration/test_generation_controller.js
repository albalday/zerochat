const test = require('node:test');
const assert = require('node:assert/strict');
const GenerationController = require('../../js/generation-controller.js');

test('GenerationController - initial state is not generating', () => {
  assert.equal(GenerationController.isGenerating(), false);
  assert.equal(GenerationController.getCurrentAbortController(), null);
});

test('GenerationController - returned and thrown errors use the same connection view', async t => {
  const State = require('../../js/state.js');
  const names = ['ChatState', 'ChatEngine', 'ChatProfileRepository', 'ChatAttachments'];
  const previous = names.map(name => [name, global[name]]);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete global[name];
      else global[name] = value;
    }
  });
  t.mock.method(console, 'error', () => {});
  global.ChatProfileRepository = { load: async () => null };
  global.ChatAttachments = { getFiles: () => [] };
  const rendered = [];
  for (const throws of [false, true]) {
    global.ChatState = State.createStore();
    global.ChatEngine = { executeAgentTurnLoop: async () => {
      const error = new Error('<img src=x onerror="bad()">');
      if (throws) throw error;
      return { error };
    } };
    const content = { innerHTML: '' };
    const actions = { style: {} };
    await GenerationController.handleSendMessage({
      elements: { userInput: { value: 'Question' } },
      api: { streamChatCompletion() {} },
      getRuntimeConfig: () => ({ model: 'test', apiUrl: '<script>bad()</script>' }),
      appendUserMessage: () => 'user-test',
      getChatHistory: () => global.ChatState.get('messages'),
      createAssistantMessagePlaceholder: () => ({ content, actions, wrapper: {}, row: {}, msgId: 'assistant-test' })
    });
    assert.equal(actions.style.display, 'inline-flex');
    assert.equal(GenerationController.isGenerating(), false);
    assert.doesNotMatch(content.innerHTML, /<img|<script/);
    rendered.push(content.innerHTML);
  }
  assert.equal(rendered[0], rendered[1]);
});

test('GenerationController - finishGeneration resets state and calls saveCurrentSession', () => {
  let saved = false;
  let typingRemoved = false;
  let statusCleared = false;

  GenerationController.finishGeneration({
    skipSave: false,
    error: null,
    elements: {
      btnSend: { disabled: true },
      btnStopStream: { style: { display: 'block' } }
    },
    removeTypingIndicator: () => { typingRemoved = true; },
    clearGenerationStatus: () => { statusCleared = true; },
    saveCurrentSession: () => { saved = true; },
    scrollToBottom: () => {}
  });

  assert.equal(typingRemoved, true);
  assert.equal(statusCleared, true);
  assert.equal(saved, true);
  assert.equal(GenerationController.isGenerating(), false);
});

test('GenerationController - handleSendMessage ignores empty input with no files', async () => {
  let appendCalled = false;
  await GenerationController.handleSendMessage({
    elements: { userInput: { value: '   ' } },
    appendUserMessage: () => { appendCalled = true; }
  });
  assert.equal(appendCalled, false);
});

test('GenerationController - handleSendMessage rejects empty model configuration gracefully', async () => {
  let finishCalled = false;
  let rowClasses = [];
  const mockRow = {
    classList: {
      add: (c) => rowClasses.push(c)
    }
  };
  const mockContent = { innerHTML: '' };
  const mockActions = { style: {} };

  await GenerationController.handleSendMessage({
    elements: { userInput: { value: 'Hola' } },
    api: { streamChatCompletion: () => {} },
    getRuntimeConfig: () => ({ model: '', apiUrl: 'http://localhost:1234' }),
    appendUserMessage: () => 'msg_usr_test',
    createAssistantMessagePlaceholder: () => ({
      wrapper: {},
      row: mockRow,
      content: mockContent,
      actions: mockActions,
      btnCopy: {},
      statsContainer: { style: {} },
      msgId: 'msg_ast_test'
    }),
    finishGeneration: () => { finishCalled = true; }
  });

  assert.ok(rowClasses.includes('message-error'));
  assert.ok(mockContent.innerHTML.includes('No hay ningún modelo seleccionado') || mockContent.innerHTML.includes('err_no_model_title'));
});

test('GenerationController - loopDetected sets agent.loopWarning, reports error status and stops cleanly', async t => {
  const State = require('../../js/state.js');
  const store = State.createStore();
  const previousState = global.ChatState;
  const previousEngine = global.ChatEngine;
  const previousProfile = global.ChatProfileRepository;
  const previousAttachments = global.ChatAttachments;

  t.after(() => {
    global.ChatState = previousState;
    global.ChatEngine = previousEngine;
    global.ChatProfileRepository = previousProfile;
    global.ChatAttachments = previousAttachments;
  });

  global.ChatState = store;
  global.ChatProfileRepository = { load: async () => null };
  global.ChatAttachments = { getFiles: () => [] };

  let debugStatusValue = null;
  let debugLogRecorded = null;
  let savedSession = false;

  global.ChatEngine = {
    executeAgentTurnLoop: async () => ({
      success: true,
      loopDetected: true,
      finalAssistantText: '\n\n> ⚠️ *[Infinite Loop Protection]*: Tools were repeatedly invoked with identical parameters without progress.',
      chatHistory: [
        { role: 'user', content: 'Loop me' },
        { role: 'assistant', content: '\n\n> ⚠️ *[Infinite Loop Protection]*: Tools were repeatedly invoked with identical parameters without progress.' }
      ]
    })
  };

  const content = { innerHTML: '' };
  const actions = { style: {} };

  await GenerationController.handleSendMessage({
    elements: {
      userInput: { value: 'Trigger loop' },
      btnSend: { disabled: true },
      btnStopStream: { style: { display: 'block' } }
    },
    api: { streamChatCompletion() {} },
    getRuntimeConfig: () => ({ model: 'test-model', apiUrl: 'http://localhost:1234/v1' }),
    appendUserMessage: () => 'user-loop-test',
    getChatHistory: () => store.get('messages'),
    createAssistantMessagePlaceholder: () => ({ content, actions, wrapper: {}, row: {}, msgId: 'assistant-loop-test' }),
    setDebugStatus: (status) => { debugStatusValue = status; },
    addDebugLog: (type, text) => { debugLogRecorded = { type, text }; },
    saveCurrentSession: () => { savedSession = true; }
  });

  assert.equal(store.get('agent').loopWarning, true, 'Debe marcar agent.loopWarning como true en ChatState');
  assert.equal(debugStatusValue, 'error', 'El estado de depuración debe indicar error tras bucle');
  assert.equal(debugLogRecorded?.type, 'error', 'Debe registrar log de error con advertencia de bucle');
  assert.equal(savedSession, true, 'Debe guardar la sesión completa tras la parada ordenada');
  assert.equal(GenerationController.isGenerating(), false, 'La generación debe quedar inactiva');
  assert.equal(actions.style.display, 'inline-flex', 'Las acciones del mensaje deben quedar visibles para copia');
});
