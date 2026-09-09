const { test } = require('node:test');
const assert = require('node:assert/strict');
const I18n = require('../js/i18n.js');

test('I18n - Traducción básica y fallback', () => {
  assert.ok(I18n.TRANSLATIONS.es, 'Debe existir diccionario español');
  assert.ok(I18n.TRANSLATIONS.en, 'Debe existir diccionario inglés');
  
  const esKeys = Object.keys(I18n.TRANSLATIONS.es);
  const enKeys = Object.keys(I18n.TRANSLATIONS.en);
  
  // Comprobar paridad de claves entre idiomas
  const missingInEn = esKeys.filter(k => !(k in I18n.TRANSLATIONS.en));
  const missingInEs = enKeys.filter(k => !(k in I18n.TRANSLATIONS.es));
  
  assert.deepEqual(missingInEn, [], 'No deben faltar claves en el diccionario en');
  assert.deepEqual(missingInEs, [], 'No deben faltar claves en el diccionario es');
});

test('I18n - Reemplazo dinámico de parámetros en t()', () => {
  const t = I18n.t;
  const msg = t('field_temperature', { val: '0.85' });
  assert.match(msg, /0\.85/);
});

test('I18n - uiText centraliza textos visibles con fallback local', () => {
  assert.equal(I18n.uiText('rag_modal_title'), I18n.t('rag_modal_title'));
  assert.equal(I18n.uiText('__missing_ui_key__', 'Fallback visible'), 'Fallback visible');
});

test('I18n - Traducciones del conocimiento local', () => {
  I18n.setLanguage('es', false);
  assert.equal(I18n.t('rag_modal_title'), 'Conocimiento local');
  assert.ok(I18n.t('rag_help_storage_desc').includes('IndexedDB'));
  assert.match(I18n.t('rag_help_llm_desc'), /temperatura baja/);

  I18n.setLanguage('en', false);
  assert.equal(I18n.t('rag_modal_title'), 'Local knowledge');
  assert.ok(I18n.t('rag_help_storage_desc').includes('Orama'));
  assert.match(I18n.t('rag_help_llm_desc'), /low temperature/);
});

test('I18n - Título de la aplicación solo contiene ZeroChat y la versión', () => {
  I18n.setLanguage('es', false);
  assert.match(I18n.t('app_title'), /^ZeroChat v[^\s-]+$/);

  I18n.setLanguage('en', false);
  assert.match(I18n.t('app_title'), /^ZeroChat v[^\s-]+$/);
  I18n.setLanguage('es', false);
});

test('I18n - Listener reactivo onChange se ejecuta al cambiar idioma', () => {
  let callCount = 0;
  let receivedLang = null;

  const unsubscribe = I18n.onChange(lang => {
    callCount++;
    receivedLang = lang;
  });

  try {
    I18n.setLanguage('en', false);
    assert.equal(callCount, 1);
    assert.equal(receivedLang, 'en');
    assert.equal(I18n.getLanguage(), 'en');

    // Comprobar formateo en inglés
    const enText = I18n.t('rag_branch_summary_format', { count: 5, plural: 's', bytes: '12 MB' });
    assert.equal(enText, '5 documents of 12 MB');

    I18n.setLanguage('es', false);
    assert.equal(callCount, 2);
    assert.equal(receivedLang, 'es');
    assert.equal(I18n.getLanguage(), 'es');

    // Comprobar formateo en español
    const esText = I18n.t('rag_branch_summary_format', { count: 5, plural: 's', bytes: '12 MB' });
    assert.equal(esText, '5 documentos de 12 MB');
  } finally {
    unsubscribe();
  }

  // Tras cancelar suscripción, no debe invocarse
  I18n.setLanguage('en', false);
  assert.equal(callCount, 2, 'El listener desuscrito no debe ejecutarse');

  // Restaurar idioma por defecto
  I18n.setLanguage('es', false);
});
