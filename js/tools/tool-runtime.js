/**
 * Infraestructura de ejecución para módulos de tools de ZeroChat.
 *
 * Expone un contexto explícito y servicios resueltos de forma perezosa para
 * que cada tool autocontenida declare sólo las dependencias que consume.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatToolRuntime = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SERVICE_DEFINITIONS = {
    sandbox: { globalName: 'ChatSandbox', modulePath: '../sandbox.js' },
    webSearch: { globalName: 'ChatWebSearch', modulePath: '../web-search.js' },
    webBrowser: { globalName: 'ChatWebBrowser', modulePath: '../web-browser.js' },
    charts: { globalName: 'ChatCharts', modulePath: '../charts.js' },
    ragStorage: { globalName: 'ChatRagStorage', modulePath: '../ragStorage.js' },
    ragService: { globalName: 'ChatRagService', modulePath: '../rag-service.js' },
    mcp: { globalName: 'ChatMCP', modulePath: '../mcp.js' }
  };

  function resolveService(name) {
    const definition = SERVICE_DEFINITIONS[name];
    if (!definition) return null;

    if (typeof window !== 'undefined') {
      if (window[definition.globalName]) return window[definition.globalName];
      if (definition.fallbackGlobalName && window[definition.fallbackGlobalName]) {
        return window[definition.fallbackGlobalName];
      }
    }

    if (typeof require !== 'undefined') {
      try { return require(definition.modulePath); } catch (e) {}
    }
    return null;
  }

  /**
   * Contenedor de servicios con resolución perezosa y sustituciones para test.
   */
  function createToolServices(overrides = {}) {
    const services = {};
    Object.keys(SERVICE_DEFINITIONS).forEach(name => {
      Object.defineProperty(services, name, {
        enumerable: true,
        get: () => Object.prototype.hasOwnProperty.call(overrides, name)
          ? overrides[name]
          : resolveService(name)
      });
    });
    return services;
  }

  /**
   * Crea el contexto estándar recibido por execute(args, context).
   */
  function createToolExecutionContext(options = {}, serviceOverrides = {}) {
    return {
      ...options,
      language: options.language || options.lang || 'es',
      services: options.services || createToolServices(serviceOverrides),
      config: options.config || {}
    };
  }

  return {
    SERVICE_DEFINITIONS,
    resolveService,
    createToolServices,
    createToolExecutionContext
  };
});
