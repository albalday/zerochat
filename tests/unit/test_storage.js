const { test } = require('node:test');
const assert = require('node:assert/strict');
const Storage = require('../../js/storage.js');

test('Storage - guarda, lee y borra valores con el prefijo de ZeroChat', () => {
  Storage.setStorageItem('test_key', 'test_value');
  assert.equal(Storage.getStorageItem('test_key'), 'test_value');
  assert.equal(localStorage.getItem('zerochat_test_key'), 'test_value');

  Storage.deleteStorageItem('test_key');
  const valDeleted = Storage.getStorageItem('test_key');
  assert.equal(valDeleted, null);
});

test('Storage - persiste exclusivamente el documento de configuración operativa', () => {
  const config = { model: 'custom-test-model', enabledTools: { search_web: false } };
  Storage.saveRuntimeConfigV2(config);
  const loaded = Storage.loadRuntimeConfigV2();
  assert.deepEqual(loaded, config);
  loaded.enabledTools.search_web = true;
  assert.equal(Storage.loadRuntimeConfigV2().enabledTools.search_web, false);
});

test('Storage - valida el contrato restrictivo de la sesión del backend local', () => {
  assert.deepEqual(
    Storage.normalizeBackendSession({ token: 'token_seguro-123', host: 'LOCALHOST', port: '6388' }),
    { token: 'token_seguro-123', host: 'localhost', port: 6388 }
  );
  assert.equal(Storage.normalizeBackendSession({ token: '', host: '127.0.0.1', port: 6388 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: ' token ', host: '127.0.0.1', port: 6388 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: 'token', host: 'example.test', port: 6388 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: 'token', host: '127.0.0.1', port: 0 }), null);
  assert.equal(Storage.normalizeBackendSession({ token: 'token', host: '127.0.0.1', port: 65536 }), null);
});

test('Storage - el borrado completo solo elimina claves y cookies propias de ZeroChat', async () => {
  localStorage.setItem('zerochat_language', 'es');
  localStorage.setItem('otra_app_token', 'x');
  sessionStorage.setItem('zerochat_tmp', '1');
  sessionStorage.setItem('otra_app_estado', '2');
  const writtenCookies = [];
  const descriptors = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location')
  };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:' } });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get cookie() { return 'zerochat_backend_session_v1=abc; otra_app_sesion=def'; },
      set cookie(value) { writtenCookies.push(value); }
    }
  });
  try {
    assert.equal(await Storage.clearAllStorage(), true, Storage.getLastClearAllStorageError());
    assert.equal(localStorage.getItem('zerochat_language'), null);
    assert.equal(localStorage.getItem('otra_app_token'), 'x');
    assert.equal(sessionStorage.getItem('zerochat_tmp'), null);
    assert.equal(sessionStorage.getItem('otra_app_estado'), '2');
    assert.equal(writtenCookies.length, 1);
    assert.match(writtenCookies[0], /^zerochat_backend_session_v1=;Max-Age=0;/);
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    localStorage.removeItem('otra_app_token');
    sessionStorage.removeItem('otra_app_estado');
  }
});

test('Storage - avisa si localStorage rechaza la escritura', t => {
  t.mock.method(localStorage, 'setItem', () => { throw new Error('QuotaExceededError'); });
  t.mock.method(console, 'warn', () => {});
  Storage.setStorageItem('quota_key', 'value');
  assert.equal(console.warn.mock.callCount(), 1);
  assert.match(String(console.warn.mock.calls[0].arguments[0]), /quota_key/);
  assert.equal(Storage.getStorageItem('quota_key'), null);
});

test('ZeroChatDB - crea el esquema compartido completo', async () => {
  const Database = require('../../js/storage-db.js');
  const db = await Database.openDatabase();
  assert.deepEqual(Array.from(db.objectStoreNames).sort(), Object.values(Database.STORES).sort());

  const tx = db.transaction([
    Database.STORES.ragDocuments,
    Database.STORES.ragImages,
    Database.STORES.ragChunks
  ], 'readonly');
  assert.ok(tx.objectStore(Database.STORES.ragDocuments).indexNames.contains('by_branchId'));
  assert.ok(tx.objectStore(Database.STORES.ragImages).indexNames.contains('by_branchId'));
  assert.ok(tx.objectStore(Database.STORES.ragChunks).indexNames.contains('by_documentId'));
});

test('ZeroChatDB - conserva imágenes, metadatos y chunks en almacenes separados', async () => {
  const RagStorage = require('../../js/ragStorage.js');
  await RagStorage.clearAllData();
  const branch = await RagStorage.createBranch('Persistencia real');
  const document = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'informe.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    fileSize: 123,
    chunks: [{ title: 'Fragmento', content: 'contenido original' }]
  }, [{ id: 'img_1', dataUrl: 'data:image/jpeg;base64,123' }]);

  assert.equal((await RagStorage.getDocumentImages(document.id))[0].id, 'img_1');
  assert.equal((await RagStorage.getDocumentsByBranch(branch.id))[0].chunkCount, 1);
  assert.equal((await RagStorage.getChunksByDocument(document.id))[0].content, 'contenido original');
});

