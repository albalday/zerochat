/**
 * Adaptador WebLLM: carga diferida y transporte local en el navegador.
 * WebLLM conserva por defecto los artefactos de los modelos mediante Cache Storage.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./providers.js'));
  } else {
    root.ChatWebLLM = factory(root.ChatProviders);
  }
})(typeof self !== 'undefined' ? self : this, function (Providers) {
  'use strict';

  const WEBLLM_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.80';
  const COMPLETED_MODELS_STORAGE_KEY = 'webllm_completed_models_v1';
  let modulePromise = null;

  function supported() {
    return typeof navigator !== 'undefined' && !!navigator.gpu && typeof caches !== 'undefined' && typeof ReadableStream !== 'undefined' && typeof AbortController !== 'undefined';
  }

  function supportError() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return 'WebGPU no está disponible en este navegador.';
    if (typeof caches === 'undefined') return 'Cache Storage no está disponible en este navegador.';
    return 'El navegador no admite los requisitos de WebLLM.';
  }

  function getAppConfig(webllm) {
    const base = webllm.prebuiltAppConfig;
    if (!base || !Array.isArray(base.model_list)) throw new Error('WebLLM did not provide a valid model catalog.');
    return { ...base, model_list: base.model_list };
  }

  function getStorage() {
    return typeof globalThis !== 'undefined' ? globalThis.ChatStorage : null;
  }

  function completedModels() {
    const Storage = getStorage();
    if (!Storage?.getStorageItem) return null;
    try {
      const models = JSON.parse(Storage.getStorageItem(COMPLETED_MODELS_STORAGE_KEY) || '[]');
      return new Set(Array.isArray(models) ? models.filter(model => typeof model === 'string') : []);
    } catch (_) {
      return new Set();
    }
  }

  function setModelCompleted(modelId, completed) {
    const Storage = getStorage();
    if (!Storage?.setStorageItem) return false;
    const models = completedModels() || new Set();
    if (completed) models.add(modelId);
    else models.delete(modelId);
    try {
      Storage.setStorageItem(COMPLETED_MODELS_STORAGE_KEY, JSON.stringify([...models]));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function getModelAvailability(webllm, modelId, appConfig) {
    if (typeof webllm.hasModelInCache !== 'function') return 'unknown';
    const cached = await webllm.hasModelInCache(modelId, appConfig);
    const recorded = completedModels();
    if (cached !== true) return recorded?.has(modelId) ? 'incomplete' : 'missing';
    if (recorded === null) return 'unknown';
    return recorded.has(modelId) ? 'cached' : 'incomplete';
  }

  async function isModelAvailable(webllm, modelId, appConfig) {
    return await getModelAvailability(webllm, modelId, appConfig) === 'cached';
  }

  function loadWebLLM(loader) {
    if (!supported()) return Promise.reject(new Error(supportError()));
    if (!modulePromise) {
      const importModule = loader || ((url) => import(/* webpackIgnore: true */ url));
      modulePromise = Promise.resolve().then(() => importModule(WEBLLM_URL)).catch(error => {
        modulePromise = null;
        throw new Error(`No se pudo preparar WebLLM: ${error.message || error}`);
      });
    }
    return modulePromise;
  }

  function normalizeProgress(progress) {
    const detail = String(progress?.text || '').trim();
    const explicit = progress?.progress === null || progress?.progress === undefined ? NaN : Number(progress.progress);
    const match = detail.match(/(\d+(?:\.\d+)?)%\s+completed/i);
    const percent = Number.isFinite(explicit)
      ? Math.max(0, Math.min(100, explicit <= 1 ? explicit * 100 : explicit))
      : (match ? Math.max(0, Math.min(100, Number(match[1]))) : null);
    let phase = 'preparing';
    if (/shader modules/i.test(detail)) phase = 'compiling';
    else if (/fetch params|loading model/i.test(detail)) phase = 'loading';
    else if (/finish loading/i.test(detail)) phase = 'ready';
    return { phase, percent, detail };
  }

  function emitProgress(onProgress, progress) {
    onProgress?.(typeof progress === 'string' ? { phase: progress, percent: null, detail: '' } : normalizeProgress(progress));
  }

  function abortError() {
    return typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' });
  }

  function createMainThreadEngine(webllm, modelId, appConfig, onProgress, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    const creation = Promise.resolve().then(() => webllm.CreateMLCEngine(modelId, {
      appConfig,
      initProgressCallback: progress => emitProgress(onProgress, progress)
    }));

    // CreateMLCEngine does not accept an AbortSignal.  Reject the caller as
    // soon as it cancels, then unload an engine that completes in the
    // background so it cannot remain active after a cancelled conversation.
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(abortError());
      };

      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }

      creation.then(engine => {
        if (settled || signal?.aborted) {
          return Promise.resolve(engine?.unload?.()).catch(() => {});
        }
        settled = true;
        cleanup();
        resolve({ engine, release: () => engine.unload?.() });
      }, error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  async function createMainThreadFallback(webllm, modelId, appConfig, onProgress, signal, workerError) {
    emitProgress(onProgress, 'main-thread-fallback');
    try {
      return await createMainThreadEngine(webllm, modelId, appConfig, onProgress, signal);
    } catch (error) {
      if (error && error.cause === undefined) error.cause = workerError;
      throw error;
    }
  }

  function createWorkerEngine(webllm, modelId, appConfig, onProgress, signal) {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof webllm.CreateWebWorkerMLCEngine !== 'function') {
      return createMainThreadEngine(webllm, modelId, appConfig, onProgress, signal);
    }
    const source = `import * as webllm from ${JSON.stringify(WEBLLM_URL)};\nconst handler = new webllm.WebWorkerMLCEngineHandler();\nself.onmessage = event => handler.onmessage(event);`;
    const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    let worker;
    try {
      worker = new Worker(workerUrl, { type: 'module' });
    } catch (error) {
      URL.revokeObjectURL(workerUrl);
      return createMainThreadFallback(webllm, modelId, appConfig, onProgress, signal, error);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let receivedProgress = false;
      const workerFailure = event => fail(event, !receivedProgress);
      const abort = () => fail(abortError(), false);
      const cleanup = () => {
        worker.removeEventListener('error', workerFailure);
        worker.removeEventListener('messageerror', workerFailure);
        signal?.removeEventListener('abort', abort);
      };
      const discard = () => {
        worker.terminate();
        URL.revokeObjectURL(workerUrl);
      };
      const fail = (event, bootstrapFailure = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        discard();
        const detail = event?.message || event?.error?.message || event?.messageText || '';
        const error = event?.name === 'AbortError' ? event : new Error(`WebLLM worker failed${detail ? `: ${detail}` : '.'}`);
        if (bootstrapFailure) error.code = 'WEBLLM_WORKER_BOOTSTRAP';
        reject(error);
      };
      const notifyProgress = progress => {
        receivedProgress = true;
        emitProgress(onProgress, progress);
      };
      worker.addEventListener('error', workerFailure, { once: true });
      worker.addEventListener('messageerror', workerFailure, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      webllm.CreateWebWorkerMLCEngine(worker, modelId, { appConfig, initProgressCallback: notifyProgress })
        .then(engine => {
          if (settled) {
            engine.unload?.();
            return;
          }
          settled = true;
          cleanup();
          resolve({
            engine,
            release: async () => {
              try { await engine.unload?.(); } finally { discard(); }
            }
          });
        })
        .catch(error => fail(error, false));
    }).catch(async error => {
      if (error?.code !== 'WEBLLM_WORKER_BOOTSTRAP') throw error;
      return createMainThreadFallback(webllm, modelId, appConfig, onProgress, signal, error);
    });
  }

  class WebLLMEngineManager {
    constructor(createEngine = createWorkerEngine) {
      this.createEngine = createEngine;
      this.active = null;
      this.pending = null;
    }

    async acquire(webllm, modelId, appConfig, onProgress, signal) {
      if (this.active?.modelId === modelId) return { handle: this.active.handle, reused: true };
      if (this.pending) {
        if (this.pending.modelId !== modelId) throw new Error('Another WebLLM model is still being prepared.');
        return { handle: await this.pending.promise, reused: false };
      }
      if (this.active) await this.dispose();

      onProgress?.({ phase: 'starting', percent: null, detail: '' });
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const pending = { modelId, promise: null, controller };
      pending.promise = this.createEngine(webllm, modelId, appConfig, onProgress, controller.signal)
        .then(handle => {
          this.active = { modelId, handle };
          return handle;
        })
        .finally(() => {
          signal?.removeEventListener('abort', abort);
          if (this.pending === pending) this.pending = null;
        });
      this.pending = pending;
      return { handle: await pending.promise, reused: false };
    }

    async dispose(modelId) {
      if (modelId && this.active?.modelId !== modelId && this.pending?.modelId !== modelId) return;
      if (this.pending) {
        this.pending.controller.abort();
        try { await this.pending.promise; } catch (_) { /* The caller receives the preparation error. */ }
      }
      const active = this.active;
      this.active = null;
      await active?.handle.release();
    }
  }

  async function listModels(options = {}) {
    const webllm = await loadWebLLM(options.loader);
    const appConfig = getAppConfig(webllm);
    const entries = Array.isArray(appConfig?.model_list) ? appConfig.model_list : [];
    const models = await Promise.all(entries.map(async entry => {
      let cached = null;
      try {
        cached = await getModelAvailability(webllm, entry.model_id, appConfig);
      } catch (_) { cached = 'unknown'; }
      return {
        id: entry.model_id,
        name: entry.model_id,
        details: {
          webllmCache: cached,
          webllmVramMB: Number.isFinite(Number(entry.vram_required_MB)) ? Number(entry.vram_required_MB) : null
        }
      };
    }));
    return { success: true, models, count: models.length, endpoint: 'webllm://local' };
  }

  function toSseStream(iterable, release) {
    const encoder = new TextEncoder();
    const iterator = iterable[Symbol.asyncIterator]();
    return new ReadableStream({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            await release();
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
        } catch (error) {
          await release();
          controller.error(error);
        }
      },
      async cancel() {
        try { await iterator.return?.(); } finally { await release(); }
      }
    });
  }

  const BaseProviderAdapter = Providers?.BaseProviderAdapter || class {};
  class WebLLMProviderAdapter extends BaseProviderAdapter {
    constructor(options = {}) {
      super({
        id: 'webllm', label: 'WebLLM (local)', reasoningLevels: ['none'],
        connection: { endpoint: 'webllm://local', endpointReadOnly: true, credentials: false, localModelManagement: true },
        capabilities: { vision: false, tools: false, reasoning: false, jsonMode: false, promptCaching: false, embeddings: false, modelListing: true },
        ...options
      });
      this.engines = options.engineManager || new WebLLMEngineManager();
    }

    normalizeEndpoint() { return 'webllm://local'; }
    buildHeaders() { return {}; }
    supportsUsageStatistics() { return false; }
    async listModels(options) { return listModels(options); }

    async disposeActiveEngine() {
      await this.engines.dispose();
    }

    async deactivate() {
      await this.disposeActiveEngine();
    }

    async createStreamResponse({ payload, signal, onProgress }) {
      if (!payload.model) throw new Error('Selecciona un modelo WebLLM descargado en el perfil.');
      const webllm = await loadWebLLM();
      const appConfig = getAppConfig(webllm);
      const available = await isModelAvailable(webllm, payload.model, appConfig);
      if (!available) throw new Error('El modelo WebLLM no está disponible por completo en el almacenamiento local. Descárgalo desde el perfil antes de iniciar el chat.');

      if (signal?.aborted) throw abortError();
      const acquired = await this.engines.acquire(webllm, payload.model, appConfig, onProgress, signal);
      const engineHandle = acquired.handle;
      if (signal?.aborted) {
        throw abortError();
      }
      const interrupt = () => engineHandle.engine?.interruptGenerate?.();
      signal?.addEventListener('abort', interrupt, { once: true });
      const finishStream = () => signal?.removeEventListener('abort', interrupt);
      try {
        const stream = await engineHandle.engine.chat.completions.create({ ...payload, stream: true });
        return { ok: true, body: toSseStream(stream, finishStream) };
      } catch (error) {
        finishStream();
        throw error;
      }
    }

    async downloadModel(modelId, onProgress) {
      const webllm = await loadWebLLM();
      const appConfig = getAppConfig(webllm);
      try {
        await this.engines.acquire(webllm, modelId, appConfig, onProgress);
        const cached = await webllm.hasModelInCache?.(modelId, appConfig);
        if (cached !== true) {
          throw new Error('WebLLM terminó la preparación, pero el navegador no pudo guardar el modelo en Cache Storage.');
        }
        if (!setModelCompleted(modelId, true)) {
          throw new Error('WebLLM could not persist the completed model verification.');
        }
      } catch (error) {
        setModelCompleted(modelId, false);
        await this.engines.dispose(modelId);
        throw error;
      }
      return true;
    }

    async deleteModel(modelId) {
      await this.engines.dispose(modelId);
      const webllm = await loadWebLLM();
      const appConfig = getAppConfig(webllm);
      if (typeof webllm.deleteModelAllInfoInCache !== 'function') {
        throw new Error('Esta versión de WebLLM no permite borrar modelos individualmente.');
      }
      await webllm.deleteModelAllInfoInCache(modelId, appConfig);
      const removed = await webllm.hasModelInCache?.(modelId, appConfig) !== true;
      if (removed) setModelCompleted(modelId, false);
      return removed;
    }

    async cancelModelOperation(modelId) {
      await this.engines.dispose(modelId);
    }
  }

  const adapter = new WebLLMProviderAdapter();
  Providers?.registry?.register(adapter);
  return { WEBLLM_URL, COMPLETED_MODELS_STORAGE_KEY, WebLLMEngineManager, WebLLMProviderAdapter, adapter, loadWebLLM, listModels, getModelAvailability, normalizeProgress, createWorkerEngine };
});
