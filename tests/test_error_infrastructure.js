const test = require('node:test');
const assert = require('node:assert');

function setupMockDocument() {
  global.document = {
    createElement: (tag) => {
      const attrs = {};
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        style: {},
        setAttribute: (k, v) => { attrs[k] = v; },
        getAttribute: (k) => attrs[k] || null,
        innerHTML: '',
        textContent: '',
        querySelector: () => null,
        querySelectorAll: () => []
      };
      return el;
    }
  };
}

setupMockDocument();

const ChatDebug = require('../js/debug.js');
const ChatState = require('../js/state.js');
const ChatRagService = require('../js/rag-service.js');

test('Error Infrastructure - ChatDebug registra unhandledrejection y error sin lanzar', () => {
  setupMockDocument();
  const listeners = {};
  const mockWindow = {
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    }
  };

  const logs = [];
  const mockDom = {
    debugLogContent: {
      appendChild: (el) => logs.push(el),
      scrollTop: 0,
      scrollHeight: 100
    }
  };
  ChatDebug.setElements(mockDom);

  // Registrar en mockWindow
  const registered = ChatDebug.registerGlobalErrorHandlers(mockWindow);
  assert.equal(registered, true);
  assert.ok(typeof listeners.unhandledrejection === 'function');
  assert.ok(typeof listeners.error === 'function');

  // 1. Simular unhandledrejection
  listeners.unhandledrejection({ reason: new Error('Promesa rechazada de prueba') });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].getAttribute('data-type'), 'error');
  assert.match(logs[0].innerHTML, /Unhandled Promise/);
  assert.match(logs[0].innerHTML, /Promesa rechazada de prueba/);

  // 2. Simular error de runtime
  listeners.error({ message: 'TypeError inesperado en script', filename: 'app.js', lineno: 42 });
  assert.equal(logs.length, 2);
  assert.equal(logs[1].getAttribute('data-type'), 'error');
  assert.match(logs[1].innerHTML, /Runtime Error/);
  assert.match(logs[1].innerHTML, /TypeError inesperado en script at app\.js:42/);

  // 3. Simular cancelación con AbortError: debe ignorarse silenciosamente
  const abortError = new Error('The user aborted a request.');
  abortError.name = 'AbortError';
  listeners.unhandledrejection({ reason: abortError });
  listeners.error({ error: abortError });
  assert.equal(logs.length, 2, 'AbortError no debe registrarse como error del sistema');
});

test('Error Infrastructure - ChatDebug soporta tipo warning y filtrado', () => {
  setupMockDocument();
  const logs = [];
  const mockDom = {
    debugLogContent: {
      appendChild: (el) => logs.push(el),
      querySelectorAll: () => logs,
      scrollTop: 0,
      scrollHeight: 100
    }
  };
  ChatDebug.setElements(mockDom);

  ChatDebug.addLog('warning', 'Aviso de prueba');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].getAttribute('data-type'), 'warning');
  assert.ok(logs[0].className.includes('debug-entry-warning'));

  // Filtrado por network debe incluir warnings
  ChatDebug.filterLogs('network');
  assert.equal(logs[0].style.display, 'flex');

  // Filtrado por thinking debe ocultar warnings
  ChatDebug.filterLogs('thinking');
  assert.equal(logs[0].style.display, 'none');

  // Filtrado por all debe mostrar warnings
  ChatDebug.filterLogs('all');
  assert.equal(logs[0].style.display, 'flex');
});

test('Error Infrastructure - ChatState.streaming persiste status error y mensaje', () => {
  const store = ChatState.createStore();

  // Inicio de generación
  store.set('streaming', { isGenerating: true, status: 'streaming', error: null });
  assert.equal(store.get('streaming').isGenerating, true);
  assert.equal(store.get('streaming').status, 'streaming');
  assert.equal(store.get('streaming').error, null);

  // Fallo de generación
  store.set('streaming', { isGenerating: false, status: 'error', error: 'Fallo de conexión al servidor' });
  const errState = store.get('streaming');
  assert.equal(errState.isGenerating, false);
  assert.equal(errState.status, 'error');
  assert.equal(errState.error, 'Fallo de conexión al servidor');

  // Nueva generación resetea el error
  store.set('streaming', { isGenerating: true, status: 'streaming', error: null });
  const resetState = store.get('streaming');
  assert.equal(resetState.isGenerating, true);
  assert.equal(resetState.status, 'streaming');
  assert.equal(resetState.error, null);
});

test('Error Infrastructure - buildRagSystemContext degrada a texto vacío ante fallo sin lanzar', async () => {
  const origWarn = console.warn;
  let warnCalled = false;
  console.warn = () => { warnCalled = true; };
  try {
    const result = await ChatRagService.buildRagSystemContext(['invalid_branch_id_test']);
    assert.equal(typeof result, 'string');
    assert.equal(result, '');
    assert.equal(warnCalled, true, 'buildRagSystemContext debe emitir advertencia ante fallo');
  } finally {
    console.warn = origWarn;
  }
});

test('Error Infrastructure - No se generan alertas de usuario (notices) ante fallos técnicos', () => {
  const store = ChatState.createStore();
  assert.equal(store.get('ui').notices.length, 0);

  // Un error de streaming o de depuración nunca debe alterar ui.notices
  store.set('streaming', { isGenerating: false, status: 'error', error: 'Internal failure' });
  assert.equal(store.get('ui').notices.length, 0, 'ui.notices debe permanecer intacto');
});

