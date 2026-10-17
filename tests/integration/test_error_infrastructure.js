const test = require('node:test');
const assert = require('node:assert');
const ChatRagService = require('../../js/rag-service.js');

test('Error Infrastructure - buildRagSystemContext degrada a texto vacío ante fallo sin lanzar', async () => {
  const origWarn = console.warn;
  let warnCalled = false;
  console.warn = () => { warnCalled = true; };
  try {
    const result = await ChatRagService.buildRagSystemContext(['invalid_branch_id_test']);
    assert.equal(result, '');
    assert.equal(warnCalled, true, 'buildRagSystemContext debe emitir advertencia ante fallo');
  } finally {
    console.warn = origWarn;
  }
});
