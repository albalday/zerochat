const { test } = require('node:test');
const assert = require('node:assert/strict');
const UITransfer = require('../../js/ui-transfer.js');
const Export = require('../../js/export.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Diálogo de exportación real con dos conversaciones: la activa en memoria y otra guardada. */
function setup(t, overrides = {}) {
  const dom = installDom({ app: true });
  Export.ensureDialogMarkup();
  const elements = getAppElements(document);
  const downloads = [];
  t.mock.method(Export, 'downloadFile', (content, filename, mimeType) => { downloads.push({ content, filename, mimeType }); return true; });
  const alerts = [];
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { alert: async message => { alerts.push(message); } };
  const imported = [];
  UITransfer.mount({
    elements,
    getActiveSessionId: () => 'active',
    getSavedSessions: () => [{ id: 'active', title: 'Activa' }],
    getHistory: () => [{ role: 'user', content: 'Hola activa' }],
    getSession: async id => ({ id, title: 'Guardada', history: [{ role: 'user', content: 'Hola guardada' }] }),
    getConfig: () => ({ model: 'gpt-4o', apiUrl: 'http://localhost:1234/v1', apiType: 'openai' }),
    onSwitchSession: async () => {},
    onImportSuccess: async session => { imported.push(session); },
    isBusy: () => false,
    ...overrides
  });
  t.after(() => {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  });
  return { elements, downloads, alerts, imported };
}

function selectFile(input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

test('UITransfer - exporta en Markdown la conversación activa y en JSON otra guardada', async t => {
  const { elements, downloads } = setup(t);
  UITransfer.openExportModal();
  assert.ok(elements.exportModal.open);
  elements.btnExportMarkdown.click();
  await settle();
  assert.match(downloads[0].filename, /^Activa_\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(downloads[0].content, /# Activa[\s\S]*gpt-4o[\s\S]*Hola activa/);
  assert.equal(elements.exportModal.open, false);

  UITransfer.openExportModal('saved');
  elements.btnExportJson.click();
  await settle();
  const exported = JSON.parse(downloads[1].content);
  assert.equal(downloads[1].mimeType, 'application/json');
  assert.equal(exported.session.title, 'Guardada');
  assert.deepEqual(exported.session.history, [{ role: 'user', content: 'Hola guardada' }]);
  assert.equal(elements.exportModal.dataset.sessionId, undefined, 'Cerrar olvida la conversación elegida');
});

test('UITransfer - importa un JSON exportado y rechaza archivos inválidos o demasiado grandes', async t => {
  const { elements, alerts, imported } = setup(t);
  const json = Export.buildJsonExport({ id: 'x', title: 'Copia' }, [{ role: 'user', content: 'Hola' }], { model: 'm', apiUrl: 'u', apiType: 'openai' });
  selectFile(elements.importJsonInput, new File([json], 'copia.json', { type: 'application/json' }));
  await settle();
  assert.equal(imported[0].title, 'Copia');
  assert.notEqual(imported[0].id, 'x', 'La conversación importada recibe un id nuevo');
  assert.equal(elements.importJsonInput.value, '');

  selectFile(elements.importJsonInput, new File(['{"invalido":true}'], 'mal.json'));
  await settle();
  assert.match(alerts[0], /valid chat history/);

  const huge = new File(['x'], 'enorme.json');
  Object.defineProperty(huge, 'size', { value: 1024 * 1024 * 1024 });
  selectFile(elements.importJsonInput, huge);
  await settle();
  assert.match(alerts[1], /enorme\.json/);
  assert.equal(imported.length, 1);
});

test('UITransfer - no importa mientras hay una generación en curso', async t => {
  const { elements, imported } = setup(t, { isBusy: () => true });
  selectFile(elements.importJsonInput, new File(['{}'], 'chat.json'));
  await settle();
  assert.equal(imported.length, 0);
});
