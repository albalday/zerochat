const test = require('node:test');
const assert = require('node:assert/strict');
const UIBrowser = require('../../js/ui-browser.js');

const SAVED = { mode: 'own', engine: 'chromium', userBrowser: 'chrome', headless: true, extensionToken: '' };
const NOTHING = { tokenInvalid: false, setConfig: false, offerRestart: false, start: false };
const plan = (changes, status) => UIBrowser.getSavePlan({ tool: 'playwright', savedTool: 'playwright', config: SAVED, savedConfig: SAVED, ...changes }, status);

test('UIBrowser - con otra herramienta Guardar no valida ni envía la configuración de Playwright', () => {
  // Firefox rellenaba el token oculto con una contraseña guardada y el servidor rechazaba la configuración.
  const autofilled = { ...SAVED, mode: 'user', extensionToken: 'contraseña guardada!' };
  for (const tool of ['browser_action', 'none']) {
    assert.deepEqual(plan({ tool, savedTool: 'none', config: autofilled }, 'stopped'), NOTHING, tool);
  }
});

test('UIBrowser - el token de la extensión admite hasta 256 caracteres de su alfabeto', () => {
  assert.deepEqual(plan({ config: { ...SAVED, extensionToken: 'a'.repeat(256) } }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: { ...SAVED, extensionToken: 'a'.repeat(257) } }, 'running'), { ...NOTHING, tokenInvalid: true });
  assert.deepEqual(plan({ config: { ...SAVED, extensionToken: 'tok 1' } }, 'running'), { ...NOTHING, tokenInvalid: true });
});

test('UIBrowser - una configuración cambiada se envía y solo con Playwright MCP en marcha se ofrece reiniciarlo', () => {
  const changed = { ...SAVED, headless: false };
  assert.deepEqual(plan({ config: changed }, 'running'), { ...NOTHING, setConfig: true, offerRestart: true });
  assert.deepEqual(plan({ config: changed }, 'stopped'), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({ config: changed }, null), { ...NOTHING, setConfig: true });
  assert.deepEqual(plan({}, 'running'), NOTHING, 'Sin cambios no se envía nada');
  // Sin Playwright instalado no se cargó la configuración: no hay nada que validar ni enviar.
  assert.deepEqual(plan({ config: null, savedConfig: null }, 'running'), NOTHING);
});

test('UIBrowser - elegir de nuevo Playwright MCP lo arranca si está detenido o falló', () => {
  for (const status of ['stopped', 'error']) {
    assert.deepEqual(plan({ savedTool: 'browser_action' }, status), { ...NOTHING, start: true }, status);
  }
  for (const status of ['running', 'starting', null]) {
    assert.deepEqual(plan({ savedTool: 'none' }, status), NOTHING, String(status));
  }
  assert.deepEqual(plan({ savedTool: 'playwright' }, 'stopped'), NOTHING, 'Ya elegido no se arranca al guardar');
  assert.deepEqual(plan({ savedTool: 'none', config: { ...SAVED, engine: 'firefox' } }, 'error'), { ...NOTHING, setConfig: true, start: true });
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
