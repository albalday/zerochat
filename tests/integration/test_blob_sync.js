const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const MCP = require('../../js/mcp.js');
const Storage = require('../../js/storage.js');
const Database = require('../../js/storage-db.js');

test('Sincronización de blobs desacoplados entre frontend y backend local', async t => {
  // Configuración de mock backend para blobs y conversaciones
  const backendBlobs = new Map();
  const backendConversations = new Map();
  const rpcCalls = [];

  t.mock.method(MCP.manager, 'isProxyConnected', () => true);
  t.mock.method(MCP.manager, 'requestExternalControl', async (method, params, options) => {
    rpcCalls.push({ method, params, options });
    if (method === 'zerochat/blobs/has') {
      const ids = params?.ids || [];
      const existing = ids.filter(id => backendBlobs.has(id));
      const missing = ids.filter(id => !backendBlobs.has(id));
      return { existing, missing };
    }
    if (method === 'zerochat/blobs/put') {
      const { id, mimeType, data } = params;
      backendBlobs.set(id, { id, mimeType, data });
      return { id, mimeType, size: data.length };
    }
    if (method === 'zerochat/blobs/get') {
      const blob = backendBlobs.get(params?.id);
      return { blob: blob ? { id: blob.id, mimeType: blob.mimeType, size: blob.data.length, data: blob.data.split(',')[1] || blob.data } : null };
    }
    if (method === 'zerochat/conversations/save') {
      const { conversation, messages = [] } = params;
      backendConversations.set(conversation.id, { ...conversation, history: messages });
      return { conversation: { ...conversation, history: messages } };
    }
    if (method === 'zerochat/conversations/get') {
      return { conversation: backendConversations.get(params?.id) || null };
    }
    throw new Error(`Método no soportado en mock: ${method}`);
  });

  try {
    const rawImage1 = 'datos-binarios-imagen-1'.repeat(100);
    const b64Image1 = Buffer.from(rawImage1).toString('base64');
    const dataUrl1 = `data:image/png;base64,${b64Image1}`;
    const expectedSha1 = crypto.createHash('sha256').update(Buffer.from(rawImage1)).digest('hex');

    const rawImage2 = 'datos-binarios-imagen-2'.repeat(100);
    const b64Image2 = Buffer.from(rawImage2).toString('base64');
    const dataUrl2 = `data:image/jpeg;base64,${b64Image2}`;
    const expectedSha2 = crypto.createHash('sha256').update(Buffer.from(rawImage2)).digest('hex');

    const convId = 'sync_conv_blobs_1';
    const sessionMeta = { id: convId, title: 'Chat con imágenes grandes', createdAt: Date.now(), updatedAt: Date.now() };

    // Dos mensajes con imágenes; el segundo reutiliza image1 para probar deduplicación
    const messages = [
      {
        id: 'msg_1',
        role: 'user',
        content: 'Primer mensaje con imagen 1',
        images: [{ name: 'img1.png', dataUrl: dataUrl1, mimeType: 'image/png' }]
      },
      {
        id: 'msg_2',
        role: 'user',
        content: 'Segundo mensaje con imagen 2 e imagen 1 duplicada',
        images: [
          { name: 'img2.jpg', dataUrl: dataUrl2, mimeType: 'image/jpeg' },
          { name: 'img1_copia.png', dataUrl: dataUrl1, mimeType: 'image/png' }
        ]
      }
    ];

    // 1. Guardar la conversación
    await Storage.saveConversation(sessionMeta, messages);

    // 2. Verificar que se consultaron los blobs con zerochat/blobs/has
    const hasCalls = rpcCalls.filter(call => call.method === 'zerochat/blobs/has');
    assert.equal(hasCalls.length, 1);
    assert.ok(hasCalls[0].params.ids.includes(expectedSha1));
    assert.ok(hasCalls[0].params.ids.includes(expectedSha2));

    // 3. Verificar que se subieron los blobs con zerochat/blobs/put (exactamente 2, deduplicados)
    const putCalls = rpcCalls.filter(call => call.method === 'zerochat/blobs/put');
    assert.equal(putCalls.length, 2, 'Deben subirse solo los 2 blobs únicos');
    const uploadedIds = putCalls.map(c => c.params.id);
    assert.ok(uploadedIds.includes(expectedSha1));
    assert.ok(uploadedIds.includes(expectedSha2));

    // Cabecera X-ZeroChat-Blob presente para el tope extendido de body
    for (const call of putCalls) {
      assert.equal(call.options?.headers?.['X-ZeroChat-Blob'], '1');
    }

    // 4. Verificar que zerochat/conversations/save recibió mensajes ligeros SIN dataUrl
    const saveCalls = rpcCalls.filter(call => call.method === 'zerochat/conversations/save');
    assert.equal(saveCalls.length, 1);
    const savedMessages = saveCalls[0].params.messages;
    assert.equal(savedMessages.length, 2);

    for (const msg of savedMessages) {
      for (const img of msg.images) {
        assert.equal(img.dataUrl, undefined, 'dataUrl no debe viajar en el historial del mensaje');
        assert.ok(img.blobId && (img.blobId === expectedSha1 || img.blobId === expectedSha2));
      }
    }

    // El payload total de los mensajes guardados debe ser diminuto (< 1 KiB)
    const payloadSize = JSON.stringify(savedMessages).length;
    assert.ok(payloadSize < 1024, `El tamaño del payload (${payloadSize} bytes) debe ser menor a 1 KiB`);

    // 5. Segunda llamada de guardado: ningún blob se vuelve a subir
    rpcCalls.length = 0;
    await Storage.saveConversation(sessionMeta, messages);
    const secondPutCalls = rpcCalls.filter(call => call.method === 'zerochat/blobs/put');
    assert.equal(secondPutCalls.length, 0, 'No se deben resubir blobs ya existentes en el servidor');

    // 6. Recuperar la conversación y verificar hidratación de dataUrl
    const loaded = await Storage.getConversation(convId);
    assert.ok(loaded);
    assert.equal(loaded.history.length, 2);
    assert.equal(loaded.history[0].images[0].dataUrl, dataUrl1);
    assert.equal(loaded.history[1].images[0].dataUrl, dataUrl2);
    assert.equal(loaded.history[1].images[1].dataUrl, dataUrl1);
  } finally {
    await Database.closeDatabase();
  }
});
