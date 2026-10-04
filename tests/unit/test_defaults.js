const test = require('node:test');
const assert = require('node:assert/strict');
const Defaults = require('../../js/defaults.js');

test('ChatDefaults - el tema predeterminado compartido es oscuro', () => {
  assert.equal(Defaults.DEFAULT_THEME, 'dark');
  assert.ok(Object.isFrozen(Defaults));
});

test('ChatDefaults - el contexto WebLLM predeterminado es 4K en móviles y 16K en el resto', () => {
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgentData: { mobile: true }, userAgent: 'X11; Linux' }), 4096);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgentData: { mobile: false }, userAgent: 'Android Mobile' }), 16384);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0' }), 4096);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' }), 16384);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize(null), 16384);
  assert.ok(Defaults.WEBLLM_CONTEXT_WINDOW_SIZES.includes(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE));
});
