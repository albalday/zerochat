/**
 * Catálogo de modelos de la conexión del editor: la caché por conexión (API y URL) de los modelos
 * que publicó el proveedor, los descargados de WebLLM y el contexto que el catálogo da a cada modelo.
 * Sin DOM: ChatUIInspector lo pinta y app.js publica con él el contexto del modelo activo.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatModelCatalog = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;
  const getStorage = () => resolveDep('ChatStorage', './storage.js');
  const getContextManager = () => resolveDep('ChatContextManager', './context-manager.js');
  const getWebLLM = () => resolveDep('ChatWebLLM', './providers-webllm.js');

  const MODEL_CACHE_KEY = 'cached_models';
  const MODEL_CACHE_VERSION = 1;

  // Modelos de la última consulta o de la caché de la conexión del editor.
  let currentModels = [];

  const modelId = model => getContextManager().catalogModelId(model);

  function getConnectionCacheKey({ apiType, apiUrl }) {
    const type = String(apiType || 'openai').trim().toLowerCase();
    const url = String(apiUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    return url ? `${type}:${url}` : '';
  }

  /** Caché de modelos por conexión; una ilegible o de otra versión se borra. */
  function readModelCache() {
    const Storage = getStorage();
    const raw = Storage.getStorageItem(MODEL_CACHE_KEY);
    if (raw) {
      try {
        const document = JSON.parse(raw);
        if (document?.version === MODEL_CACHE_VERSION && document.connections && typeof document.connections === 'object') return document;
      } catch (_) { /* caché ilegible */ }
      Storage.deleteStorageItem(MODEL_CACHE_KEY);
    }
    return { version: MODEL_CACHE_VERSION, connections: {} };
  }

  function isDownloaded(model, completed) {
    return model?.details?.webllmCache === 'cached' || completed.has(modelId(model));
  }

  /** Modelos WebLLM con los descargados primero, en el orden del catálogo. */
  function sortWebLLMModels(models) {
    const completed = new Set(getWebLLM().getCompletedModelIds());
    return [...models].sort((a, b) => getWebLLM().compareCatalogModels(a, b, model => isDownloaded(model, completed)));
  }

  /** Modelos WebLLM descargados, ordenados. */
  function downloadedWebLLMModels(models) {
    const completed = new Set(getWebLLM().getCompletedModelIds());
    return sortWebLLMModels(models).filter(model => isDownloaded(model, completed));
  }

  /**
   * Modelos guardados para la conexión, que pasan a ser los del editor. En WebLLM añade los
   * descargados aunque no estén en la caché.
   */
  function load(connection) {
    const cacheKey = getConnectionCacheKey(connection);
    let models = cacheKey ? [...(readModelCache().connections[cacheKey] || [])] : [];
    if (String(connection.apiType || '').trim().toLowerCase() === 'webllm') {
      const known = new Set(models.map(modelId));
      const { WEBLLM_DEFAULT_CONTEXT } = getContextManager();
      for (const id of getWebLLM().getCompletedModelIds()) {
        if (known.has(id)) continue;
        models.push({ id, name: id, details: { webllmCache: 'cached', loaded_context_length: WEBLLM_DEFAULT_CONTEXT, max_context_length: WEBLLM_DEFAULT_CONTEXT } });
        known.add(id);
      }
      models = sortWebLLMModels(models);
    }
    currentModels = models;
    return models;
  }

  /** Guarda los modelos que publicó la conexión, que pasan a ser los del editor. */
  function save(models, connection) {
    currentModels = models;
    const cacheKey = getConnectionCacheKey(connection);
    if (!cacheKey) return;
    const document = readModelCache();
    document.connections[cacheKey] = models;
    getStorage().setStorageItem(MODEL_CACHE_KEY, JSON.stringify(document));
  }

  /** Contexto de un modelo según el catálogo de la conexión del editor; null si no lo publica. */
  function getContextLimit(model) {
    return getContextManager().getModelContextLimit(model, currentModels);
  }

  return {
    modelId,
    isDownloaded,
    sortWebLLMModels,
    downloadedWebLLMModels,
    load,
    save,
    getContextLimit
  };
}));
