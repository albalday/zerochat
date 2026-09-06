/**
 * Registro de módulos de tools autocontenidas.
 *
 * Los módulos futuros se registrarán aquí al cargarse; durante la transición
 * las tools existentes continúan registrándose mediante BuiltinToolProvider.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatToolManifest = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ToolModuleManifest {
    constructor(options = {}) {
      this.id = options.id || 'builtin';
      this.modules = new Map();
    }

    register(toolModule, options = {}) {
      if (!toolModule || typeof toolModule.id !== 'string' || !toolModule.id.trim()) {
        throw new Error('Un módulo de tool debe declarar un id válido.');
      }
      const id = toolModule.id.trim();
      if (this.modules.has(id) && !options.overwrite) {
        throw new Error(`El módulo de tool '${id}' ya está registrado.`);
      }
      this.modules.set(id, toolModule);
      return toolModule;
    }

    has(id) {
      return this.modules.has(id);
    }

    get(id) {
      return this.modules.get(id) || null;
    }

    list() {
      return Array.from(this.modules.values());
    }
  }

  const builtin = new ToolModuleManifest({ id: 'builtin' });

  return {
    ToolModuleManifest,
    builtin
  };
});
