const test = require('node:test');
const assert = require('node:assert/strict');

const ChatUIConnection = require('../../js/ui-connection.js');
const ChatI18n = require('../../js/i18n.js');

test('UIConnection - un bloqueo por intentos fallidos indica los minutos de espera, redondeados hacia arriba', () => {
  const locked = retryAfter => ChatUIConnection.loginErrorMessage({ rpcError: { code: -32002, data: { retryAfter } } });
  assert.equal(locked(900), ChatI18n.t('login_locked', { minutes: 15 }));
  assert.equal(locked(61), ChatI18n.t('login_locked', { minutes: 2 }));
  assert.equal(locked(1), ChatI18n.t('login_locked', { minutes: 1 }));
  // Cualquier otro fallo (red, servidor) se muestra tal cual.
  assert.equal(ChatUIConnection.loginErrorMessage(new Error('Failed to fetch')), 'Failed to fetch');
});
