const test = require('node:test');
const assert = require('node:assert');
const ChatAttachments = require('../js/attachments.js');

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

test('ChatAttachments - Sincronización transparente con ChatState.ui.attachedFiles', () => {
  const ChatState = require('../js/state.js');
  ChatAttachments.clearFiles();
  assert.deepEqual(ChatState.get('ui').attachedFiles, []);

  ChatAttachments.addFile({ name: 'directo.txt', size: 50, type: 'text', content: 'test' });
  assert.equal(ChatState.get('ui').attachedFiles.length, 1);
  assert.equal(ChatState.get('ui').attachedFiles[0].name, 'directo.txt');

  ChatState.setAttachments([
    { name: 'desde_state.pdf', size: 200, type: 'pdf', content: 'doc' }
  ]);
  assert.equal(ChatAttachments.getFiles().length, 1);
  assert.equal(ChatAttachments.getFiles()[0].name, 'desde_state.pdf');

  ChatAttachments.clearFiles();
  assert.equal(ChatState.get('ui').attachedFiles.length, 0);
});

test('ChatAttachments - Validación de tamaño máximo de archivo', () => {
  assert.equal(ChatAttachments.MAX_FILE_SIZE, 50 * 1024 * 1024);

  // Archivo aceptable (10 MB)
  const okFile = { name: 'documento.pdf', size: 10 * 1024 * 1024 };
  const resOk = ChatAttachments.validateFileSize(okFile);
  assert.equal(resOk.valid, true);

  // Archivo demasiado grande (51 MB)
  const largeFile = { name: 'video.mp4', size: 51 * 1024 * 1024 };
  const resLarge = ChatAttachments.validateFileSize(largeFile);
  assert.equal(resLarge.valid, false);
  assert.equal(resLarge.reason, 'too_large');

  // Límite personalizado
  const customLimit = ChatAttachments.validateFileSize({ size: 100 }, 50);
  assert.equal(customLimit.valid, false);
});

test('ChatAttachments - renderChips escapa caracteres peligrosos y comillas en nombres de archivo', () => {
  const container = {
    innerHTML: '',
    style: {},
    children: [],
    appendChild: (child) => container.children.push(child)
  };
  global.document = {
    createElement: () => ({
      className: '',
      innerHTML: '',
      querySelector: () => ({ addEventListener: () => {} })
    })
  };

  ChatAttachments.clearFiles();
  ChatAttachments.addFile({ name: "archivo<script>'\"&.pdf", size: 1024, type: 'pdf' });
  ChatAttachments.renderChips(container);

  assert.equal(container.children.length, 1);
  const chipHtml = container.children[0].innerHTML;
  assert.ok(chipHtml.includes('&lt;script&gt;'));
  assert.ok(chipHtml.includes('&#39;'));
  assert.ok(chipHtml.includes('&quot;'));
  assert.ok(chipHtml.includes('&amp;'));
  assert.equal(chipHtml.includes('<script>'), false);
});