test('ZeroChatDB - elimina en cascada toda una rama', async () => {
  const RagStorage = require('../../js/ragStorage.js');
  await RagStorage.clearAllData();
  const branch = await RagStorage.createBranch('Descartable');
  const document = await RagStorage.saveDocument({
    branchId: branch.id,
    title: 'descartable.md',
    fileType: 'md',
    chunks: [{ content: '# Temporal' }]
  });

  await RagStorage.deleteBranch(branch.id);

  assert.equal(await RagStorage.getBranchById(branch.id), null);
  assert.equal(await RagStorage.getDocumentById(document.id), null);
  assert.deepEqual(await RagStorage.getDocumentImages(document.id), []);
  assert.deepEqual(await RagStorage.getChunksByBranch(branch.id), []);
});

test('Storage IndexedDB - Creación y recuperación de conversación y mensajes', async () => {
  const sessionId = 'test_session_001';
  const sessionMeta = {
    id: sessionId,
    title: 'Conversación de prueba',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 5000
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

  const list = await Storage.getConversationsList();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'conv_2');
  assert.equal(list[1].id, 'conv_3');
  assert.equal(list[2].id, 'conv_1');

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

test('Storage IndexedDB - borra conversaciones individuales, todas y el almacenamiento completo', async () => {
  const s1 = 'conv_delete_1';
  const s2 = 'conv_delete_2';

  await Storage.saveConversation({ id: s1, title: 'Chat 1' }, [{ id: 'm1', content: '1' }]);
  await Storage.saveConversation({ id: s2, title: 'Chat 2' }, [{ id: 'm2', content: '2' }]);

  const del1 = await Storage.deleteConversation(s1);
  assert.equal(del1, true);

  const check1 = await Storage.getConversation(s1);
  assert.equal(check1, null);

  const check2 = await Storage.getConversation(s2);
  assert.ok(check2);

  await Storage.deleteAllConversations();
  const emptyList = await Storage.getConversationsList();
  assert.equal(emptyList.length, 0);

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

test('Storage IndexedDB - preserva íntegros turnos del asistente, herramientas, sistema y contexto', async () => {
  {
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
  }

  {
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
  }
});

test('Storage IndexedDB - conserva la nota de comandos terminados del mensaje del usuario', async () => {
  const sessionId = 'test_session_command_notes';
  await Storage.saveConversation({ id: sessionId, title: 'Notas' }, [
    { id: 'n1', role: 'user', content: 'sigue', commandNotes: 'Background commands that finished since your last turn: ...' },
    { id: 'n2', role: 'user', content: 'sin nota' }
  ]);
  const loaded = await Storage.getConversation(sessionId);
  assert.equal(loaded.history[0].commandNotes, 'Background commands that finished since your last turn: ...');
  assert.equal('commandNotes' in loaded.history[1], false);
});

test('Storage IndexedDB - conserva el orden de la conversación aunque los ids no lo sigan', async () => {
  const history = ['z', 'a', 'm', 'b'].map((id, index) => ({ id, role: index % 2 ? 'assistant' : 'user', content: `mensaje ${index}` }));
  await Storage.saveConversation({ id: 'conv_order' }, history);
  await Storage.saveConversation({ id: 'conv_order' }, [...history, { id: 'c', role: 'user', content: 'mensaje 4' }]);
  const loaded = await Storage.getConversation('conv_order');
  assert.deepEqual(loaded.history.map(message => message.id), ['z', 'a', 'm', 'b', 'c']);
  assert.deepEqual(Object.keys(loaded.history[0]).sort(), ['content', 'id', 'role']);
});

test('Storage IndexedDB - propaga errores estructurados en lugar de silenciosos fallbacks', async () => {
  const Database = require('../../js/storage-db.js');
  const originalOpen = Database.openDatabase;
  Database.openDatabase = async () => {
    throw new Error('Simulated QuotaExceededError');
  };
  try {
    await assert.rejects(
      Storage.getConversationsList(),
      err => err.code === 'STORAGE_ERROR' && err.message.includes('read the conversation list')
    );
    await assert.rejects(
      Storage.saveConversation({ id: 'err_test' }, []),
      err => err.code === 'STORAGE_ERROR' && err.message.includes('save the conversation')
    );
    await assert.rejects(
      Storage.getConversation('err_test'),
      err => err.code === 'STORAGE_ERROR' && err.message.includes('read the conversation')
    );
    await assert.rejects(
      Storage.deleteConversation('err_test'),
      err => err.code === 'STORAGE_ERROR' && err.message.includes('delete the conversation')
    );
  } finally {
    Database.openDatabase = originalOpen;
  }
});
