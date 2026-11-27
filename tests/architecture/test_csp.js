const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/** Directivas de la meta CSP de una página, como nombre -> lista de fuentes; null si no la tiene. */
function pageCsp(file) {
  const html = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const content = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
  if (!content) return null;
  return new Map(content.split(';').map(part => part.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...sources]) => [name, sources]));
}

test('Security - la CSP de zerochat.html restringe objetos, base, formularios, marcos, manifiesto y medios', () => {
  const csp = pageCsp('zerochat.html');
  assert.ok(csp, 'zerochat.html debe contener la etiqueta meta CSP');
  // WebLLM se ejecuta desde una copia verificada en blob: (js/providers-webllm.js): ningún script de un CDN.
  assert.deepEqual(csp.get('default-src'), ["'self'"]);
  assert.deepEqual(csp.get('script-src'), ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:'], 'La CSP no admite scripts de otros orígenes');
  assert.deepEqual(csp.get('worker-src'), ["'self'", 'blob:'], 'Los workers solo desde la propia página o blob:');
  assert.deepEqual(csp.get('object-src'), ["'none'"]);
  assert.deepEqual(csp.get('base-uri'), ["'self'"]);
  assert.deepEqual(csp.get('form-action'), ["'none'"], 'Los formularios se envían por JavaScript, nunca navegando');
  assert.deepEqual(csp.get('frame-src'), ["'self'", 'blob:']);
  assert.deepEqual(csp.get('manifest-src'), ["'self'"]);
  assert.deepEqual(csp.get('media-src'), ["'self'", 'data:', 'blob:']);
});

test('Security - files.html mantiene su CSP estricta sin scripts ni marcos externos', () => {
  const csp = pageCsp('files.html');
  assert.ok(csp, 'files.html debe contener la etiqueta meta CSP');
  for (const [name, sources] of [['default-src', ["'self'"]], ['script-src', ["'self'"]], ['object-src', ["'none'"]], ['base-uri', ["'self'"]], ['form-action', ["'none'"]], ['frame-src', ["'none'"]]]) {
    assert.deepEqual(csp.get(name), sources, `La CSP de files.html debe incluir ${name} ${sources.join(' ')}`);
  }
});
