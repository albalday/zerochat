const test = require('node:test');
const assert = require('node:assert/strict');
const ProfileExportBundle = require('../../js/profile-export-bundle.js');
const I18n = require('../../js/i18n.js');
const { installDom } = require('../helpers/dom-env.js');

function generate(t, payload = '{"encrypted":true}', metadata = { profileCount: 2 }) {
  const dom = installDom({ url: 'http://127.0.0.1:6388/app/zerochat.html' });
  t.after(() => dom.restore());
  return ProfileExportBundle.generateExportHTML(payload, metadata);
}

test('ProfileExportBundle - aísla cada intento con un identificador de transferencia efímero', t => {
  const html = generate(t);
  assert.match(html, /function createTransferId\(\)/);
  assert.match(html, /const targetName = 'zerochat_import_' \+ activeTransferId/);
  assert.match(html, /#mode=import&transferId=/);
  assert.match(html, /event\.source !== targetWindow/);
  assert.match(html, /event\.data\.transferId !== activeTransferId/);
  assert.match(html, /const TARGET_URL = "http:\/\/127\.0\.0\.1:6388\/app\/zerochat\.html"/);
});

test('ProfileExportBundle - los textos salen en el idioma activo y los estados se muestran como texto', t => {
  I18n.setLanguage('en');
  t.after(() => I18n.setLanguage('es'));
  const html = generate(t, '</script><script>alert(1)</script>');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /2 encrypted connection profile\(s\)/);
  assert.match(html, /"importFailed":"The profiles could not be imported: \{error\}"/);
  assert.doesNotMatch(html, /innerHTML/, 'Los mensajes de la otra pestaña no se insertan como HTML');
  assert.equal(html.includes('</script><script>alert(1)'), false, 'Los datos embebidos no pueden cerrar el script');
});
