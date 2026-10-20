/**
 * Consulta de modelos del servidor, caché de modelos por conexión, modelos locales de WebLLM e
 * inspector de capacidades del proveedor.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUIInspector = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml, createId } = Utils;
  const { t } = I18n;

  const getApi = () => resolveDep('ChatAPI', './api.js');
  const getStorage = () => resolveDep('ChatStorage', './storage.js');
  const getDebug = () => resolveDep('ChatDebug', './debug.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getProviders = () => resolveDep('ChatProviders', './providers.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getUITelemetry = () => resolveDep('ChatUITelemetry', './ui-telemetry.js');
  const getUIReasoning = () => resolveDep('ChatUIReasoning', './ui-reasoning.js');
  const getWebLLM = () => resolveDep('ChatWebLLM', './providers-webllm.js');

  const MODEL_CACHE_KEY = 'cached_models';
  const MODEL_CACHE_VERSION = 1;
  // Contexto que se asume para un modelo WebLLM sin dato propio.
  const WEBLLM_DEFAULT_CONTEXT = 4096;

  // Modelos de la última consulta o de la caché de la conexión del editor.
  let discoveredModels = [];

  const addDebugLog = (type, text) => getDebug().addLog(type, text);
  const modelId = model => (typeof model === 'string' ? model : (model?.id || model?.name || '')).trim();
  const spinner = size => Icons.get('spinner', { size, className: 'ui-icon-spin' });
  const statusHtml = (message, className = 'status-error') => `<div class="server-query-status inspector-status ${className}">${message}</div>`;

  const getWebLLMState = () => getState().get('ui').webllm;

  function setWebLLMState(update) {
    getState().set('ui', ui => ({ ...ui, webllm: { ...ui.webllm, ...update } }));
    return getWebLLMState();
  }

  /** Identifica el perfil y la conexión del editor: una operación en curso solo afecta a la suya. */
  const getEditorContextKey = elements => [elements.profileSelectHelper.value, elements.settingApiType.value, elements.settingApiUrl.value].join('|');

  function updateWebLLMModel(id, status) {
    const catalog = getWebLLMState().catalog.map(model => model?.id === id
      ? { ...model, details: { ...model.details, webllmCache: status } }
      : model);
    setWebLLMState({ catalog });
    return catalog;
  }

  function getOllamaConnectionHelp(apiType, error) {
    const message = String(error?.message || error || '');
    const isBrowserNetworkError = /networkerror|failed to fetch|load failed|network request failed/i.test(message);
    return String(apiType).trim().toLowerCase() === 'ollama' && isBrowserNetworkError ? t('err_ollama_origins') : '';
  }

  function getConnectionCacheKey({ apiType, apiUrl }) {
    const type = String(apiType || 'openai').trim().toLowerCase();
    const url = String(apiUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    return url ? `${type}:${url}` : '';
  }

  const isLocallyManaged = apiType => getProviders().registry.get(apiType).getConnectionConfig().localModelManagement === true;

  function isDownloaded(model, completed) {
    return model?.details?.webllmCache === 'cached' || completed.has(modelId(model));
  }

  /** Modelos WebLLM con los descargados primero, en el orden del catálogo. */
  function sortWebLLMModels(models) {
    const completed = new Set(getWebLLM().getCompletedModelIds());
    return [...models].sort((a, b) => getWebLLM().compareCatalogModels(a, b, model => isDownloaded(model, completed)));
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

  /**
   * Carga en el editor los modelos guardados para la conexión. En WebLLM añade los descargados
   * aunque no estén en la caché.
   */
  function loadCachedModels(elements, appConfig) {
    const apiType = String(appConfig.apiType || elements.settingApiType.value || 'openai').trim().toLowerCase();
    const cacheKey = getConnectionCacheKey(appConfig);
    discoveredModels = cacheKey ? [...(readModelCache().connections[cacheKey] || [])] : [];

    if (apiType === 'webllm') {
      const known = new Set(discoveredModels.map(modelId));
      for (const id of getWebLLM().getCompletedModelIds()) {
        if (known.has(id)) continue;
        discoveredModels.push({ id, name: id, details: { webllmCache: 'cached', loaded_context_length: WEBLLM_DEFAULT_CONTEXT, max_context_length: WEBLLM_DEFAULT_CONTEXT } });
        known.add(id);
      }
      discoveredModels = sortWebLLMModels(discoveredModels);
    }
    if (discoveredModels.length > 0) populateModelList(elements, appConfig, discoveredModels, false);
    return discoveredModels;
  }

  function saveCachedModels(models, connection) {
    discoveredModels = models;
    const cacheKey = getConnectionCacheKey(connection);
    if (!cacheKey) return;
    const document = readModelCache();
    document.connections[cacheKey] = models;
    getStorage().setStorageItem(MODEL_CACHE_KEY, JSON.stringify(document));
  }

  /** Entrada del catálogo para un modelo: por id exacto, sin `models/` ni `:latest`, o por sufijo de ruta. */
  function findModelInCatalog(models, targetModel) {
    const target = String(targetModel || '').trim().toLowerCase();
    if (!target) return null;
    const idOf = model => modelId(model).toLowerCase();
    const base = id => id.replace(/^models\//, '').replace(/:latest$/, '');
    return models.find(model => idOf(model) === target)
      || models.find(model => base(idOf(model)) === base(target))
      || models.find(model => idOf(model).endsWith(`/${target}`) || target.endsWith(`/${idOf(model)}`))
      || null;
  }

  /**
   * Contexto de un modelo según su entrada del catálogo: primero el cargado en el servidor, luego el
   * nominal y por último los tokens máximos declarados.
   */
  function getModelContextLimit(model, catalog = discoveredModels) {
    const selected = String(model || '').trim();
    if (!selected) return null;
    const entry = findModelInCatalog(catalog, selected);
    const details = entry?.details || entry || {};
    const meta = details.meta || entry?.meta || {};
    const smallest = values => {
      const valid = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
      return valid.length ? Math.floor(Math.min(...valid)) : null;
    };

    const active = smallest([details.loaded_context_length, meta.n_ctx]);
    if (active) return active;
    const nominal = smallest([
      details.max_context_length,
      meta.n_ctx_train,
      details.context_length ?? entry?.context_length,
      details.context_window ?? entry?.context_window,
      details.max_model_len ?? entry?.max_model_len
    ]);
    if (nominal) return nominal;
    const declared = smallest([details.max_context_tokens ?? details.max_tokens]);
    if (declared) return declared;
    return details.webllmCache || selected.includes('-MLC') ? WEBLLM_DEFAULT_CONTEXT : null;
  }

  function createModelOption(id, label = '') {
    const option = document.createElement('option');
    option.value = id;
    if (label) option.textContent = label;
    const contextLimit = getModelContextLimit(id);
    if (contextLimit) option.dataset.contextLength = String(contextLimit);
    return option;
  }

  /** Rellena la lista de modelos del editor; en WebLLM solo ofrece los descargados. */
  function populateModelList(elements, appConfig, models, selectFirstIfEmpty) {
    const apiType = String(elements.settingApiType.value || appConfig?.apiType || '').trim().toLowerCase();
    let ids = models.map(modelId).filter(Boolean);
    if (apiType === 'webllm') {
      const completed = new Set(getWebLLM().getCompletedModelIds());
      ids = models.filter(model => isDownloaded(model, completed)).map(modelId).filter(Boolean);
    }

    elements.modelDatalist.replaceChildren(...ids.map(id => createModelOption(id)));

    const currentModel = elements.settingModel.value.trim();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.disabled = true;
    placeholder.textContent = t('model_select_count', { count: ids.length });
    elements.modelSelectHelper.replaceChildren(placeholder, ...ids.map(id => createModelOption(id, id)));
    elements.modelSelectHelper.value = ids.includes(currentModel) ? currentModel : '';

    const firstId = ids[0] || '';
    const replaceModel = apiType === 'webllm' ? !ids.includes(currentModel) : (selectFirstIfEmpty && !currentModel && firstId);
    if (replaceModel) {
      elements.settingModel.value = firstId;
      elements.modelSelectHelper.value = firstId;
    }
  }

  /** Tras descargar o borrar un modelo WebLLM, el modelo elegido debe seguir entre los descargados. */
  function refreshSelectableModels(elements, models) {
    const completed = new Set(getWebLLM().getCompletedModelIds());
    const downloaded = sortWebLLMModels(models).filter(model => isDownloaded(model, completed));
    if (!downloaded.some(model => modelId(model) === elements.settingModel.value.trim())) {
      elements.settingModel.value = downloaded.length > 0 ? modelId(downloaded[0]) : '';
    }
    populateModelList(elements, null, downloaded, !elements.settingModel.value);
  }

  function parseWebLLMProgress(progress) {
    const rawText = String(progress?.detail || progress?.text || '').trim();
    const percentMatch = rawText.match(/(\d+(?:\.\d+)?)%\s+completed/i);
    const shaderMatch = rawText.match(/Loading GPU shader modules\s*\[(\d+)\/(\d+)\]/i);
    const loadingMatch = rawText.match(/Loading model from cache\[(\d+)\/(\d+)\]/i);
    const elapsedMatch = rawText.match(/(\d+(?:\.\d+)?)\s+secs?\s+elapsed/i);
    const explicitPercent = progress?.percent === null || progress?.percent === undefined ? NaN : Number(progress.percent);
    const rawPercent = Number.isFinite(explicitPercent) ? explicitPercent : (percentMatch ? Number(percentMatch[1]) : null);
    const percent = rawPercent === null ? null : Math.min(100, Math.max(0, rawPercent));
    const elapsed = elapsedMatch ? t('webllm_elapsed_seconds', { seconds: Math.round(Number(elapsedMatch[1])) }) : '';
    const counters = match => ({
      current: match[1],
      total: match[2],
      percent: percent === null ? '' : ` · ${Math.round(percent)} %`,
      elapsed: elapsed ? ` · ${elapsed}` : ''
    });
    const phase = progress?.phase || '';
    let text;
    if (phase === 'starting') text = t('webllm_starting');
    else if (phase === 'ready') text = t('webllm_ready');
    else if (shaderMatch) text = t('webllm_gpu_shaders', counters(shaderMatch));
    else if (loadingMatch) text = t('webllm_loading_model', counters(loadingMatch));
    else text = t(phase === 'loading' ? 'webllm_loading_parameters' : 'webllm_preparing');
    return { text, percent };
  }

  function formatWebLLMVram(model) {
    const megabytes = Number(model?.details?.webllmVramMB);
    if (!Number.isFinite(megabytes) || megabytes <= 0) return '';
    const size = megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.round(megabytes)} MB`;
    return ` · ${t('webllm_vram_required', { size })}`;
  }

  /** Mensaje legible de un error de WebLLM, que a veces llega como objeto o en su causa. */
  function formatWebLLMErrorMessage(error, fallbackKey) {
    if (!error) return fallbackKey ? t(fallbackKey) : '';
    const raw = typeof error === 'string' ? error : (error.message || error.error?.message || error.error || '');
    const message = typeof raw === 'string' ? raw.trim().replace(/^Error:\s*/i, '').trim() : '';
    if (message && message !== '[object Object]') return message;
    const cause = typeof error === 'object' && error.cause ? formatWebLLMErrorMessage(error.cause, '') : '';
    return cause || (fallbackKey ? t(fallbackKey) : '');
  }

  /** Lista de modelos WebLLM con su estado y las acciones de descargar, cancelar y borrar. */
  function renderWebLLMModels(elements, rawModels = getWebLLMState().catalog) {
    const status = elements.serverQueryStatus;
    const models = sortWebLLMModels(rawModels);
    const operation = getWebLLMState().operation;
    status.querySelector('.webllm-model-list')?.remove();
    const list = document.createElement('div');
    list.className = 'webllm-model-list';
    const API = getApi();
    const apiType = elements.settingApiType.value;

    for (const model of models) {
      const id = modelId(model);
      if (!id) continue;
      const row = document.createElement('div');
      row.className = 'webllm-model-row';
      const state = model?.details?.webllmCache;
      const label = document.createElement('span');
      const toolsLabel = model?.details?.webllmToolsRecommended === true ? ` · ${t('webllm_tools_recommended')}` : '';
      const stateLabel = text => `${id} · ${text}${formatWebLLMVram(model)}${toolsLabel}`;
      const stateKey = { cached: 'webllm_model_cached', incomplete: 'webllm_model_incomplete', unknown: 'webllm_model_unknown' }[state] || 'webllm_model_missing';
      label.textContent = stateLabel(t(stateKey));
      const progressBar = document.createElement('progress');
      progressBar.className = 'webllm-model-progress';
      progressBar.max = 100;
      progressBar.hidden = true;
      row.append(label, progressBar);

      const createAction = (icon, labelKey, handler, disabled) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'webllm-model-action';
        button.title = t(labelKey);
        button.setAttribute('aria-label', t(labelKey));
        button.innerHTML = Icons.get(icon, { size: 14 });
        button.disabled = disabled;
        button.addEventListener('click', handler);
        return button;
      };

      /** Reserva la operación del modelo; al terminar solo se aplica si el editor sigue en la misma conexión. */
      const startOperation = () => {
        const operationId = createId();
        const contextKey = getEditorContextKey(elements);
        setWebLLMState({ operation: { id: operationId, modelId: id, contextKey } });
        list.querySelectorAll('button').forEach(action => { action.disabled = true; });
        progressBar.hidden = false;
        progressBar.removeAttribute('value');
        return {
          isCurrent: () => getWebLLMState().operation?.id === operationId && getEditorContextKey(elements) === contextKey,
          isSameEditor: () => getEditorContextKey(elements) === contextKey,
          finish: () => { if (getWebLLMState().operation?.id === operationId) setWebLLMState({ operation: null }); }
        };
      };
      const applyStatus = webllmCache => {
        const catalog = updateWebLLMModel(id, webllmCache);
        setWebLLMState({ operation: null });
        refreshSelectableModels(elements, catalog);
        renderWebLLMModels(elements, catalog);
      };

      const downloadModel = async event => {
        const button = event.currentTarget;
        if (getWebLLMState().operation?.modelId === id) {
          button.disabled = true;
          label.textContent = stateLabel(t('webllm_cancelling'));
          await API.cancelLocalModelOperation(id, apiType);
          return;
        }
        const op = startOperation();
        button.disabled = false;
        button.title = t('webllm_cancel');
        button.setAttribute('aria-label', t('webllm_cancel'));
        button.innerHTML = Icons.get('stop', { size: 14 });
        label.textContent = stateLabel(t('webllm_preparing'));
        addDebugLog('system', `[WebLLM] Preparing model ${id}`);
        const update = progress => {
          if (!op.isCurrent()) return;
          const feedback = parseWebLLMProgress(progress);
          label.textContent = stateLabel(feedback.text);
          if (feedback.percent === null) progressBar.removeAttribute('value');
          else progressBar.value = feedback.percent;
        };
        try {
          if (!await API.downloadLocalModel(id, update, apiType)) throw new Error(t('webllm_model_incomplete'));
          addDebugLog('system', `[WebLLM] Model ${id} downloaded and ready`);
          if (op.isCurrent()) applyStatus('cached');
        } catch (error) {
          const errorMsg = formatWebLLMErrorMessage(error, 'webllm_model_incomplete');
          addDebugLog('error', `[WebLLM] Could not prepare model ${id}: ${errorMsg}`);
          console.error(`[WebLLM] Could not prepare model ${id}:`, error);
          if (op.isCurrent()) {
            applyStatus('incomplete');
            const currentRow = [...elements.serverQueryStatus.querySelectorAll('.webllm-model-row')]
              .find(item => item.querySelector('span').textContent.startsWith(`${id} ·`));
            if (currentRow) currentRow.querySelector('span').textContent = stateLabel(errorMsg);
          }
        } finally {
          op.finish();
        }
      };

      const deleteModel = async event => {
        const button = event.currentTarget;
        if (!await getDialogs().confirm(t('confirm_webllm_delete', { model: id }))) return;
        const op = startOperation();
        button.dataset.loading = 'true';
        button.innerHTML = spinner(14);
        label.textContent = stateLabel(t('webllm_deleting'));
        addDebugLog('system', `[WebLLM] Deleting model ${id} from local storage`);
        try {
          if (!await API.deleteLocalModel(id, apiType)) throw new Error(t('webllm_delete_failed'));
          addDebugLog('system', `[WebLLM] Model ${id} deleted`);
          if (op.isCurrent()) applyStatus('missing');
        } catch (error) {
          const errorMsg = formatWebLLMErrorMessage(error, 'webllm_delete_failed');
          addDebugLog('error', `[WebLLM] Could not delete model ${id}: ${errorMsg}`);
          console.error(`[WebLLM] Could not delete model ${id}:`, error);
          if (op.isSameEditor()) {
            label.textContent = stateLabel(errorMsg);
            progressBar.hidden = true;
            button.disabled = false;
            delete button.dataset.loading;
          }
        } finally {
          op.finish();
        }
      };

      const actions = document.createElement('div');
      actions.className = 'webllm-model-actions';
      if (state === 'cached') {
        actions.append(createAction('trash', 'webllm_delete', deleteModel, Boolean(operation)));
      } else {
        actions.append(
          createAction('download', 'webllm_download', downloadModel, Boolean(operation)),
          createAction('trash', 'webllm_delete', deleteModel, Boolean(operation) || state !== 'incomplete')
        );
      }
      row.appendChild(actions);
      list.appendChild(row);
    }
    status.appendChild(list);
  }

  /** Consulta los modelos del servidor del editor. Devuelve true si obtuvo una lista. */
  async function handleQueryServer(elements, appConfig) {
    const apiType = (elements.settingApiType.value || appConfig.apiType || 'openai').trim();
    let apiUrl = elements.settingApiUrl.value.trim();
    const apiKey = elements.settingApiKey.value.trim();
    if (!apiUrl) {
      apiUrl = String(getProviders().registry.get(apiType).getConnectionConfig().endpoint || elements.settingApiUrl.placeholder || '').trim();
      elements.settingApiUrl.value = apiUrl;
    }

    const status = elements.serverQueryStatus;
    status.hidden = false;
    if (!apiUrl) {
      status.className = 'server-query-status status-error';
      status.textContent = t('err_invalid_url');
      return false;
    }

    const button = elements.btnQueryServer;
    const queryText = button.querySelector('.query-btn-text');
    button.disabled = true;
    button.classList.add('loading');
    queryText.textContent = t('btn_querying_text');
    status.className = 'server-query-status status-loading';
    status.textContent = t('err_connecting_models', { url: apiUrl });

    try {
      addDebugLog('network', `Querying models at ${apiUrl} [${apiType}]`);
      const res = await getApi().fetchServerModels(apiUrl, apiKey, apiType);
      addDebugLog('raw', `<<< INCOMING (fetchServerModels):\n${JSON.stringify(res, null, 2)}`);
      if (!res.success || !res.models?.length) throw new Error(res.error || 'The server did not return a valid model list.');

      const locallyManaged = isLocallyManaged(apiType);
      const models = locallyManaged ? sortWebLLMModels(res.models) : res.models;
      saveCachedModels(models, { apiUrl, apiType });
      if (locallyManaged) refreshSelectableModels(elements, models);
      else populateModelList(elements, appConfig, models, true);

      status.className = 'server-query-status status-success';
      status.textContent = t('msg_models_success_text', { count: res.count, endpoint: res.endpoint });
      if (locallyManaged) {
        const contextKey = getEditorContextKey(elements);
        const { operation } = getWebLLMState();
        setWebLLMState({ catalog: models, contextKey, operation: operation?.contextKey === contextKey ? operation : null });
        renderWebLLMModels(elements, models);
      }
      return true;
    } catch (err) {
      console.error('[UIInspector] Model query failed:', err);
      status.className = 'server-query-status status-error';
      status.innerHTML = getOllamaConnectionHelp(apiType, err) || t('err_api_connect', { err: escapeHtml(err.message || String(err)) });
      return false;
    } finally {
      button.disabled = false;
      button.classList.remove('loading');
      queryText.textContent = t('btn_query_text');
    }
  }

  const BADGES = {
    confirmed: ['✓', 'inspector_status_confirmed'],
    inferred: ['✦', 'inspector_status_inferred'],
    declared: ['ℹ', 'inspector_status_declared'],
    unsupported: ['✕', 'inspector_status_unsupported'],
    unknown: ['?', 'inspector_status_unknown']
  };

  function renderBadge(status) {
    const known = status in BADGES ? status : 'unknown';
    const [icon, labelKey] = BADGES[known];
    return `<span class="cap-badge cap-badge-${known}">${icon} ${escapeHtml(t(labelKey))}</span>`;
  }

  const CAPABILITIES = [
    ['streaming', 'radio', 'inspector_cap_streaming'], ['tools', 'settings', 'inspector_cap_tools'],
    ['vision', 'eye', 'inspector_cap_vision'], ['reasoning', 'brain', 'inspector_cap_reasoning'],
    ['jsonMode', 'code', 'inspector_cap_jsonMode'], ['promptCaching', 'zap', 'inspector_cap_promptCaching'],
    ['embeddings', 'hash', 'inspector_cap_embeddings'], ['modelListing', 'bot', 'inspector_cap_modelListing']
  ];

  /** Informe del inspector: metadatos del endpoint y una tarjeta por capacidad. */
  function renderInspectorReport(elements, report, modelSectionHtml) {
    if (report.success === false || report.connected === false) {
      elements.inspectorResults.innerHTML = `${modelSectionHtml}${statusHtml(escapeHtml(report.error || t('inspector_conn_failed')))}`;
      return;
    }
    const provider = report.provider || {};
    const endpoint = report.endpoint || {};
    const model = report.model || {};
    const caps = report.capabilities || {};
    const cards = CAPABILITIES.map(([key, icon, titleKey]) => {
      const capability = caps[key] || { status: 'unknown' };
      return `<div class="inspector-cap-card">
          <div class="cap-card-header">
            <span class="cap-card-title">${Icons.get(icon, { size: 14 })} ${escapeHtml(t(titleKey))}</span>
            ${renderBadge(capability.status)}
          </div>
          <div class="cap-card-detail">${capability.detailKey ? escapeHtml(t(capability.detailKey, capability.detailParams)) : ''}</div>
        </div>`;
    }).join('');
    const modelInfo = model.totalDiscovered > 0
      ? t('inspector_discovered_models', { count: model.totalDiscovered })
      : (model.selected ? t('inspector_model_selected', { model: model.selected }) : t('inspector_no_models'));
    const metaItem = (labelKey, value, className = '') => `<div class="inspector-meta-item">
            <span class="meta-label">${escapeHtml(t(labelKey))}</span>
            <span class="meta-value${className}">${escapeHtml(value)}</span>
          </div>`;

    elements.inspectorResults.innerHTML = `${modelSectionHtml}
      <div class="inspector-endpoint-section">
        <div class="inspector-section-title">${escapeHtml(t('inspector_endpoint_title'))}</div>
        <div class="inspector-header-meta">
          ${metaItem('inspector_meta_provider', provider.label || provider.id || t('inspector_unknown'))}
          ${metaItem('inspector_meta_endpoint', endpoint.normalized || endpoint.raw || '', ' inspector-endpoint')}
          ${metaItem('inspector_meta_models', modelInfo)}
          ${metaItem('inspector_meta_latency', `${report.inspectionTimeMs || 0} ms`)}
        </div>
        <div class="inspector-cap-grid">${cards}</div>
      </div>`;
  }

  function renderModelSection(displayName, contextLabel, reasoningLabel) {
    return `<div class="inspector-model-section">
        <div class="inspector-model-header">
          <div class="inspector-model-title">
            ${Icons.get('check-circle', { size: 16 })}
            <span>${escapeHtml(t('inspector_model_title'))}: <strong>${escapeHtml(displayName)}</strong></span>
          </div>
          ${renderBadge('confirmed')}
        </div>
        <div class="inspector-model-grid">
          <div class="inspector-meta-item">
            <span class="meta-label">${escapeHtml(t('inspector_meta_context'))}</span>
            <span class="meta-value">${escapeHtml(contextLabel)}</span>
          </div>
          <div class="inspector-meta-item">
            <span class="meta-label">${escapeHtml(t('inspector_meta_reasoning'))}</span>
            <span class="meta-value">${escapeHtml(reasoningLabel)}</span>
          </div>
        </div>
      </div>`;
  }

  /** Resumen del razonamiento del modelo: niveles que admite el proveedor y el configurado. */
  function describeReasoning(adapter, model, effort) {
    const isReasoningModel = /(?:-r1|r1|qwq|o1|o3|reasoning|thinking|gemma-4|deepseek)/i.test(model);
    if (adapter.id === 'webllm' || (adapter.getCapabilities(model).reasoning === false && !isReasoningModel)) {
      return t('inspector_reasoning_none');
    }
    return t('inspector_reasoning_supported', { levels: adapter.reasoningLevels.join(', '), effort: getUIReasoning().getReasoningLevelLabel(effort) });
  }

  const loadingHtml = (size, message) => `<div class="inspector-loading">${spinner(size)}<p>${escapeHtml(message)}</p></div>`;

  /**
   * Inspecciona una conexión: comprueba que el servidor tiene el modelo, muestra su contexto y su
   * razonamiento y diagnostica las capacidades del endpoint. Sin `connection` usa el editor.
   */
  async function handleRunInspector(elements, appConfig, connection = null) {
    const source = connection?.settings || connection;
    const apiUrl = String(source ? source.apiUrl : elements.settingApiUrl.value).trim();
    const apiType = source ? source.apiType : elements.settingApiType.value;
    const apiKey = String(source ? source.apiKey : elements.settingApiKey.value).trim();
    const model = String(source ? source.model : elements.settingModel.value).trim();
    const results = elements.inspectorResults;

    if (!apiUrl || !model) {
      results.innerHTML = statusHtml(escapeHtml(t(apiUrl ? 'inspector_err_no_model' : 'err_invalid_url')));
      return false;
    }

    results.innerHTML = loadingHtml(24, t('inspector_querying_model', { model }));

    const API = getApi();
    try {
      addDebugLog('network', `[Inspector] Querying models at ${apiUrl} [${apiType}] for model ${model}`);
      let queryRes;
      try {
        queryRes = await API.fetchServerModels(apiUrl, apiKey, apiType);
      } catch (err) {
        queryRes = { success: false, error: err?.message || String(err) };
      }
      if (!queryRes.success) {
        const errorMsg = queryRes.error || 'Could not connect to the model server.';
        results.innerHTML = statusHtml(getOllamaConnectionHelp(apiType, errorMsg) || escapeHtml(t('inspector_err_query_failed', { err: errorMsg })));
        return false;
      }

      const models = Array.isArray(queryRes.models) ? queryRes.models : [];
      const sortedModels = isLocallyManaged(apiType) ? sortWebLLMModels(models) : models;
      saveCachedModels(sortedModels, { apiUrl, apiType });
      const foundModel = findModelInCatalog(sortedModels, model);
      if (!foundModel) {
        results.innerHTML = statusHtml(escapeHtml(t('inspector_err_model_not_found', { model })));
        return false;
      }

      // El contexto del modelo activo se publica para el presupuesto de la conversación.
      const contextLimit = getModelContextLimit(model, sortedModels);
      const Config = getConfig();
      const runtimeConfig = Config.getActive();
      if (contextLimit && runtimeConfig.apiUrl === apiUrl && runtimeConfig.model === model) {
        Config.updateRuntime({ modelContextLimit: contextLimit });
      }
      const contextLabel = contextLimit
        ? `${getUITelemetry().formatContextCapacity(contextLimit)} (${contextLimit.toLocaleString()} tokens)`
        : t('inspector_context_unknown');
      const adapter = getProviders().registry.resolve(apiUrl, apiType);
      const effort = String(source?.reasoningEffort || runtimeConfig.reasoningEffort || 'medium').toLowerCase();
      const modelSectionHtml = renderModelSection(modelId(foundModel) || model, contextLabel, describeReasoning(adapter, model, effort));

      results.innerHTML = `${modelSectionHtml}${loadingHtml(20, t('inspector_diagnosing_endpoint'))}`;
      addDebugLog('network', `Running the provider inspector on ${apiUrl} [${apiType}]`);
      let report;
      try {
        report = await API.inspectProvider({ apiUrl, apiType, apiKey, model });
      } catch (probeErr) {
        report = { success: false, connected: false, error: probeErr?.message || String(probeErr) };
      }
      renderInspectorReport(elements, report, modelSectionHtml);
      return true;
    } catch (err) {
      console.error('[UIInspector] Provider inspection failed:', err);
      results.innerHTML = statusHtml(getOllamaConnectionHelp(apiType, err) || escapeHtml(err.message || String(err)));
      return false;
    }
  }

  return {
    findModelInCatalog,
    loadCachedModels,
    getModelContextLimit,
    handleQueryServer,
    handleRunInspector
  };
});
