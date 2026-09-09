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

  function getOllamaConnectionHelp(apiType, error) {
    const type = String(apiType || '').trim().toLowerCase();
    const message = String(error?.message || error || '');
    const isBrowserNetworkError = /networkerror|failed to fetch|load failed|network request failed/i.test(message);
    return type === 'ollama' && isBrowserNetworkError ? t('err_ollama_origins') : '';
  }

  function loadCachedModels(elements, appConfig) {
    try {
      const Storage = getStorage();
      const cached = Storage?.getStorageItem ? Storage.getStorageItem('cached_models') : null;
      if (cached) {
        discoveredModels = JSON.parse(cached);
        if (Array.isArray(discoveredModels) && discoveredModels.length > 0) {
          populateModelList(elements, appConfig, discoveredModels, false);
        }
      }
    } catch (e) {
      console.warn('No se pudieron cargar modelos de caché:', e);
    }
    return discoveredModels;
  }

  function saveCachedModels(models) {
    discoveredModels = models || [];
    try {
      const Storage = getStorage();
      if (Storage?.setStorageItem) {
        Storage.setStorageItem('cached_models', JSON.stringify(discoveredModels));
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
    if (!models || !Array.isArray(models) || models.length === 0) return;

    const doc = elements?.modelDatalist?.ownerDocument || elements?.modelSelectHelper?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    if (elements?.modelDatalist) {
      elements.modelDatalist.innerHTML = '';
      models.forEach(m => {
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
      defaultOpt.textContent = t('model_select_count', { count: models.length });
      elements.modelSelectHelper.appendChild(defaultOpt);

      const currentVal = elements.settingModel ? elements.settingModel.value.trim() : (appConfig?.model || '');

      models.forEach(m => {
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
      const firstId = (typeof models[0] === 'string' ? models[0] : (models[0].id || models[0].name || '')).trim();
      if (!currentVal && firstId) {
        elements.settingModel.value = firstId;
        if (elements.modelSelectHelper) elements.modelSelectHelper.value = firstId;
      }
    }
  }

  async function handleQueryServer(elements, appConfig) {
    if (!elements || !elements.btnQueryServer) return;

    const apiUrl = (elements.settingApiUrl ? elements.settingApiUrl.value : appConfig?.apiUrl || '').trim();
    const apiKey = (elements.settingApiKey ? elements.settingApiKey.value : appConfig?.apiKey || '').trim();
    const apiType = (elements.settingApiType ? elements.settingApiType.value : appConfig?.apiType || 'openai').trim();

    if (!apiUrl) {
      if (elements.serverQueryStatus) {
        elements.serverQueryStatus.style.display = 'block';
        elements.serverQueryStatus.className = 'server-query-status status-error';
        elements.serverQueryStatus.textContent = t('err_invalid_url');
      }
      return;
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
        saveCachedModels(res.models);
        populateModelList(elements, appConfig, res.models, true);

        if (elements.serverQueryStatus) {
          elements.serverQueryStatus.className = 'server-query-status status-success';
          elements.serverQueryStatus.innerHTML = t('msg_models_success', { count: res.count, endpoint: res.endpoint });
        }
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

    const capIcons = {
      streaming: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.93 19.07a10 10 0 0 1 0-14.14"></path><path d="M7.76 16.24a6 6 0 0 1 0-8.48"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.48"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>',
      tools: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',
      vision: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
      reasoning: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04zm5 0a2.5 2.5 0 0 0-2.5 2.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z"></path></svg>',
      jsonMode: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>',
      promptCaching: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
      embeddings: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>',
      modelListing: '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="12" x="3" y="10" rx="2"></rect><circle cx="12" cy="4" r="2"></circle><line x1="12" y1="6" x2="12" y2="10"></line><circle cx="8" cy="15" r="1"></circle><circle cx="16" cy="15" r="1"></circle></svg>'
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
    getCachedModels,
    getModelContextLimit,
    populateModelList,
    handleQueryServer,
    handleRunInspector,
    renderInspectorReport,
    getOllamaConnectionHelp,
    getBadgeClass,
    getBadgeIcon,
    getStatusLabel
  };
});
