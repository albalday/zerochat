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

test('ServerRun.attentionCounts cuenta por historial las conversaciones que esperan al usuario o fallaron', () => {
  const sessions = [{ id: 'chat' }, { id: 'chat2' }, { id: 'agent', agent: 'informes.diario' }, { id: 'agent2', agent: 'x' }, { id: 'quieta' }];
  const runs = [
    { conversationId: 'chat', status: 'needs_input' },
    { conversationId: 'chat2', status: 'error' },
    { conversationId: 'agent', status: 'needs_input' },
    { conversationId: 'agent2', status: 'needs_input' },
    // En marcha o parada por un límite no piden nada; una conversación que la lista aún no trae no cuenta.
    { conversationId: 'quieta', status: 'running' },
    { conversationId: 'quieta', status: 'limit' },
    { conversationId: 'sin-guardar', status: 'error' }
  ];
  assert.deepEqual(ServerRun.attentionCounts(sessions, runs), {
    agentsNeedsInput: 2, agentsError: 0, chatsNeedsInput: 1, chatsError: 1,
    key: 'agent2:needs_input\nagent:needs_input\nchat2:error\nchat:needs_input'
  });
  assert.deepEqual(ServerRun.attentionCounts(sessions, []), { agentsNeedsInput: 0, agentsError: 0, chatsNeedsInput: 0, chatsError: 0, key: '' });
});

test('ServerRun.keepDismissedAttention deja cerrado el aviso hasta que aparece una conversación o estado que no estaba', () => {
  const keep = ServerRun.keepDismissedAttention;
  const dismissed = 'a:needs_input\nb:error';
  // Resolverse una no lo reabre: sigue cerrado (el resultado es igual a lo que hay) y la resuelta sale de lo cerrado.
  assert.equal(keep(dismissed, 'b:error'), 'b:error');
  // Con los mismos números, otra conversación o un cambio de estado sí son nuevos.
  assert.equal(keep(dismissed, 'a:needs_input\nc:error'), 'a:needs_input');
  assert.equal(keep(dismissed, 'a:error\nb:error'), 'b:error');
  // Una que salió y vuelve a pedir atención ya es nueva.
  assert.equal(keep(keep(dismissed, 'b:error'), 'a:needs_input\nb:error'), 'b:error');
  assert.equal(keep(dismissed, ''), '');
  assert.equal(keep('', 'a:needs_input'), '');
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
