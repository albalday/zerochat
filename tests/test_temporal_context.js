require('fake-indexeddb/auto');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Engine = require('../js/chat-engine.js');
const Storage = require('../js/cookies.js');
const Database = require('../js/storage-db.js');
const Export = require('../js/export.js');
const Context = require('../js/context-manager.js');
after(() => Database.closeDatabase());

test('Contexto temporal - conserva fecha en IndexedDB, exportación y compactación', async () => {
  const history = [{ id: 'system_root', role: 'system', content: 'Sistema estable' }];
  const anchor = Engine.ensureConversationDate(history, 'es', '2026-01-01T12:00:00Z');
  for (let i = 0; i < 12; i++) {
    history.push({ role: 'user', content: `Pregunta ${i}` }, { role: 'assistant', content: `Respuesta ${i}` });
  }
  const session = { id: 'temporal', createdAt: 1, title: 'Fecha estable' };
  await Storage.saveConversation(session, history);
  await Database.closeDatabase();
  const loaded = await Storage.getConversation(session.id);
  assert.equal(loaded.history[0].contextDateAnchor, anchor);
  const imported = Export.parseImportedJson(Export.buildJsonExport(session, loaded.history));
  assert.equal(imported.history[0].contextDateAnchor, anchor);
  const compacted = await Context.compressHistory({ messages: imported.history, options: { recentTurnsToKeep: 2 } });
  assert.equal(compacted.compressed, true);
  assert.equal(Engine.ensureConversationDate(compacted.messages, 'en', '2027-03-03T12:00:00Z'), anchor);
  assert.ok(Engine.buildEffectiveMessages(compacted.messages, { sendDateTime: true })[0].content.includes(anchor));
});

test('Contexto temporal - usa el día local en el límite de medianoche', () => {
  const code = `const e = require('./js/chat-engine.js'); process.stdout.write(e.getConversationDateAnchor('es', '2026-09-05T23:30:00Z'));`;
  const anchor = execFileSync(process.execPath, ['-e', code], {
    cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, TZ: 'Europe/Madrid' }, encoding: 'utf8'
  });
  assert.match(anchor, /2026-09-06/);
  assert.match(anchor, /Europe\/Madrid/);
  assert.doesNotMatch(anchor, /\d{2}:\d{2}/);
});
