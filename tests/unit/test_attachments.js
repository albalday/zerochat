const test = require('node:test');
const assert = require('node:assert');
const ChatAttachments = require('../../js/attachments.js');

test('ChatAttachments - Gestión del estado de adjuntos y formateo de payload', () => {
  ChatAttachments.clearFiles();
  assert.equal(ChatAttachments.getFiles().length, 0);

  ChatAttachments.addFile({ name: 'datos.txt', size: 1024, type: 'text', content: 'col1,col2\n1,2' });
  ChatAttachments.addFile({ name: 'foto.png', size: 2048, type: 'image', dataUrl: 'data:image/png;base64,123' });

  assert.equal(ChatAttachments.getFiles().length, 2);

  const payload = ChatAttachments.buildAttachmentsPayload('Analiza esto:');
  assert.ok(payload.fullPrompt.includes('--- File: datos.txt'));
  assert.ok(payload.fullPrompt.includes('--- Image: foto.png'));
  assert.equal(payload.imageAttachments.length, 1);
  assert.equal(payload.imageAttachments[0].name, 'foto.png');
  assert.ok(payload.displayText.includes('Analiza esto:'));
  assert.ok(payload.displayText.includes('datos.txt'));

  ChatAttachments.removeFileAt(0);
  assert.equal(ChatAttachments.getFiles().length, 1);
  assert.equal(ChatAttachments.getFiles()[0].name, 'foto.png');
});

test('ChatAttachments - el tope de tamaño admite MAX_FILE_SIZE y rechaza un byte más', () => {
  const max = ChatAttachments.MAX_FILE_SIZE;
  assert.equal(ChatAttachments.validateFileSize({ name: 'borde.pdf', size: max }).valid, true);
  assert.equal(ChatAttachments.validateFileSize({ name: 'grande.pdf', size: max + 1 }).valid, false);
  assert.equal(ChatAttachments.validateFileSize({ name: 'grande.pdf', size: max + 1 }).reason, 'too_large');
});

test('ChatAttachments - un documento ofimático aporta su cabecera, su Markdown y sus imágenes', () => {
  ChatAttachments.clearFiles();
  try {
    ChatAttachments.addFile({
      name: 'ventas.xlsx', size: 2048, type: 'office', format: 'xlsx', documentKind: 'Excel spreadsheet',
      content: '## Sheet: Ventas\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Image: Image 1 (attached image 1)]',
      images: [{ name: 'ventas.xlsx: Image 1', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }]
    });
    const payload = ChatAttachments.buildAttachmentsPayload('Resume');
    assert.ok(payload.fullPrompt.includes('--- Excel spreadsheet: ventas.xlsx (2 KB) ---\n```markdown\n## Sheet: Ventas'));
    assert.deepEqual(payload.imageAttachments, [{ name: 'ventas.xlsx: Image 1', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }]);
    assert.ok(payload.displayText.endsWith('[📄 ventas.xlsx]'));
  } finally {
    ChatAttachments.clearFiles();
  }
});
