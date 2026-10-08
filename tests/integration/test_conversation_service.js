const { test } = require('node:test');
const assert = require('node:assert/strict');
const ConversationService = require('../../js/conversation-service.js');

test('ConversationService - cloneBranchHistory clones up to boundary and generates session-scoped IDs', () => {
  const history = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' },
    { id: 'm4', role: 'user', content: 'user 2' }
  ];

  const branched = ConversationService.cloneBranchHistory(history, 2, 'new_branch_1');
  assert.equal(branched.length, 3);
  assert.equal(branched[0].id, 'msg_new_branch_1_0');
  assert.equal(branched[1].id, 'msg_new_branch_1_1');
  assert.equal(branched[2].id, 'msg_new_branch_1_2');
  assert.equal(branched[2].content, 'asst 1');
});

test('ConversationService - getBranchBoundaryIndex locates boundary from wrapper attributes', () => {
  const history = [
    { id: 'm1', role: 'system' },
    { id: 'm2', role: 'user' },
    { id: 'm3', role: 'assistant' }
  ];

  const mockWrapper = {
    getAttribute: (attr) => attr === 'data-msg-id' ? 'm2' : null
  };

  const idx = ConversationService.getBranchBoundaryIndex(mockWrapper, history);
  assert.equal(idx, 1);
});

test('ConversationService - shouldOfferBranchSummary requires at least 2 user turns or 4 dialogue turns', () => {
  const shortHistory = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' }
  ];
  assert.equal(ConversationService.shouldOfferBranchSummary(shortHistory, 2), false);

  const longHistory = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' },
    { id: 'm4', role: 'user', content: 'user 2' },
    { id: 'm5', role: 'assistant', content: 'asst 2' }
  ];
  assert.equal(ConversationService.shouldOfferBranchSummary(longHistory, 4), true);
  assert.equal(ConversationService.shouldOfferBranchSummary(longHistory, 2), false);
  assert.equal(ConversationService.shouldOfferBranchSummary([], -1), false);
});

test('ConversationService - renumberForSession clona los mensajes con IDs de la sesión destino', () => {
  const messages = [
    { id: 'sys_1', role: 'system', content: 'Base system prompt' },
    { id: 'summary_1', role: 'system', content: 'Summary', _isSummaryBlock: true, _compressedMetadata: { n: 1 } }
  ];
  const result = ConversationService.renumberForSession(messages, 'sess_branch_123');
  assert.deepEqual(result.map(m => m.id), ['msg_sess_branch_123_0', 'msg_sess_branch_123_1']);
  assert.equal(result[1]._isSummaryBlock, true);
  result[1]._compressedMetadata.n = 2;
  assert.equal(messages[1]._compressedMetadata.n, 1, 'Debe ser una copia profunda');
  assert.equal(messages[0].id, 'sys_1');
});

test('ConversationService - createConversationBranch with summarize: true generates summarized branch', async () => {
  const history = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' },
    { id: 'm4', role: 'user', content: 'user 2' },
    { id: 'm5', role: 'assistant', content: 'asst 2' }
  ];
  const mockWrapper = {
    getAttribute: (attr) => attr === 'data-msg-id' ? 'm5' : null
  };

  let savedSession = null;
  let savedHistory = null;

  const mockStorage = {
    saveConversation: async (session, hist) => {
      savedSession = session;
      savedHistory = hist;
      return true;
    }
  };

  const options = {
    storage: mockStorage,
    getChatHistory: () => history,
    getCurrentSessionId: () => 'parent_sess_1',
    getSavedSessions: () => [{ id: 'parent_sess_1', title: 'Parent Chat' }],
    summarize: true,
    summarizeHistory: async ({ messages }) => {
      summarizedContents.push(...messages.map(m => m.content));
      return 'Consolidated summary of conversation';
    },
    uiConversation: {
      showBranchLoadingIndicator: (wrap, text) => {
        indicatorEvents.push(['show', text]);
      },
      hideBranchLoadingIndicator: (wrap) => {
        indicatorEvents.push(['hide']);
      }
    },
    renderSessionMessages: () => {},
    renderSidebarChats: () => {},
    resetComposerInput: () => {}
  };

  const indicatorEvents = [];
  const summarizedContents = [];
  const success = await ConversationService.createConversationBranch(mockWrapper, options);
  assert.equal(success, true);
  assert.deepEqual(indicatorEvents, [['show', 'Resumiendo contexto previo...'], ['hide']]);
  assert.equal(savedSession.metadata.parentSessionId, 'parent_sess_1');
  assert.ok(savedHistory.some(m => m._isSummaryBlock && m.content === 'Consolidated summary of conversation'));
  assert.equal(savedHistory[savedHistory.length - 1].content, 'asst 2');
  assert.deepEqual(summarizedContents, ['user 1', 'asst 1', 'user 2'], 'La respuesta de anclaje no se resume: se conserva literal');
  assert.deepEqual(savedHistory.map(m => m.content), ['sys', 'Consolidated summary of conversation', 'asst 2']);
});

