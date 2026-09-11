const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Markdown = require('../js/markdown.js');
const WebBrowser = require('../js/web-browser.js');

test('Security - Sanitización de URLs en Markdown.sanitizeUrl', () => {
  // URLs válidas y seguras
  assert.equal(Markdown.sanitizeUrl('https://example.com'), 'https://example.com');
  assert.equal(Markdown.sanitizeUrl('http://localhost:1234/api'), 'http://localhost:1234/api');
  assert.equal(Markdown.sanitizeUrl('mailto:user@example.com'), 'mailto:user@example.com');

  // Bloqueo estricto de esquemas peligrosos
  assert.equal(Markdown.sanitizeUrl('javascript:alert(1)'), '#');
  assert.equal(Markdown.sanitizeUrl('JAVASCRIPT:alert(document.cookie)'), '#');
  assert.equal(Markdown.sanitizeUrl('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(Markdown.sanitizeUrl('vbscript:msgbox(1)'), '#');
  assert.equal(Markdown.sanitizeUrl('file:///etc/passwd'), '#');

  // Prevención de inyección de comillas en atributos href
  const injected = Markdown.sanitizeUrl('https://example.com" onclick="alert(1)');
  assert.ok(!injected.includes('"'), 'Las comillas deben estar escapadas');
  assert.ok(injected.includes('&quot;'));
});

test('Security - Sanitización de URLs de imagen en Markdown.sanitizeImageUrl', () => {
  // URLs de imagen legítimas
  assert.equal(Markdown.sanitizeImageUrl('https://example.com/img.jpg'), 'https://example.com/img.jpg');
  assert.equal(Markdown.sanitizeImageUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
  assert.equal(Markdown.sanitizeImageUrl('blob:http://localhost:8080/1234-5678'), 'blob:http://localhost:8080/1234-5678');

  // Bloqueo de URLs peligrosas
  assert.equal(Markdown.sanitizeImageUrl('javascript:alert(1)'), '');
  assert.equal(Markdown.sanitizeImageUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(Markdown.sanitizeImageUrl('vbscript:msgbox(1)'), '');
  assert.equal(Markdown.sanitizeImageUrl('file:///etc/shadow'), '');
});

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

test('Security - Validación de URLs y mitigación SSRF en WebBrowser', () => {
  // URL pública válida
  const resValid = WebBrowser.validateUrlForFetch('https://es.wikipedia.org/wiki/Sol');
  assert.equal(resValid.valid, true);

  // Intento de SSRF contra endpoint de metadatos cloud (169.254.169.254)
  const resMetadata = WebBrowser.validateUrlForFetch('http://169.254.169.254/latest/meta-data/');
  assert.equal(resMetadata.valid, false);
  assert.match(resMetadata.error, /metadatos/i);

  // Intento de protocolo local file://
  const resFile = WebBrowser.validateUrlForFetch('file:///etc/passwd');
  assert.equal(resFile.valid, false);
  assert.match(resFile.error, /Protocolo no permitido/i);

  // Intento de protocolo javascript:
  const resJs = WebBrowser.validateUrlForFetch('javascript:alert(1)');
  assert.equal(resJs.valid, false);
});

test('Security - Presencia de Content Security Policy (CSP) en index.html', () => {
  const indexPath = path.join(__dirname, '..', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'Debe contener la etiqueta meta CSP');
  assert.ok(html.includes('https://esm.run'), 'La CSP debe permitir el módulo WebLLM fijado');
  assert.ok(html.includes("object-src 'none'"), 'CSP debe bloquear objetos embebidos');
  assert.ok(html.includes("base-uri 'self'"), 'CSP debe restringir base-uri');
});
