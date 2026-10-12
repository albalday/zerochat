const test = require('node:test');
const assert = require('node:assert/strict');
const ChatDebug = require('../../js/debug.js');
const I18n = require('../../js/i18n.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

function setup(t) {
  const dom = installDom({ app: true });
  ChatDebug.ensureDialogMarkup();
  const elements = getAppElements(document);
  ChatDebug.setElements(elements);
  ChatDebug.clearLogs();
  ChatDebug.filterLogs('all');
  t.after(() => dom.restore());
  return elements;
}

const entries = elements => [...elements.debugLogContent.querySelectorAll('.debug-entry')];

test('ChatDebug - acumula el razonamiento en un bloque y oculta lo crudo fuera de su pestaña', t => {
  const elements = setup(t);
  ChatDebug.addLog('thinking', 'Pienso ');
  ChatDebug.addLog('thinking', 'despacio');
  ChatDebug.addLog('network', 'POST <url>');
  ChatDebug.addLog('raw', '>>> payload');
  const [cleared, thinking, network, raw] = entries(elements);
  assert.equal(cleared.dataset.type, 'system');
  assert.equal(thinking.querySelector('.debug-msg').textContent, 'Pienso despacio');
  assert.equal(network.querySelector('.debug-msg').textContent, 'POST <url>', 'Los mensajes se muestran como texto');
  assert.match(network.querySelector('.debug-time').textContent, /^\[\d{1,2}:\d{2}:\d{2}\]$/);
  assert.ok(raw.classList.contains('raw-outgoing'));
  assert.equal(raw.hidden, true);

  ChatDebug.filterLogs('raw');
  assert.deepEqual(entries(elements).map(entry => entry.hidden), [true, true, true, false]);
  ChatDebug.setRawLogsEnabled(false);
  ChatDebug.addLog('raw', 'ignorado');
  ChatDebug.setRawLogsEnabled(true);
  assert.equal(entries(elements).length, 4);
});

test('ChatDebug - el panel, el estado y el interceptor de mensajes', async t => {
  const elements = setup(t);
  ChatDebug.togglePanel(true);
  assert.equal(elements.debugPanel.hidden, false);
  assert.equal(elements.btnToggleDebug.getAttribute('aria-expanded'), 'true');
  ChatDebug.togglePanel();
  assert.equal(elements.debugPanel.hidden, true);

  ChatDebug.setStatus('streaming');
  assert.equal(elements.debugStatusIndicator.textContent, I18n.t('debug_status_streaming'));
  ChatDebug.setStatus('error', 'Fallo');
  assert.equal(elements.debugStatusIndicator.className, 'debug-status-indicator error');
  assert.equal(elements.debugStatusIndicator.textContent, 'Fallo');

  let synced = null;
  const pending = ChatDebug.openInterceptorModal({ endpoint: 'http://x/v1', payload: { a: 1 }, onSyncDebugState: value => { synced = value; } });
  assert.ok(elements.debugInterceptorDialog.open);
  assert.equal(elements.debugModalEndpointBadge.textContent, 'POST http://x/v1');
  elements.txtDebugPayload.value = '{ roto';
  elements.btnDebugSend.click();
  assert.equal(elements.debugJsonError.hidden, false, 'Un JSON inválido no se envía');
  elements.txtDebugPayload.value = '{"a":2}';
  elements.btnDebugSendDisable.click();
  assert.deepEqual(await pending, { cancel: false, modifiedPayload: { a: 2 } });
  assert.equal(synced, false);
  assert.equal(elements.debugInterceptorDialog.open, false);

  const cancelled = ChatDebug.openInterceptorModal({ endpoint: 'http://x/v1', payload: {}, onSyncDebugState: () => {} });
  elements.btnCloseDebugModal.click();
  assert.deepEqual(await cancelled, { cancel: true });
});
