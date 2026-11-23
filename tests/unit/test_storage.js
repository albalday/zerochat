const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../js/storage-db.js');
const Storage = require('../../js/storage.js');

test('Storage - la sesión del backend guarda un token válido y solo el origen http(s) de su URL', () => {
  assert.deepEqual(
    Storage.normalizeBackendSession({ token: 'token_seguro-123', url: 'HTTP://LOCALHOST:6388/' }),
    { token: 'token_seguro-123', url: 'http://localhost:6388' }
  );
  assert.deepEqual(Storage.normalizeBackendSession({ token: 'token', url: 'https://zerochat.example' }), { token: 'token', url: 'https://zerochat.example' });
  for (const token of ['', ' token ', 'to\nken', 'x'.repeat(513)]) {
    assert.equal(Storage.normalizeBackendSession({ token, url: 'http://127.0.0.1:6388' }), null, JSON.stringify(token));
  }
  assert.ok(Storage.normalizeBackendSession({ token: 'x'.repeat(512), url: 'http://127.0.0.1:6388' }));
  // El cliente añade las rutas (/mcp/external) y firma la de cada herramienta: la URL es solo un origen.
  for (const url of ['ftp://127.0.0.1', 'javascript:alert(1)', 'http://user:pass@127.0.0.1:6388', 'http://127.0.0.1:6388/api',
    'http://127.0.0.1:6388/?a=1', 'http://127.0.0.1:6388/#x', 'no es una url', undefined]) {
    assert.equal(Storage.normalizeBackendSession({ token: 'token', url }), null, String(url));
  }
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

test('Storage IndexedDB - borra conversaciones individuales, todas y el almacenamiento completo', async () => {
  const s1 = 'conv_delete_1';
  const s2 = 'conv_delete_2';

  await Storage.saveConversation({ id: s1, title: 'Chat 1' }, [{ id: 'm1', content: '1' }]);
  await Storage.saveConversation({ id: s2, title: 'Chat 2' }, [{ id: 'm2', content: '2' }]);

  await Storage.deleteConversation(s1);

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

test('Storage IndexedDB - preserva el orden, los metadatos de sesión e imágenes y notas de comandos', async () => {
  // 1. Conversación agéntica + perfil + serverRun
  const agenticId = 'test_agentic_turn_session';
  const agenticHistory = [
    { id: 'u1', role: 'user', content: 'Grafica esto', commandNotes: 'Background commands that finished since your last turn: ...' },
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
      content: '{"success":true}',
      images: [{ name: 'screenshot.png', dataUrl: `data:image/png;base64,${Buffer.from('tiny-img').toString('base64')}`, mimeType: 'image/png', action: 'screenshot', url: 'http://example.com' }]
    },
    { id: 'a1_final', role: 'assistant', content: 'Aquí tienes el gráfico generado.' }
  ];
  await Storage.saveConversation({ id: agenticId, title: 'Chat con herramientas', profileId: 'deepseek', serverRun: true, agent: 'informes.diario' }, agenticHistory);
  const loaded = await Storage.getConversation(agenticId);
  assert.equal(loaded.history.length, 4);
  assert.equal(loaded.profileId, 'deepseek');
  assert.equal(loaded.serverRun, true);
  assert.equal(loaded.agent, 'informes.diario');
  assert.equal(loaded.history[0].commandNotes, 'Background commands that finished since your last turn: ...');
  assert.equal('commandNotes' in loaded.history[3], false);
  assert.equal(loaded.history[2].images[0].action, 'screenshot');
  assert.equal(loaded.history[2].images[0].url, 'http://example.com');
  assert.ok(loaded.history[2].images[0].blobId);
  const listItem = (await Storage.getConversationsList()).find(c => c.id === agenticId);
  assert.equal(listItem.profileId, 'deepseek');
  assert.equal(listItem.serverRun, true);
  assert.equal(listItem.agent, 'informes.diario');

  // 2. Orden de mensajes con ids arbitrarios aislado entre conversaciones
  const ordered = ['z', 'a', 'm', 'b'].map((id, index) => ({ id, role: index % 2 ? 'assistant' : 'user', content: `mensaje ${index}` }));
  await Storage.saveConversation({ id: 'conv_order' }, ordered);
  await Storage.saveConversation({ id: 'conv_order' }, [...ordered, { id: 'c', role: 'user', content: 'mensaje 4' }]);
  await Storage.saveConversation({ id: 'conv_other' }, [{ id: 'z', role: 'system', content: 'otro sistema' }]);
  const loadedOrder = await Storage.getConversation('conv_order');
  assert.deepEqual(loadedOrder.history.map(message => message.id), ['z', 'a', 'm', 'b', 'c']);
  assert.deepEqual(Object.keys(loadedOrder.history[0]).sort(), ['content', 'id', 'role']);
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

test('Storage Backend - sincroniza en los dos sentidos con la copia más reciente, replica CRUD y propaga errores del servidor', async t => {
  const MCP = require('../../js/mcp.js');
  let connected = false;
  const backendStore = new Map([
    ['b_conv', {
      id: 'b_conv',
      title: 'Backend Chat',
      createdAt: 100,
      updatedAt: 200,
      messageCount: 1,
      history: [{ id: 'm_b1', role: 'user', content: 'Desde backend' }]
    }]
  ]);
  const backendCalls = [];
  let refuseDelete = false;
  let refuseSave = false;

  t.mock.method(MCP.manager, 'isProxyConnected', () => connected);
  t.mock.method(MCP.manager, 'requestExternalControl', async (method, params) => {
    backendCalls.push({ method, params });
    if (method === 'zerochat/conversations/list') {
      return {
        conversations: Array.from(backendStore.values()).map(({ history, ...header }) => header)
      };
    }
    if (method === 'zerochat/conversations/get') {
      return { conversation: backendStore.get(params.id) || null };
    }
    if (method === 'zerochat/conversations/save') {
      if (refuseSave) throw new Error('Run in progress');
      const history = params.messages || [];
      const record = { ...params.conversation, messageCount: history.length, history };
      backendStore.set(record.id, record);
      return { conversation: record };
    }
    if (method === 'zerochat/conversations/rename') {
      const existing = backendStore.get(params.id);
      if (existing) {
        existing.title = params.title;
        existing.updatedAt = (existing.updatedAt || Date.now()) + 123;
      }
      return { renamed: Boolean(existing), ...(existing ? { updatedAt: existing.updatedAt } : {}) };
    }
    if (method === 'zerochat/conversations/delete') {
      if (refuseDelete) throw new Error('Run in progress');
      if (params.all) backendStore.clear();
      else if ('project' in params) backendStore.forEach((record, id) => { if ((record.project || '') === (params.project || '')) backendStore.delete(id); });
      else backendStore.delete(params.id);
      return { deleted: true };
    }
    throw new Error(`Unexpected method: ${method}`);
  });

  await Storage.deleteAllConversations();
  // Guardar conversación local sin conexión
  await Storage.saveConversation(
    { id: 'l_conv', title: 'Local Chat', createdAt: 150, updatedAt: 300 },
    [{ id: 'm_l1', role: 'user', content: 'Desde local' }]
  );

  // 1. Al conectar, getConversationsList guarda las cabeceras remotas sin sus mensajes y sube la local hecha sin conexión
  connected = true;
  backendCalls.length = 0;
  const list = await Storage.getConversationsList();
  assert.deepEqual(list.map(c => c.id), ['l_conv', 'b_conv']);
  assert.deepEqual(backendCalls.map(call => call.method), ['zerochat/conversations/list', 'zerochat/conversations/save'], 'La lista no descarga mensajes');
  assert.equal(list.find(c => c.id === 'b_conv').messagesPending, true);
  assert.equal(backendStore.get('l_conv').updatedAt, 300, 'Se sube con su fecha');
  assert.equal(backendStore.get('l_conv').history[0].content, 'Desde local');
  // Ya sincronizada, no se vuelve a subir
  backendCalls.length = 0;
  await Storage.getConversationsList();
  assert.deepEqual(backendCalls.map(call => call.method), ['zerochat/conversations/list']);

  // Sin servidor, una conversación de la que solo hay cabecera no se abre vacía
  connected = false;
  await assert.rejects(Storage.getConversation('b_conv'), error => error.code === Storage.CONVERSATION_NOT_DOWNLOADED);

  // Abrirla conectado la guarda en IndexedDB y después se lee sin servidor
  connected = true;
  assert.equal((await Storage.getConversation('b_conv')).history[0].content, 'Desde backend');
  connected = false;
  const cachedRemote = await Storage.getConversation('b_conv');
  assert.equal(cachedRemote.history[0].content, 'Desde backend');
  assert.equal(cachedRemote.messagesPending, undefined);

  // Editada sin conexión, al abrirla conectado gana la copia local, más reciente, y se sube con la lista
  await Storage.saveConversation({ ...cachedRemote, updatedAt: 500 }, [...cachedRemote.history, { id: 'm_b2', role: 'user', content: 'Sin conexión' }]);
  connected = true;
  assert.equal((await Storage.getConversation('b_conv')).history.length, 2, 'La copia del servidor, más antigua, no sustituye a la local');
  await Storage.getConversationsList();
  assert.equal(backendStore.get('b_conv').history.length, 2);

  // Editada a la vez sin conexión y en el servidor, gana la más reciente: aquí la del servidor
  connected = false;
  await Storage.saveConversation({ ...cachedRemote, updatedAt: 600 }, [{ id: 'm_b3', role: 'user', content: 'Perdida' }]);
  backendStore.set('b_conv', { ...backendStore.get('b_conv'), updatedAt: 700 });
  connected = true;
  backendCalls.length = 0;
  await Storage.getConversationsList();
  assert.deepEqual(backendCalls.map(call => call.method), ['zerochat/conversations/list'], 'La copia local más antigua no se sube');
  assert.equal((await Storage.getConversation('b_conv')).history.length, 2);

  // Una copia ya sincronizada nunca gana: si el servidor la cambia con un reloj atrasado, gana el servidor
  backendStore.set('b_conv', { ...backendStore.get('b_conv'), updatedAt: 650, history: [{ id: 'm_b4', role: 'user', content: 'Reloj atrasado' }] });
  await Storage.getConversationsList();
  assert.equal((await Storage.getConversation('b_conv')).history[0].content, 'Reloj atrasado');
  connected = false;
  assert.equal((await Storage.getConversation('b_conv')).history[0].content, 'Reloj atrasado', 'Y se guarda aquí');
  connected = true;

  // Si el servidor rechaza subir una (ejecución en marcha), sigue sin sincronizar y se reintenta
  connected = false;
  await Storage.saveConversation({ id: 'run_conv', title: 'Run', createdAt: 800, updatedAt: 800 }, [{ id: 'm_r1', role: 'user', content: 'r' }]);
  connected = true;
  refuseSave = true;
  await Storage.getConversationsList();
  assert.equal(backendStore.has('run_conv'), false);
  refuseSave = false;
  await Storage.getConversationsList();
  assert.equal(backendStore.has('run_conv'), true);
  await Storage.deleteConversation('run_conv');

  // Si el servidor tiene una versión más reciente de una conversación local, sin servidor se abre la copia local
  backendStore.set('l_conv', { id: 'l_conv', title: 'Local Chat', createdAt: 150, updatedAt: 400, messageCount: 0, history: [] });
  await Storage.getConversationsList();
  connected = false;
  assert.equal((await Storage.getConversation('l_conv')).history[0].content, 'Desde local');
  backendStore.delete('l_conv');

  // 2. Conectado: save, rename, get y delete operan sobre el backend
  connected = true;
  backendCalls.length = 0;
  await Storage.saveConversation({ id: 'dual_conv', title: 'Dual Chat' }, [{ id: 'm1', role: 'user', content: 'Hola dual' }]);
  assert.equal(backendCalls.pop().method, 'zerochat/conversations/save');

  await Storage.renameConversation('dual_conv', 'Nuevo Titulo');
  assert.equal(backendCalls.pop().method, 'zerochat/conversations/rename');
  assert.equal((await Storage.getConversation('dual_conv')).title, 'Nuevo Titulo');
  // Al volver a listar, la copia local conserva el updatedAt exacto del servidor y no queda messagesPending.
  const listedAfterRename = await Storage.getConversationsList();
  assert.equal(listedAfterRename.find(item => item.id === 'dual_conv')?.messagesPending, undefined);

  // Si el servidor rechaza el borrado, la copia local se conserva
  refuseDelete = true;
  await assert.rejects(Storage.deleteConversation('dual_conv'), /Run in progress/);
  connected = false;
  assert.ok(await Storage.getConversation('dual_conv'));
  connected = true;
  refuseDelete = false;

  await Storage.deleteConversation('dual_conv');
  assert.equal(backendCalls.pop().method, 'zerochat/conversations/delete');
  assert.equal(await Storage.getConversation('dual_conv'), null);

  await Storage.deleteAllConversations();
  assert.deepEqual(backendCalls.pop(), { method: 'zerochat/conversations/delete', params: { all: true } });

  await Storage.saveConversation({ id: 'proj_x', title: 'X', project: '/repo/x' }, []);
  await Storage.saveConversation({ id: 'proj_y', title: 'Y', project: '/repo/y' }, []);
  await Storage.saveConversation({ id: 'proj_g', title: 'G' }, []);
  await Storage.deleteProjectConversations('/repo/x');
  assert.deepEqual(backendCalls.pop(), { method: 'zerochat/conversations/delete', params: { project: '/repo/x' } });
  assert.equal(await Storage.getConversation('proj_x'), null);
  assert.ok(await Storage.getConversation('proj_y'));
  assert.ok(await Storage.getConversation('proj_g'));

  await Storage.deleteProjectConversations('');
  assert.deepEqual(backendCalls.pop(), { method: 'zerochat/conversations/delete', params: { project: '' } });
  assert.equal(await Storage.getConversation('proj_g'), null);
  assert.ok(await Storage.getConversation('proj_y'));

  // 3. Sin fallbacks silenciosos: un fallo del servidor conectado se propaga al llamador
  t.mock.method(MCP.manager, 'requestExternalControl', async () => {
    throw new Error('Backend network error');
  });
  await assert.rejects(Storage.getConversationsList(), /Backend network error/);
  await assert.rejects(Storage.getConversation('l_conv'), /Backend network error/);
  await assert.rejects(Storage.saveConversation({ id: 'err_conv', title: 'Err' }, []), /Backend network error/);
});

test('Storage IndexedDB - guardar o borrar conversaciones recoge blobs sin referencia y respeta los compartidos', async () => {
  const image = text => ({ name: `${text}.png`, mimeType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.from(text).toString('base64')}` });
  const blobIds = async id => (await Storage.getConversation(id)).history.flatMap(msg => (msg.images || []).map(img => img.blobId));
  await Storage.deleteAllConversations();
  await Storage.saveConversation({ id: 'blob_a', title: 'A' }, [
    { id: 'm1', role: 'user', content: 'a', images: [image('propia'), image('editada')] },
    { id: 'm2', role: 'user', content: 'comp', images: [image('compartida')] }
  ]);
  await Storage.saveConversation({ id: 'blob_b', title: 'B' }, [{ id: 'm1', role: 'user', content: 'b', images: [image('compartida')] }]);
  const [own, edited, shared] = await blobIds('blob_a');
  const loose = (await Storage.saveBlob({ dataUrl: image('suelta').dataUrl, mimeType: 'image/png' })).id;

  // Quitar un mensaje con imagen recoge su blob y conserva el resto
  await Storage.saveConversation({ id: 'blob_a', title: 'A' }, [{ id: 'm1', role: 'user', content: 'a', images: [image('propia'), image('compartida')] }]);
  assert.equal(await Storage.getBlob(edited), null);
  assert.ok(await Storage.getBlob(shared));

  await Storage.deleteConversation('blob_a');
  assert.equal(await Storage.getBlob(own), null);
  assert.ok(await Storage.getBlob(shared));

  await Storage.deleteAllConversations();
  assert.equal(await Storage.getBlob(shared), null);
  assert.ok(await Storage.getBlob(loose), 'Un blob que ninguna conversación referenciaba no se toca');
});

test('Storage IndexedDB - gestión, deduplicación y validación de bordes en blobs', async () => {
  const text = 'Hello ZeroChat Blob!';
  const base64Data = Buffer.from(text).toString('base64');
  const dataUrl = `data:text/plain;base64,${base64Data}`;
  const crypto = require('node:crypto');
  const expectedSha = crypto.createHash('sha256').update(Buffer.from(text)).digest('hex');

  const saved = await Storage.saveBlob({ dataUrl, mimeType: 'text/plain' });
  assert.equal(saved.id, expectedSha);
  assert.equal(saved.mimeType, 'text/plain');
  assert.equal(saved.size, Buffer.from(text).length);
  assert.equal(saved.dataUrl, dataUrl);

  const retrieved = await Storage.getBlob(expectedSha);
  assert.equal(retrieved.id, expectedSha);
  assert.equal(retrieved.dataUrl, dataUrl);
  assert.equal(await Storage.getBlob('0'.repeat(64)), null);
  assert.equal((await Storage.saveBlob({ dataUrl })).id, expectedSha);

  const bytes = new Uint8Array(Buffer.from('binary-content'));
  const binarySha = crypto.createHash('sha256').update(Buffer.from('binary-content')).digest('hex');
  const savedBinary = await Storage.saveBlob({ bytes, mimeType: 'application/octet-stream' });
  assert.equal(savedBinary.id, binarySha);
  assert.equal(savedBinary.size, bytes.length);
  assert.match(savedBinary.dataUrl, /^data:application\/octet-stream;base64,/);

  await assert.rejects(Storage.saveBlob(null), /Blob data is required/);
  await assert.rejects(Storage.saveBlob({}), /Blob data cannot be empty/);
  await assert.rejects(Storage.saveBlob({ bytes: new Uint8Array(0) }), /Blob data cannot be empty/);
});

test('Storage.searchConversations busca en títulos y mensajes y descarga pendientes si hay servidor', async t => {
  const MCP = require('../../js/mcp.js');
  await Storage.deleteAllConversations();
  await Storage.saveConversation(
    { id: 's_title', title: 'Informe financiero', createdAt: 100, updatedAt: 100 },
    [{ id: 'm1', role: 'user', content: 'Hola mundo' }]
  );
  await Storage.saveConversation(
    { id: 's_text', title: 'Charla general', createdAt: 200, updatedAt: 200 },
    [{ id: 'm2', role: 'assistant', content: 'Revisar el archivo Caddyfile del proxy' }]
  );
  await Storage.saveConversation(
    { id: 's_parts', title: 'Multimodal', createdAt: 300, updatedAt: 300 },
    [{ id: 'm3', role: 'user', content: [{ type: 'text', text: 'Fragmento multimodal secreto' }] }]
  );

  // Pendiente remota que solo tiene cabecera local hasta buscar conectado.
  let connected = true;
  const remoteConv = {
    id: 's_remote',
    title: 'Desde CLI',
    createdAt: 400,
    updatedAt: 400,
    history: [{ id: 'mr1', role: 'assistant', content: 'Resultado remoto con palabra clave Caddyfile' }]
  };
  t.mock.method(MCP.manager, 'isProxyConnected', () => connected);
  t.mock.method(MCP.manager, 'requestExternalControl', async (method, params) => {
    if (method === 'zerochat/conversations/list') return { conversations: [{ id: 's_remote', title: 'Desde CLI', createdAt: 400, updatedAt: 400, messageCount: 1 }] };
    if (method === 'zerochat/conversations/get' && params.id === 's_remote') return { conversation: remoteConv };
    if (method === 'zerochat/conversations/save') return { ok: true };
    throw new Error(`Unexpected RPC ${method}`);
  });

  await Storage.getConversationsList();
  connected = false;
  assert.deepEqual(Array.from(await Storage.searchConversations('caddyfile')).sort(), ['s_text']);

  connected = true;
  const phases = [];
  assert.deepEqual(Array.from(await Storage.searchConversations('caddyfile', { onProgress: p => phases.push(p) })).sort(), ['s_remote', 's_text']);
  assert.deepEqual(phases, [
    { phase: 'syncing', done: 0, total: 1 },
    { phase: 'syncing', done: 1, total: 1 },
    { phase: 'searching' }
  ]);
  assert.deepEqual(Array.from(await Storage.searchConversations('secreto')), ['s_parts']);
  assert.deepEqual(Array.from(await Storage.searchConversations('financiero')), ['s_title']);

  connected = false;
  await Storage.deleteAllConversations();
});

test('Storage.saveRemoteConversation divide conversaciones grandes en tramos bajo el tope y parte mensajes enormes sin romper sustitutos UTF-16', async () => {
  const chunkLimit = Storage.CONVERSATION_SAVE_CHUNK_BYTES;
  const encoder = new TextEncoder();
  const calls = [];
  const fakeBackend = async (method, params) => {
    const wireBytes = encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })).length;
    assert.ok(wireBytes <= chunkLimit, `${method} (${wireBytes} B) debe quedar bajo ${chunkLimit} B`);
    calls.push({ method, params });
    return { ok: true };
  };

  // Varios mensajes que juntos superan el tope de tramo, más un único mensaje con emojis en la frontera UTF-16.
  const hugeContent = `${'A'.repeat(chunkLimit - 1024)}${'🚀'.repeat(40000)}`;
  const messages = [
    { id: 'm1', role: 'user', content: 'x'.repeat(Math.floor(chunkLimit * 0.6)) },
    { id: 'm2', role: 'assistant', content: 'y'.repeat(Math.floor(chunkLimit * 0.6)) },
    { id: 'm3', role: 'tool', content: hugeContent, tool_call_id: 'call_1' }
  ];

  await Storage.saveRemoteConversation(fakeBackend, { id: 'conv_chunked', title: 'Grande' }, messages);

  assert.ok(calls.length >= 4);
  assert.equal(calls.at(-1).method, 'zerochat/conversations/save');
  assert.ok(calls.at(-1).params.uploadId);
  assert.equal(calls.at(-1).params.messages, undefined);

  const chunkCalls = calls.slice(0, -1);
  assert.ok(chunkCalls.every((c, i) => c.method === 'zerochat/conversations/save_chunk' && c.params.chunkIndex === i && c.params.totalChunks === chunkCalls.length));

  // Reconstruir los mensajes recibidos y verificar que los emojis no tienen reemplazo \uFFFD.
  const reconstructed = [];
  let parts = [];
  let partBase = null;
  for (const c of chunkCalls) {
    if (c.params.messages) {
      reconstructed.push(...c.params.messages);
    } else if (c.params.messagePart) {
      const mp = c.params.messagePart;
      if (mp.partIndex === 0) partBase = { ...mp.message };
      parts.push(mp.content);
      if (mp.partIndex === mp.totalParts - 1) {
        reconstructed.push({ ...partBase, content: parts.join('') });
        parts = [];
        partBase = null;
      }
    }
  }
  assert.equal(reconstructed.length, 3);
  assert.equal(reconstructed[2].content, hugeContent);
  assert.equal(reconstructed[2].tool_call_id, 'call_1');
  assert.ok(!reconstructed[2].content.includes('\uFFFD'));
});

test('Storage.saveRemoteConversation comprueba el tope de tramos en el borde y libera la subida si falla un tramo', async () => {
  const max = Storage.MAX_CONVERSATION_UPLOAD_CHUNKS;
  // Cada mensaje ocupa más de medio tramo: un tramo por mensaje, con el mismo texto compartido.
  const content = 'x'.repeat(Math.floor(Storage.CONVERSATION_SAVE_CHUNK_BYTES * 0.6));
  const messagesFor = count => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: 'user', content }));
  const recorder = (failAt = -1) => {
    const calls = [];
    const backend = async (method, params) => {
      calls.push({ method, params });
      if (method === 'zerochat/conversations/save_chunk' && params.chunkIndex === failAt) throw new Error('tramo caído');
      return { ok: true };
    };
    return { calls, backend };
  };

  const ok = recorder();
  await Storage.saveRemoteConversation(ok.backend, { id: 'conv_max', title: 'Tope' }, messagesFor(max));
  assert.equal(ok.calls.filter(c => c.method === 'zerochat/conversations/save_chunk').length, max);
  assert.equal(ok.calls.at(-1).method, 'zerochat/conversations/save');

  const over = recorder();
  await assert.rejects(Storage.saveRemoteConversation(over.backend, { id: 'conv_over', title: 'Tope+1' }, messagesFor(max + 1)), /up to 512/);
  assert.equal(over.calls.length, 0);

  const failing = recorder(1);
  await assert.rejects(Storage.saveRemoteConversation(failing.backend, { id: 'conv_fail', title: 'Falla' }, messagesFor(3)), /tramo caído/);
  const cancel = failing.calls.at(-1);
  assert.equal(cancel.method, 'zerochat/conversations/cancel_upload');
  assert.deepEqual(cancel.params, { uploadId: failing.calls[0].params.uploadId, conversationId: 'conv_fail' });
});

test('Storage - clearAllStorage elimina datos RAG y cachés sin borrar bases ajenas', async () => {
  const db = await Database.openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(Database.STORES.ragDocuments, 'readwrite');
    tx.objectStore(Database.STORES.ragDocuments).put({ id: 'document', content: 'test' });
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
  await new Promise(resolve => {
    const request = indexedDB.open('unrelated-file-origin-database');
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  const originalCaches = global.caches;
  const deleted = [];
  global.caches = { keys: async () => ['webllm/model', 'webllm/wasm'], delete: async name => { deleted.push(name); return true; } };
  try {
    assert.equal(await Storage.clearAllStorage(), true);
    assert.deepEqual(await indexedDB.databases(), [{ name: 'unrelated-file-origin-database', version: 1 }]);
    assert.deepEqual(deleted.sort(), ['webllm/model', 'webllm/wasm']);
  } finally {
    global.caches = originalCaches;
    await Database.closeDatabase();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('unrelated-file-origin-database');
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }
});

test('Storage - clearAllStorage tolera Service Worker no disponible e informa errores de caché sin saltar IndexedDB', async () => {
  await Database.openDatabase();
  const originalCaches = global.caches;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  global.caches = { keys: async () => { throw new Error('Storage denied'); } };
  try {
    assert.equal(await Storage.clearAllStorage(), false);
    assert.match(Storage.getLastClearAllStorageError(), /^Cache Storage: Storage denied$/);
    assert.deepEqual(await indexedDB.databases(), []);

    global.caches = originalCaches;
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistrations: async () => {
            throw new Error("Failed to get ServiceWorkerRegistration objects: The URL protocol of the current origin ('null') is not supported.");
          }
        }
      }
    });
    assert.equal(await Storage.clearAllStorage(), true);
  } finally {
    global.caches = originalCaches;
    if (navigatorDescriptor) Object.defineProperty(global, 'navigator', navigatorDescriptor);
    else delete global.navigator;
  }
});
