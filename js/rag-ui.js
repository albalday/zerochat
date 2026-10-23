/**
 * Interfaz del conocimiento local: activar ramas, gestionarlas e indexar sus documentos.
 * Se organiza en tres zonas: el modelo (estado del editor de ramas y consultas a ChatRagStorage y a
 * la configuración, sin DOM), la vista (plantillas y escrituras en el DOM, sin consultas) y el
 * controlador (acciones del usuario, que escriben en el almacenamiento y repintan, y eventos,
 * enlazados una sola vez en initRagUI).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  else root.ChatRagUI = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml, formatBytes, resolveDep } = Utils;
  const { t } = I18n;
  const storage = () => resolveDep('ChatRagStorage', './ragStorage.js');
  const ingestion = () => resolveDep('ChatIngestionEngine', './ingestionEngine.js');
  const indexer = () => resolveDep('ChatRagIndex', './rag-index.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getRagService = () => resolveDep('ChatRagService', './rag-service.js');
  const $ = id => document.getElementById(id);

  // ==========================================================================
  // 1. Modelo: estado y consultas
  // ==========================================================================

  const NEW_BRANCH = '__new__';
  const DEFAULT_LANGUAGE = 'spanish';
  const MAX_FILE_BYTES = 50 * 1024 * 1024;

  // Rama cargada en el editor, para detectar cambios sin guardar.
  let editor = { creating: false, id: '', name: '', description: '', language: DEFAULT_LANGUAGE };
  let currentIngestionController = null;
  let manageDialogSeq = 0;

  /** Estado del editor para una rama, o vacío para crear una nueva. */
  function editorFor(branch) {
    return branch
      ? { creating: false, id: branch.id, name: branch.name || '', description: branch.description || '', language: branch.language || DEFAULT_LANGUAGE }
      : { creating: true, id: '', name: '', description: '', language: DEFAULT_LANGUAGE };
  }

  /** Los campos difieren de la rama cargada en el editor, o hay algo escrito para una rama nueva. */
  function hasPendingChanges({ name, description, language }) {
    if (editor.creating) return Boolean(name || description || language !== DEFAULT_LANGUAGE);
    return name !== editor.name || description !== editor.description || language !== editor.language;
  }

  const canSaveBranch = fields => Boolean(fields.name) && (editor.creating || hasPendingChanges(fields));

  // Las ramas activas viven en la configuración en ejecución.
  const getActiveBranchIds = () => getConfig().getActive().activeRagBranchIds;
  const isBranchActive = branchId => getActiveBranchIds().includes(String(branchId).trim());

  /** Guarda las ramas activas sin vacíos ni repetidos y las devuelve. */
  function setActiveBranchIds(ids) {
    const unique = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
    getConfig().updateRuntime({ activeRagBranchIds: unique });
    return unique;
  }

  /** Ramas activas tras activar o desactivar una. */
  function toggledBranchIds(branchId) {
    const id = String(branchId).trim();
    const active = getActiveBranchIds();
    return active.includes(id) ? active.filter(item => item !== id) : [...active, id];
  }

  /** Ramas con su número de documentos y los bytes que suman. */
  async function listBranchesWithMetrics() {
    const branches = await storage().getBranches();
    return Promise.all(branches.map(async branch => {
      const documents = await storage().getDocumentsByBranch(branch.id);
      return {
        ...branch,
        metrics: {
          documentCount: documents.length,
          totalBytes: documents.reduce((sum, document) => sum + (Number(document.fileSize) || 0), 0)
        }
      };
    }));
  }

  /** Idiomas distintos de las ramas indicadas. */
  async function getBranchLanguages(branchIds) {
    return [...new Set((await storage().getBranches())
      .filter(branch => branchIds.includes(branch.id))
      .map(branch => String(branch.language || DEFAULT_LANGUAGE).trim().toLowerCase()))];
  }

  // ==========================================================================
  // 2. Vista: plantillas y DOM
  // ==========================================================================

  const LANGUAGE_KEYS = {
    spanish: 'rag_lang_spanish',
    english: 'rag_lang_english',
    french: 'rag_lang_french',
    german: 'rag_lang_german',
    italian: 'rag_lang_italian',
    portuguese: 'rag_lang_portuguese'
  };
  const PROGRESS_KEYS = {
    extracting: 'rag_progress_extracting',
    chunking: 'rag_progress_chunking',
    saving: 'rag_progress_saving',
    skipped: 'rag_progress_skipped',
    cancelled: 'rag_progress_cancelled',
    error: 'rag_progress_error'
  };

  function formatBranchMetrics(metrics) {
    const count = Number(metrics?.documentCount) || 0;
    return t('rag_branch_summary_format', { count, plural: count === 1 ? '' : 's', bytes: formatBytes(metrics?.totalBytes || 0) });
  }

  function formatBranchLanguage(lang) {
    const clean = String(lang || DEFAULT_LANGUAGE).toLowerCase().trim();
    return LANGUAGE_KEYS[clean] ? t(LANGUAGE_KEYS[clean]) : clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  function formatDocumentMetrics(document) {
    const images = !Number.isInteger(document.imageCount) || document.imageCount < 0
      ? t('rag_image_count_reload')
      : t(document.imageCount === 1 ? 'rag_image_count_singular' : 'rag_image_count_plural', { count: document.imageCount });
    return t('rag_doc_metrics_format', { chunks: document.chunkCount || 0, size: formatBytes(document.fileSize), images });
  }

  function progressMessage({ status, fileName, detail }) {
    if (status === 'completed') return t(detail.replaced ? 'rag_progress_replaced' : 'rag_progress_indexed', { name: fileName, chunks: detail.chunks, images: detail.images });
    return t(PROGRESS_KEYS[status], { name: fileName, error: detail.error });
  }

  function progressMarkup(event) {
    const itemClass = event.status === 'error' ? 'error' : (event.status === 'cancelled' || event.status === 'skipped') ? 'skipped' : '';
    return `<div class="rag-ingestion-progress-item ${itemClass}"><strong>${escapeHtml(event.fileName)}</strong><span>${escapeHtml(progressMessage(event))}</span><progress max="100" value="${Number(event.percent) || 0}"></progress></div>`;
  }

  /** Traduce los contadores distintos de cero de una lista de pares [clave, valor]. */
  function countParts(counts) {
    return counts.filter(([, count]) => count > 0).map(([key, count]) => t(key, { count }));
  }

  /** Progreso global de la ingesta; tras pulsar detener, el botón queda desactivado hasta que termina. */
  function globalProgressMarkup(event, stopping) {
    const processed = Number(event.processedFiles) || 0;
    const overallPercent = Math.round(Number(event.overallPercent) || 0);
    const parts = countParts([
      ['rag_count_new', processed],
      ['rag_count_replaced', Number(event.replacedFiles) || 0],
      ['rag_count_skipped', Number(event.skippedFiles) || 0],
      ['rag_count_failed', Number(event.failedFiles) || 0]
    ]);
    const status = parts.length ? parts.join(' · ') : t('rag_ingestion_status', { processed });
    const header = t('rag_ingestion_global', { finished: Number(event.finishedFiles) || 0, total: Number(event.totalFiles) || 0 });
    const stopLabel = escapeHtml(t(stopping ? 'rag_ingestion_stopping' : 'rag_btn_stop_ingestion'));
    return `<div class="rag-ingestion-global-progress"><div><strong>${escapeHtml(header)}</strong><span>${escapeHtml(status)}</span></div><progress max="100" value="${overallPercent}"></progress><div class="rag-ingestion-global-actions"><span>${overallPercent}%</span><button type="button" class="btn-danger-outline rag-stop-ingestion-btn" data-rag-stop-ingestion title="${stopLabel}"${stopping ? ' disabled' : ''}>${Icons.get('stop', { size: 11 })} <span>${stopLabel}</span></button></div></div>`;
  }

  function ingestionResultMarkup(result) {
    const count = key => Number(result[key]) || 0;
    const totalIndexed = count('processed') + count('replaced');
    const failed = count('failed');
    let header = t('rag_ingestion_complete', { processed: totalIndexed, failed, total: count('total') });
    if (count('cancelled') > 0) {
      let summaryText = `${t('rag_ingestion_status', { processed: totalIndexed })} · ${t('rag_count_not_indexed', { count: failed })}`;
      const extra = countParts([['rag_count_replaced', count('replaced')], ['rag_count_skipped', count('skipped')], ['rag_count_cancelled', count('cancelled')]]);
      if (extra.length) summaryText += ` (${extra.join(', ')})`;
      header = `${t('rag_ingestion_cancelled')}: ${summaryText}`;
    }
    const errors = result.errors || [];
    const errorList = errors.length
      ? `<div class="rag-ingestion-progress-recent">${errors.map(error => `<div class="rag-ingestion-progress-item error"><strong>${escapeHtml(error.fileName)}</strong><span>${escapeHtml(error.error)}</span></div>`).join('')}</div>`
      : '';
    return `<div class="rag-ingestion-global-progress${failed ? ' error' : ''}"><div><strong>${escapeHtml(header)}</strong></div>${errorList}</div>`;
  }

  function paintToolbarStatus(activeCount) {
    const button = $('btn-open-rag');
    button.classList.toggle('active', activeCount > 0);
    if (activeCount === 0) button.title = t('btn_rag_title');
    else button.title = activeCount === 1 ? t('rag_toolbar_active_single') : t('rag_toolbar_active_multi', { count: activeCount });
  }

  /** Estado del conocimiento y una tarjeta por rama para activarla o desactivarla. */
  function paintActivationDialog(branches, activeIds) {
    const activeList = branches.filter(branch => activeIds.includes(branch.id));
    const activeCount = activeList.length;

    if (activeCount === 0) $('rag-active-status-title').textContent = t('rag_status_disabled');
    else if (activeCount === 1) $('rag-active-status-title').textContent = activeList[0].name;
    else $('rag-active-status-title').textContent = t('rag_status_active_count', { count: activeCount, list: activeList.map(branch => branch.name).join(', ') });
    if (activeCount === 0) $('rag-active-status-desc').textContent = t('rag_status_disabled_desc');
    else $('rag-active-status-desc').textContent = activeCount === 1 ? t('rag_status_desc_single') : t('rag_status_desc_multi', { count: activeCount });
    $('btn-rag-toggle-master').disabled = activeCount === 0;

    const list = $('rag-active-branch-list');
    if (!branches.length) {
      list.innerHTML = `<div class="rag-empty-state">${escapeHtml(t('rag_no_branches_active'))}</div>`;
      return;
    }
    list.innerHTML = branches.map(branch => {
      const isActive = activeIds.includes(branch.id);
      const loadedText = t('rag_branch_loaded', { summary: formatBranchMetrics(branch.metrics) });
      const badge = isActive
        ? `${Icons.get('check', { size: 12 })} <span>${escapeHtml(t('rag_branch_active_badge'))}</span>`
        : `${Icons.get('plus', { size: 12 })} <span>${escapeHtml(t('rag_branch_activate_badge'))}</span>`;
      return `
      <button type="button" class="setting-toggle-card rag-branch-select-card${isActive ? ' active' : ''}" data-branch-id="${escapeHtml(branch.id)}">
        <span class="toggle-card-info"><strong>${escapeHtml(branch.name)}</strong><span class="toggle-card-desc">${escapeHtml(branch.description || t('rag_branch_no_desc'))}</span><span class="rag-branch-metrics">${escapeHtml(loadedText)} · <span class="rag-branch-lang-inline">${Icons.get('globe', { size: 12 })} <span>${escapeHtml(formatBranchLanguage(branch.language))}</span></span></span></span>
        <span class="rag-branch-badge-status">${badge}</span>
      </button>`;
    }).join('');
  }

  const selectedBranchId = () => $('rag-manage-branch-select').value;

  /** Selector de ramas con sus métricas y la opción de crear una nueva. */
  function paintBranchSelect(branches, selected) {
    $('rag-manage-branch-select').innerHTML = [
      ...branches.map(branch => `<option value="${escapeHtml(branch.id)}"${branch.id === selected ? ' selected' : ''}>${escapeHtml(branch.name)} (${escapeHtml(formatBranchMetrics(branch.metrics))})</option>`),
      `<option value="${NEW_BRANCH}"${selected === NEW_BRANCH ? ' selected' : ''}>${escapeHtml(t('rag_opt_new_branch'))}</option>`
    ].join('');
  }

  function paintEmptyWorkspace() {
    $('rag-manage-workspace').innerHTML = `<div class="rag-empty-state">${escapeHtml(t('rag_workspace_empty'))}</div>`;
  }

  /**
   * Documentos de la rama, zona para añadir archivos (con el id de la rama, que leen los eventos
   * delegados del controlador) y, tras indexar, el resumen de la ingesta.
   */
  function paintWorkspace(branchId, branch, documents, ingestionResult) {
    const deleteDocTitle = escapeHtml(t('rag_delete_doc_title'));
    const documentCards = documents.length ? documents.map(document => `
        <div class="rag-document-card" data-document-id="${escapeHtml(document.id)}">
          <div><strong>${escapeHtml(document.title)}</strong><div class="toggle-card-desc">${escapeHtml(formatDocumentMetrics(document))}</div></div>
          <button type="button" class="btn-danger-outline btn-rag-delete-document" data-delete-document="${escapeHtml(document.id)}" title="${deleteDocTitle}" aria-label="${deleteDocTitle}">${Icons.get('trash', { size: 13 })}</button>
        </div>`).join('') : `<div class="rag-empty-state">${escapeHtml(t('rag_branch_empty_docs'))}</div>`;

    $('rag-manage-workspace').innerHTML = `
      <div class="rag-workspace-header-bar">
        <span>${escapeHtml(t('rag_branch_label'))} <strong>${escapeHtml(branch?.name || '')}</strong></span>
        <span class="rag-workspace-lang">${Icons.get('globe', { size: 14 })} ${escapeHtml(t('rag_branch_lang'))} <strong>${escapeHtml(formatBranchLanguage(branch?.language))}</strong></span>
      </div>
      <label class="rag-dropzone" id="rag-dropzone" data-branch-id="${escapeHtml(branchId)}">
        <strong>${escapeHtml(t('rag_dropzone_title'))}</strong>
        <span>${escapeHtml(t('rag_dropzone_hint'))}</span>
        <input id="rag-file-input" type="file" multiple hidden>
      </label>
      <div id="rag-ingestion-progress">${ingestionResult ? ingestionResultMarkup(ingestionResult) : ''}</div>
      <div class="rag-documents-list">${documentCards}</div>`;
  }

  /** Pinta el progreso de una ingesta en el área de trabajo donde empezó, aunque luego se repinte otra. */
  function createIngestionProgressView() {
    const container = $('rag-ingestion-progress');
    return (latest, recent, stopping) => {
      container.innerHTML = `${globalProgressMarkup(latest, stopping)}<div class="rag-ingestion-progress-recent">${recent.map(progressMarkup).join('')}</div>`;
    };
  }

  function paintStopping(button) {
    button.disabled = true;
    button.textContent = t('rag_ingestion_stopping');
  }

  function readBranchFields() {
    return {
      name: $('rag-branch-name-input').value.trim(),
      description: $('rag-branch-desc-input').value.trim(),
      language: ($('rag-branch-lang-select').value || DEFAULT_LANGUAGE).trim().toLowerCase()
    };
  }

  function paintEditor(state) {
    $('rag-branch-feedback').hidden = true;
    $('rag-manage-branch-select').value = state.creating ? NEW_BRANCH : state.id;
    $('rag-branch-name-input').value = state.name;
    $('rag-branch-desc-input').value = state.description;
    $('rag-branch-lang-select').value = state.language;
    $('btn-rag-delete-branch').disabled = state.creating;
  }

  const focusBranchName = () => $('rag-branch-name-input').focus();

  function setSaveEnabled(enabled) {
    $('btn-rag-save-branch').disabled = !enabled;
  }

  function showBranchFeedback(message, type = 'success') {
    const feedback = $('rag-branch-feedback');
    feedback.hidden = false;
    feedback.className = `server-query-status status-${type}`;
    feedback.textContent = message;
    setTimeout(() => { feedback.hidden = true; }, 4000);
  }

  /** Muestra el progreso en el texto del botón y restaura su contenido al terminar. */
  async function withButtonProgress(button, operation) {
    const previousHtml = button.innerHTML;
    button.disabled = true;
    try {
      return await operation(text => { button.textContent = text; });
    } finally {
      button.disabled = false;
      button.innerHTML = previousHtml;
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function getRagActivationModalHTML() {
    return `<div class="modal-header settings-section-header">
      <div class="modal-title">
        <h3 data-i18n="rag_modal_title_activate">RAG</h3>
      </div>
      <div class="settings-header-actions">
        <button type="button" id="btn-rag-activate-all" class="btn-secondary" data-i18n="rag_activate_all">Activar todas</button>
        <button type="button" id="btn-rag-toggle-master" class="btn-secondary" data-i18n="rag_disable_all">Desactivar todas</button>
        <button type="button" id="btn-close-rag" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
          <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
        </button>
      </div>
    </div>
    <div class="modal-body rag-modal-body">
      <div class="rag-modal-content">
        <div class="setting-toggle-card rag-master-toggle-card">
          <div class="toggle-card-info">
            <div class="toggle-card-title"><span id="rag-active-status-title" data-i18n="rag_status_disabled">Conocimiento desactivado</span></div>
            <p class="toggle-card-desc" id="rag-active-status-desc" data-i18n="rag_status_disabled_desc">Selecciona una o varias ramas para que el agente pueda buscar en tus documentos.</p>
          </div>
        </div>
        <div class="form-field">
          <label><strong data-i18n="rag_available_branches">Ramas disponibles</strong><span class="label-hint" data-i18n="rag_available_branches_hint">Puedes activar una o varias ramas simultáneamente para búsquedas cruzadas.</span></label>
          <div id="rag-active-branch-list" class="rag-active-branch-list"></div>
        </div>
        <div class="rag-help-link-card">
          <svg class="ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-help-circle"></use></svg>
          <span data-i18n="rag_help_link_text">¿Necesitas ayuda con RAG?</span>
          <a href="help/rag.html" target="_blank" rel="noopener noreferrer" class="rag-help-external-link" data-i18n="rag_help_link_label">Ver guía completa</a>
        </div>
        <div class="rag-active-tip-card">
          <span class="rag-active-tip-icon">${Icons.get('lightbulb', { size: 18 })}</span>
          <div class="rag-active-tip-content">
            <strong data-i18n="rag_active_tip_title">Eficacia del RAG y modelo:</strong>
            <span data-i18n-html="rag_active_tip_desc">La eficacia del RAG se basa en gran medida en la <strong>inteligencia, visión multimodal</strong> (para interpretar tablas, gráficos e imágenes) y la <strong>capacidad de razonamiento agéntico</strong> del modelo elegido: es clave para formular búsquedas precisas, examinar fragmentos contiguos y contrastar evidencias sin desorientarse. Usa un modelo con al menos <strong>32K tokens de contexto</strong>: con menos, el protocolo, las herramientas y unos pocos fragmentos llenan la ventana y la conversación se compacta casi de inmediato.</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  function getRagManageModalHTML() {
    return `<div class="modal-header settings-section-header">
      <div class="modal-title">
        <h3 data-i18n="rag_modal_title_manage">RAG-Ramas</h3>
      </div>
      <div class="settings-header-actions">
        <button type="button" id="btn-rag-export-branch" class="btn-secondary" data-i18n-title="rag_export_branch" title="Respaldo">
          <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-download"></use></svg>
          <span class="btn-text-responsive" data-i18n="rag_export_branch">Respaldo</span>
        </button>
        <button type="button" id="btn-rag-import-branch" class="btn-secondary" data-i18n-title="rag_import_branch" title="Restaurar">
          <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-upload"></use></svg>
          <span class="btn-text-responsive" data-i18n="rag_import_branch">Restaurar</span>
        </button>
        <input id="rag-import-input" type="file" accept="application/json,.json,.gz,.json.gz,application/gzip" hidden>
        <button type="button" id="btn-close-rag-manage" class="btn-close" data-i18n-aria="modal_close_aria" aria-label="Cerrar modal">
          <svg class="ui-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-close"></use></svg>
        </button>
      </div>
    </div>
    <div class="modal-body rag-modal-body">
      <div class="rag-modal-content">
        <div class="rag-manage-toolbar">
          <div class="form-field rag-manage-branch-field">
            <label for="rag-branch-name-input"><strong data-i18n="rag_branch_label">Rama:</strong></label>
            <div class="combobox-wrapper rag-branch-combobox">
              <input type="text" id="rag-branch-name-input" data-i18n-placeholder="rag_branch_name_placeholder" placeholder="Nombre de la rama (ej: Manuales)" autocomplete="off">
              <select id="rag-manage-branch-select" class="combobox-select-helper" aria-label="Seleccionar rama"></select>
            </div>
          </div>
          <div class="rag-manage-toolbar-actions">
            <button type="button" id="btn-rag-save-branch" class="btn-primary" data-i18n-title="rag_btn_save" title="Guardar" disabled>
              <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-save"></use></svg>
              <span data-i18n="rag_btn_save">Guardar</span>
            </button>
            <button type="button" id="btn-rag-delete-branch" class="btn-danger-outline" data-i18n-title="rag_delete_branch" title="Eliminar">
              <svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"><use href="#icon-trash"></use></svg>
              <span class="btn-text-responsive" data-i18n="rag_delete_branch">Eliminar</span>
            </button>
          </div>
        </div>
        <div class="rag-branch-details-card" id="rag-branch-details-card">
          <div class="rag-branch-fields-grid">
            <div class="form-field">
              <label for="rag-branch-lang-select"><strong data-i18n="rag_branch_lang">Idioma de la documentación:</strong></label>
              <select id="rag-branch-lang-select" class="combobox-select-helper">
                <option value="spanish" selected data-i18n="rag_lang_spanish">Español</option>
                <option value="english" data-i18n="rag_lang_english">Inglés</option>
                <option value="french" data-i18n="rag_lang_french">Francés</option>
                <option value="german" data-i18n="rag_lang_german">Alemán</option>
                <option value="italian" data-i18n="rag_lang_italian">Italiano</option>
                <option value="portuguese" data-i18n="rag_lang_portuguese">Portugués</option>
              </select>
            </div>
            <div class="form-field">
              <label for="rag-branch-desc-input"><strong data-i18n="rag_branch_desc">Descripción (opcional):</strong></label>
              <input type="text" id="rag-branch-desc-input" data-i18n-placeholder="rag_branch_desc_placeholder" placeholder="Descripción sobre el contenido de esta rama" autocomplete="off">
            </div>
          </div>
          <div id="rag-branch-feedback" class="server-query-status" hidden></div>
        </div>
        <div id="rag-manage-workspace" class="rag-manage-workspace"></div>
      </div>
    </div>`;
  }

  /** Inserta el marcado de los diálogos de activación y gestión, que zerochat.html deja vacíos. */
  function ensureDialogMarkup() {
    const activationDialog = $('rag-modal');
    const manageDialog = $('rag-manage-modal');
    if (!activationDialog.firstElementChild) activationDialog.innerHTML = getRagActivationModalHTML();
    if (!manageDialog.firstElementChild) manageDialog.innerHTML = getRagManageModalHTML();
  }

  // ==========================================================================
  // 3. Controlador: acciones y eventos
  // ==========================================================================

  const reportError = error => console.error('[RagUI]', error);

  const updateToolbarStatus = () => paintToolbarStatus(getActiveBranchIds().length);

  function changeActiveBranches(ids) {
    const active = setActiveBranchIds(ids);
    updateToolbarStatus();
    return active;
  }

  /** Avisa si las ramas activas están en idiomas distintos: la búsqueda léxica depende del idioma. */
  async function warnAboutMixedBranchLanguages(branchIds) {
    if (branchIds.length < 2) return;
    const languages = await getBranchLanguages(branchIds);
    if (languages.length < 2) return;
    await getDialogs().alert(t('rag_mixed_languages_warning', { languages: languages.map(formatBranchLanguage).join(', ') }), { type: 'info' });
  }

  async function warnAboutSmallContext() {
    const RagService = getRagService();
    const limit = RagService.getInsufficientRagContextLimit(getConfig().getActive());
    if (limit) await getDialogs().alert(t('rag_small_context_warning', { limit, min: RagService.RAG_MIN_CONTEXT_TOKENS }), { type: 'warning' });
  }

  /** Activa ramas y avisa de idiomas mezclados o de un contexto insuficiente para el RAG. */
  async function activateWithNotices(activeIds, activated) {
    await warnAboutMixedBranchLanguages(activeIds);
    if (activated) await warnAboutSmallContext();
  }

  async function renderActivationDialog() {
    const branches = await listBranchesWithMetrics();
    paintActivationDialog(branches, getActiveBranchIds());
  }

  async function syncActivationIfOpen() {
    if ($('rag-modal').open) await renderActivationDialog();
  }

  const syncSaveButton = () => setSaveEnabled(canSaveBranch(readBranchFields()));

  /** Carga en el editor una rama, o lo deja vacío para una nueva. */
  function loadEditor(branch) {
    editor = editorFor(branch);
    paintEditor(editor);
    syncSaveButton();
  }

  async function updateBranchFields(branchId) {
    if (!branchId || branchId === NEW_BRANCH) {
      loadEditor(null);
      return;
    }
    const branch = await storage().getBranchById(branchId);
    // Si mientras tanto se eligió otra rama, la carga es obsoleta.
    if (selectedBranchId() !== branchId) return;
    loadEditor(branch);
  }

  function prepareNewBranch() {
    loadEditor(null);
    focusBranchName();
    paintEmptyWorkspace();
  }

  /** Documentos de la rama, zona para añadir archivos y, tras indexar, el resumen de la ingesta. */
  async function renderWorkspace(branchId, ingestionResult) {
    await updateBranchFields(branchId);
    if (!branchId) {
      paintEmptyWorkspace();
      return;
    }
    const documents = await storage().getDocumentsByBranch(branchId);
    const branch = await storage().getBranchById(branchId);
    paintWorkspace(branchId, branch, documents, ingestionResult);
  }

  /** Rellena el selector de ramas y abre la elegida o el editor de una rama nueva. */
  async function renderManageDialog(preferredBranchId) {
    const seq = ++manageDialogSeq;
    const branches = await listBranchesWithMetrics();
    if (seq !== manageDialogSeq) return;
    const selected = preferredBranchId || (editor.creating ? NEW_BRANCH : selectedBranchId()) || branches[0]?.id || NEW_BRANCH;
    paintBranchSelect(branches, selected);
    if (selected === NEW_BRANCH || !branches.length) prepareNewBranch();
    else await renderWorkspace(selected);
  }

  async function closeManageDialog() {
    if (hasPendingChanges(readBranchFields()) && !await getDialogs().confirm(t('confirm_rag_branch_unsaved_changes'))) return false;
    $('rag-manage-modal').close();
    return true;
  }

  async function deleteDocument(branchId, documentId) {
    if (!await getDialogs().confirm(t('rag_delete_doc_confirm'))) return;
    const document = await storage().getDocumentById(documentId);
    if (!document || document.branchId !== branchId || !(await storage().getBranchById(branchId))) return;
    await storage().deleteDocument(documentId);
    indexer().invalidateBranch(branchId);
    await renderWorkspace(branchId);
  }

  /** Pregunta qué hacer con un archivo ya indexado en la rama: reemplazarlo u omitirlo. */
  async function askDuplicate({ fullPath }) {
    const { accepted, applyToAll } = await getDialogs().askDuplicate(t('rag_duplicate_prompt', { name: fullPath }), {
      title: t('rag_duplicate_title'),
      acceptText: t('rag_btn_replace'),
      cancelText: t('rag_btn_ignore'),
      checkbox: t('rag_duplicate_apply_all')
    });
    return { action: accepted ? 'replace' : 'ignore', applyToAll };
  }

  /** Indexa los archivos en la rama mostrando el progreso; solo hay una ingesta a la vez. */
  async function ingestFiles(files, branchId) {
    if (!files.length || currentIngestionController) return;
    const oversized = files.filter(file => file.size > MAX_FILE_BYTES);
    if (oversized.length > 0) {
      await getDialogs().alert(t('err_file_too_large', { name: oversized.map(file => file.name).join(', '), max: '50 MB' }), { type: 'error' });
    }
    const validFiles = files.filter(file => file.size <= MAX_FILE_BYTES);
    if (!validFiles.length) return;

    const paintProgress = createIngestionProgressView();
    const events = new Map();
    const abortController = new AbortController();
    currentIngestionController = abortController;
    try {
      const result = await ingestion().processDocumentQueue(validFiles, branchId, event => {
        events.set(event.fileIndex, event);
        paintProgress(event, [...events.values()].slice(-12).reverse(), abortController.signal.aborted);
      }, { signal: abortController.signal, onDuplicateConflict: askDuplicate });
      await renderWorkspace(branchId, result);
    } finally {
      currentIngestionController = null;
    }
  }

  function stopIngestion(button) {
    paintStopping(button);
    currentIngestionController?.abort();
  }

  async function saveOrUpdateBranch() {
    const fields = readBranchFields();
    if (!fields.name) {
      showBranchFeedback(t('rag_branch_name_empty'), 'error');
      focusBranchName();
      return;
    }
    setSaveEnabled(false);
    try {
      const selectedId = selectedBranchId();
      const creating = editor.creating || !selectedId || selectedId === NEW_BRANCH;
      let branchId = selectedId;
      if (creating) {
        branchId = (await storage().createBranch(fields)).id;
      } else {
        await storage().updateBranch(branchId, fields);
        indexer().invalidateBranch(branchId);
      }
      editor = { creating: false, id: branchId, ...fields };
      await renderManageDialog(branchId);
      await syncActivationIfOpen();
      updateToolbarStatus();
      showBranchFeedback(t(creating ? 'rag_branch_created' : 'rag_branch_updated', { name: fields.name }), 'success');
    } finally {
      syncSaveButton();
    }
  }

  async function deleteBranch() {
    const id = selectedBranchId();
    if (!id || id === NEW_BRANCH || !await getDialogs().confirm(t('rag_delete_branch_confirm'))) return;
    if (!(await storage().getBranchById(id))) return;
    await storage().deleteBranch(id);
    indexer().invalidateBranch(id);
    if (isBranchActive(id)) changeActiveBranches(getActiveBranchIds().filter(item => item !== id));
    await renderManageDialog();
    await syncActivationIfOpen();
  }

  async function exportBranch() {
    const branchId = selectedBranchId();
    if (!branchId || branchId === NEW_BRANCH) return;
    await withButtonProgress($('btn-rag-export-branch'), async setText => {
      setText(t('rag_export_starting'));
      const { blob, filename } = await storage().exportBranchBlob(branchId, {
        compress: true,
        onProgress: ({ current, total, percent }) => setText(t('rag_export_progress', { percent, current, total }))
      });
      downloadBlob(blob, filename);
      setText(t('rag_export_done'));
      await new Promise(resolve => setTimeout(resolve, 1500));
    });
  }

  async function importBranchFile(file) {
    const branch = await withButtonProgress($('btn-rag-import-branch'), async setText => {
      setText(t('rag_import_decompressing'));
      let text;
      try {
        text = await storage().readBackupText(file);
      } catch (error) {
        if (error.name === 'RangeError' || error.code === 'ERR_STRING_TOO_LONG') throw new Error(t('rag_import_too_large'));
        throw error;
      }
      if (!text) throw new Error(t('rag_import_empty'));
      setText(t('rag_import_starting'));
      return storage().importBranch(text, ({ current, total, percent }) => setText(t('rag_import_progress', { percent, current, total })));
    });
    indexer().invalidateBranch(branch.id);
    await renderManageDialog(branch.id);
    await syncActivationIfOpen();
    updateToolbarStatus();
    await getDialogs().alert(t('notice_branch_restored', { name: branch.name }), { type: 'success' });
  }

  async function refresh() {
    if ($('rag-modal').open) await renderActivationDialog();
    if ($('rag-manage-modal').open) await renderManageDialog();
    updateToolbarStatus();
  }

  function openActivationModal() {
    renderActivationDialog().catch(reportError);
    $('rag-modal').showModal();
  }

  function openManageModal() {
    renderManageDialog().catch(reportError);
    $('rag-manage-modal').showModal();
  }

  function bindActivationDialog() {
    $('btn-close-rag').addEventListener('click', () => $('rag-modal').close());
    $('btn-rag-toggle-master').addEventListener('click', async () => {
      changeActiveBranches([]);
      await renderActivationDialog();
    });
    $('btn-rag-activate-all').addEventListener('click', async () => {
      const activeIds = changeActiveBranches((await storage().getBranches()).map(branch => branch.id));
      await activateWithNotices(activeIds, activeIds.length > 0);
      await renderActivationDialog();
    });
    $('rag-active-branch-list').addEventListener('click', async event => {
      const card = event.target.closest('[data-branch-id]');
      if (!card) return;
      const activeIds = changeActiveBranches(toggledBranchIds(card.dataset.branchId));
      await activateWithNotices(activeIds, activeIds.includes(card.dataset.branchId));
      await renderActivationDialog();
    });
  }

  /** Eventos del área de trabajo, que se vuelve a pintar: borrar documentos, detener la ingesta y añadir archivos. */
  function bindWorkspace() {
    const workspace = $('rag-manage-workspace');
    const dropzoneOf = event => event.target.closest('#rag-dropzone');
    workspace.addEventListener('click', event => {
      const deleteButton = event.target.closest('[data-delete-document]');
      if (deleteButton) deleteDocument(selectedBranchId(), deleteButton.dataset.deleteDocument).catch(reportError);
      const stopButton = event.target.closest('[data-rag-stop-ingestion]');
      if (stopButton) stopIngestion(stopButton);
    });
    workspace.addEventListener('change', event => {
      if (event.target.id !== 'rag-file-input') return;
      ingestFiles(Array.from(event.target.files), dropzoneOf(event).dataset.branchId);
      event.target.value = '';
    });
    workspace.addEventListener('dragover', event => {
      const dropzone = dropzoneOf(event);
      if (!dropzone) return;
      event.preventDefault();
      dropzone.classList.add('drag-over');
    });
    workspace.addEventListener('dragleave', event => dropzoneOf(event)?.classList.remove('drag-over'));
    workspace.addEventListener('drop', event => {
      const dropzone = dropzoneOf(event);
      if (!dropzone) return;
      event.preventDefault();
      dropzone.classList.remove('drag-over');
      ingestFiles(Array.from(event.dataTransfer.files), dropzone.dataset.branchId);
    });
  }

  function bindManageDialog() {
    const modal = $('rag-manage-modal');
    $('btn-close-rag-manage').addEventListener('click', closeManageDialog);
    modal.addEventListener('cancel', event => {
      if (!hasPendingChanges(readBranchFields())) return;
      event.preventDefault();
      closeManageDialog();
    });
    const handleSave = () => {
      if (canSaveBranch(readBranchFields())) saveOrUpdateBranch().catch(reportError);
    };
    $('btn-rag-save-branch').addEventListener('click', handleSave);
    for (const id of ['rag-branch-name-input', 'rag-branch-desc-input']) {
      $(id).addEventListener('input', syncSaveButton);
      $(id).addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        handleSave();
      });
    }
    $('rag-branch-lang-select').addEventListener('change', syncSaveButton);
    $('btn-rag-delete-branch').addEventListener('click', deleteBranch);
    $('btn-rag-export-branch').addEventListener('click', () => exportBranch()
      .catch(error => getDialogs().alert(t('notice_export_error', { err: error.message || error }), { type: 'error' })));
    const importInput = $('rag-import-input');
    $('btn-rag-import-branch').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      try {
        if (importInput.files[0]) await importBranchFile(importInput.files[0]);
      } catch (error) {
        await getDialogs().alert(t('notice_import_error', { err: error.message || error }), { type: 'error' });
      } finally {
        importInput.value = '';
      }
    });
    $('rag-manage-branch-select').addEventListener('change', async event => {
      const value = event.target.value;
      if (hasPendingChanges(readBranchFields()) && !await getDialogs().confirm(t('confirm_rag_branch_unsaved_changes'))) {
        event.target.value = editor.creating ? NEW_BRANCH : editor.id;
        return;
      }
      if (value === NEW_BRANCH) prepareNewBranch();
      else await renderWorkspace(value);
    });
    bindWorkspace();
  }

  /** Conecta los diálogos de conocimiento local; el marcado se inserta antes con ensureDialogMarkup. */
  function initRagUI() {
    $('btn-open-rag').addEventListener('click', openActivationModal);
    bindActivationDialog();
    bindManageDialog();
    updateToolbarStatus();
    I18n.onChange(() => refresh().catch(error => console.warn('[RagUI] Could not refresh after a language change:', error)));
  }

  return {
    initRagUI,
    ensureDialogMarkup,
    openActivationModal,
    openManageModal
  };
});
