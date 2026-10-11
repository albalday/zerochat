const fs = require('node:fs');
const path = require('node:path');
const { Window } = require('happy-dom');

// DOM real (happy-dom) para las pruebas sin navegador: los módulos reciben elementos completos,
// así que no necesitan respaldos para métodos que un objeto simulado no tuviera.

const ROOT_DIR = path.resolve(__dirname, '../..');
const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'Node', 'Element', 'HTMLElement', 'HTMLDialogElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'HTMLButtonElement', 'DocumentFragment', 'DOMParser', 'Event', 'CustomEvent',
  'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent', 'ClipboardEvent', 'DragEvent',
  'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'FileReader', 'DataTransfer'
];

let appMarkup = null;

/** Cuerpo de zerochat.html sin scripts: los mismos elementos que recibe la aplicación. */
function getAppMarkup() {
  if (appMarkup === null) {
    const html = fs.readFileSync(path.join(ROOT_DIR, 'zerochat.html'), 'utf8');
    const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
    appMarkup = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  }
  return appMarkup;
}

/**
 * Instala un DOM real como entorno global. Con `app: true` el documento contiene el marcado de
 * zerochat.html. Devuelve el window y una función que restaura los globales anteriores.
 */
function installDom({ html = '', app = false, url = 'http://127.0.0.1:6388/zerochat.html' } = {}) {
  const window = new Window({ url, settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  window.document.body.innerHTML = app ? getAppMarkup() : html;
  const previous = new Map();
  for (const name of DOM_GLOBALS) {
    if (!(name in window)) continue;
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = name === 'window' ? window : window[name];
    Object.defineProperty(globalThis, name, {
      value: typeof value === 'function' && !/^[A-Z]/.test(name) ? value.bind(window) : value,
      configurable: true,
      writable: true
    });
  }
  return {
    window,
    document: window.document,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      window.happyDOM.abort();
      window.close();
    }
  };
}

/** Mapa de elementos por propiedad a partir de sus id (`{ btnSend: 'btn-send' }`). */
function getElements(document, ids) {
  return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, document.getElementById(id)]));
}

module.exports = { installDom, getAppMarkup, getElements };
