const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RagStorage = require('../js/ragStorage.js');
const RagIndex = require('../js/rag-index.js');
const RagService = require('../js/rag-service.js');

beforeEach(async () => { RagIndex.clearCache(); await RagStorage.clearAllData(); });

async function seed() {
  const branch = await RagStorage.createBranch('Operaciones', 'Procedimientos internos');
  const document = await RagStorage.saveDocument({
    branchId: branch.id, title: 'servidores.md', fileType: 'md',
    chunks: [
      { title: 'Despliegue', content: 'El despliegue de Kubernetes utiliza Helm y el namespace producción.' },
      { title: 'Copias', content: 'Las copias PostgreSQL se ejecutan cada noche a las 02:00.' }
    ]
  });
  return { branch, document };
}

test('RagService - inyecta solo instrucciones compactas', async () => {
  const { branch } = await seed();
  const context = await RagService.buildRagSystemContext(branch.id);
  assert.match(context, /Operaciones/);
  assert.match(context, /search_knowledge_base/);
  assert.match(context, /list_documents/);
  assert.match(context, /read_knowledge_image/);
  assert.match(context, /native vision/);
  assert.match(context, /scope="corpus" for comparisons, multiple documents, companies, or years/);
  assert.match(context, /Do not repeat the same query with different documentHint values/);
  assert.match(context, /scope="auto" only when neither intent is clear/);
  assert.doesNotMatch(context, /Kubernetes|PostgreSQL/);
  assert.match(await RagService.injectRagContext('Responde brevemente.', branch.id), /Responde brevemente/);
});

test('RagService - lista, busca y lee chunks', async () => {
  const { branch, document } = await seed();
  const list = await RagService.listDocuments(branch.id);
  assert.equal(list.count, 1);
  assert.equal(list.documents[0].id, document.id);

  const search = await RagService.searchKnowledgeBase(branch.id, { query: 'copias PostgreSQL', tolerance: 0 });
  assert.ok(search.matchesCount >= 1);
  assert.match(search.text, /chunkId/);
  const chunkId = search.matches[0].chunkId;
  const read = await RagService.readKnowledgeChunk(branch.id, { chunkId });
  assert.equal(read.success, true);
  assert.match(read.content, /PostgreSQL/);
  assert.equal(read.totalChunks, 2);
  assert.equal(read.order, 1);
  assert.equal(read.prevChunkId, `${document.id}:chunk:0`);
  assert.equal(read.nextChunkId, null);
});

test('RagService - lee múltiples fragmentos simultáneamente con metadatos de continuidad', async () => {
  const { branch, document } = await seed();
  const id0 = `${document.id}:chunk:0`;
  const id1 = `${document.id}:chunk:1`;

  // Lectura múltiple mediante array chunkIds
  const multiRead = await RagService.readKnowledgeChunk(branch.id, { chunkIds: [id0, id1] });
  assert.equal(multiRead.success, true);
  assert.equal(multiRead.count, 2);
  assert.equal(multiRead.items.length, 2);
  assert.equal(multiRead.items[0].order, 0);
  assert.equal(multiRead.items[0].prevChunkId, null);
  assert.equal(multiRead.items[0].nextChunkId, id1);
  assert.equal(multiRead.items[1].order, 1);
  assert.equal(multiRead.items[1].prevChunkId, id0);
  assert.equal(multiRead.items[1].nextChunkId, null);
  assert.match(multiRead.content, /Kubernetes/);
  assert.match(multiRead.content, /PostgreSQL/);

  // Lectura con string separado por comas
  const commaRead = await RagService.readKnowledgeChunk(branch.id, { chunkIds: `${id0}, ${id1}` });
  assert.equal(commaRead.success, true);
  assert.equal(commaRead.count, 2);
});

