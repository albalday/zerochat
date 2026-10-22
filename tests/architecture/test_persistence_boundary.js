const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSourceFiles } = require('../helpers/source-files');

// Frontera de persistencia (js/README.md §4): solo ChatStorage, ChatRagStorage y ZeroChatDB tocan
// localStorage, sessionStorage, IndexedDB y cookies. sandbox.js solo nombra esas APIs como texto,
// en la lista de globales que bloquea dentro del iframe.

const ROOT = path.resolve(__dirname, '../..');
const STORAGE_MODULES = ['js/storage.js', 'js/storage-db.js', 'js/ragStorage.js'];
const SANDBOX = 'js/sandbox.js';
const PERSISTENCE_API = /(?<![\w$])(localStorage|sessionStorage|indexedDB)(?![\w$])|document\.cookie/g;

test('Persistencia - fuera de los módulos de almacenamiento nadie accede a localStorage, IndexedDB ni cookies', () => {
  const files = [...listSourceFiles(path.join(ROOT, 'js')), path.join(ROOT, 'zerochat.html'), path.join(ROOT, 'sw.js')];
  const offenders = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (STORAGE_MODULES.includes(relative)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(PERSISTENCE_API)) {
      const quoted = /['"]$/.test(source.slice(0, match.index)) && /^['"]/.test(source.slice(match.index + match[0].length));
      if (relative === SANDBOX && quoted) continue;
      offenders.push(`${relative}:${source.slice(0, match.index).split('\n').length} ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `Usa ChatStorage, ChatRagStorage o ZeroChatDB:\n${offenders.join('\n')}`);
});
