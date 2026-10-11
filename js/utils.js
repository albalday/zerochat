/**
 * Módulo Universal de Utilidades Compartidas para ZeroChat.
 * ZeroChat - js/utils.js
 *
 * Centraliza funciones utilitarias esenciales (escapeHtml, fetchWithTimeout,
 * serializeContent, clone, createId, resolveDep, etc.) para eliminar
 * duplicación en toda la base de código.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Escapa caracteres especiales de HTML para prevenir inyecciones XSS.
   * @param {*} str 
   * @returns {string}
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Normaliza una URL no confiable para usarla en un atributo href. */
  function sanitizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '#';
    const trimmed = rawUrl.trim();
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(trimmed)) return escapeHtml(trimmed);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[\\/]{2}/.test(trimmed)) return escapeHtml(trimmed);
    return '#';
  }

  /**
   * Valida una URL no confiable como origen de imagen y la devuelve sin
   * escapar; quien la interpole en HTML debe escaparla en ese punto.
   */
  function sanitizeImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) return trimmed;
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s.]+$/i.test(trimmed)) return trimmed.replace(/\s+/g, '');
    if (/^blob:[^\s"'<>]+$/i.test(trimmed) || /^rag-image:\/\/[a-zA-Z0-9_\-:]+$/i.test(trimmed)) return trimmed;
    return '';
  }

  /**
   * Asigna contenido no confiable como texto, sin interpretarlo como HTML.
   * @param {Element|Object|null|undefined} element
   * @param {*} value
   * @returns {Element|Object|null|undefined}
   */
  function setText(element, value) {
    if (element) element.textContent = value === null || value === undefined ? '' : String(value);
    return element;
  }

  /**
   * Elimina el contenido de un contenedor sin analizar HTML.
   * @param {Element} element
   * @returns {Element}
   */
  function clearElement(element) {
    element.replaceChildren();
    return element;
  }

  /**
   * Añade un elemento cuyo contenido se asigna siempre mediante textContent.
   * @param {Element} parent
   * @param {string} tagName
   * @param {*} value
   * @param {{ className?: string }} [options]
   * @returns {Element}
   */
  function appendTextElement(parent, tagName, value, options = {}) {
    const element = parent.ownerDocument.createElement(tagName);
    if (options.className) element.className = options.className;
    setText(element, value);
    parent.appendChild(element);
    return element;
  }

  /**
   * Inserta HTML generado exclusivamente por código propio (por ejemplo SVGs).
   * Nunca debe recibir datos de red, proveedores, herramientas o usuarios.
   * @param {Element|Object|null|undefined} element
   * @param {string} html
   * @returns {Element|Object|null|undefined}
   */
  function setTrustedHtml(element, html) {
    if (element) element.innerHTML = html || '';
    return element;
  }

  /**
   * Realiza una petición fetch con timeout configurable (0: sin plazo). Si options.signal
   * existe, la petición se cancela con la primera de las dos señales.
   * @param {string|Request} resource
   * @param {Object} [options={}]
   * @param {number} [timeoutMs=8000]
   * @returns {Promise<Response>}
   */
  async function fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      return await fetch(resource, { ...options, signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Serializa el contenido de un mensaje para la API: el texto se conserva y el resto pasa a JSON.
   * @param {*} content
   * @returns {string}
   */
  function serializeContent(content) {
    if (typeof content === 'string') return content;
    if (content === undefined) return '';
    if (typeof content === 'object') return JSON.stringify(content);
    return String(content);
  }

  /**
   * Clona profundamente estructuras de datos JSON serializables.
   * @template T
   * @param {T} value 
   * @returns {T}
   */
  function clone(value) {
    if (value === undefined || value === null) return value;
    try {
      return structuredClone(value);
    } catch (_) {
      // Las funciones no se pueden clonar: la copia JSON las omite.
      return JSON.parse(JSON.stringify(value));
    }
  }

  /**
   * Identificador único con prefijo opcional (`session_…`, `msg_usr_…`).
   * @param {string} [prefix]
   * @returns {string}
   */
  function createId(prefix = '') {
    return prefix ? `${prefix}_${crypto.randomUUID()}` : crypto.randomUUID();
  }

  /**
   * Formatea un tamaño en bytes con la unidad adecuada (ej: 1536 -> "1.5 KB").
   * @param {number} bytes
   * @returns {string}
   */
  function formatBytes(bytes) {
    let value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB'];
    let index = -1;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index++;
    }
    return `${parseFloat(value.toFixed(1))} ${units[index]}`;
  }

  /**
   * Formatea números de forma compacta (ej: 1500 -> 1.5k).
   * @param {number} val 
   * @returns {string|number}
   */
  function formatShortValue(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return '0';
    return num >= 1000 ? (num / 1000).toFixed(1) + 'k' : num;
  }

  /**
   * Resuelve un módulo en tiempo de llamada: el global del navegador o, en Node.js, require().
   * Si no existe, el error se propaga: ningún módulo de ZeroChat es opcional.
   * @param {string} globalName - Nombre en globalThis.
   * @param {string} modulePath - Ruta para require() en Node.js, relativa a js/.
   * @returns {*}
   */
  function resolveDep(globalName, modulePath) {
    if (globalThis[globalName]) return globalThis[globalName];
    if (typeof module === 'object' && module.exports) return require(modulePath);
    throw new Error(`Missing module ${globalName}`);
  }

  return {
    escapeHtml,
    sanitizeUrl,
    sanitizeImageUrl,
    setText,
    clearElement,
    appendTextElement,
    setTrustedHtml,
    fetchWithTimeout,
    serializeContent,
    clone,
    createId,
    formatShortValue,
    formatBytes,
    resolveDep
  };
});
