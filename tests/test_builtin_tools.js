const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AgentCore = require('../js/agent-core.js');
const ToolManifest = require('../js/tools/tool-manifest.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const BUILTIN_DIR = path.join(ROOT_DIR, 'js/tools/builtin');
const ALL_BUILTIN_MODULES = fs.readdirSync(BUILTIN_DIR)
  .filter(file => file.endsWith('.tool.js'))
  .sort()
  .map(file => require(path.join(BUILTIN_DIR, file)));
const BUILTIN_BY_ID = new Map(ALL_BUILTIN_MODULES.map(toolModule => [toolModule.id, toolModule]));
const ExecuteJavascriptTool = BUILTIN_BY_ID.get('execute_javascript');
const SearchWebTool = BUILTIN_BY_ID.get('search_web');
const FetchWebPageTool = BUILTIN_BY_ID.get('fetch_web_page');
const DownloadPdfTool = BUILTIN_BY_ID.get('download_pdf');
const RenderChartTool = BUILTIN_BY_ID.get('render_chart');
const ListDocumentsTool = BUILTIN_BY_ID.get('list_documents');
const SearchKnowledgeBaseTool = BUILTIN_BY_ID.get('search_knowledge_base');
const ReadKnowledgeChunkTool = BUILTIN_BY_ID.get('read_knowledge_chunk');

test('Builtin Tools - Todos los módulos cumplen el contrato declarativo y se registran en el manifiesto', () => {
  for (const toolModule of ALL_BUILTIN_MODULES) {
    const tool = toolModule.createTool(AgentCore.Tool);
    const validation = AgentCore.validateToolContract(tool);

    assert.equal(validation.valid, true, `${toolModule.id}: ${validation.errors.join(' ')}`);
    assert.equal(tool.name, toolModule.id);
    assert.equal(tool.getDefinition().function.name, toolModule.id);
    assert.equal(ToolManifest.builtin.get(toolModule.id), toolModule);
    assert.equal(AgentCore.registry.getTool(toolModule.id)?.id, toolModule.id);
  }
});

test('Builtin Tools - index.html carga exactamente los módulos builtin disponibles', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf-8');
  const loaded = Array.from(html.matchAll(/<script[^>]+src=["'](js\/tools\/builtin\/[^"']+\.tool\.js)["']/gi), match => path.basename(match[1]));
  const available = fs.readdirSync(BUILTIN_DIR).filter(file => file.endsWith('.tool.js')).sort();
  assert.deepEqual(loaded.sort(), available);
});

test('Builtin Tools - execute_javascript ejecuta con sandbox inyectado y conserva formatos', async () => {
  const tool = ExecuteJavascriptTool.createTool(AgentCore.Tool);
  let receivedCode = '';
  let receivedTimeout = null;
  const result = await tool.execute({ javascript: 'return 21 * 2;' }, {
    timeoutMs: 123,
    services: {
      sandbox: {
        execute: async (code, timeout) => {
          receivedCode = code;
          receivedTimeout = timeout;
          return { success: true, result: '42' };
        }
      }
    }
  });

  assert.equal(receivedCode, 'return 21 * 2;');
  assert.equal(receivedTimeout, 123);
  assert.equal(tool.serializeResultForModel({}, result), '42');
  assert.match(tool.formatDispatchMarkdown({ code: 'return 21 * 2;' }, result), /execute_javascript/);
  assert.ok(tool.aliases.includes('executejs'));
});

test('Builtin Tools - search_web ejecuta contra servicio inyectado y preserva serialización', async () => {
  const tool = SearchWebTool.createTool(AgentCore.Tool);
  const calls = [];
  const result = await tool.execute({ q: 'ZeroChat refactor' }, {
    language: 'en',
    services: {
      webSearch: {
        search: async (query, language) => {
          calls.push({ query, language });
          return { success: true, count: 1, markdown: '## Result' };
        }
      }
    }
  });

  assert.deepEqual(calls, [{ query: 'ZeroChat refactor', language: 'en' }]);
  assert.equal(tool.serializeResultForModel({}, result), '## Result');
  assert.match(tool.formatDispatchMarkdown({ query: 'ZeroChat refactor' }, result), /1 fuentes/);
  assert.equal(SearchWebTool.getQuery({ keyword: 'alternativa' }), 'alternativa');
});

test('Builtin Tools - fetch_web_page y download_pdf usan WebBrowser inyectado', async () => {
  const fetchTool = FetchWebPageTool.createTool(AgentCore.Tool);
  const pdfTool = DownloadPdfTool.createTool(AgentCore.Tool);
  const calls = [];
  const services = {
    webBrowser: {
      fetchPage: async (url, options) => {
        calls.push({ operation: 'fetch', url, options });
        return { success: true, content: 'Página' };
      },
      downloadPdf: async (url, options) => {
        calls.push({ operation: 'pdf', url, options });
        return { success: true, text: 'PDF' };
      }
    }
  };

  const pageResult = await fetchTool.execute({ href: 'https://example.com/article' }, {
    options: { maxLength: 100 }, services
  });
  const pdfResult = await pdfTool.execute({ URL: 'https://example.com/document.pdf' }, {
    options: { extract: true }, services
  });

  assert.deepEqual(calls, [
    { operation: 'fetch', url: 'https://example.com/article', options: { maxLength: 100 } },
    { operation: 'pdf', url: 'https://example.com/document.pdf', options: { extract: true } }
  ]);
  assert.equal(fetchTool.serializeResultForModel({}, pageResult), JSON.stringify(pageResult));
  assert.equal(pdfTool.serializeResultForModel({}, pdfResult), JSON.stringify(pdfResult));
  assert.match(fetchTool.formatDispatchMarkdown({ url: 'https://example.com/article' }, pageResult), /fetch_web_page/);
  assert.match(pdfTool.formatDispatchMarkdown({ url: 'https://example.com/document.pdf' }, pdfResult), /download_pdf/);
});

