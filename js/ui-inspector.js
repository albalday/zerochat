/**
 * Módulo de Interfaz de Usuario para Consulta de Modelos e Inspector de Servidor.
 * ZeroChat - js/ui-inspector.js
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIInspector = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let discoveredModels = [];
  const MODEL_CACHE_VERSION = 1;

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof require !== 'undefined') { try { return require(relPath); } catch (e) { return null; } }
    return null;
  }

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getApi = () => resolveDep('ChatAPI', './api.js');
  const getStorage = () => resolveDep('ChatStorage', './cookies.js');
  const getMarkdown = () => resolveDep('ChatMarkdown', './markdown.js');
  const getDebug = () => resolveDep('ChatDebug', './debug.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getProviders = () => resolveDep('ChatProviders', './providers.js');

  function t(key, params) {
    const I18n = getI18n();
    if (I18n && typeof I18n.t === 'function') return I18n.t(key, params);
    return key;
  }

  function escapeHtml(str) {
    const Markdown = getMarkdown();
    if (Markdown && typeof Markdown.escapeHtml === 'function') {
      return Markdown.escapeHtml(str);
    }
    return String(str || '').replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return m;
      }
    });
  }

  function addDebugLog(type, text, rawData) {
    const Debug = getDebug();
    if (Debug && typeof Debug.addLog === 'function') {
      Debug.addLog(type, text, rawData);
    }
  }

  function getWebLLMState() {
    return getState()?.get?.('ui')?.webllm || { catalog: [], contextKey: '', operation: null };
  }

  function setWebLLMState(update) {
    const State = getState();
    if (!State?.set) return { ...getWebLLMState(), ...update };
    State.set('ui', ui => ({
      ...ui,
      webllm: { ...(ui.webllm || { catalog: [], contextKey: '', operation: null }), ...update }
    }));
    return getWebLLMState();
  }

  function getEditorContextKey(elements) {
    return [
      elements?.profileSelectHelper?.value || '',
      elements?.settingApiType?.value || '',
      elements?.settingApiUrl?.value || ''
    ].join('|');
  }

  function updateWebLLMModel(modelId, status) {
    const state = getWebLLMState();
    const catalog = state.catalog.map(model => model?.id === modelId
      ? { ...model, details: { ...(model.details || {}), webllmCache: status } }
      : model);
    setWebLLMState({ catalog });
    return catalog;
  }

  function getOllamaConnectionHelp(apiType, error) {
    const type = String(apiType || '').trim().toLowerCase();
    const message = String(error?.message || error || '');
    const isBrowserNetworkError = /networkerror|failed to fetch|load failed|network request failed/i.test(message);
    return type === 'ollama' && isBrowserNetworkError ? t('err_ollama_origins') : '';
  }

  function getConnectionCacheKey(connection = {}) {
    const apiType = String(connection.apiType || 'openai').trim().toLowerCase();
    const apiUrl = String(connection.apiUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    return apiUrl ? `${apiType}:${apiUrl}` : '';
  }

  function getWebLLMCompletedModelIds() {
    const Providers = getProviders();
    const adapter = Providers?.registry?.get?.('webllm');
    if (typeof adapter?.getCompletedModelIds === 'function') {
      return adapter.getCompletedModelIds();
    }
    const WebLLM = typeof ChatWebLLM !== 'undefined' ? ChatWebLLM : (typeof globalThis !== 'undefined' ? globalThis.ChatWebLLM : null);
    if (typeof WebLLM?.getCompletedModelIds === 'function') {
      return WebLLM.getCompletedModelIds();
    }
    const Storage = getStorage();
    if (Storage?.getStorageItem) {
      try {
        const key = WebLLM?.COMPLETED_MODELS_STORAGE_KEY || 'webllm_completed_models_v1';
        const parsed = JSON.parse(Storage.getStorageItem(key) || '[]');
        return Array.isArray(parsed) ? parsed.filter(m => typeof m === 'string') : [];
      } catch (_) {}
    }
    return [];
  }

  function sortWebLLMModels(models) {
    if (!Array.isArray(models)) return [];
    const completed = new Set(getWebLLMCompletedModelIds());
    return [...models].sort((a, b) => {
      const aId = typeof a === 'string' ? a : (a?.id || a?.name || '');
      const bId = typeof b === 'string' ? b : (b?.id || b?.name || '');
      const aCached = (a?.details?.webllmCache === 'cached' || completed.has(aId)) ? 1 : 0;
      const bCached = (b?.details?.webllmCache === 'cached' || completed.has(bId)) ? 1 : 0;
      return bCached - aCached;
    });
  }

  function loadCachedModels(elements, appConfig) {
    discoveredModels = [];
    try {
      const Storage = getStorage();
      const cached = Storage?.getStorageItem ? Storage.getStorageItem('cached_models') : null;
      const apiType = String(appConfig?.apiType || elements?.settingApiType?.value || 'openai').trim().toLowerCase();
      const isWebLLM = apiType === 'webllm';
      const cacheKey = getConnectionCacheKey(appConfig || { apiType, apiUrl: elements?.settingApiUrl?.value });

      if (cached) {
        const document = JSON.parse(cached);
        if (document?.version !== MODEL_CACHE_VERSION || !document.connections || typeof document.connections !== 'object') {
          Storage?.deleteStorageItem?.('cached_models');
          return discoveredModels;
        }
        discoveredModels = cacheKey ? (document.connections[cacheKey] || []) : [];
      }

      if (isWebLLM) {
        const completed = getWebLLMCompletedModelIds();
        const existingIds = new Set(discoveredModels.map(m => typeof m === 'string' ? m : (m?.id || m?.name || '')));
        completed.forEach(id => {
          if (!existingIds.has(id)) {
            discoveredModels.push({ id, name: id, details: { webllmCache: 'cached' } });
            existingIds.add(id);
          }
        });
        discoveredModels = sortWebLLMModels(discoveredModels);
      }

      if (Array.isArray(discoveredModels) && discoveredModels.length > 0) {
        populateModelList(elements, appConfig, discoveredModels, false);
      }
    } catch (e) {
      discoveredModels = [];
      console.warn('No se pudieron cargar modelos de caché:', e);
    }
    return discoveredModels;
  }

  function saveCachedModels(models, connection) {
    discoveredModels = Array.isArray(models) ? models : [];
    try {
      const Storage = getStorage();
      const cacheKey = getConnectionCacheKey(connection);
      if (Storage?.setStorageItem && cacheKey) {
        const cached = Storage.getStorageItem?.('cached_models');
        let document = { version: MODEL_CACHE_VERSION, connections: {} };
        try {
          const parsed = cached ? JSON.parse(cached) : null;
          if (parsed?.version === MODEL_CACHE_VERSION && parsed.connections && typeof parsed.connections === 'object') {
            document = parsed;
          }
        } catch (_) {}
        document.connections[cacheKey] = discoveredModels;
        Storage.setStorageItem('cached_models', JSON.stringify(document));
      }
    } catch (e) {}
    return discoveredModels;
  }

  function getCachedModels() {
    return discoveredModels;
  }

  function getModelContextLimit(model) {
    const selected = String(model || '').trim();
    const entry = discoveredModels.find(item => String(item?.id || item?.name || '').trim() === selected);
    const details = entry?.details || entry || {};
    const loaded = Number(details.loaded_context_length);
    const maximum = Number(details.max_context_length);
    return Number.isFinite(loaded) && loaded > 0 ? Math.floor(loaded)
      : (Number.isFinite(maximum) && maximum > 0 ? Math.floor(maximum) : null);
  }

  function populateModelList(elements, appConfig, models, selectFirstIfEmpty = false) {
    const modelList = Array.isArray(models) ? models : [];

    const doc = elements?.modelDatalist?.ownerDocument || elements?.modelSelectHelper?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    if (elements?.modelDatalist) {
      elements.modelDatalist.innerHTML = '';
      modelList.forEach(m => {
        const id = (typeof m === 'string' ? m : (m.id || m.name || '')).trim();
        if (id) {
          const opt = doc.createElement('option');
          opt.value = id;
          const contextLimit = getModelContextLimit(id);
          if (contextLimit) opt.dataset.contextLength = String(contextLimit);
          elements.modelDatalist.appendChild(opt);
        }
      });
    }

    if (elements?.modelSelectHelper) {
      elements.modelSelectHelper.innerHTML = '';
      const defaultOpt = doc.createElement('option');
      defaultOpt.value = '';
      defaultOpt.disabled = true;
      defaultOpt.selected = true;
      defaultOpt.textContent = t('model_select_count', { count: modelList.length });
      elements.modelSelectHelper.appendChild(defaultOpt);

      const currentVal = elements.settingModel ? elements.settingModel.value.trim() : (appConfig?.model || '');

      modelList.forEach(m => {
        const id = (typeof m === 'string' ? m : (m.id || m.name || '')).trim();
        if (id) {
          const opt = doc.createElement('option');
          opt.value = id;
          opt.textContent = id;
          const contextLimit = getModelContextLimit(id);
          if (contextLimit) opt.dataset.contextLength = String(contextLimit);
          if (currentVal && currentVal === id) {
            opt.selected = true;
            defaultOpt.selected = false;
          }
          elements.modelSelectHelper.appendChild(opt);
        }
      });
    }

    if (selectFirstIfEmpty && elements?.settingModel) {
      const currentVal = elements.settingModel.value.trim();
      const firstId = (typeof modelList[0] === 'string' ? modelList[0] : (modelList[0]?.id || modelList[0]?.name || '')).trim();
      if (!currentVal && firstId) {
        elements.settingModel.value = firstId;
        if (elements.modelSelectHelper) elements.modelSelectHelper.value = firstId;
      }
    }
  }

  function renderWebLLMModels(elements, rawModels = getWebLLMState().catalog) {
    const status = elements?.serverQueryStatus;
    if (!status || !Array.isArray(rawModels)) return;
    const models = sortWebLLMModels(rawModels);
    const operation = getWebLLMState().operation;
    status.querySelector?.('.webllm-model-list')?.remove();
    const doc = status.ownerDocument;
    const list = doc.createElement('div');
    list.className = 'webllm-model-list';
    models.forEach(model => {
      const id = String(model?.id || '').trim();
      if (!id) return;
      const row = doc.createElement('div');
      row.className = 'webllm-model-row';
      const state = model?.details?.webllmCache;
      const label = doc.createElement('span');
      const stateLabel = text => `${id} · ${text}${formatWebLLMVram(model)}`;
      const stateKey = state === 'cached' ? 'webllm_model_cached'
        : (state === 'incomplete' ? 'webllm_model_incomplete' : (state === 'unknown' ? 'webllm_model_unknown' : 'webllm_model_missing'));
      label.textContent = stateLabel(t(stateKey));
      row.appendChild(label);
      const progressBar = doc.createElement('progress');
      progressBar.className = 'webllm-model-progress';
      progressBar.max = 100;
      progressBar.hidden = true;
      row.appendChild(progressBar);
      const createAction = (icon, labelKey, handler, disabled = false) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'webllm-model-action';
        const labelText = t(labelKey);
        button.title = labelText;
        button.setAttribute('aria-label', labelText);
        button.innerHTML = getIcons()?.get?.(icon, { size: 14 }) || labelText;
        button.disabled = disabled;
        button.addEventListener('click', handler);
        return button;
      };
      const actions = doc.createElement('div');
      actions.className = 'webllm-model-actions';
      const downloadModel = async event => {
          const button = event.currentTarget;
          const API = getApi();
          const activeOperation = getWebLLMState().operation;
          if (activeOperation?.modelId === id) {
            button.disabled = true;
            label.textContent = stateLabel(t('webllm_cancelling'));
            await API.cancelLocalModelOperation?.(id, elements?.settingApiType?.value);
            return;
          }
          const contextKey = getEditorContextKey(elements);
          const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          setWebLLMState({ operation: { id: operationId, modelId: id, contextKey } });
          list.querySelectorAll('button').forEach(action => { action.disabled = true; });
          button.disabled = false;
          button.title = t('webllm_cancel');
          button.setAttribute('aria-label', t('webllm_cancel'));
          button.innerHTML = getIcons()?.get?.('stop', { size: 14 }) || t('webllm_cancel');
          label.textContent = stateLabel(t('webllm_preparing'));
          progressBar.hidden = false;
          progressBar.removeAttribute('value');
          const update = progress => {
            const current = getWebLLMState().operation;
            if (current?.id !== operationId || getEditorContextKey(elements) !== contextKey) return;
            const feedback = parseWebLLMProgress(progress);
            label.textContent = stateLabel(feedback.text);
            if (feedback.percent === null) progressBar.removeAttribute('value');
            else progressBar.value = feedback.percent;
          };
          try {
            const complete = await API.downloadLocalModel(id, update, elements?.settingApiType?.value);
            if (!complete) throw new Error(t('webllm_model_incomplete'));
            if (getWebLLMState().operation?.id === operationId && getEditorContextKey(elements) === contextKey) {
              const catalog = updateWebLLMModel(id, 'cached');
              setWebLLMState({ operation: null });
              refreshSelectableModels(elements, catalog);
              renderWebLLMModels(elements, catalog);
            }
          } catch (error) {
            if (getWebLLMState().operation?.id === operationId && getEditorContextKey(elements) === contextKey) {
              const catalog = updateWebLLMModel(id, 'incomplete');
              setWebLLMState({ operation: null });
              renderWebLLMModels(elements, catalog);
              const currentRow = Array.from(elements.serverQueryStatus.querySelectorAll('.webllm-model-row'))
                .find(item => item.querySelector('span')?.textContent?.startsWith(`${id} ·`));
              if (currentRow) currentRow.querySelector('span').textContent = stateLabel(error.message || String(error));
            }
          } finally {
            if (getWebLLMState().operation?.id === operationId) setWebLLMState({ operation: null });
          }
      };
      const deleteModel = async event => {
          const button = event.currentTarget;
          const Dialogs = getDialogs();
          if (!Dialogs?.confirm || !await Dialogs.confirm(t('confirm_webllm_delete', { model: id }))) return;
          const contextKey = getEditorContextKey(elements);
          const operationId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          setWebLLMState({ operation: { id: operationId, modelId: id, contextKey } });
          list.querySelectorAll('button').forEach(action => { action.disabled = true; });
          button.dataset.loading = 'true';
          button.innerHTML = getIcons()?.get?.('spinner', { size: 14 }) || t('webllm_deleting');
          const API = getApi();
          label.textContent = stateLabel(t('webllm_deleting'));
          progressBar.hidden = false;
          progressBar.removeAttribute('value');
          try {
            const removed = await API.deleteLocalModel(id, elements?.settingApiType?.value);
            if (!removed) throw new Error(t('webllm_delete_failed'));
            if (getWebLLMState().operation?.id === operationId && getEditorContextKey(elements) === contextKey) {
              const catalog = updateWebLLMModel(id, 'missing');
              setWebLLMState({ operation: null });
              refreshSelectableModels(elements, catalog);
              renderWebLLMModels(elements, catalog);
            }
          } catch (error) {
            if (getEditorContextKey(elements) === contextKey) {
              label.textContent = stateLabel(error.message || String(error));
              progressBar.hidden = true;
              button.disabled = false;
              delete button.dataset.loading;
            }
          } finally {
            if (getWebLLMState().operation?.id === operationId) setWebLLMState({ operation: null });
          }
      };
      const renderActions = status => {
        if (status === 'cached') {
          actions.replaceChildren(createAction('trash', 'webllm_delete', deleteModel, !!operation));
          return;
        }
        actions.replaceChildren(
          createAction('download', 'webllm_download', downloadModel, !!operation),
          createAction('trash', 'webllm_delete', deleteModel, !!operation || status !== 'incomplete')
        );
      };
      renderActions(state === 'cached' ? 'cached' : 'missing');
      row.appendChild(actions);
      list.appendChild(row);
    });
    status.appendChild(list);
  }

  function parseWebLLMProgress(progress) {
    const rawText = String(progress?.detail || progress?.text || '').trim();
    const percentMatch = rawText.match(/(\d+(?:\.\d+)?)%\s+completed/i);
    const shaderMatch = rawText.match(/Loading GPU shader modules\s*\[(\d+)\/(\d+)\]/i);
    const elapsedMatch = rawText.match(/(\d+(?:\.\d+)?)\s+secs?\s+elapsed/i);
    const explicitPercent = progress?.percent === null || progress?.percent === undefined ? NaN : Number(progress.percent);
    const percent = Number.isFinite(explicitPercent)
      ? Math.min(100, Math.max(0, explicitPercent))
      : (percentMatch ? Math.min(100, Math.max(0, Number(percentMatch[1]))) : null);
    const elapsed = elapsedMatch ? t('webllm_elapsed_seconds', { seconds: Math.round(Number(elapsedMatch[1])) }) : '';
    const loadingMatch = rawText.match(/Loading model from cache\[(\d+)\/(\d+)\]/i);
    const phase = progress?.phase || '';
    const text = phase === 'starting' ? t('webllm_starting')
      : (phase === 'ready' ? t('webllm_ready')
      : (shaderMatch
      ? t('webllm_gpu_shaders', { current: shaderMatch[1], total: shaderMatch[2], percent: percent === null ? '' : ` · ${Math.round(percent)} %`, elapsed: elapsed ? ` · ${elapsed}` : '' })
      : (loadingMatch ? t('webllm_loading_model', { current: loadingMatch[1], total: loadingMatch[2], percent: percent === null ? '' : ` · ${Math.round(percent)} %`, elapsed: elapsed ? ` · ${elapsed}` : '' })
      : (phase === 'loading' ? t('webllm_loading_parameters') : t('webllm_preparing')))));
    return { text, percent: Number.isFinite(percent) ? percent : null };
  }

  function formatWebLLMVram(model) {
    const megabytes = Number(model?.details?.webllmVramMB);
    if (!Number.isFinite(megabytes) || megabytes <= 0) return '';
    const size = megabytes >= 1024
      ? `${(megabytes / 1024).toFixed(1).replace(/\.0$/, '')} GB`
      : `${Math.round(megabytes)} MB`;
    return ` · ${t('webllm_vram_required', { size })}`;
  }

  function refreshSelectableModels(elements, models) {
    const sorted = sortWebLLMModels(models);
    const completed = new Set(getWebLLMCompletedModelIds());
    const downloaded = sorted.filter(m => {
      const id = typeof m === 'string' ? m : (m?.id || m?.name || '');
      return m?.details?.webllmCache === 'cached' || completed.has(id);
    });
    if (elements?.settingModel && !downloaded.some(model => model.id === elements.settingModel.value.trim())) {
      if (downloaded.length > 0) {
        elements.settingModel.value = downloaded[0].id;
      }
    }
    populateModelList(elements, null, sorted, !elements?.settingModel?.value);
  }

  async function handleQueryServer(elements, appConfig) {
    if (!elements || !elements.btnQueryServer) return false;

    const apiUrl = (elements.settingApiUrl ? elements.settingApiUrl.value : appConfig?.apiUrl || '').trim();
    const apiKey = (elements.settingApiKey ? elements.settingApiKey.value : appConfig?.apiKey || '').trim();
    const apiType = (elements.settingApiType ? elements.settingApiType.value : appConfig?.apiType || 'openai').trim();

    if (!apiUrl) {
      if (elements.serverQueryStatus) {
        elements.serverQueryStatus.style.display = 'block';
        elements.serverQueryStatus.className = 'server-query-status status-error';
        elements.serverQueryStatus.textContent = t('err_invalid_url');
      }
      return false;
    }

    elements.btnQueryServer.disabled = true;
    elements.btnQueryServer.classList.add('loading');
    const queryText = elements.btnQueryServer.querySelector('.query-btn-text');
    if (queryText) queryText.textContent = t('btn_querying_text');

    if (elements.serverQueryStatus) {
      elements.serverQueryStatus.style.display = 'block';
      elements.serverQueryStatus.className = 'server-query-status status-loading';
      elements.serverQueryStatus.textContent = t('err_connecting_models', { url: apiUrl });
    }

    try {
      const API = getApi();
      if (!API?.fetchServerModels) {
        throw new Error('API query function not available.');
      }

      addDebugLog('network', `Consultando modelos en ${apiUrl} [${apiType}]`);
      addDebugLog('raw', `>>> OUTGOING GET/POST ${apiUrl} (fetchServerModels)`);
      const res = await API.fetchServerModels(apiUrl, apiKey, apiType);
      addDebugLog('raw', `<<< INCOMING (fetchServerModels):\n${JSON.stringify(res, null, 2)}`);

      if (res.success && res.models && res.models.length > 0) {
        const locallyManaged = getProviders()?.registry?.get?.(apiType)?.getConnectionConfig?.().localModelManagement === true;
        const sortedModels = locallyManaged ? sortWebLLMModels(res.models) : res.models;
        saveCachedModels(sortedModels, { apiUrl, apiType });
        if (locallyManaged) refreshSelectableModels(elements, sortedModels);
        else populateModelList(elements, appConfig, sortedModels, true);

        if (elements.serverQueryStatus) {
          elements.serverQueryStatus.className = 'server-query-status status-success';
          elements.serverQueryStatus.textContent = t('msg_models_success_text', { count: res.count, endpoint: res.endpoint });
          if (locallyManaged) {
            const contextKey = getEditorContextKey(elements);
            const current = getWebLLMState();
            setWebLLMState({
              catalog: sortedModels,
              contextKey,
              operation: current.operation?.contextKey === contextKey ? current.operation : null
            });
            renderWebLLMModels(elements, sortedModels);
          }
        }
        return true;
      } else {
        throw new Error(res.error || 'Server did not return a valid models list.');
      }
    } catch (err) {
      console.error('Error querying server models:', err);
      if (elements.serverQueryStatus) {
        elements.serverQueryStatus.className = 'server-query-status status-error';
        const ollamaHelp = getOllamaConnectionHelp(apiType, err);
        elements.serverQueryStatus.innerHTML = ollamaHelp || t('err_api_connect', { err: escapeHtml(err.message || String(err)) });
      }
      return false;
    } finally {
      elements.btnQueryServer.disabled = false;
      elements.btnQueryServer.classList.remove('loading');
      if (queryText) queryText.textContent = t('btn_query_text');
    }
  }

  function getBadgeClass(status) {
    switch (status) {
      case 'confirmed': return 'cap-badge cap-badge-confirmed';
      case 'inferred': return 'cap-badge cap-badge-inferred';
      case 'declared': return 'cap-badge cap-badge-declared';
      case 'unsupported': return 'cap-badge cap-badge-unsupported';
      default: return 'cap-badge cap-badge-unknown';
    }
  }

  function getBadgeIcon(status) {
    switch (status) {
      case 'confirmed': return '✓';
      case 'inferred': return '✦';
      case 'declared': return 'ℹ';
      case 'unsupported': return '✕';
      default: return '?';
    }
  }

  function getStatusLabel(status) {
    switch (status) {
      case 'confirmed': return t('inspector_status_confirmed');
      case 'inferred': return t('inspector_status_inferred');
      case 'declared': return t('inspector_status_declared');
      case 'unsupported': return t('inspector_status_unsupported');
      default: return t('inspector_status_unknown');
    }
  }

  function renderInspectorReport(elements, report) {
    if (!elements || !elements.inspectorResults || !report) return;

    if (report.success === false || report.connected === false) {
      elements.inspectorResults.innerHTML = `
        <div class="server-query-status status-error" style="display: block;">
          ${escapeHtml(report.error || t('inspector_conn_failed') || 'Fallo de conexión: No se pudo conectar con el servidor.')}
        </div>
      `;
      return;
    }

    const p = report.provider || {};
    const ep = report.endpoint || {};
    const m = report.model || {};
    const caps = report.capabilities || {};

    const icons = getIcons();
    const capIcons = {
      streaming: icons?.get?.('radio', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.93 19.07a10 10 0 0 1 0-14.14"></path><path d="M7.76 16.24a6 6 0 0 1 0-8.48"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.48"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>',
      tools: icons?.get?.('settings', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
      vision: icons?.get?.('eye', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
      reasoning: icons?.get?.('brain', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04zm5 0a2.5 2.5 0 0 0-2.5 2.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z"></path></svg>',
      jsonMode: icons?.get?.('code', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
      promptCaching: icons?.get?.('zap', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
      embeddings: icons?.get?.('hash', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>',
      modelListing: icons?.get?.('bot', { size: 14 }) || '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="12" x="3" y="10" rx="2"></rect><circle cx="12" cy="4" r="2"></circle><line x1="12" y1="6" x2="12" y2="10"></line><circle cx="8" cy="15" r="1"></circle><circle cx="16" cy="15" r="1"></circle></svg>'
    };

    const capKeys = [
      { key: 'streaming', title: t('inspector_cap_streaming'), icon: capIcons.streaming },
      { key: 'tools', title: t('inspector_cap_tools'), icon: capIcons.tools },
      { key: 'vision', title: t('inspector_cap_vision'), icon: capIcons.vision },
      { key: 'reasoning', title: t('inspector_cap_reasoning'), icon: capIcons.reasoning },
      { key: 'jsonMode', title: t('inspector_cap_jsonMode'), icon: capIcons.jsonMode },
      { key: 'promptCaching', title: t('inspector_cap_promptCaching'), icon: capIcons.promptCaching },
      { key: 'embeddings', title: t('inspector_cap_embeddings'), icon: capIcons.embeddings },
      { key: 'modelListing', title: t('inspector_cap_modelListing'), icon: capIcons.modelListing }
    ];

    let cardsHtml = '';
    capKeys.forEach(item => {
      const c = caps[item.key] || { status: 'unknown', detail: '' };
      const badgeCls = getBadgeClass(c.status);
      const badgeIcon = getBadgeIcon(c.status);
      const statusLabel = getStatusLabel(c.status);

      cardsHtml += `
        <div class="inspector-cap-card">
          <div class="cap-card-header">
            <span class="cap-card-title" style="display: inline-flex; align-items: center; gap: 0.35rem;">${item.icon} ${item.title}</span>
            <span class="${badgeCls}">${badgeIcon} ${statusLabel}</span>
          </div>
          <div class="cap-card-detail">${escapeHtml(c.detail || '')}</div>
        </div>
      `;
    });

    const modelInfoText = m.totalDiscovered > 0
      ? (t('inspector_discovered_models', { count: m.totalDiscovered }) || `${m.totalDiscovered} modelo(s) descubierto(s)`)
      : (m.selected ? (t('inspector_model_selected', { model: escapeHtml(m.selected) }) || `Modelo: ${escapeHtml(m.selected)}`) : (t('inspector_no_models') || 'Sin modelos listados'));

    const metaProvider = t('inspector_meta_provider') || 'Proveedor';
    const metaEndpoint = t('inspector_meta_endpoint') || 'Endpoint Chat';
    const metaModels = t('inspector_meta_models') || 'Modelos';
    const metaLatency = t('inspector_meta_latency') || 'Latencia Diagnóstico';
    const unknownText = t('inspector_unknown') || 'Desconocido';

    elements.inspectorResults.innerHTML = `
      <div class="inspector-header-meta">
        <div class="inspector-meta-item">
          <span class="meta-label">${escapeHtml(metaProvider)}</span>
          <span class="meta-value">${escapeHtml(p.label || p.id || unknownText)}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="meta-label">${escapeHtml(metaEndpoint)}</span>
          <span class="meta-value" style="font-family: monospace; font-size: 0.775rem;">${escapeHtml(ep.normalized || ep.raw || '')}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="meta-label">${escapeHtml(metaModels)}</span>
          <span class="meta-value">${escapeHtml(modelInfoText)}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="meta-label">${escapeHtml(metaLatency)}</span>
          <span class="meta-value">${report.inspectionTimeMs || 0} ms</span>
        </div>
      </div>

      <div class="inspector-cap-grid">
        ${cardsHtml}
      </div>
    `;
  }

  async function handleRunInspector(elements, appConfig) {
    if (!elements || !elements.btnRunInspector || !elements.inspectorResults) return;

    const apiUrl = elements.settingApiUrl ? elements.settingApiUrl.value.trim() : (appConfig?.apiUrl || '');
    const apiType = elements.settingApiType ? elements.settingApiType.value : (appConfig?.apiType || 'openai');
    const apiKey = elements.settingApiKey ? elements.settingApiKey.value.trim() : (appConfig?.apiKey || '');
    const model = elements.settingModel ? elements.settingModel.value.trim() : (appConfig?.model || '');

    if (!apiUrl) {
      if (elements.inspectorResults) {
        elements.inspectorResults.style.display = 'block';
        elements.inspectorResults.innerHTML = `
          <div class="server-query-status status-error" style="display: block;">
            ${escapeHtml(t('err_invalid_url') || 'Por favor, introduce una URL de servidor válida.')}
          </div>
        `;
      }
      return;
    }

    elements.btnRunInspector.disabled = true;
    const btnText = elements.btnRunInspector.querySelector('.inspector-btn-text');
    const originalText = btnText ? btnText.textContent : '';
    if (btnText) btnText.textContent = t('btn_running_inspector');

    elements.inspectorResults.style.display = 'block';
    elements.inspectorResults.innerHTML = `
      <div style="padding: 1.5rem; text-align: center; color: var(--text-muted);">
        <span class="query-icon" style="display:inline-flex; align-items: center; justify-content: center; animation: spin 1s linear infinite;"><svg class="ui-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg></span>
        <p style="margin-top: 0.5rem; font-size: 0.85rem;">${t('btn_running_inspector')}</p>
      </div>
    `;

    try {
      const API = getApi();
      if (!API?.inspectProvider) {
        throw new Error(t('inspector_module_unavailable') || 'Módulo de inspección no disponible.');
      }

      addDebugLog('network', `Ejecutando Provider Inspector en ${apiUrl} [${apiType}]`);
      const report = await API.inspectProvider({ apiUrl, apiType, apiKey, model });

      if (report && (report.success === false || report.connected === false)) {
        throw new Error(report.error || t('inspector_conn_failed') || 'Fallo de conexión con el servidor.');
      }

      renderInspectorReport(elements, report);
    } catch (err) {
      console.error('Error in Provider Inspector:', err);
      const ollamaHelp = getOllamaConnectionHelp(apiType, err);
      elements.inspectorResults.innerHTML = `
        <div class="server-query-status status-error" style="display: block;">
          ${ollamaHelp || escapeHtml(err.message || String(err))}
        </div>
      `;
    } finally {
      elements.btnRunInspector.disabled = false;
      if (btnText) btnText.textContent = originalText;
    }
  }

  return {
    loadCachedModels,
    saveCachedModels,
    getConnectionCacheKey,
    getCachedModels,
    getModelContextLimit,
    populateModelList,
    renderWebLLMModels,
    getWebLLMState,
    setWebLLMState,
    updateWebLLMModel,
    formatWebLLMVram,
    parseWebLLMProgress,
    handleQueryServer,
    handleRunInspector,
    renderInspectorReport,
    getOllamaConnectionHelp,
    getBadgeClass,
    getBadgeIcon,
    getStatusLabel,
    sortWebLLMModels,
    getWebLLMCompletedModelIds
  };
});
