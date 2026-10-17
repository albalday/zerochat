const test = require('node:test');
const assert = require('node:assert/strict');
const GenerationController = require('../../js/generation-controller.js');
const State = require('../../js/state.js');

// El envío completo (handleSendMessage) se prueba en tests/browser/browser_generation.test.js.

test('GenerationController.runCancellableTask - marca la conversación ocupada y la libera aunque la tarea falle', async () => {
  await assert.rejects(GenerationController.runCancellableTask(async signal => {
    assert.equal(State.isConversationBusy(), true);
    assert.equal(signal.aborted, false);
    await assert.rejects(GenerationController.runCancellableTask(async () => {}), /already running/);
    throw new Error('task failed');
  }), /task failed/);
  assert.equal(State.isConversationBusy(), false);
  assert.equal(GenerationController.isGenerating(), false);
});

test('GenerationController.runCancellableTask - el botón de parar aborta la señal de la tarea', async () => {
  const aborted = await GenerationController.runCancellableTask(async signal => {
    GenerationController.handleStopGeneration();
    return signal.aborted;
  });
  assert.equal(aborted, true);
});
