const test = require('node:test');
const assert = require('node:assert');
const ChatExport = require('../../js/export.js');

test('ChatExport - Generación y Parseo de JSON de conversación', () => {
  const history = [
    { id: 'u1', role: 'user', content: '¿Qué hora es?' },
    { id: 'a1', role: 'assistant', content: 'Son las 12:00.' }
  ];
  const sessionMeta = { id: 'sess_123', title: 'Prueba JSON', createdAt: 100000 };
  const config = { model: 'llama-3', apiUrl: 'http://localhost:11434/v1', apiType: 'ollama' };

  const jsonString = ChatExport.buildJsonExport(sessionMeta, history, config);
  assert.ok(jsonString.length > 50);

  const parsed = ChatExport.parseImportedJson(jsonString, 'Fallback');
  assert.ok(parsed.id);
  assert.equal(parsed.title, 'Prueba JSON');
  assert.equal(parsed.history.length, 2);
  assert.equal(parsed.history[0].content, '¿Qué hora es?');
});

test('ChatExport - Manejo de errores al importar JSON inválido', () => {
  assert.throws(() => {
    ChatExport.parseImportedJson('{ "invalido": true }');
  }, /valid chat history/);

  assert.throws(() => {
    ChatExport.parseImportedJson('esto no es json');
  });
});