test('RagService - search_knowledge_base preserva saltos de línea y estructura de tablas en snippets', async () => {
  const branch = await RagStorage.createBranch('Finanzas', 'Informes 10-K');
  const tableContent = [
    'Consolidated Statements of Income',
    'Fiscal Years Ended January 31, 2020 | 2019 | 2018',
    'Total revenues: 523964 | 514405 | 500343',
    'Operating income: 20568 | 21957 | 20437'
  ].join('\n');

  await RagStorage.saveDocument({
    branchId: branch.id, title: 'WMT_2020_10K.pdf', fileType: 'pdf',
    chunks: [{ title: 'P&L Statement', content: tableContent }]
  });

  const search = await RagService.searchKnowledgeBase(branch.id, { query: 'Operating income', tolerance: 0 });
  assert.equal(search.success, true);
  assert.ok(search.matches.length >= 1);
  const snippet = search.matches[0].snippet;
  assert.ok(snippet.includes('\n'), 'El snippet debe preservar los saltos de línea de la tabla');
  assert.match(snippet, /Total revenues: 523964/);
  assert.match(snippet, /Operating income: 20568/);
});

test('RagService - valida rama, consulta y chunk', async () => {
  assert.equal((await RagService.listDocuments('')).success, false);
  assert.equal((await RagService.searchKnowledgeBase('', { query: '' })).success, false);
  assert.equal((await RagService.readKnowledgeChunk('', {})).success, false);
});

test('RagService - impide leer chunks de una rama distinta', async () => {
  const { branch } = await seed();
  const foreign = await RagStorage.createBranch('Otra rama');
  const search = await RagService.searchKnowledgeBase(branch.id, { query: 'Kubernetes', tolerance: 0 });
  const read = await RagService.readKnowledgeChunk(foreign.id, { chunkId: search.matches[0].chunkId });
  assert.equal(read.success, false);
  assert.match(read.error, /ramas activas/);
});

test('RagService - recupera una imagen solo desde una rama activa', async () => {
  const { branch } = await seed();
  const document = await RagStorage.saveDocument({
    branchId: branch.id, title: 'diagrama.md', fileType: 'md',
    chunks: [{ content: '![Diagrama](rag-image://__DOC_ID__:img_1)' }]
  }, [{ id: 'img_1', page: 2, label: 'Diagrama', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }]);

  const result = await RagService.readKnowledgeImage(branch.id, { imageRef: `rag-image://${document.id}:img_1` });
  assert.equal(result.success, true);
  assert.equal(result.documentTitle, 'diagrama.md');
  assert.equal(result.page, 2);
  assert.equal(result.dataUrl, 'data:image/png;base64,AA==');

  const foreign = await RagStorage.createBranch('Ajena');
  const rejected = await RagService.readKnowledgeImage(foreign.id, { imageRef: result.imageRef });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /ramas activas/);
});

test('RagService - valida referencias e imágenes inexistentes', async () => {
  const { branch, document } = await seed();
  const invalid = await RagService.readKnowledgeImage(branch.id, { imageRef: 'imagen.png' });
  assert.equal(invalid.success, false);
  assert.match(invalid.error, /imageRef/);

  const missing = await RagService.readKnowledgeImage(branch.id, { imageRef: `rag-image://${document.id}:img_404` });
  assert.equal(missing.success, false);
  assert.match(missing.error, /No existe/);
});

test('RagService - soporta múltiples ramas activas simultáneamente', async () => {
  const { branch: b1 } = await seed();
  const b2 = await RagStorage.createBranch('Redes', 'Configuración de red');
  await RagStorage.saveDocument({
    branchId: b2.id, title: 'firewall.md', fileType: 'md',
    chunks: [
      { title: 'Puertos', content: 'El puerto 443 HTTPS y el puerto 22 SSH están abiertos.' }
    ]
  });

  const context = await RagService.buildRagSystemContext([b1.id, b2.id]);
  assert.match(context, /ACTIVE KNOWLEDGE BASES/);
  assert.match(context, /Operaciones/);
  assert.match(context, /Redes/);

  const list = await RagService.listDocuments([b1.id, b2.id]);
  assert.equal(list.count, 2);
  assert.match(list.text, /DOCUMENTS IN Operaciones/);
  assert.match(list.text, /DOCUMENTS IN Redes/);

  const search = await RagService.searchKnowledgeBase([b1.id, b2.id], { query: 'puerto SSH', tolerance: 0 });
  assert.ok(search.matchesCount >= 1);
  assert.match(search.text, /Branch: Redes/);
  const chunkId = search.matches[0].chunkId;

  const read = await RagService.readKnowledgeChunk([b1.id, b2.id], { chunkId });
  assert.equal(read.success, true);
  assert.match(read.content, /puerto 443/);
});

