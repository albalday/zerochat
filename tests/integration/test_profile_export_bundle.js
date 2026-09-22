const test = require('node:test');
const assert = require('node:assert/strict');
const ProfileExportBundle = require('../../js/profile-export-bundle.js');

test('ProfileExportBundle - aísla cada intento con un identificador de transferencia efímero', () => {
  const html = ProfileExportBundle.generateExportHTML('{"encrypted":true}', { profileCount: 1 });

  assert.match(html, /function createTransferId\(\)/);
  assert.match(html, /const targetName = 'zerochat_import_' \+ activeTransferId/);
  assert.match(html, /#mode=import&transferId=/);
  assert.match(html, /event\.source !== targetWindow/);
  assert.match(html, /event\.data\.transferId !== activeTransferId/);
  assert.match(html, /window\.addEventListener\('message', handleMessage\)/);
  assert.doesNotMatch(html, /window\.open\(TARGET_URL, 'zerochat_import'\)/);
});
