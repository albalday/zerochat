const test = require('node:test');
const assert = require('node:assert');
const ChatUtils = require('../js/utils.js');

test('ChatUtils.escapeHtml escapa caracteres peligrosos', () => {
  assert.strictEqual(ChatUtils.escapeHtml('<script>alert("XSS")&\'test\'</script>'), '&lt;script&gt;alert(&quot;XSS&quot;)&amp;&#39;test&#39;&lt;/script&gt;');
  assert.strictEqual(ChatUtils.escapeHtml(null), '');
  assert.strictEqual(ChatUtils.escapeHtml(undefined), '');
});

test('ChatUtils - primitivas de DOM separan texto no confiable de HTML interno', () => {
  const documentMock = {
    createElement: (tagName) => ({ tagName, className: '', textContent: '' })
  };
  const parent = {
    ownerDocument: documentMock,
    children: [],
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; }
  };

  const child = ChatUtils.appendTextElement(parent, 'span', '<img src=x onerror=alert(1)>', { className: 'safe-text' });
  assert.equal(child.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(child.className, 'safe-text');
  assert.equal(parent.children.length, 1);
  ChatUtils.clearElement(parent);
  assert.equal(parent.children.length, 0);
});

test('ChatUtils.serializeContent maneja strings, arrays multipart y objetos', () => {
  assert.strictEqual(ChatUtils.serializeContent('Hola mundo'), 'Hola mundo');
  assert.strictEqual(ChatUtils.serializeContent([{ text: 'Parte 1' }, { content: 'Parte 2' }, 'Parte 3']), 'Parte 1\nParte 2\nParte 3');
  assert.strictEqual(ChatUtils.serializeContent({ text: 'Objeto texto' }), 'Objeto texto');
  assert.strictEqual(ChatUtils.serializeContent(null), '');
});

test('ChatUtils.clone realiza copia profunda', () => {
  const original = { a: 1, b: [2, 3], c: { d: 'test' } };
  const copia = ChatUtils.clone(original);
  assert.deepStrictEqual(copia, original);
  assert.notStrictEqual(copia, original);
  assert.notStrictEqual(copia.c, original.c);
});

test('ChatUtils.formatShortValue formatea miles con k', () => {
  assert.strictEqual(ChatUtils.formatShortValue(500), 500);
  assert.strictEqual(ChatUtils.formatShortValue(1500), '1.5k');
  assert.strictEqual(ChatUtils.formatShortValue(20000), '20.0k');
  assert.strictEqual(ChatUtils.formatShortValue(NaN), '0');
});

test('ChatUtils.resolveDep resuelve módulos en Node.js', () => {
  const resolved = ChatUtils.resolveDep('ChatUtils', '../js/utils.js');
  assert.ok(resolved);
  assert.strictEqual(typeof resolved.escapeHtml, 'function');
});
