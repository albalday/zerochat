/** Tool autocontenida: get_current_datetime. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinGetCurrentDatetimeTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const definition = {
    name: 'get_current_datetime',
    description: 'Devuelve la fecha y hora actuales. Úsala cuando necesites conocer el momento actual; la fecha de inicio de la conversación es una referencia histórica.',
    parameters: { type: 'object', properties: {} }
  };

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear get_current_datetime.');
    return new Tool({
      id: definition.name,
      definition,
      aliases: ['get_current_time', 'get_datetime', 'current_time', 'current_date', 'get_date', 'now', 'fecha_actual', 'hora_actual'],
      category: 'system',
      metadata: { icon: '⏱️', label: definition.name },
      settings: { showInSettings: false },
      promptGuide: (lang) => lang === 'en'
        ? '- `get_current_datetime()`: Returns the current date and exact time.'
        : '- `get_current_datetime()`: Devuelve la fecha y hora exactas actuales.',
      isAvailable: (appConfig = {}) => appConfig.sendDateTime !== false,
      execute: async () => {
        return {
          success: true,
          iso: new Date().toISOString()
        };
      },
      result: {
        toMarkdown: () => ''
      },
      view: { id: definition.name }
    });
  }

  const toolModule = { id: definition.name, definition, createTool };
  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) {} }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