test('Builtin Tools - render_chart ejecuta de forma autocontenida', async () => {
  const chartTool = RenderChartTool.createTool(AgentCore.Tool);
  const chartResult = await chartTool.execute({ type: 'bar', title: 'Ventas', labels: ['Enero'], datasets: [{ label: '2026', data: [10] }] }, {
    services: { charts: { renderChartCard: (args) => `<svg data-title="${args.title}"></svg>` } }
  });

  assert.equal(chartResult.success, true);
  assert.match(chartResult.svg, /Ventas/);
  assert.equal(chartTool.serializeResultForModel({ type: 'bar', title: 'Ventas' }, chartResult), '{"success":true,"type":"bar","title":"Ventas"}');

  // Vista delegada de render_chart
  const fakeDocument = { createElement: () => ({ className: '', innerHTML: '' }) };
  const viewContext = {
    document: fakeDocument,
    charts: { renderChartCard: (args) => `<svg data-chart="${args.title}"></svg>` },
    markdown: { escapeHtml: (value) => String(value) }
  };
  const historical = chartTool.view.renderHistoricalCard({ title: 'Evolución' }, {}, viewContext);
  const live = { innerHTML: '' };
  chartTool.view.updateLiveCard(live, { title: 'Evolución' }, {}, 2, viewContext);

  assert.match(historical.innerHTML, /data-chart="Evolución"/);
  assert.match(live.innerHTML, /data-chart="Evolución"/);
});

test('Builtin Tools - RAG tools consumen el servicio inyectado y propagan rama activa', async () => {
  const calls = [];
  const ragService = {
    listDocuments: async (branchId) => {
      calls.push({ name: 'list', branchId });
      return { success: true, count: 1, text: 'Documento' };
    },
    searchKnowledgeBase: async (branchId, args) => {
      calls.push({ name: 'search', branchId, args });
      return { success: true, matchesCount: 1, text: 'Coincidencia' };
    },
    readKnowledgeChunk: async (branchId, args) => {
      calls.push({ name: 'read', branchId, args });
      return { success: true, chunkId: args.chunkId, content: 'Contenido', charCount: 9 };
    }
  };
  const context = { config: { activeRagBranchId: 'branch-1' }, services: { ragService } };

  const listResult = await ListDocumentsTool.createTool(AgentCore.Tool).execute({}, context);
  const searchArgs = { query: 'seguridad', scope: 'document', documentHint: 'manual interno', limit: 3 };
  const searchResult = await SearchKnowledgeBaseTool.createTool(AgentCore.Tool).execute(searchArgs, context);
  const readResult = await ReadKnowledgeChunkTool.createTool(AgentCore.Tool).execute({ chunkId: 'doc-1:chunk:2' }, context);

  assert.equal(listResult.text, 'Documento');
  assert.equal(searchResult.text, 'Coincidencia');
  assert.equal(readResult.content, 'Contenido');
  assert.deepEqual(calls, [
    { name: 'list', branchId: 'branch-1' },
    { name: 'search', branchId: 'branch-1', args: searchArgs },
    { name: 'read', branchId: 'branch-1', args: { chunkId: 'doc-1:chunk:2' } }
  ]);
});

test('Builtin Tools - read_knowledge_chunk declara parámetros para múltiples fragmentos', async () => {
  const properties = ReadKnowledgeChunkTool.definition.parameters.properties;
  assert.equal(properties.chunkId.type, 'string');
  assert.equal(properties.chunkIds.type, 'array');
  assert.equal(properties.chunkIds.items.type, 'string');

  const calls = [];
  const ragService = {
    readKnowledgeChunk: async (branchId, args) => {
      calls.push({ branchId, args });
      return { success: true, count: 2, chunkIds: args.chunkIds, content: 'Contenido múltiple' };
    }
  };
  const context = { config: { activeRagBranchId: 'branch-1' }, services: { ragService } };
  const tool = ReadKnowledgeChunkTool.createTool(AgentCore.Tool);
  const res = await tool.execute({ chunkIds: ['chunk-1', 'chunk-2'] }, context);
  assert.equal(res.success, true);
  assert.equal(res.content, 'Contenido múltiple');
  assert.deepEqual(calls[0].args, { chunkIds: ['chunk-1', 'chunk-2'] });
});

test('Builtin Tools - search_knowledge_base declara los alcances de recuperación', () => {
  const properties = SearchKnowledgeBaseTool.definition.parameters.properties;
  assert.deepEqual(properties.scope.enum, ['auto', 'document', 'corpus']);
  assert.equal(properties.documentHint.type, 'string');
  assert.match(SearchKnowledgeBaseTool.definition.description, /scope="document"/);
  assert.match(SearchKnowledgeBaseTool.definition.description, /scope="corpus"/);
});
