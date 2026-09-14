const { test } = require('node:test');
const assert = require('node:assert/strict');
const DataResetService = require('../js/data-reset-service.js');

test('DataResetService - aborts active controller when resetting', async () => {
  let aborted = false;
  const mockAbortController = {
    abort: () => { aborted = true; }
  };

  const result = await DataResetService.resetAllData({
    abortController: mockAbortController,
    skipConfirm: true,
    reload: false
  });

  assert.equal(aborted, true, 'Debe llamar a abort() en el AbortController activo');
  assert.equal(result.confirmed, true);
});

test('DataResetService - invokes abort callback function when provided', async () => {
  let called = false;
  const abortFn = () => { called = true; };

  const result = await DataResetService.resetAllData({
    abortController: abortFn,
    skipConfirm: true,
    reload: false
  });

  assert.equal(called, true, 'Debe invocar la función de parada si es una función');
  assert.equal(result.confirmed, true);
});

test('DataResetService - respects cancellation if user rejects confirmation', async () => {
  // En entorno Node.js sin ChatDialogs, requestResetConfirmation retorna true por fallback
  // pero si pasamos skipConfirm: false con Dialogs mockeado podemos probar el rechazo
  const originalDialogs = global.ChatDialogs;
  global.ChatDialogs = {
    confirm: async () => false
  };

  try {
    let aborted = false;
    const result = await DataResetService.resetAllData({
      abortController: { abort: () => { aborted = true; } },
      skipConfirm: false,
      reload: false
    });

    assert.equal(result.confirmed, false);
    assert.equal(result.success, false);
    assert.equal(aborted, false, 'No debe abortar si el usuario canceló la confirmación');
  } finally {
    global.ChatDialogs = originalDialogs;
  }
});

test('DataResetService - invokes onComplete with reset outcome', async () => {
  let completedData = null;
  const result = await DataResetService.resetAllData({
    skipConfirm: true,
    reload: false,
    onComplete: (data) => { completedData = data; }
  });

  assert.notEqual(completedData, null);
  assert.equal(typeof completedData.success, 'boolean');
});
