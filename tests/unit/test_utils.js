const test = require('node:test');
const assert = require('node:assert');
const ChatUtils = require('../../js/utils.js');
const ChatUIConnection = require('../../js/ui-connection.js');
const ChatI18n = require('../../js/i18n.js');

test('ChatUtils - escapa HTML y sanea URLs y orígenes de imagen no confiables', () => {
  assert.strictEqual(ChatUtils.escapeHtml('<script>alert("XSS")&\'test\'</script>'), '&lt;script&gt;alert(&quot;XSS&quot;)&amp;&#39;test&#39;&lt;/script&gt;');
  assert.strictEqual(ChatUtils.escapeHtml(null), '');
  assert.strictEqual(ChatUtils.escapeHtml(undefined), '');

  assert.equal(ChatUtils.sanitizeUrl('https://example.test/" onclick="alert(1)'), 'https://example.test/&quot; onclick=&quot;alert(1)');
  assert.equal(ChatUtils.sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(ChatUtils.sanitizeUrl('//evil.test/path'), '#');
  for (const hidden of ['\x01javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', ' \x00javascript:alert(1)', 'javascript\x7f:alert(1)', '\x03//evil.test']) {
    assert.equal(ChatUtils.sanitizeUrl(hidden), '#', JSON.stringify(hidden));
  }
  assert.equal(ChatUtils.sanitizeUrl('https://e.test/\ta'), 'https://e.test/a');
  assert.equal(ChatUtils.sanitizeImageUrl('https://example.test/a.png'), 'https://example.test/a.png');
  assert.equal(ChatUtils.sanitizeImageUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('javascript:alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('data:image/png;base64,AAAA\n BBBB=='), 'data:image/png;base64,AAAABBBB==');
  assert.equal(ChatUtils.sanitizeImageUrl('data:image/png;base64,AAAA" onerror="alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('data:image/png;base64,AAAA<script>'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('https://example.test/a.png" onerror="alert(1)'), '');
  assert.equal(ChatUtils.sanitizeImageUrl('blob:https://example.test/1234 onerror=alert(1)'), '');
});

test('ChatUtils - fetchWithTimeout combina la señal de quien llama con el plazo', async t => {
  const originalFetch = global.fetch;
  const signals = [];
  global.fetch = async (_url, options) => { signals.push(options.signal); return { ok: true }; };
  // Reloj simulado: el plazo vence al avanzarlo, sin esperas reales.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const caller = new AbortController();
    await ChatUtils.fetchWithTimeout('http://x', { signal: caller.signal }, 20);
    t.mock.timers.tick(40);
    assert.equal(signals[0].aborted, false, 'Terminada la petición, el plazo ya no la cancela');

    global.fetch = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const withCaller = new AbortController();
    const timedOut = ChatUtils.fetchWithTimeout('http://x', { signal: withCaller.signal }, 20);
    t.mock.timers.tick(20);
    await assert.rejects(timedOut, /abort/i, 'El plazo se aplica aunque haya señal propia');

    const cancelled = new AbortController();
    const pending = ChatUtils.fetchWithTimeout('http://x', { signal: cancelled.signal }, 0);
    let settled = false;
    pending.catch(() => {}).finally(() => { settled = true; });
    t.mock.timers.tick(10 ** 6);
    await Promise.resolve();
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

test('UIConnection - un bloqueo por intentos fallidos indica los minutos de espera, redondeados hacia arriba', () => {
  const locked = retryAfter => ChatUIConnection.loginErrorMessage({ rpcError: { code: -32002, data: { retryAfter } } });
  assert.equal(locked(900), ChatI18n.t('login_locked', { minutes: 15 }));
  assert.equal(locked(61), ChatI18n.t('login_locked', { minutes: 2 }));
  assert.equal(locked(1), ChatI18n.t('login_locked', { minutes: 1 }));
  assert.equal(ChatUIConnection.loginErrorMessage(new Error('Failed to fetch')), 'Failed to fetch');
});

test('Utils.matchesToolDecision solo acepta la llamada aprobada, con los argumentos en cualquier orden', () => {
  const decision = { toolName: 'run_command', args: { command: 'npm test', timeout_seconds: 60 }, decision: 'allow_once' };
  assert.strictEqual(ChatUtils.matchesToolDecision(decision, 'run_command', { timeout_seconds: 60, command: 'npm test' }), true);
  assert.strictEqual(ChatUtils.matchesToolDecision(decision, 'run_command', { command: 'rm -rf build', timeout_seconds: 60 }), false);
  assert.strictEqual(ChatUtils.matchesToolDecision(decision, 'run_command', { command: 'npm test' }), false);
  assert.strictEqual(ChatUtils.matchesToolDecision(decision, 'write_file', { command: 'npm test', timeout_seconds: 60 }), false);
  // Sin argumentos aprobados no vale para ninguna llamada.
  assert.strictEqual(ChatUtils.matchesToolDecision({ toolName: 'run_command', decision: 'allow_once' }, 'run_command', {}), false);
  assert.strictEqual(ChatUtils.matchesToolDecision(null, 'run_command', {}), false);
  assert.strictEqual(ChatUtils.canonicalJson({ b: [{ d: 1, c: 2 }], a: 1 }), '{"a":1,"b":[{"c":2,"d":1}]}');
});
