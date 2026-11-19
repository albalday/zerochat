const test = require('node:test');
const assert = require('node:assert');
const ChatAttachments = require('../../js/attachments.js');

test('ChatAttachments - gestiona adjuntos y construye payload con texto, imágenes, blobId y documentos ofimáticos', () => {
  ChatAttachments.clearFiles();
  try {
    const fakeBlobId = 'a'.repeat(64);
    ChatAttachments.addFile({ name: 'datos.txt', size: 1024, type: 'text', content: 'col1,col2\n1,2' });
    ChatAttachments.addFile({ name: 'foto.png', size: 2048, type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,123', blobId: fakeBlobId });
    ChatAttachments.addFile({
      name: 'ventas.xlsx', size: 2048, type: 'office', format: 'xlsx', documentKind: 'Excel spreadsheet',
      content: '## Sheet: Ventas\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Image: Image 1 (attached image 1)]',
      images: [{ name: 'ventas.xlsx: Image 1', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }]
    });
    assert.equal(ChatAttachments.getFiles().length, 3);

    const payload = ChatAttachments.buildAttachmentsPayload('Analiza esto:');
    assert.ok(payload.fullPrompt.includes('--- File: datos.txt'));
    assert.ok(payload.fullPrompt.includes('--- Image: foto.png'));
    assert.ok(payload.fullPrompt.includes('--- Excel spreadsheet: ventas.xlsx (2 KB) ---\n```markdown\n## Sheet: Ventas'));
    assert.equal(payload.imageAttachments.length, 2);
    assert.equal(payload.imageAttachments[0].blobId, fakeBlobId);
    assert.equal(payload.imageAttachments[0].size, 2048);
    assert.deepEqual(payload.imageAttachments[1], { name: 'ventas.xlsx: Image 1', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' });
    assert.ok(payload.displayText.includes('Analiza esto:') && payload.displayText.includes('datos.txt') && payload.displayText.endsWith('📄 ventas.xlsx]'));

    ChatAttachments.removeFileAt(0);
    assert.equal(ChatAttachments.getFiles().length, 2);
    assert.equal(ChatAttachments.getFiles()[0].name, 'foto.png');
  } finally {
    ChatAttachments.clearFiles();
  }
});

test('ChatAttachments - el tope de tamaño admite MAX_FILE_SIZE y rechaza un byte más', () => {
  const max = ChatAttachments.MAX_FILE_SIZE;
  assert.equal(ChatAttachments.validateFileSize({ name: 'borde.pdf', size: max }).valid, true);
  assert.equal(ChatAttachments.validateFileSize({ name: 'grande.pdf', size: max + 1 }).valid, false);
  assert.equal(ChatAttachments.validateFileSize({ name: 'grande.pdf', size: max + 1 }).reason, 'too_large');
});
