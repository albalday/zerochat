const test = require('node:test');
const assert = require('node:assert/strict');

const HtmlDocument = require('../../js/html-document.js');
const WebBrowser = require('../../js/web-browser.js');

function nestDivs(depth, innerText) {
  return `${'<div>'.repeat(depth)}${innerText}${'</div>'.repeat(depth)}`;
}

test('ChatHtmlDocument - etiquetas con comilla sin cerrar se analizan en tiempo lineal acotado', () => {
  const hostile = '<a title="sin cerrar '.repeat(12000); // ~240 KiB
  const start = performance.now();
  const doc = HtmlDocument.parseHtml(hostile);
  const elapsedMs = performance.now() - start;

  assert.ok(elapsedMs < 500, `el análisis tardó ${elapsedMs.toFixed(1)} ms`);
  assert.ok(doc.body.textContent.length > 0);
});

test('ChatHtmlDocument - tope de profundidad en el borde exacto N y N+1 con recorridos iterativos', () => {
  const N = HtmlDocument.MAX_DEPTH;

  const atLimit = HtmlDocument.parseHtml(nestDivs(N, 'fondo'));
  assert.equal(atLimit.truncated, false);
  assert.equal(atLimit.truncationNotice, '');
  assert.equal(atLimit.querySelectorAll('div').length, N);
  assert.equal(atLimit.body.textContent, 'fondo');
  assert.equal(atLimit.body.cloneNode(true).textContent, 'fondo');

  const overLimit = HtmlDocument.parseHtml(nestDivs(N + 1, 'fondo'));
  assert.equal(overLimit.truncated, true);
  assert.equal(overLimit.truncationNotice, HtmlDocument.DEPTH_TRUNCATION_NOTICE);
  assert.equal(overLimit.querySelectorAll('div').length, N + 1);
  assert.equal(overLimit.body.textContent, 'fondo');
  assert.equal(overLimit.body.cloneNode(true).textContent, 'fondo');

  const extracted = WebBrowser.extractReadableTextFromHtml(nestDivs(N + 1, 'fondo'), 'https://example.com');
  assert.ok(extracted.includes(HtmlDocument.DEPTH_TRUNCATION_NOTICE));
});