test('ConversationService - createConversationBranch no bifurca mientras la conversación está ocupada', async () => {
  const State = require('../../js/state.js');
  const previousDialogs = globalThis.ChatDialogs;
  const alerts = [];
  globalThis.ChatDialogs = { alert: async message => { alerts.push(message); } };
  State.set('streaming', { isGenerating: true });
  try {
    const { wrapper, options, saved } = createSummarizableBranch();
    assert.equal(await ConversationService.createConversationBranch(wrapper, options), false);
    assert.equal(saved.length, 0);
    assert.equal(alerts.length, 1);
  } finally {
    State.set('streaming', { isGenerating: false });
    globalThis.ChatDialogs = previousDialogs;
  }
});

test('ConversationService - createConversationBranch with summarize: false clones full branch', async () => {
  const history = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' },
    { id: 'm4', role: 'user', content: 'user 2' },
    { id: 'm5', role: 'assistant', content: 'asst 2' }
  ];
  const mockWrapper = {
    getAttribute: (attr) => attr === 'data-msg-id' ? 'm5' : null
  };

  let savedSession = null;
  let savedHistory = null;

  const mockStorage = {
    saveConversation: async (session, hist) => {
      savedSession = session;
      savedHistory = hist;
      return true;
    }
  };

  const options = {
    storage: mockStorage,
    getChatHistory: () => history,
    getCurrentSessionId: () => 'parent_sess_1',
    getSavedSessions: () => [{ id: 'parent_sess_1', title: 'Parent Chat' }],
    summarize: false,
    renderSessionMessages: () => {},
    renderSidebarChats: () => {},
    resetComposerInput: () => {}
  };

  const success = await ConversationService.createConversationBranch(mockWrapper, options);
  assert.equal(success, true);
  assert.equal(savedHistory.length, 5);
  assert.equal(savedHistory.some(m => m._isSummaryBlock), false);
});


test('ConversationService - defaultSummarizeHistory usa la API key del perfil activo y no oculta fallos al cargarlo', async () => {
  const ChatAPI = require('../../js/api.js');
  const previous = { Profiles: globalThis.ChatProfileRepository, stream: ChatAPI.streamChatCompletion };
  const requests = [];
  ChatAPI.streamChatCompletion = async request => { requests.push(request); return { accumulatedText: 'summary' }; };
  const getRuntimeConfig = () => ({ apiUrl: 'https://x.test', apiType: 'openai', model: 'm', activeProfile: { id: 'p1' } });
  try {
    globalThis.ChatProfileRepository = { load: async () => ({ settings: { apiKey: 'sk-profile' } }) };
    const summary = await ConversationService.defaultSummarizeHistory({ systemPrompt: 'sys', messages: [] }, { getRuntimeConfig });
    assert.equal(summary, 'summary');
    assert.equal(requests[0].apiKey, 'sk-profile');

    globalThis.ChatProfileRepository = { load: async () => { throw new Error('storage broken'); } };
    await assert.rejects(
      ConversationService.defaultSummarizeHistory({ systemPrompt: 'sys', messages: [] }, { getRuntimeConfig }),
      /storage broken/
    );
    assert.equal(requests.length, 1);
  } finally {
    globalThis.ChatProfileRepository = previous.Profiles;
    ChatAPI.streamChatCompletion = previous.stream;
  }
});

