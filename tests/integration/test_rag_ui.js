const { test } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const RagUI = require('../../js/rag-ui.js');
const I18n = require('../../js/i18n.js');

test('RagUI - genera diálogos separados para activar y gestionar documentos', () => {
  const activationHtml = RagUI.getRagActivationModalHTML();
  const manageHtml = RagUI.getRagManageModalHTML();

  assert.match(activationHtml, /btn-rag-activate-all/);
  assert.match(activationHtml, /<h3 data-i18n="rag_modal_title_activate">RAG<\/h3>/);
  assert.match(activationHtml, /class="modal-header settings-section-header"/);
  assert.match(activationHtml, /class="settings-header-actions"/);
  assert.doesNotMatch(activationHtml, /class="modal-footer"/);
  assert.doesNotMatch(activationHtml, /rag-manage-branch-select/);
  assert.match(manageHtml, /rag-manage-branch-select/);
  assert.match(manageHtml, /rag-branch-combobox/);
  assert.match(manageHtml, /rag-branch-name-input/);
  assert.match(manageHtml, /btn-rag-save-branch/);
  assert.match(manageHtml, /<h3 data-i18n="rag_modal_title_manage">RAG-Ramas<\/h3>/);
  assert.match(manageHtml, /class="modal-header settings-section-header"/);
  assert.match(manageHtml, /class="settings-header-actions"/);
  assert.doesNotMatch(manageHtml, /class="modal-footer"/);
  assert.doesNotMatch(manageHtml, /btn-rag-activate-all/);
  assert.doesNotMatch(`${activationHtml}${manageHtml}`, /data-rag-tab|rag-modal-tabs-nav/);
});

function withI18n(lang, fn) {
  const previousWindow = globalThis.window;
  globalThis.window = { ChatI18n: I18n };
  I18n.setLanguage(lang, false);
  try {
    return fn();
  } finally {
    I18n.setLanguage('es', false);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test('RagUI - conserva un resumen claro de archivos no indexados', () => {
  const markup = withI18n('es', () => RagUI.ingestionResultMarkup({
    total: 2,
    processed: 1,
    failed: 1,
    errors: [{ fileName: 'logs.zip', error: 'El archivo es un ZIP.' }]
  }));
  assert.match(markup, /1 indexados · 1 no indexados/);
  assert.match(markup, /logs\.zip/);
  assert.match(markup, /El archivo es un ZIP/);
});

test('RagUI - el resumen de ingesta detenida se traduce al idioma activo', () => {
  const result = { total: 5, processed: 1, replaced: 1, skipped: 1, cancelled: 2, failed: 0 };
  const es = withI18n('es', () => RagUI.ingestionResultMarkup(result));
  const en = withI18n('en', () => RagUI.ingestionResultMarkup(result));
  assert.match(es, /Ingesta detenida por el usuario: 2 indexados · 0 no indexados \(1 reemplazados, 1 omitidos, 2 cancelados\)/);
  assert.match(en, /Ingestion stopped by user: 2 indexed · 0 not indexed \(1 replaced, 1 skipped, 2 cancelled\)/);
  assert.doesNotMatch(en, /indexados|reemplazados|omitidos|cancelados|detenida/);
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
