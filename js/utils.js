/**
 * Módulo Universal de Utilidades Compartidas para ZeroChat.
 * ZeroChat - js/utils.js
 *
 * Centraliza funciones utilitarias esenciales (escapeHtml, fetchWithTimeout,
 * serializeContent, clone, formatShortValue, resolveDep, etc.) para eliminar
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

  /**
   * Realiza una petición fetch con timeout configurable.
   * @param {string|Request} resource 
   * @param {Object} [options={}] 
   * @param {number} [timeoutMs=8000] 
   * @returns {Promise<Response>}
   */
  async function fetchWithTimeout(resource, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(resource, {
        ...options,
        signal: controller.signal
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Serializa contenido multipart o texto a una cadena plana.
   * @param {*} content 
   * @returns {string}
   */
  function serializeContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (!part) return '';
          if (typeof part === 'string') return part;
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.content === 'string') return content.content;
    }
    return '';
  }

  /**
   * Clona profundamente estructuras de datos JSON serializables.
   * @template T
   * @param {T} value 
   * @returns {T}
   */
  function clone(value) {
    if (value === undefined || value === null) return value;
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (_) {
        // Fallback a JSON si contiene tipos no clonables nativamente
      }
    }
    return JSON.parse(JSON.stringify(value));
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
   * Resuelve dependencias de forma segura en entornos UMD (Browser / Node.js).
   * @param {string} globalName - Nombre en window/globalThis.
   * @param {string} [modulePath] - Ruta para require() en Node.js.
   * @returns {*}
   */
  function resolveDep(globalName, modulePath) {
    if (typeof window !== 'undefined' && window[globalName]) {
      return window[globalName];
    }
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (modulePath && typeof require === 'function') {
      try {
        return require(modulePath);
      } catch (_) {}
    }
    return null;
  }

  return {
    escapeHtml,
    fetchWithTimeout,
    serializeContent,
    clone,
    formatShortValue,
    resolveDep
  };
});

