const test = require('node:test');
const assert = require('node:assert');
const ChatExport = require('../../js/export.js');

test('ChatExport - Generación de Markdown estructurado', () => {
  const history = [
    { role: 'system', content: 'Prompt sistema' },
    { role: 'user', content: 'Hola asistente' },
    { role: 'assistant', content: '¡Hola! ¿En qué puedo ayudarte?' }
  ];

  const md = ChatExport.buildMarkdownExport(history, { title: 'Charla de prueba', model: 'gpt-4o' });
  assert.ok(md.includes('# Charla de prueba'));
  assert.ok(md.includes('*Modelo: gpt-4o*'));
  assert.ok(md.includes('### 👤 Usuario\n\nHola asistente'));
  assert.ok(md.includes('### 🤖 Asistente\n\n¡Hola! ¿En qué puedo ayudarte?'));
  assert.equal(md.includes('Prompt sistema'), false, 'No debe exportar el mensaje de sistema');
});

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
  }, /historial de chat válido/);

  assert.throws(() => {
    ChatExport.parseImportedJson('esto no es json');
  });
});
