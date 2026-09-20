const { test } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const RagUI = require('../../js/rag-ui.js');

test('RagUI - exporta la superficie mínima', () => {
  assert.equal(typeof RagUI.initRagUI, 'function');
  assert.equal(typeof RagUI.updateToolbarStatus, 'function');
  assert.equal(typeof RagUI.renderActiveTab, 'function');
  assert.equal(typeof RagUI.renderManageTab, 'function');
  assert.equal(typeof RagUI.getActiveBranchId, 'function');
  assert.equal(typeof RagUI.setActiveBranchId, 'function');
  assert.equal(typeof RagUI.getActiveBranchIds, 'function');
  assert.equal(typeof RagUI.setActiveBranchIds, 'function');
  assert.equal(typeof RagUI.toggleBranchActive, 'function');
  assert.equal(typeof RagUI.isBranchActive, 'function');
  assert.equal(typeof RagUI.exportBranch, 'function');
  assert.equal(typeof RagUI.importBranchFile, 'function');
  assert.equal(typeof RagUI.ingestionResultMarkup, 'function');
  assert.equal(typeof RagUI.openRagModal, 'function');
});

test('RagUI - genera diálogos separados para activar y gestionar documentos', () => {
  const activationHtml = RagUI.getRagModalHTML('activate');
  const manageHtml = RagUI.getRagModalHTML('manage');

  assert.match(activationHtml, /btn-rag-activate-all/);
  assert.match(activationHtml, /<h3 data-i18n="rag_modal_title_activate">RAG<\/h3>/);
  assert.doesNotMatch(activationHtml, /rag-header-icon/);
  assert.doesNotMatch(activationHtml, /btn-close-rag-footer/);
  assert.doesNotMatch(activationHtml, /class="modal-footer"/);
  assert.doesNotMatch(activationHtml, /rag-manage-branch-select/);
  assert.match(manageHtml, /rag-manage-branch-select/);
  assert.match(manageHtml, /<h3 data-i18n="rag_modal_title_manage">RAG\. Gestionar<\/h3>/);
  assert.doesNotMatch(manageHtml, /rag-header-icon/);
  assert.doesNotMatch(manageHtml, /class="modal-footer"/);
  assert.doesNotMatch(manageHtml, /btn-close-rag-manage-footer/);
  assert.doesNotMatch(manageHtml, /btn-rag-activate-all/);
  assert.doesNotMatch(`${activationHtml}${manageHtml}`, /data-rag-tab|rag-modal-tabs-nav/);
});

test('RagUI - conserva un resumen claro de archivos no indexados', () => {
  const markup = RagUI.ingestionResultMarkup({
    total: 2,
    processed: 1,
    failed: 1,
    errors: [{ fileName: 'logs.zip', error: 'El archivo es un ZIP.' }]
  });
  assert.match(markup, /1 indexados · 1 no indexados/);
  assert.match(markup, /logs\.zip/);
  assert.match(markup, /El archivo es un ZIP/);
});

test('RagUI - gestiona la rama activa y multi-ramas', () => {
  RagUI.setActiveBranchId('branch_test_123');
  assert.equal(RagUI.getActiveBranchId(), 'branch_test_123');
  assert.deepEqual(RagUI.getActiveBranchIds(), ['branch_test_123']);

  RagUI.setActiveBranchIds(['b1', 'b2']);
  assert.deepEqual(RagUI.getActiveBranchIds(), ['b1', 'b2']);
  assert.equal(RagUI.isBranchActive('b1'), true);
  assert.equal(RagUI.isBranchActive('b3'), false);

  RagUI.toggleBranchActive('b3');
  assert.equal(RagUI.isBranchActive('b3'), true);
  RagUI.toggleBranchActive('b1');
  assert.equal(RagUI.isBranchActive('b1'), false);

  RagUI.setActiveBranchId('');
  assert.equal(RagUI.getActiveBranchId(), '');
  assert.deepEqual(RagUI.getActiveBranchIds(), []);
});
