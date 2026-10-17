const { test } = require('node:test');
const assert = require('node:assert/strict');
const I18n = require('../../js/i18n.js');

test('I18n - los diccionarios es y en tienen las mismas claves', () => {
  const { es, en } = I18n.TRANSLATIONS;
  assert.deepEqual(Object.keys(es).filter(key => !(key in en)), [], 'Claves de es que faltan en en');
  assert.deepEqual(Object.keys(en).filter(key => !(key in es)), [], 'Claves de en que faltan en es');
});

test('I18n - t() inserta los valores literalmente, sin patrones especiales de replace', () => {
  const t = I18n.t;
  const template = t('field_temperature');
  const value = 'precio $& y $` fin $1 $$';
  assert.equal(t('field_temperature', { val: value }), template.replace('{val}', () => value));
  assert.equal(t('field_temperature', { val: 0 }), template.replace('{val}', '0'));
  assert.equal(t('field_temperature', { other: 'x' }), template);
});
