const { test } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../js/cookies.js');

test('Storage IndexedDB - Creación y recuperación de conversación y mensajes', async () => {
  const sessionId = 'test_session_001';
  const sessionMeta = {
    id: sessionId,
    title: 'Conversación de prueba',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 5000,
    model: 'test-model',
    summary: 'Resumen de prueba'
  };

  const messages = [
    { id: 'msg_1', role: 'user', content: '¿Cuánto es 2+2?' },
    { id: 'msg_2', role: 'assistant', content: '4' }
  ];

  const saved = await Storage.saveConversation(sessionMeta, messages);
  assert.equal(saved, true, 'Debe guardar la conversación exitosamente');

  const loaded = await Storage.getConversation(sessionId);
  assert.ok(loaded, 'Debe recuperar la conversación guardada');
  assert.equal(loaded.id, sessionId);
  assert.equal(loaded.title, 'Conversación de prueba');
  assert.equal(loaded.messageCount, 2);
  assert.equal(loaded.history.length, 2);
  assert.equal(loaded.history[0].content, '¿Cuánto es 2+2?');
  assert.equal(loaded.history[1].content, '4');
});

test('Storage IndexedDB - Listado y filtrado de conversaciones', async () => {
  await Storage.deleteAllConversations();

  const conv1 = { id: 'conv_1', title: 'Receta de cocina', updatedAt: 1000 };
  const conv2 = { id: 'conv_2', title: 'Cálculo de matrices', updatedAt: 3000 };
  const conv3 = { id: 'conv_3', title: 'Análisis de datos', updatedAt: 2000 };

  await Storage.saveConversation(conv1, [{ id: 'm1', role: 'user', content: 'Hola' }]);
  await Storage.saveConversation(conv2, [{ id: 'm2', role: 'user', content: 'Hola' }]);
  await Storage.saveConversation(conv3, [{ id: 'm3', role: 'user', content: 'Hola' }]);

  // Listar todas (debe estar ordenado por updatedAt desc: conv_2, conv_3, conv_1)
  const list = await Storage.getConversationsList();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'conv_2');
  assert.equal(list[1].id, 'conv_3');
  assert.equal(list[2].id, 'conv_1');

  // Filtrar por término
  const filtered = await Storage.getConversationsList('matrices');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'conv_2');
});

test('Storage IndexedDB - Renombrar conversación', async () => {
  const sessionId = 'conv_rename_test';
  await Storage.saveConversation({ id: sessionId, title: 'Título Original' }, [{ id: 'm1', content: 'A' }]);

  const renamed = await Storage.renameConversation(sessionId, 'Título Actualizado');
  assert.equal(renamed, true);

  const conv = await Storage.getConversation(sessionId);
  assert.equal(conv.title, 'Título Actualizado');
});

test('Storage IndexedDB - Borrado individual y borrado total', async () => {
  const s1 = 'conv_delete_1';
  const s2 = 'conv_delete_2';

  await Storage.saveConversation({ id: s1, title: 'Chat 1' }, [{ id: 'm1', content: '1' }]);
  await Storage.saveConversation({ id: s2, title: 'Chat 2' }, [{ id: 'm2', content: '2' }]);

  // Borrar s1
  const del1 = await Storage.deleteConversation(s1);
  assert.equal(del1, true);

  const check1 = await Storage.getConversation(s1);
  assert.equal(check1, null);

  const check2 = await Storage.getConversation(s2);
  assert.ok(check2);

  // Borrar todo
  await Storage.deleteAllConversations();
  const emptyList = await Storage.getConversationsList();
  assert.equal(emptyList.length, 0);
});

test('Storage IndexedDB - Borrar todos los datos elimina el historial de chats', async () => {
  const sessionId = 'conv_clear_all_storage';
  await Storage.saveConversation(
    { id: sessionId, title: 'Chat que debe borrarse' },
    [{ id: 'm1', role: 'user', content: 'Eliminar este historial' }]
  );

  const cleared = await Storage.clearAllStorage();
  assert.equal(cleared, true);
  assert.equal(await Storage.getConversation(sessionId), null);
  assert.equal((await Storage.getConversationsList()).length, 0);
});

test('Storage IndexedDB - Preservación íntegra de turnos del asistente y herramientas', async () => {
  const sessionId = 'test_agentic_turn_session';
  const sessionMeta = { id: sessionId, title: 'Chat con herramientas' };

  const history = [
    { id: 'u1', role: 'user', content: 'Grafica esto' },
    {
      id: 'a1_turn_0_assistant',
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'render_chart', arguments: '{"type":"bar"}' } }]
    },
    {
      id: 'a1_turn_0_tool_call_123',
      role: 'tool',
      tool_call_id: 'call_123',
      name: 'render_chart',
      content: '{"success":true}'
    },
    {
      id: 'a1_final',
      role: 'assistant',
      content: 'Aquí tienes el gráfico generado.'
    }
  ];

  await Storage.saveConversation(sessionMeta, history);
  const loaded = await Storage.getConversation(sessionId);

  assert.ok(loaded);
  assert.equal(loaded.history.length, 4, 'No debe sobreescribir ningún mensaje de turno');
  assert.equal(loaded.history[0].role, 'user');
  assert.equal(loaded.history[1].role, 'assistant');
  assert.ok(Array.isArray(loaded.history[1].tool_calls));
  assert.equal(loaded.history[2].role, 'tool');
  assert.equal(loaded.history[3].role, 'assistant');
  assert.equal(loaded.history[3].content, 'Aquí tienes el gráfico generado.');
});

test('Storage IndexedDB - Preservación íntegra de conversaciones multi-turno con mensajes de sistema y contexto', async () => {
  const sessionId = 'session_test_multiturn_' + Date.now();
  const sessionMeta = { id: sessionId, title: 'Consulta multi-turno' };

  const history = [
    { id: 'msg_sys', role: 'system', content: '[Fecha actual: 2026-09-02, Zona: UTC]' },
    { id: 'msg_user_1', role: 'user', content: 'Hola' },
    { id: 'msg_ast_1', role: 'assistant', content: '¡Hola! ¿En qué puedo ayudarte?' },
    { id: 'msg_user_2', role: 'user', content: '¿Qué día es hoy?' },
    { id: 'msg_ast_2', role: 'assistant', content: 'Hoy es 2 de septiembre de 2026.' }
  ];

  await Storage.saveConversation(sessionMeta, history);
  const loaded = await Storage.getConversation(sessionId);

  assert.ok(loaded);
  assert.equal(loaded.history.length, 5);
  assert.equal(loaded.history[0].role, 'system');
  assert.equal(loaded.history[1].role, 'user');
  assert.equal(loaded.history[4].content, 'Hoy es 2 de septiembre de 2026.');
});
