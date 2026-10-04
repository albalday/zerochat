const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ROOT, 'zerochat.html'), 'utf8');
const compatScript = html.match(/<head>\s*<meta charset="UTF-8">\s*<script>([\s\S]*?)<\/script>/)[1];

function runCompatCheck(userAgent, maxTouchPoints, language) {
  let redirectedTo = null;
  const documentElement = { style: {} };
  vm.runInNewContext(compatScript, {
    navigator: { userAgent, maxTouchPoints, language },
    document: { documentElement },
    location: { replace: url => { redirectedTo = url; } }
  });
  return { redirectedTo, hidden: documentElement.style.display === 'none' };
}

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

test('Compatibilidad - WebKit se redirige a la ayuda en el idioma del navegador', () => {
  const cases = [
    ['Safari macOS', SAFARI_MAC, 0, 'es-ES', 'help/install.html#browser-compatibility'],
    ['Chrome iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1', 5, 'en-US', 'help/en/install.html#browser-compatibility'],
    ['Safari iPadOS', SAFARI_MAC, 5, 'en-GB', 'help/en/install.html#browser-compatibility']
  ];
  for (const [name, userAgent, touchPoints, language, expected] of cases) {
    assert.deepEqual(runCompatCheck(userAgent, touchPoints, language), { redirectedTo: expected, hidden: true }, name);
  }
  for (const helpPage of ['help/install.html', 'help/en/install.html']) {
    assert.match(fs.readFileSync(path.join(ROOT, helpPage), 'utf8'), /id="browser-compatibility"/, helpPage);
  }
});

test('Compatibilidad - Chrome y Firefox de escritorio no se redirigen', () => {
  const supported = {
    'Firefox macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Chrome macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Chrome Android': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
  };
  for (const [name, userAgent] of Object.entries(supported)) {
    assert.deepEqual(runCompatCheck(userAgent, 0, 'es-ES'), { redirectedTo: null, hidden: false }, name);
  }
});