test('RagService - focaliza una fuente identificable sin contaminar con otros documentos', async () => {
  const branch = await RagStorage.createBranch('Catálogo de productos');
  const alpha = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Product_Alpha_datasheet.pdf',
    chunks: [
      { title: 'Battery', content: 'Battery runtime is twelve hours.' },
      { title: 'Charging', content: 'The battery uses a USB-C charging port.' }
    ]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Product_Beta_datasheet.pdf',
    chunks: [{ title: 'Battery', content: 'Battery runtime is eight hours.' }]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'What is the battery runtime?',
    scope: 'document',
    documentHint: 'Product Alpha',
    tolerance: 0
  });

  assert.equal(result.success, true);
  assert.equal(result.requestedScope, 'document');
  assert.equal(result.appliedScope, 'document');
  assert.equal(result.selectedDocument.documentId, alpha.id);
  assert.ok(result.matches.length >= 1);
  assert.ok(result.matches.every(match => match.documentId === alpha.id));
  assert.match(result.text, /Applied scope: document/);
});

test('RagService - scope auto resuelve empresa y ejercicio desde títulos FinanceBench', async () => {
  const branch = await RagStorage.createBranch('FinanceBench');
  const target = await RagStorage.saveDocument({
    branchId: branch.id,
    title: '3M_2018_10K.pdf',
    chunks: [{ title: 'Cash Flows', content: 'Purchases of property plant and equipment were 1577 million dollars.' }]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'ADOBE_2017_10K.pdf',
    chunks: [{ title: 'Capitalization', content: 'Cash flows and capital expenditure discussion.' }]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: '3M FY2018 cash flow statement capital expenditure',
    scope: 'auto',
    documentHint: '3M',
    tolerance: 0
  });

  assert.equal(result.appliedScope, 'document');
  assert.equal(result.selectedDocument.documentId, target.id);
  assert.ok(result.matches.every(match => match.documentId === target.id));
});

test('RagService - documentHint resuelve exactamente sin contaminarse por años en la consulta', async () => {
  const branch = await RagStorage.createBranch('WalmartFinance');
  const w2018 = await RagStorage.saveDocument({
    branchId: branch.id, title: 'WALMART_2018_10K.pdf',
    chunks: [{ title: 'P&L 2018', content: 'Operating income 2018 was 20437.' }]
  });
  const w2019 = await RagStorage.saveDocument({
    branchId: branch.id, title: 'WALMART_2019_10K.pdf',
    chunks: [{ title: 'P&L 2019', content: 'Operating income 2019 was 21957.' }]
  });
  const w2020 = await RagStorage.saveDocument({
    branchId: branch.id, title: 'WALMART_2020_10K.pdf',
    chunks: [{ title: 'P&L 2020', content: 'Operating income 2020 was 20568. 2019 was 21957. 2018 was 20437.' }]
  });
  await RagStorage.saveDocument({
    branchId: branch.id, title: 'PG_E_2023Q3_10Q.pdf',
    chunks: [{ title: 'Instruments', content: 'Operating income revenues 2020 2019 2018.' }]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'Consolidated Statements of Income Revenues Operating income Fiscal Year Ended January 31 2020 2019 2018',
    scope: 'document',
    documentHint: 'WALMART_2020_10K.pdf',
    tolerance: 0
  });

  assert.equal(result.success, true);
  assert.equal(result.requestedScope, 'document');
  assert.equal(result.appliedScope, 'document');
  assert.equal(result.selectedDocument.documentId, w2020.id);
  assert.ok(result.matches.length >= 1);
  assert.ok(result.matches.every(match => match.documentId === w2020.id));
});

test('RagService - usa corpus ante una referencia documental ambigua', async () => {
  const branch = await RagStorage.createBranch('Manuales');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Product_Alpha_manual.pdf',
    chunks: [{ content: 'Alpha wireless connection setup procedure.' }]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Product_Alpha_accessories.pdf',
    chunks: [{ content: 'Alpha wireless accessories and connection options.' }]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'Alpha wireless connection',
    scope: 'document',
    documentHint: 'Product Alpha',
    tolerance: 0
  });

  assert.equal(result.requestedScope, 'document');
  assert.equal(result.appliedScope, 'corpus');
  assert.equal(result.selectedDocument, null);
  assert.equal(new Set(result.matches.map(match => match.documentId)).size, 2);
  assert.match(result.text, /Document candidates/);
});

