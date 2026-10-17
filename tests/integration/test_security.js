const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Markdown = require('../../js/markdown.js');

test('Security - Renderizado seguro de enlaces en Markdown', () => {
  // Enlace legítimo
  const safeMd = '[Página Segura](https://example.com)';
  const safeHtml = Markdown.parseMarkdown(safeMd);
  assert.ok(safeHtml.includes('href="https://example.com"'));
  assert.ok(safeHtml.includes('rel="noopener noreferrer"'));
  assert.ok(safeHtml.includes('target="_blank"'));

  // Intento de XSS vía enlace javascript:
  const xssMd = '[Ataque XSS](javascript:alert(1))';
  const xssHtml = Markdown.parseMarkdown(xssMd);
  assert.ok(!xssHtml.includes('href="javascript:'), 'No debe renderizar enlaces javascript:');
});

test('Security - Presencia de Content Security Policy (CSP) en zerochat.html', () => {
  const indexPath = path.join(__dirname, '../..', 'zerochat.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'Debe contener la etiqueta meta CSP');
  assert.ok(html.includes('https://esm.run'), 'La CSP debe permitir el módulo WebLLM fijado');
  assert.ok(html.includes("worker-src 'self' blob: https://esm.run https://cdn.jsdelivr.net"), 'La CSP debe permitir el worker aislado y su módulo WebLLM');
  assert.ok(html.includes("object-src 'none'"), 'CSP debe bloquear objetos embebidos');
  assert.ok(html.includes("base-uri 'self'"), 'CSP debe restringir base-uri');
  assert.ok(html.includes("frame-src 'self' blob:"), 'CSP debe restringir frame-src a self y blob');
  assert.ok(html.includes("manifest-src 'self'"), 'CSP debe restringir manifest-src');
  assert.ok(html.includes("media-src 'self' data: blob:"), 'CSP debe restringir media-src');
});
