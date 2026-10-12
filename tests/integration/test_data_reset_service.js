const { test } = require('node:test');
const assert = require('node:assert/strict');
const DataResetService = require('../../js/data-reset-service.js');
const Storage = require('../../js/cookies.js');
const GenerationController = require('../../js/generation-controller.js');
const I18n = require('../../js/i18n.js');
const { installDom } = require('../helpers/dom-env.js');

/** Página real con los diálogos sustituidos; la recarga y la parada se registran. */
function setup(t, { accept = true, cleared = true } = {}) {
  const dom = installDom();
  const calls = [];
  const alerts = [];
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { confirm: async () => accept, alert: async message => { alerts.push(message); } };
  t.mock.method(dom.window.location, 'reload', () => calls.push('reload'));
  t.mock.method(GenerationController, 'handleStopGeneration', () => calls.push('stop'));
  t.mock.method(Storage, 'clearAllStorage', async () => { calls.push('clear'); return cleared; });
  t.mock.method(Storage, 'getLastClearAllStorageError', () => 'IndexedDB blocked');
  t.after(() => {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  });
  return { calls, alerts };
}

test('DataResetService - tras confirmar detiene la generación, borra los datos y recarga', async t => {
  const { calls, alerts } = setup(t);
  assert.deepEqual(await DataResetService.resetAllData(), { confirmed: true, success: true });
  assert.deepEqual(calls, ['stop', 'clear', 'reload']);
  assert.deepEqual(alerts, []);
});

test('DataResetService - cancelar no toca nada', async t => {
  const { calls } = setup(t, { accept: false });
  assert.deepEqual(await DataResetService.resetAllData(), { confirmed: false, success: false });
  assert.deepEqual(calls, []);
});

test('DataResetService - si el borrado falla avisa con el motivo y no recarga', async t => {
  const { calls, alerts } = setup(t, { cleared: false });
  const result = await DataResetService.resetAllData();
  assert.deepEqual(result, { confirmed: true, success: false, error: 'IndexedDB blocked' });
  assert.deepEqual(calls, ['stop', 'clear']);
  assert.deepEqual(alerts, [I18n.t('clear_all_data_failed_detail', { detail: 'IndexedDB blocked' })]);
});