function createSummarizableBranch() {
  const history = [
    { id: 'm1', role: 'system', content: 'sys' },
    { id: 'm2', role: 'user', content: 'user 1' },
    { id: 'm3', role: 'assistant', content: 'asst 1' },
    { id: 'm4', role: 'user', content: 'user 2' },
    { id: 'm5', role: 'assistant', content: 'asst 2' }
  ];
  const saved = [];
  const options = {
    storage: { saveConversation: async (session, hist) => { if (session.id !== 'parent_sess_1') saved.push({ session, hist }); return true; } },
    getChatHistory: () => history,
    getCurrentSessionId: () => 'parent_sess_1',
    getSavedSessions: () => [{ id: 'parent_sess_1', title: 'Parent Chat' }],
    summarize: true,
    uiConversation: {},
    renderSessionMessages: () => {},
    renderSidebarChats: () => {},
    resetComposerInput: () => {}
  };
  return { wrapper: { getAttribute: attr => attr === 'data-msg-id' ? 'm5' : null }, options, saved };
}

test('ConversationService - la conversación está ocupada mientras se resume la rama', async () => {
  const State = require('../../js/state.js');
  const { wrapper, options, saved } = createSummarizableBranch();
  let busyDuringSummary = null;
  let signalReceived = null;
  options.summarizeHistory = async ({ signal }) => {
    busyDuringSummary = State.isConversationBusy();
    signalReceived = signal;
    return 'summary';
  };
  assert.equal(await ConversationService.createConversationBranch(wrapper, options), true);
  assert.equal(busyDuringSummary, true);
  assert.ok(signalReceived && typeof signalReceived.aborted === 'boolean');
  assert.equal(State.isConversationBusy(), false);
  assert.equal(State.get('ui').generationStatus.phase, 'idle');
  assert.equal(saved.length, 1);
});

test('ConversationService - parar durante el resumen cancela la rama sin ofrecer el historial completo', async () => {
  const GenerationController = require('../../js/generation-controller.js');
  const State = require('../../js/state.js');
  const { wrapper, options, saved } = createSummarizableBranch();
  options.summarizeHistory = ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
    GenerationController.handleStopGeneration();
  });
  const previousDialogs = globalThis.ChatDialogs;
  let dialogs = 0;
  globalThis.ChatDialogs = { confirm: async () => { dialogs++; return true; }, alert: async () => { dialogs++; } };
  try {
    assert.equal(await ConversationService.createConversationBranch(wrapper, options), false);
  } finally {
    globalThis.ChatDialogs = previousDialogs;
  }
  assert.equal(dialogs, 0);
  assert.equal(saved.length, 0);
  assert.equal(State.isConversationBusy(), false);
});

async function branchWithDialogs(confirmResults, configure = () => {}) {
  const { wrapper, options, saved } = createSummarizableBranch();
  delete options.summarize;
  configure(options);
  const previousDialogs = globalThis.ChatDialogs;
  const confirms = [];
  globalThis.ChatDialogs = {
    confirm: async (message, opts) => { confirms.push({ message, opts }); return confirmResults.shift(); },
    alert: async () => {}
  };
  try {
    const created = await ConversationService.createConversationBranch(wrapper, options);
    return { created, confirms, saved };
  } finally {
    globalThis.ChatDialogs = previousDialogs;
  }
}

test('ConversationService - cancelar el diálogo de bifurcación no crea la rama', async () => {
  const { created, confirms, saved } = await branchWithDialogs([{ accepted: false, checkboxChecked: true }]);
  assert.equal(created, false);
  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].opts.checkbox, 'Debe ofrecer la casilla de resumen');
  assert.equal(saved.length, 0);
});

test('ConversationService - aceptar sin la casilla de resumen clona el historial completo', async () => {
  const { created, saved } = await branchWithDialogs([{ accepted: true, checkboxChecked: false }], options => {
    options.summarizeHistory = async () => { throw new Error('no debe resumir'); };
  });
  assert.equal(created, true);
  assert.equal(saved[0].hist.length, 5);
});

test('ConversationService - si el resumen falla ofrece bifurcar con el historial completo', async () => {
  const failing = options => { options.summarizeHistory = async () => { throw new Error('provider down'); }; };
  const accepted = await branchWithDialogs([{ accepted: true, checkboxChecked: true }, true], failing);
  assert.equal(accepted.created, true);
  assert.equal(accepted.confirms.length, 2);
  assert.equal(accepted.saved[0].hist.length, 5);

  const declined = await branchWithDialogs([{ accepted: true, checkboxChecked: true }, false], failing);
  assert.equal(declined.created, false);
  assert.equal(declined.saved.length, 0);
});
