const test = require('node:test');
const assert = require('node:assert');
const { installDom } = require('../helpers/dom-env.js');

const ChatDebug = require('../../js/debug.js');
const ChatRagService = require('../../js/rag-service.js');

function mountDebugLog(t) {
  const dom = installDom();
  t.after(() => dom.restore());
  const debugLogContent = document.createElement('div');
  document.body.appendChild(debugLogContent);
  ChatDebug.setElements({ debugLogContent });
  return debugLogContent;
}

test('Error Infrastructure - ChatDebug registra unhandledrejection y error sin lanzar', t => {
  const log = mountDebugLog(t);
  assert.equal(ChatDebug.registerGlobalErrorHandlers(window), true);

  const rejection = new Event('unhandledrejection');
  rejection.reason = new Error('Promesa rechazada de prueba');
  window.dispatchEvent(rejection);
  const entries = () => log.querySelectorAll('.debug-entry');
  assert.equal(entries().length, 1);
  assert.equal(entries()[0].getAttribute('data-type'), 'error');
  assert.match(entries()[0].innerHTML, /Unhandled Promise/);
  assert.match(entries()[0].innerHTML, /Promesa rechazada de prueba/);

  const runtimeError = new Event('error');
  Object.assign(runtimeError, { message: 'TypeError inesperado en script', filename: 'app.js', lineno: 42 });
  window.dispatchEvent(runtimeError);
  assert.equal(entries().length, 2);
  assert.match(entries()[1].innerHTML, /Runtime Error/);
  assert.match(entries()[1].innerHTML, /TypeError inesperado en script at app\.js:42/);

  // Una cancelación con AbortError se ignora silenciosamente.
  const abortError = new Error('The user aborted a request.');
  abortError.name = 'AbortError';
  const aborted = new Event('unhandledrejection');
  aborted.reason = abortError;
  window.dispatchEvent(aborted);
  assert.equal(entries().length, 2, 'AbortError no debe registrarse como error del sistema');
});

test('Error Infrastructure - ChatDebug soporta tipo warning y filtrado', t => {
  const log = mountDebugLog(t);
  ChatDebug.addLog('warning', 'Aviso de prueba');
  const entry = log.querySelector('.debug-entry');
  assert.equal(entry.getAttribute('data-type'), 'warning');
  assert.ok(entry.classList.contains('debug-entry-warning'));

  ChatDebug.filterLogs('network');
  assert.equal(entry.style.display, 'flex', 'El filtro de red incluye los avisos');
  ChatDebug.filterLogs('thinking');
  assert.equal(entry.style.display, 'none');
  ChatDebug.filterLogs('all');
  assert.equal(entry.style.display, 'flex');
});

test('Error Infrastructure - buildRagSystemContext degrada a texto vacío ante fallo sin lanzar', async () => {
  const origWarn = console.warn;
  let warnCalled = false;
  console.warn = () => { warnCalled = true; };
  try {
    const result = await ChatRagService.buildRagSystemContext(['invalid_branch_id_test']);
    assert.equal(result, '');
    assert.equal(warnCalled, true, 'buildRagSystemContext debe emitir advertencia ante fallo');
  } finally {
    console.warn = origWarn;
  }
});
