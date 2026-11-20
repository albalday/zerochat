const test = require('node:test');
const assert = require('node:assert/strict');
const UIBrowser = require('../../js/ui-browser.js');
const Defaults = require('../../js/defaults.js');
const CONTRACT = require('../fixtures/mcp/contract.json');

const SAVED = { mode: 'own', engine: 'chromium', userBrowser: 'chrome', headless: true, extensionToken: '' };
const NOTHING = { tokenInvalid: false, setConfig: false, offerRestart: false, start: false };
const plan = (changes, status) => UIBrowser.getSavePlan({ tool: 'playwright', savedTool: 'playwright', config: SAVED, savedConfig: SAVED, ...changes }, status);

test('UIBrowser.getSavePlan - decide envío, reinicio y arranque según herramienta, cambios y estado', () => {
  const autofilled = { ...SAVED, mode: 'user', extensionToken: 'contraseña guardada!' };
  for (const tool of ['browser_action', 'none']) {
    assert.deepEqual(plan({ tool, savedTool: 'none', config: autofilled }, 'stopped'), NOTHING, tool);
  }

  const changed = { ...SAVED, headless: false };
  assert.deepEqual(plan({ config: changed }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: changed }, 'stopped'), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({ config: changed }, null), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({}, 'running'), NOTHING);
  assert.deepEqual(plan({ config: null, savedConfig: null }, 'running'), NOTHING);

  for (const status of ['stopped', 'error']) {
    assert.deepEqual(plan({ savedTool: 'browser_action' }, status), { ...NOTHING, start: true }, status);
  }
  for (const status of ['running', 'starting', null]) {
    assert.deepEqual(plan({ savedTool: 'none' }, status), NOTHING, String(status));
  }
  assert.deepEqual(plan({ savedTool: 'playwright' }, 'stopped'), NOTHING);
  assert.deepEqual(plan({ savedTool: 'none', config: { ...SAVED, engine: 'firefox' } }, 'error'), { ...NOTHING, setConfig: true, start: true });
});

test('UIBrowser - motores, navegadores del usuario y tokens de la extensión coinciden con el backend (tests/fixtures/mcp/contract.json)', () => {
  assert.deepEqual(Defaults.BROWSER_TOOLS, CONTRACT.browserTools);
  assert.deepEqual(Defaults.PLAYWRIGHT_ENGINES, CONTRACT.playwrightEngines);
  assert.deepEqual(Defaults.USER_BROWSERS, CONTRACT.userBrowsers);
  for (const extensionToken of CONTRACT.extensionTokens.valid) {
    assert.deepEqual(plan({ config: { ...SAVED, extensionToken } }, 'running'), { ...NOTHING, setConfig: extensionToken !== '', offerRestart: extensionToken !== '' }, extensionToken);
  }
  for (const extensionToken of CONTRACT.extensionTokens.invalid) {
    assert.deepEqual(plan({ config: { ...SAVED, extensionToken } }, 'running'), { ...NOTHING, tokenInvalid: true }, extensionToken);
  }
});

test('UIBrowser - el token admite pegar la línea de entorno que muestra la extensión, con o sin comillas', () => {
  const cases = [
    [' tok_1 ', 'tok_1'],
    [' PLAYWRIGHT_MCP_EXTENSION_TOKEN=tok_1 ', 'tok_1'],
    ['PLAYWRIGHT_MCP_EXTENSION_TOKEN = "tok-2"', 'tok-2'],
    ["'tok_3'", 'tok_3'],
    ['"tok_4\'', '"tok_4\'']
  ];
  for (const [value, expected] of cases) assert.equal(UIBrowser.normalizeExtensionToken(value), expected, value);
});
