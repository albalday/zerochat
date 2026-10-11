/**
 * Infraestructura de ejecución para módulos de tools de ZeroChat.
 *
 * Expone un contexto explícito y servicios resueltos de forma perezosa para
 * que cada tool autocontenida declare sólo las dependencias que consume.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('../utils.js'));
  } else {
    root.ChatToolRuntime = factory(root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;

  const SERVICE_DEFINITIONS = {
    sandbox: { globalName: 'ChatSandbox', modulePath: './sandbox.js' },
    webSearch: { globalName: 'ChatWebSearch', modulePath: './web-search.js' },
    webBrowser: { globalName: 'ChatWebBrowser', modulePath: './web-browser.js' },
    charts: { globalName: 'ChatCharts', modulePath: './charts.js' },
    ragStorage: { globalName: 'ChatRagStorage', modulePath: './ragStorage.js' },
    ragService: { globalName: 'ChatRagService', modulePath: './rag-service.js' },
    mcp: { globalName: 'ChatMCP', modulePath: './mcp.js' },
    agent: { globalName: 'ChatAgentCore', modulePath: './agent-core.js' },
    engine: { globalName: 'ChatEngine', modulePath: './chat-engine.js' },
    profiles: { globalName: 'ChatProfileRepository', modulePath: './profile-repository.js' },
    profilesUI: { globalName: 'ChatUIProfiles', modulePath: './ui-profiles.js' }
  };

  function resolveService(name) {
    const { globalName, modulePath } = SERVICE_DEFINITIONS[name];
    return resolveDep(globalName, modulePath);
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
