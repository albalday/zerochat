const test = require('node:test');
const assert = require('node:assert/strict');

const CommandCard = require('../../js/command-card.js');
const I18n = require('../../js/i18n.js');

test('ChatCommandCard - parseResult acepta el JSON de run_command y rechaza lo demás', () => {
  const data = { success: true, status: 'running', job_id: 4, output: 'listo\n' };
  assert.deepEqual(CommandCard.parseResult(JSON.stringify(data)), data);
  assert.deepEqual(CommandCard.parseResult({ content: JSON.stringify(data) }), data);
  assert.equal(CommandCard.parseResult('Error MCP (-32602): Argumento no permitido: cwd'), null);
  assert.equal(CommandCard.parseResult(JSON.stringify({ success: false, error: 'x' })), null);
  assert.equal(CommandCard.parseResult(null), null);
  assert.equal(CommandCard.parseResult({ content: [{ type: 'text' }] }), null);
});

test('ChatCommandCard - formatDuration usa segundos, m:ss y h:mm:ss', () => {
  assert.equal(CommandCard.formatDuration(0), '0.0 s');
  assert.equal(CommandCard.formatDuration(3.25), '3.3 s');
  assert.equal(CommandCard.formatDuration(42.9), '42 s');
  assert.equal(CommandCard.formatDuration(65), '1:05');
  assert.equal(CommandCard.formatDuration(3725), '1:02:05');
  assert.equal(CommandCard.formatDuration(-4), '0.0 s');
  assert.equal(CommandCard.formatDuration('x'), '0.0 s');
});

test('ChatCommandCard - la insignia distingue cada estado del comando', () => {
  const now = 1_000_000;
  const view = state => CommandCard.getBadgeView({ elapsed: 2, startedAt: now - 12_000, exitCode: null, ...state }, now);
  // El reloj de un comando en marcha cuenta desde su inicio; el de uno terminado es su duración.
  assert.deepEqual(view({ status: 'running' }), { className: 'status-loading', icon: 'spinner', text: I18n.t('command_status_running', { time: '12 s' }) });
  assert.equal(view({ status: 'running', toolReturned: true }).text, I18n.t('command_status_background', { time: '12 s' }));
  assert.equal(view({ status: 'exited', exitCode: 0 }).className, 'status-success');
  assert.equal(view({ status: 'exited', exitCode: 0 }).text, I18n.t('command_status_done', { time: '2.0 s' }));
  assert.equal(view({ status: 'exited', exitCode: 2 }).className, 'status-error');
  assert.equal(view({ status: 'exited', exitCode: 2 }).text, I18n.t('command_status_exit_code', { code: 2, time: '2.0 s' }));
  assert.equal(view({ status: 'timeout' }).text, I18n.t('command_status_timeout', { time: '2.0 s' }));
  assert.equal(view({ status: 'stopped' }).className, 'status-stopped');
  assert.equal(view({ status: 'error' }).text, I18n.t('command_status_failed'));
  assert.equal(view({ status: 'unavailable' }).text, I18n.t('command_status_unavailable'));
});

test('ChatCommandCard - reactivate reposiciona al final de messages-list si la tarjeta está en el chat', t => {
  const { installDom } = require('../helpers/dom-env.js');
  const UIConversation = require('../../js/ui-conversation.js');
  const dom = installDom({ app: true });
  t.after(() => dom.restore());

  const messagesList = document.getElementById('messages-list');
  const view = CommandCard.createView();
  const card = view.createLiveCard({ command: 'npm run test' }, {
    createCardWrapper() {
      const el = document.createElement('div');
      el.className = 'tool-card-wrapper command-card-wrapper';
      return el;
    }
  });
  messagesList.appendChild(card);

  let scrolled = false;
  const originalScrollToBottom = UIConversation.scrollToBottom;
  UIConversation.scrollToBottom = container => {
    if (container === messagesList) scrolled = true;
  };
  t.after(() => { UIConversation.scrollToBottom = originalScrollToBottom; });

  view.updateLiveCard(card, { command: 'npm run test' }, { content: JSON.stringify({ status: 'running', job_id: 10, output: 'ok' }) });

  return new Promise(resolve => {
    setTimeout(() => {
      assert.equal(scrolled, true, 'reactivate debe invocar scrollToBottom en messages-list');
      view.updateLiveCard(card, { command: 'npm run test' }, { content: JSON.stringify({ status: 'exited', exit_code: 0, output: 'ok' }) });
      card.remove();
      resolve();
    }, 10);
  });
});

