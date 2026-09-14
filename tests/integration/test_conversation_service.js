const { test } = require('node:test');
const assert = require('node:assert/strict');
const ConversationService = require('../../js/conversation-service.js');

test('ConversationService - isDateTimeInitialTurn identifies initial date-time messages', () => {
  assert.equal(ConversationService.isDateTimeInitialTurn({ role: 'user', content: 'La fecha y hora actual es: 2026-09-14' }), true);
  assert.equal(ConversationService.isDateTimeInitialTurn({ role: 'user', content: 'The current date and time is: 2026-09-14' }), true);
  assert.equal(ConversationService.isDateTimeInitialTurn({ role: 'user', content: 'Hola, ¿cómo estás?' }), false);
  assert.equal(ConversationService.isDateTimeInitialTurn({ role: 'assistant', content: 'La fecha y hora actual es:' }), false);
});

test('ConversationService - extractBaseId strips turn and final suffixes', () => {
  assert.equal(ConversationService.extractBaseId('msg_123_turn_2_assistant'), 'msg_123');
  assert.equal(ConversationService.extractBaseId('msg_123_turn_1_tool_read'), 'msg_123');
  assert.equal(ConversationService.extractBaseId('msg_123_final'), 'msg_123');
  assert.equal(ConversationService.extractBaseId('msg_123'), 'msg_123');
});

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

test('ConversationService - createInitialChatHistory includes system_root role', () => {
  const history = ConversationService.createInitialChatHistory({
    getConfiguredSystemPrompt: () => 'Eres un asistente útil'
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'system');
  assert.equal(history[0].content, 'Eres un asistente útil');
});

