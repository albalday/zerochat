const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../../js/ragStorage.js');
const RagIndex = require('../../js/rag-index.js');

beforeEach(async () => {
  RagIndex.clearCache();
  await RagStorage.clearAllData();
});

test('RagIndex - indexa y busca chunks con Orama', async () => {
  const branch = await RagStorage.createBranch('Hardware');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'placa-base.md',
    fileType: 'md',
    chunks: [
      { title: 'Memoria', content: 'La placa admite memoria DDR3 a 1600 MHz.' },
      { title: 'Procesador', content: 'El socket LGA1155 acepta procesadores Intel.' }
    ]
  });

  const result = await RagIndex.searchBranch(branch.id, 'memoria DDR3', { tolerance: 0 });
  assert.ok(result.count >= 1);
  assert.equal(result.hits[0].documentTitle, 'placa-base.md');
  assert.equal(result.hits[0].sectionTitle, 'Memoria');
});

test('RagIndex - aísla ramas y reconstruye tras invalidar', async () => {
  const first = await RagStorage.createBranch('Primera');
  const second = await RagStorage.createBranch('Segunda');
  await RagStorage.saveDocument({ branchId: first.id, title: 'uno.txt', chunks: [{ content: 'kubernetes ingress controller' }] });
  await RagStorage.saveDocument({ branchId: second.id, title: 'dos.txt', chunks: [{ content: 'receta de paella valenciana' }] });

  assert.equal((await RagIndex.searchBranch(first.id, 'paella', { tolerance: 0 })).count, 0);
  RagIndex.invalidateBranch(second.id);
  assert.equal((await RagIndex.searchBranch(second.id, 'paella', { tolerance: 0 })).hits[0].documentTitle, 'dos.txt');
});

test('RagIndex - busca federadamente entre múltiples ramas', async () => {
  const dev = await RagStorage.createBranch('Logs-Dispositivo-1');
  const prod = await RagStorage.createBranch('Logs-Dispositivo-2');
  await RagStorage.saveDocument({ branchId: dev.id, title: 'dev.log', chunks: [{ title: 'Error 500', content: 'Database timeout connection error on node 1' }] });
  await RagStorage.saveDocument({ branchId: prod.id, title: 'prod.log', chunks: [{ title: 'Warning', content: 'Database high memory usage warning on node 2' }] });

  const result = await RagIndex.searchBranches([dev.id, prod.id], 'database', { tolerance: 0 });
  assert.equal(result.count, 2);
  assert.equal(result.hits.length, 2);
  const branchIds = result.hits.map(h => h.branchId);
  assert.ok(branchIds.includes(dev.id));
  assert.ok(branchIds.includes(prod.id));
});

test('RagIndex - evita falsos positivos en tokens cortos (3M no coincide con TM) y prioriza boost de título', async () => {
  const branch = await RagStorage.createBranch('Finance');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'ADOBE_2018_10K.pdf',
    chunks: [
      { title: 'Statement', content: 'Adobe 2018 cash flows capital expenditures TM trademark registered' }
    ]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: '3M_2018_10K.pdf',
    chunks: [
      { title: 'Cash Flows', content: 'Purchases of property, plant and equipment 1577 million dollars in 2018' }
    ]
  });

  // 1. "3M" no debe coincidir con "TM" de Adobe por tolerancia difusa
  const res3M = await RagIndex.searchBranch(branch.id, '3M');
  assert.equal(res3M.count, 1);
  assert.equal(res3M.hits[0].documentTitle, '3M_2018_10K.pdf');

  // 2. Query compleja con nombre de archivo, comillas y operadores booleanos
  const resComplex = await RagIndex.searchBranch(branch.id, '3M_2018_10K.pdf "Cash Flows" "Capital expenditures" OR "Purchases"');
  assert.ok(resComplex.count >= 1);
  assert.equal(resComplex.hits[0].documentTitle, '3M_2018_10K.pdf');
});

test('RagIndex - construye un índice perezoso limitado a un documento', async () => {
  const branch = await RagStorage.createBranch('Catálogo');
  const alpha = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Product_Alpha_datasheet.pdf',
    chunks: [
      { title: 'Battery', content: 'Battery runtime is twelve hours.' },
      { title: 'Charging', content: 'Battery charging uses USB-C.' }
    ]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Product_Beta_datasheet.pdf',
    chunks: [{ title: 'Battery', content: 'Battery runtime is eight hours.' }]
  });

  const result = await RagIndex.searchDocuments(branch.id, [alpha.id], 'battery runtime', { tolerance: 0, limit: 10 });
  assert.ok(result.hits.length >= 1);
  assert.ok(result.hits.every(hit => hit.documentId === alpha.id));
  assert.ok(result.hits.every(hit => hit.documentTitle === 'Product_Alpha_datasheet.pdf'));
});