test('RagService - no focaliza arbitrariamente títulos idénticos', async () => {
  const branch = await RagStorage.createBranch('Duplicados');
  const duplicates = [];
  for (const content of ['First raven evidence.', 'Second raven evidence.']) {
    duplicates.push(await RagStorage.saveDocument({
      branchId: branch.id,
      title: 'Raven_2024.pdf',
      chunks: [{ content }]
    }));
  }
  for (let index = 0; index < 18; index += 1) {
    await RagStorage.saveDocument({
      branchId: branch.id,
      title: `Other_${index}.pdf`,
      chunks: [{ content: `Unrelated reference ${index}.` }]
    });
  }

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'Raven_2024.pdf',
    scope: 'auto',
    tolerance: 0
  });

  assert.equal(result.appliedScope, 'corpus');
  assert.equal(result.selectedDocument, null);
  assert.deepEqual(
    new Set(result.matches.map(match => match.documentId)),
    new Set(duplicates.map(document => document.id))
  );
});

test('RagService - diversifica una consulta transversal entre documentos', async () => {
  const branch = await RagStorage.createBranch('Comparador');
  const documentIds = [];
  for (const product of ['Alpha', 'Beta', 'Gamma']) {
    const document = await RagStorage.saveDocument({
      branchId: branch.id,
      title: `Product_${product}_datasheet.pdf`,
      chunks: [
        { title: 'Battery', content: `${product} battery runtime specification.` },
        { title: 'Charging', content: `${product} battery charging specification.` },
        { title: 'Power', content: `${product} battery power specification.` }
      ]
    });
    documentIds.push(document.id);
  }

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'Compare battery specification',
    scope: 'corpus',
    limit: 6,
    tolerance: 0
  });

  assert.equal(result.appliedScope, 'corpus');
  assert.equal(result.maxChunksPerDocument, 2);
  assert.deepEqual(new Set(result.matches.map(match => match.documentId)), new Set(documentIds));
  for (const documentId of documentIds) {
    assert.ok(result.matches.filter(match => match.documentId === documentId).length <= 2);
  }
});

test('RagService - diversidad de corpus no pierde documentos tras un resultado dominante', async () => {
  const branch = await RagStorage.createBranch('Resultados desiguales');
  const dominant = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Dominant.pdf',
    chunks: Array.from({ length: 30 }, (_, index) => ({
      title: `Battery ${index}`,
      content: `Battery specification dominant evidence ${index}.`
    }))
  });
  const secondary = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Secondary.pdf',
    chunks: [{ title: 'Battery', content: 'Battery specification secondary evidence.' }]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'battery specification',
    scope: 'corpus',
    limit: 4,
    tolerance: 0
  });

  const returnedIds = new Set(result.matches.map(match => match.documentId));
  assert.ok(returnedIds.has(dominant.id));
  assert.ok(returnedIds.has(secondary.id));
  assert.ok(result.matches.filter(match => match.documentId === dominant.id).length <= 2);
});

test('RagService - dynamic maxPerDocument en scope auto con pocos candidatos amplía la profundidad', async () => {
  const branch = await RagStorage.createBranch('FinancialBench_Auto');
  const wmtDoc = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'WALMART_2020_10K.pdf',
    chunks: [
      { title: 'TOC', content: 'Table of Contents financial statements 2020 2019 2018.' },
      { title: 'Income Statement', content: 'Consolidated Statements of Income operating income total revenues net sales 2020 2019 2018.' },
      { title: 'Cash Flows', content: 'Consolidated Statements of Cash Flows depreciation and amortization operating activities 2020 2019 2018.' },
      { title: 'Segment Info', content: 'Segment assets, net sales, operating income and depreciation 2020 2019 2018.' }
    ]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'operating income depreciation amortization net sales 2020 2019 2018',
    scope: 'auto',
    limit: 10,
    tolerance: 0
  });

  assert.equal(result.success, true);
  // Al haber solo 1 documento en la base y scope auto, appliedScope es document si hubo match exacto o corpus con maxPerDocument dinámico de 4
  if (result.appliedScope === 'corpus') {
    assert.equal(result.maxChunksPerDocument, 4);
    assert.ok(result.matches.length >= 3, 'Debe devolver más de 2 chunks gracias a la ampliación dinámica');
  } else {
    assert.equal(result.appliedScope, 'document');
    assert.ok(result.matches.length >= 3);
  }
});

