const { test } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const RagUI = require('../../js/rag-ui.js');
const Config = require('../../js/config-store.js');
const I18n = require('../../js/i18n.js');
const { installDom } = require('../helpers/dom-env.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Diálogos de conocimiento con el marcado real, sin ramas; `dialogs` sustituye ChatDialogs. */
async function setup(t, dialogs = {}) {
  const dom = installDom({ app: true });
  await RagStorage.clearAllData();
  Config.updateRuntime({ activeRagBranchIds: [] });
  const alerts = [];
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { alert: async message => { alerts.push(message); }, confirm: async () => true, ...dialogs };
  RagUI.ensureDialogMarkup();
  RagUI.initRagUI();
  t.after(() => {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  });
  return { alerts };
}

const $ = id => document.getElementById(id);
async function waitFor(condition) {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await settle();
  assert.ok(condition(), 'La condición no se cumplió a tiempo');
}

test('RagUI - activar y gestionar ramas son diálogos distintos con cabecera de acciones', async t => {
  await setup(t);
  const activation = $('rag-modal');
  const manage = $('rag-manage-modal');
  assert.ok(activation.querySelector('#btn-rag-activate-all'));
  assert.equal(activation.querySelector('h3').dataset.i18n, 'rag_modal_title_activate');
  assert.equal(activation.querySelector('#rag-manage-branch-select'), null);
  assert.ok(manage.querySelector('.rag-branch-combobox #rag-branch-name-input'));
  assert.ok(manage.querySelector('#btn-rag-save-branch'));
  assert.equal(manage.querySelector('#btn-rag-activate-all'), null);
  for (const dialog of [activation, manage]) {
    assert.ok(dialog.querySelector('.modal-header.settings-section-header .settings-header-actions'));
    assert.equal(dialog.querySelector('.modal-footer, [data-rag-tab]'), null);
  }
});

test('RagUI - las ramas activas viven en la configuración y la barra indica cuántas hay', async t => {
  await setup(t);
  const first = await RagStorage.createBranch({ name: 'Manuales', language: 'spanish' });
  const second = await RagStorage.createBranch({ name: 'Informes', language: 'spanish' });

  RagUI.openActivationModal();
  await waitFor(() => document.querySelectorAll('#rag-active-branch-list [data-branch-id]').length === 2);
  const card = id => document.querySelector(`#rag-active-branch-list [data-branch-id="${id}"]`);
  card(first.id).click();
  await waitFor(() => card(first.id).classList.contains('active'));
  assert.deepEqual(Config.getActive().activeRagBranchIds, [first.id]);
  assert.equal($('rag-active-status-title').textContent, 'Manuales');
  assert.ok($('btn-open-rag').classList.contains('active'));

  card(second.id).click();
  await waitFor(() => card(second.id).classList.contains('active'));
  assert.deepEqual(Config.getActive().activeRagBranchIds, [first.id, second.id]);
  assert.equal($('btn-open-rag').title, I18n.t('rag_toolbar_active_multi', { count: 2 }));

  $('btn-rag-toggle-master').click();
  await waitFor(() => !card(first.id).classList.contains('active'));
  assert.deepEqual(Config.getActive().activeRagBranchIds, []);
  assert.equal($('btn-rag-toggle-master').disabled, true);
});

test('RagUI - crear una rama la guarda y la deja abierta; cerrar con cambios pide confirmación', async t => {
  let accept = false;
  await setup(t, { confirm: async () => accept });
  RagUI.openManageModal();
  await waitFor(() => $('rag-manage-branch-select').options.length === 1);
  assert.equal($('btn-rag-save-branch').disabled, true, 'Sin nombre no se guarda');

  $('rag-branch-name-input').value = 'Contratos';
  $('rag-branch-name-input').dispatchEvent(new Event('input'));
  assert.equal($('btn-rag-save-branch').disabled, false);
  $('btn-rag-save-branch').click();
  await waitFor(() => /Contratos/.test($('rag-manage-workspace').textContent));
  const [branch] = await RagStorage.getBranches();
  assert.equal(branch.name, 'Contratos');
  assert.equal($('rag-manage-branch-select').value, branch.id);
  assert.match($('rag-manage-workspace').textContent, /Contratos/);
  assert.equal($('btn-rag-save-branch').disabled, true, 'Recién guardada no hay cambios');

  $('rag-branch-desc-input').value = 'Pendiente';
  $('rag-branch-desc-input').dispatchEvent(new Event('input'));
  $('btn-close-rag-manage').click();
  await settle();
  assert.ok($('rag-manage-modal').open, 'Rechazar la confirmación mantiene el diálogo');
  accept = true;
  $('btn-close-rag-manage').click();
  await waitFor(() => !$('rag-manage-modal').open);
});

test('RagUI - el resumen de la ingesta se traduce y conserva los archivos no indexados', async t => {
  await setup(t);
  const branch = await RagStorage.createBranch({ name: 'Logs', language: 'spanish' });
  RagUI.openManageModal();
  await waitFor(() => $('rag-file-input'));
  const IngestionEngine = require('../../js/ingestionEngine.js');
  const progressTexts = [];
  let result = { total: 2, processed: 1, failed: 1, errors: [{ fileName: 'logs.zip', error: 'El archivo es un ZIP.' }] };
  t.mock.method(IngestionEngine, 'processDocumentQueue', async (files, branchId, onProgress) => {
    onProgress({ fileIndex: 0, fileName: 'a.txt', status: 'saving', detail: {}, percent: 50, totalFiles: 2, finishedFiles: 1, processedFiles: 1, overallPercent: 50 });
    progressTexts.push($('rag-ingestion-progress').textContent);
    return result;
  });
  const drop = () => {
    const input = $('rag-file-input');
    Object.defineProperty(input, 'files', { value: [new File(['texto'], 'a.txt')], configurable: true });
    input.dispatchEvent(new Event('change'));
  };

  drop();
  await waitFor(() => /no indexados/.test($('rag-ingestion-progress')?.textContent || ''));
  assert.match(progressTexts[0], /Guardando a\.txt…/, 'El progreso se redacta en la interfaz con el estado del motor');
  assert.match($('rag-ingestion-progress').textContent, /1 indexados · 1 no indexados/);
  assert.match($('rag-ingestion-progress').textContent, /logs\.zip[\s\S]*El archivo es un ZIP/);

  I18n.setLanguage('en');
  t.after(() => I18n.setLanguage('es'));
  // El cambio de idioma vuelve a dibujar el área de trabajo abierta.
  await waitFor(() => $('rag-dropzone').textContent.includes(I18n.t('rag_dropzone_title')));
  result = { total: 5, processed: 1, replaced: 1, skipped: 1, cancelled: 2, failed: 0 };
  drop();
  await waitFor(() => /Ingestion stopped/.test($('rag-ingestion-progress')?.textContent || ''));
  assert.match($('rag-ingestion-progress').textContent, /Ingestion stopped by user: 2 indexed · 0 not indexed \(1 replaced, 1 skipped, 2 cancelled\)/);
  assert.equal(branch.name, 'Logs');
});
