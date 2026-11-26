const test = require('node:test');
const assert = require('node:assert/strict');
const UIBrowser = require('../../js/ui-browser.js');
const Defaults = require('../../js/defaults.js');
const CONTRACT = require('../fixtures/mcp/contract.json');

const SAVED = { mode: 'own', engine: 'chromium', userBrowser: 'chrome', headless: true, userAgentMode: 'auto', userAgent: '' };
const NOTHING = { userAgentInvalid: false, setConfig: false, offerRestart: false };
const plan = (changes, status) => UIBrowser.getSavePlan({ tool: 'playwright', config: SAVED, savedConfig: SAVED, ...changes }, status);

test('UIBrowser.getSavePlan - decide validación, envío y reinicio según herramienta, cambios y estado', () => {
  const invalid = { ...SAVED, userAgentMode: 'custom', userAgent: '' };
  for (const tool of ['browser_action', 'none']) {
    assert.deepEqual(plan({ tool, config: invalid }, 'stopped'), NOTHING, tool);
  }

  const changed = { ...SAVED, headless: false };
  assert.deepEqual(plan({ config: changed }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: changed }, 'stopped'), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({ config: changed }, null), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({}, 'running'), NOTHING);
  assert.deepEqual(plan({ config: null, savedConfig: null }, 'running'), NOTHING);
  assert.deepEqual(plan({ config: { ...SAVED, engine: 'firefox' } }, 'error'), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({ config: { ...SAVED, userAgentMode: 'custom', userAgent: '' } }, 'running'), { ...NOTHING, userAgentInvalid: true });
  // Los navegadores instalados y el del usuario envían su User-Agent: el personalizado no se pide ni se valida.
  assert.deepEqual(plan({ config: { ...SAVED, engine: 'chrome', userAgentMode: 'custom', userAgent: '' } }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: { ...SAVED, mode: 'user', userAgentMode: 'custom', userAgent: '' } }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: { ...SAVED, userAgentMode: 'custom', userAgent: 'UA\ninject' } }, 'running'), { ...NOTHING, userAgentInvalid: true });
  assert.deepEqual(plan({ config: { ...SAVED, userAgentMode: 'custom', userAgent: 'Mozilla/5.0 Test/1.0' } }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: { ...SAVED, userAgentMode: 'custom', userAgent: 'x'.repeat(CONTRACT.userAgentMaxLength) } }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: { ...SAVED, userAgentMode: 'custom', userAgent: 'x'.repeat(CONTRACT.userAgentMaxLength + 1) } }, 'running'), { ...NOTHING, userAgentInvalid: true });
});

test('UIBrowser - motores, navegadores del usuario y tokens de la extensión coinciden con el backend (tests/fixtures/mcp/contract.json)', () => {
  assert.deepEqual(Defaults.BROWSER_TOOLS, CONTRACT.browserTools);
  assert.deepEqual(Defaults.USER_BROWSERS, CONTRACT.userBrowsers);
  assert.deepEqual(Defaults.OWN_SYSTEM_ENGINES, CONTRACT.ownSystemEngines);
  assert.deepEqual(Defaults.USER_AGENT_MODES, CONTRACT.userAgentModes);
  for (const token of CONTRACT.extensionTokens.valid) assert.equal(UIBrowser.parseExtensionToken(token), token, token);
  for (const token of CONTRACT.extensionTokens.invalid) assert.equal(UIBrowser.parseExtensionToken(token), null, token);
});

test('UIBrowser - el token admite pegar la línea de entorno que muestra la extensión, con o sin comillas', () => {
  const cases = [
    [' tok_1 ', 'tok_1'],
    [' PLAYWRIGHT_MCP_EXTENSION_TOKEN=tok_1 ', 'tok_1'],
    ['PLAYWRIGHT_MCP_EXTENSION_TOKEN = "tok-2"', 'tok-2'],
    ["'tok_3'", 'tok_3'],
    ['"tok_4\'', null]
  ];
  for (const [value, expected] of cases) assert.equal(UIBrowser.parseExtensionToken(value), expected, value);
});