test('RagService - maxPerDocument explícito es respetado en scope corpus', async () => {
  const branch = await RagStorage.createBranch('MultiDoc_Explicit');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'Doc_A.pdf',
    chunks: [
      { title: 'C1', content: 'Keyword alpha evidence 1' },
      { title: 'C2', content: 'Keyword alpha evidence 2' },
      { title: 'C3', content: 'Keyword alpha evidence 3' },
      { title: 'C4', content: 'Keyword alpha evidence 4' }
    ]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'Keyword alpha',
    scope: 'corpus',
    maxPerDocument: 3,
    limit: 10,
    tolerance: 0
  });

  assert.equal(result.appliedScope, 'corpus');
  assert.equal(result.maxChunksPerDocument, 3);
  assert.equal(result.matches.length, 3);
});

test('RagService - ambigüedad documental incluye recomendación de documentHint', async () => {
  const branch = await RagStorage.createBranch('Ambiguous_Branch');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'AMZN_2019_10K.pdf',
    chunks: [{ title: 'Revenue', content: 'Amazon net sales and operating income.' }]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'AMZN_2020_10K.pdf',
    chunks: [{ title: 'Revenue', content: 'Amazon net sales and operating income.' }]
  });

  const result = await RagService.searchKnowledgeBase(branch.id, {
    query: 'Amazon net sales',
    scope: 'document',
    documentHint: 'AMZN',
    tolerance: 0
  });

  assert.equal(result.appliedScope, 'corpus');
  assert.match(result.text, /Document candidates:/);
  assert.match(result.text, /specify documentHint with the target document to retrieve more depth/);
});

test('RagService - listDocuments filtra por palabra clave, empresa o año con coincidencia flexible', async () => {
  const branch = await RagStorage.createBranch('Catalog_Branch');
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'WMT_2020_10K.pdf',
    chunks: [{ title: 'Intro', content: 'Walmart 2020 10-K report.' }]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'WMT_2019_10K.pdf',
    chunks: [{ title: 'Intro', content: 'Walmart 2019 10-K report.' }]
  });
  await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'TGT_2020_10K.pdf',
    chunks: [{ title: 'Intro', content: 'Target 2020 10-K report.' }]
  });

  // Sin filtro -> devuelve todos los documentos
  const allList = await RagService.listDocuments(branch.id);
  assert.equal(allList.count, 3);
  assert.equal(allList.filter, null);
  assert.doesNotMatch(allList.text, /filtered by/);

  // Filtro por keyword/empresa 'WMT'
  const wmtList = await RagService.listDocuments(branch.id, { filter: 'WMT' });
  assert.equal(wmtList.count, 2);
  assert.equal(wmtList.filter, 'WMT');
  assert.match(wmtList.text, /filtered by "WMT"/);
  assert.ok(wmtList.documents.some(d => d.title === 'WMT_2020_10K.pdf'));
  assert.ok(wmtList.documents.some(d => d.title === 'WMT_2019_10K.pdf'));
  assert.ok(!wmtList.documents.some(d => d.title === 'TGT_2020_10K.pdf'));

  // Filtro por año '2019'
  const y2019List = await RagService.listDocuments(branch.id, { filter: '2019' });
  assert.equal(y2019List.count, 1);
  assert.equal(y2019List.documents[0].title, 'WMT_2019_10K.pdf');

  // Filtro sin coincidencias
  const noneList = await RagService.listDocuments(branch.id, { filter: 'Costco' });
  assert.equal(noneList.count, 0);
  assert.match(noneList.text, /No documents matching "Costco" were found/);

  // Soporta paso directo de string como argumento rawArgs
  const strList = await RagService.listDocuments(branch.id, 'TGT');
  assert.equal(strList.count, 1);
  assert.equal(strList.documents[0].title, 'TGT_2020_10K.pdf');

  // Coincidencia insensible a guiones / variantes morfológicas ("10-K" coincide con "10K")
  const hyphenList = await RagService.listDocuments(branch.id, { filter: '10-K' });
  assert.equal(hyphenList.count, 3);
});
