const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

test('Security - files.html mantiene su CSP estricta sin scripts ni marcos externos', () => {
  const html = fs.readFileSync(path.join(__dirname, '../..', 'files.html'), 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];

  assert.ok(csp, 'files.html debe contener la etiqueta meta CSP');
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-src 'none'"]) {
    assert.ok(csp.split(';').map(part => part.trim()).includes(directive), `La CSP de files.html debe incluir ${directive}`);
  }
});
