const test = require('node:test');
const assert = require('node:assert');
const ChatUtils = require('../../js/utils.js');
const { installDom } = require('../helpers/dom-env.js');

test('ChatUtils - escapa HTML y sanea URLs y orígenes de imagen no confiables', () => {
  assert.strictEqual(ChatUtils.escapeHtml('<script>alert("XSS")&\'test\'</script>'), '&lt;script&gt;alert(&quot;XSS&quot;)&amp;&#39;test&#39;&lt;/script&gt;');
  assert.strictEqual(ChatUtils.escapeHtml(null), '');
  assert.strictEqual(ChatUtils.escapeHtml(undefined), '');

  assert.equal(ChatUtils.sanitizeUrl('https://example.test/" onclick="alert(1)'), 'https://example.test/&quot; onclick=&quot;alert(1)');
  assert.equal(ChatUtils.sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(ChatUtils.sanitizeUrl('//evil.test/path'), '#');
  assert.equal(ChatUtils.sanitizeImageUrl('https://example.test/a.png'), 'https://example.test/a.png');
  assert.equal(ChatUtils.sanitizeImageUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('javascript:alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('data:image/png;base64,AAAA\n BBBB=='), 'data:image/png;base64,AAAABBBB==');
  assert.equal(ChatUtils.sanitizeImageUrl('data:image/png;base64,AAAA" onerror="alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('data:image/png;base64,AAAA<script>'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('https://example.test/a.png?w=1&h=2'), 'https://example.test/a.png?w=1&h=2');
  assert.equal(ChatUtils.sanitizeImageUrl('https://example.test/a.png" onerror="alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('blob:https://example.test/1234 onerror=alert(1)'), '');
});

test('ChatUtils - primitivas de DOM separan texto no confiable de HTML interno', () => {
  const dom = installDom();
  try {
    const parent = document.createElement('div');
    const child = ChatUtils.appendTextElement(parent, 'span', '<img src=x onerror=alert(1)>', { className: 'safe-text' });
    assert.equal(child.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(child.className, 'safe-text');
    assert.equal(parent.querySelector('img'), null);
    assert.equal(parent.children.length, 1);
    ChatUtils.clearElement(parent);
    assert.equal(parent.children.length, 0);
  } finally {
    dom.restore();
  }
});

test('ChatUtils - serializeContent, clone, formatShortValue y resolveDep', () => {
  assert.strictEqual(ChatUtils.serializeContent('Hola mundo'), 'Hola mundo');
  assert.strictEqual(ChatUtils.serializeContent([{ type: 'text', text: 'Parte' }]), '[{"type":"text","text":"Parte"}]');
  assert.strictEqual(ChatUtils.serializeContent({ ok: true }), '{"ok":true}');
  assert.strictEqual(ChatUtils.serializeContent(undefined), '');
  assert.strictEqual(ChatUtils.serializeContent(42), '42');

  const original = { a: 1, b: [2, 3], c: { d: 'test' } };
  const copia = ChatUtils.clone(original);
  assert.deepStrictEqual(copia, original);
  assert.notStrictEqual(copia, original);
  assert.notStrictEqual(copia.c, original.c);

  assert.strictEqual(ChatUtils.formatShortValue(500), 500);
  assert.strictEqual(ChatUtils.formatShortValue(1500), '1.5k');
  assert.strictEqual(ChatUtils.formatShortValue(20000), '20.0k');
  assert.strictEqual(ChatUtils.formatShortValue(NaN), '0');

  const resolved = ChatUtils.resolveDep('ChatUtils', '../js/utils.js');
  assert.ok(resolved);
  assert.strictEqual(typeof resolved.escapeHtml, 'function');
});

test('ChatUtils - fetchWithTimeout combina la señal de quien llama con el plazo', async () => {
  const originalFetch = global.fetch;
  const signals = [];
  global.fetch = async (_url, options) => { signals.push(options.signal); return { ok: true }; };
  try {
    const caller = new AbortController();
    await ChatUtils.fetchWithTimeout('http://x', { signal: caller.signal }, 20);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(signals[0].aborted, false, 'Terminada la petición, el plazo ya no la cancela');

    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const withCaller = new AbortController();
    await assert.rejects(ChatUtils.fetchWithTimeout('http://x', { signal: withCaller.signal }, 20), /abort/i, 'El plazo se aplica aunque haya señal propia');

    const cancelled = new AbortController();
    const pending = ChatUtils.fetchWithTimeout('http://x', { signal: cancelled.signal }, 0);
    let settled = false;
    pending.catch(() => {}).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(settled, false, 'Con plazo 0 solo cancela quien llama');
    cancelled.abort();
    await assert.rejects(pending);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatUtils - openImageInNewTab abre URLs seguras en visor HTML Blob con noopener', () => {
  const dom = installDom();
  try {
    const opened = [];
    window.open = (url, target, features) => {
      opened.push({ url, target, features });
      return { document: {} };
    };

    ChatUtils.openImageInNewTab('javascript:alert(1)');
    ChatUtils.openImageInNewTab('');
    ChatUtils.openImageInNewTab('rag-image://doc:img');
    assert.equal(opened.length, 0);

    ChatUtils.openImageInNewTab('https://example.com/foto.jpg', 'Foto de prueba');
    assert.equal(opened.length, 1);
    assert.ok(opened[0].url.startsWith('blob:'));
    assert.equal(opened[0].target, '_blank');
    assert.equal(opened[0].features, 'noopener,noreferrer');

    ChatUtils.openImageInNewTab('blob:https://example.com/uuid');
    assert.equal(opened.length, 2);
    assert.ok(opened[1].url.startsWith('blob:'));

    ChatUtils.openImageInNewTab('data:image/png;base64,iVBORw0KGgo=');
    assert.equal(opened.length, 3);
    assert.ok(opened[2].url.startsWith('blob:'));
  } finally {
    dom.restore();
  }
});
