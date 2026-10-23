const test = require('node:test');
const assert = require('node:assert');
const ChatUtils = require('../../js/utils.js');

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
  assert.equal(ChatUtils.sanitizeImageUrl('https://example.test/a.png" onerror="alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('blob:https://example.test/1234 onerror=alert(1)'), '');
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



test('ChatUtils.createListenerGroup - dispose retira listeners y limpiezas, y el grupo admite un nuevo montaje', () => {
  const group = ChatUtils.createListenerGroup();
  const target = new EventTarget();
  const calls = [];
  group.listen(target, 'ping', () => calls.push('first'));
  group.onDispose(() => calls.push('cleanup'));
  target.dispatchEvent(new Event('ping'));
  group.dispose();
  target.dispatchEvent(new Event('ping'));
  assert.deepStrictEqual(calls, ['first', 'cleanup']);

  group.listen(target, 'ping', () => calls.push('second'));
  target.dispatchEvent(new Event('ping'));
  group.dispose();
  group.dispose();
  assert.deepStrictEqual(calls, ['first', 'cleanup', 'second'], 'Cada limpieza corre una sola vez');
});
