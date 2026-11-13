const test = require('node:test');
const assert = require('node:assert/strict');
const ChatState = require('../../js/state.js');
const ServerRun = require('../../js/server-run.js');

test('ServerRun.finishedRunIds devuelve las conversaciones que dejan de estar en curso', () => {
  const run = (conversationId, status) => ({ conversationId, status });
  const previous = [run('a', 'running'), run('b', 'running'), run('c', 'error')];
  const current = [run('a', 'running'), run('b', 'completed'), run('d', 'running')];
  assert.deepEqual(ServerRun.finishedRunIds(previous, current), ['b']);
  assert.deepEqual(ServerRun.finishedRunIds([run('a', 'running')], []), ['a']);
  assert.deepEqual(ServerRun.finishedRunIds([], current), []);
});

test('ServerRun - la ejecución con error de la conversación activa se muestra sin bloquear el compositor', t => {
  const previousMcp = ChatState.get('mcp');
  const previousSessions = ChatState.get('sessions');
  t.after(() => {
    ChatState.set('mcp', previousMcp);
    ChatState.set('sessions', previousSessions);
  });
  ChatState.set('sessions', { activeId: 'active' });
  ChatState.set('mcp', { serverRuns: [{ conversationId: 'other', status: 'running' }, { conversationId: 'active', status: 'error' }] });
  assert.deepEqual(ServerRun.getActiveRun(), { conversationId: 'active', status: 'error' });
  assert.equal(ServerRun.isComposerBusy(), false);

  ChatState.set('mcp', { serverRuns: [{ conversationId: 'active', status: 'running' }] });
  assert.equal(ServerRun.isComposerBusy(), true);
  ChatState.set('mcp', { serverRuns: [{ conversationId: 'active', status: 'completed' }] });
  assert.equal(ServerRun.getActiveRun(), null);
});
