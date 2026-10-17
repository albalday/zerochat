const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AgentCore = require('../../js/agent-core.js');

const ROOT_DIR = path.resolve(__dirname, '../..');
const BUILTIN_DIR = path.join(ROOT_DIR, 'js/tools/builtin');
const getTool = name => AgentCore.registry.getTool(name);

// Claves de la especificación documentadas en la lista inicial de js/tools/README.md, sin lo que va
// entre paréntesis (firmas y subclaves) ni lo que sigue a los dos puntos.
function documentedToolKeys() {
  const readme = fs.readFileSync(path.join(ROOT_DIR, 'js/tools/README.md'), 'utf-8');
  const bullets = readme.split('\n\n').find(block => block.startsWith('- `definition`')).split('\n');
  return bullets.flatMap(line => {
    const head = line.replace(/\([^)]*\)/g, '').split(':')[0];
    return Array.from(head.matchAll(/`([\w$]+)`/g), match => match[1]);
  }).sort();
}

test('Builtin Tools - las especificaciones solo usan las claves documentadas en js/tools/README.md', () => {
  const documented = documentedToolKeys();
  const accepted = AgentCore.Tool.toString().match(/constructor\(\{(.*?)\}\)\s*\{/)[1]
    .split(',').map(part => part.split('=')[0].trim()).sort();
  assert.deepEqual(documented, accepted, 'README.md y el constructor de Tool deben listar las mismas claves');
  for (const file of fs.readdirSync(BUILTIN_DIR).filter(name => name.endsWith('.tool.js'))) {
    const undocumented = Object.keys(require(path.join(BUILTIN_DIR, file))).filter(key => !documented.includes(key));
    assert.deepEqual(undocumented, [], `${file} usa claves sin documentar`);
  }
});

test('Builtin Tools - execute_javascript limpia las marcas de código y formatea la salida', async () => {
  const tool = getTool('execute_javascript');
  let receivedCode = '';
  const result = await tool.execute({ javascript: '```javascript\nreturn 21 * 2;\n```' }, {
    services: { sandbox: { execute: async code => { receivedCode = code; return { success: true, result: '42' }; } } }
  });

  assert.equal(receivedCode, 'return 21 * 2;');
  assert.equal(tool.toModel({}, result), '42');
  assert.equal(tool.toModel({}, { success: true, result: 0 }), '0');
  assert.equal(tool.toModel({}, { success: true, logs: ['a', 'b'] }), 'a\nb');
  assert.equal(tool.toModel({}, { success: false, error: 'boom' }), 'Error: boom');
  assert.match(tool.toMarkdown({ code: 'return 21 * 2;' }, result), /execute_javascript[\s\S]*return 21 \* 2;[\s\S]*42/);
  assert.ok(!`${tool.description} ${tool.getPromptGuide()}`.toLowerCase().includes('sandbox'), 'El modelo no lee la palabra sandbox');
});

test('Builtin Tools - fetch_web_page y download_doc aceptan los nombres de URL que usan los modelos', async () => {
  const urls = [];
  const webBrowser = { fetchPage: async url => { urls.push(url); return { success: true, content: 'Página' }; } };
  const page = await getTool('fetch_web_page').execute({ href: 'https://example.com/article' }, { services: { webBrowser } });
  await getTool('download_doc').execute({ URL: 'https://example.com/document.pdf' }, { services: { webBrowser } });

  assert.deepEqual(urls, ['https://example.com/article', 'https://example.com/document.pdf']);
  assert.equal(getTool('fetch_web_page').toModel({}, page), JSON.stringify(page));
  assert.match(getTool('download_doc').toMarkdown({ url: 'https://example.com/document.pdf' }, page), /download_doc[\s\S]*document\.pdf/);
});

test('Builtin Tools - las herramientas de conocimiento usan las ramas activas del contexto', async () => {
  const calls = [];
  const ragService = {
    listDocuments: async (branchIds, args) => { calls.push(['list', branchIds, args]); return { success: true, count: 1, text: 'Documento' }; },
    searchKnowledgeBase: async (branchIds, args) => { calls.push(['search', branchIds, args]); return { success: true, matchesCount: 1, text: 'Coincidencia' }; },
    readKnowledgeChunk: async (branchIds, args) => { calls.push(['read', branchIds, args]); return { success: true, chunkIds: args.chunkIds, content: 'Contenido' }; },
    readKnowledgeImage: async (branchIds, args) => { calls.push(['image', branchIds, args]); return { success: true, imageRef: args.imageRef, documentTitle: 'Doc', page: 2 }; }
  };
  const context = { activeRagBranchIds: ['branch-1'], services: { ragService } };
  const searchArgs = { query: 'seguridad', scope: 'document', documentHint: 'manual interno', limit: 3 };

  assert.equal(getTool('list_documents').toModel({}, await getTool('list_documents').execute({ filter: 'Walmart' }, context)), 'Documento');
  assert.equal(getTool('search_knowledge_base').toModel({}, await getTool('search_knowledge_base').execute(searchArgs, context)), 'Coincidencia');
  const chunk = await getTool('read_knowledge_chunk').execute({ chunkIds: ['c1', 'c2'] }, context);
  assert.equal(getTool('read_knowledge_chunk').toModel({}, chunk), 'Contenido');
  const image = await getTool('read_knowledge_image').execute({ imageRef: 'rag-image://d:i' }, context);
  assert.match(getTool('read_knowledge_image').toModel({}, image), /Image retrieved: rag-image:\/\/d:i \(Doc, page 2\)/);

  assert.deepEqual(calls, [
    ['list', ['branch-1'], { filter: 'Walmart' }],
    ['search', ['branch-1'], searchArgs],
    ['read', ['branch-1'], { chunkIds: ['c1', 'c2'] }],
    ['image', ['branch-1'], { imageRef: 'rag-image://d:i' }]
  ]);
  assert.match(getTool('list_documents').toMarkdown({ filter: 'Walmart' }, { count: 1 }), /filter "Walmart"/);
  assert.doesNotMatch(getTool('list_documents').toMarkdown({}, { count: 5 }), /filter/);
  assert.match(getTool('read_knowledge_chunk').toMarkdown({ chunkId: 'c9' }, {}), /\(c9\)/);
});

test('Builtin Tools - ask_user valida opciones y cede el turno', async () => {
  const tool = getTool('ask_user');

  assert.equal((await tool.execute({ question: '', options: ['a', 'b'] })).success, false);
  assert.equal((await tool.execute({ question: '¿Cuál?', options: [{ label: 'Solo' }] })).success, false);
  assert.equal((await tool.execute({ question: '¿Cuál?', options: ['a', 'b', 'c', 'd', 'e'] })).success, false);
  assert.equal((await tool.execute({ question: '¿Cuál?', options: [{ label: 'Igual' }, { label: 'igual' }] })).success, false, 'Etiquetas duplicadas no cuentan como opciones distintas');

  const result = await tool.execute({ question: ' ¿Aplico el cambio? ', options: [{ label: 'Aplicar', description: 'Escribe AGENTS.md' }, 'Cancelar'] });
  assert.deepEqual(result, {
    success: true,
    endTurn: true,
    question: '¿Aplico el cambio?',
    options: [{ label: 'Aplicar', description: 'Escribe AGENTS.md' }, { label: 'Cancelar', description: '' }]
  });
  assert.match(tool.toModel({}, result), /next user message/);
  assert.match(tool.toMarkdown({}, result), /ask_user\*\*: ¿Aplico el cambio\?[\s\S]*- Aplicar — Escribe AGENTS\.md/);

});

