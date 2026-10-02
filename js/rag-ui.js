/** Minimal UI for IndexedDB-backed local knowledge. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'));
  else root.ChatRagUI = factory(root.ChatUtils);
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  let activeBranchIds = new Set();
  let initialized = false;

  function storage() {
    if (typeof window !== 'undefined') return window.ChatRagStorage;
    try { return require('./ragStorage.js'); } catch (_) { return null; }
  }
  function ingestion() {
    if (typeof window !== 'undefined') return window.ChatIngestionEngine || window.IngestionEngine;
    try { return require('./ingestionEngine.js'); } catch (_) { return null; }
  }
  function indexer() {
    if (typeof window !== 'undefined') return window.ChatRagIndex;
    try { return require('./rag-index.js'); } catch (_) { return null; }
  }
  function runtimeConfig() {
    return typeof window !== 'undefined' ? window.ChatConfig : null;
  }
  const { escapeHtml } = Utils;
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, exponent)).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
  }

  function t(key, params) {
    if (typeof window !== 'undefined' && window.ChatI18n?.t) {
      return window.ChatI18n.t(key, params);
    }
    return '';
  }

  function uiText(key, fallback, params) {
    if (typeof window !== 'undefined' && window.ChatI18n?.uiText) {
      return window.ChatI18n.uiText(key, fallback, params);
    }
    const val = t(key, params);
    return (val && val !== key) ? val : (fallback || key);
  }

  function getIcon(name, options) {
    if (typeof window !== 'undefined' && window.ChatIcons?.get) {
      return window.ChatIcons.get(name, options);
    }
    try {
      const icons = require('./icons.js');
      return icons?.get?.(name, options) || '';
    } catch (_) {
      return '';
    }
  }

  async function getBranchMetrics(branches) {
    const metrics = await Promise.all((branches || []).map(async branch => {
      const documents = await storage().getDocumentsByBranch(branch.id);
      return [branch.id, {
        documentCount: documents.length,
        totalBytes: documents.reduce((sum, document) => sum + (Number(document.fileSize) || 0), 0)
      }];
    }));
    return new Map(metrics);
  }

  function formatBranchMetrics(metrics) {
    const count = Number(metrics?.documentCount) || 0;
    const bytes = formatBytes(metrics?.totalBytes || 0);
    return t('rag_branch_summary_format', {
      count,
      plural: count === 1 ? '' : 's',
      bytes
    }) || `${count} documento${count === 1 ? '' : 's'} de ${bytes}`;
  }

  function formatBranchLanguage(lang) {
    const clean = String(lang || 'spanish').toLowerCase().trim();
    const map = {
      spanish: t('rag_lang_spanish') || 'Español',
      english: t('rag_lang_english') || 'Inglés',
      french: t('rag_lang_french') || 'Francés',
      german: t('rag_lang_german') || 'Alemán',
      italian: t('rag_lang_italian') || 'Italiano',
      portuguese: t('rag_lang_portuguese') || 'Portugués'
    };
    return map[clean] || (clean.charAt(0).toUpperCase() + clean.slice(1));
  }

  function formatDocumentMetrics(document) {
    const hasImageCount = Number.isInteger(document?.imageCount) && document.imageCount >= 0;
    let images;
    if (hasImageCount) {
      images = document.imageCount === 1
        ? (t('rag_image_count_singular', { count: 1 }) || '1 imagen')
        : (t('rag_image_count_plural', { count: document.imageCount }) || `${document.imageCount} imágenes`);
    } else {
      images = t('rag_image_count_reload') || 'imágenes: recarga necesaria';
    }
    const chunks = document?.chunkCount || 0;
    const size = formatBytes(document?.fileSize);
    return t('rag_doc_metrics_format', { chunks, size, images }) || `${chunks} fragmentos · ${size} · ${images}`;
  }

  function getActiveBranchIds() {
    return Array.from(activeBranchIds);
  }

  function getActiveBranchId() {
    return activeBranchIds.values().next().value || '';
  }

  function setActiveBranchIds(ids) {
    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    activeBranchIds = new Set(list.map(id => String(id || '').trim()).filter(Boolean));
    const config = runtimeConfig();
    if (config?.updateGeneral) {
      config.updateGeneral({
        activeRagBranchIds: Array.from(activeBranchIds),
        activeRagBranchId: getActiveBranchId()
      });
    }
    updateToolbarStatus();
    return Array.from(activeBranchIds);
  }

  function setActiveBranchId(branchId) {
    if (!branchId) return setActiveBranchIds([]);
    return setActiveBranchIds([branchId]);
  }

  function toggleBranchActive(branchId) {
    const cleanId = String(branchId || '').trim();
    if (!cleanId) return getActiveBranchIds();
    if (activeBranchIds.has(cleanId)) {
      activeBranchIds.delete(cleanId);
    } else {
      activeBranchIds.add(cleanId);
    }
    return setActiveBranchIds(Array.from(activeBranchIds));
  }

  async function warnAboutMixedBranchLanguages(branchIds) {
    const ids = Array.from(new Set((branchIds || []).map(id => String(id || '').trim()).filter(Boolean)));
    if (ids.length < 2 || !storage()?.getBranches) return;

    const branches = await storage().getBranches();
    const languages = Array.from(new Set(branches
      .filter(branch => ids.includes(branch.id))
      .map(branch => String(branch.language || 'spanish').trim().toLowerCase())));
    if (languages.length < 2) return;

    const Dialogs = typeof window !== 'undefined' ? window.ChatDialogs : null;
    if (!Dialogs?.alert) return;
    await Dialogs.alert(t('rag_mixed_languages_warning', {
      languages: languages.map(formatBranchLanguage).join(', ')
    }), { type: 'info' });
  }

  async function toggleBranchActiveWithLanguageNotice(branchId) {
    const activeIds = toggleBranchActive(branchId);
    await warnAboutMixedBranchLanguages(activeIds);
    return activeIds;
  }

  function isBranchActive(branchId) {
    return activeBranchIds.has(String(branchId || '').trim());
  }

  async function updateToolbarStatus() {
    if (typeof document === 'undefined') return;
    const button = document.getElementById('btn-open-rag');
    if (!button) return;
    const count = activeBranchIds.size;
    button.classList.toggle('active', count > 0);
    button.title = count === 0
      ? (t('btn_rag_title') || 'Gestionar conocimiento local')
      : (count === 1
        ? (t('rag_toolbar_active_single') || 'Conocimiento local activo (1 rama)')
        : (t('rag_toolbar_active_multi', { count }) || `Conocimiento local activo (${count} ramas)`));
  }

  async function renderActivationDialog() {
    if (typeof document === 'undefined') return;
    const branches = await storage().getBranches();
    const branchMetrics = await getBranchMetrics(branches);
    const list = document.getElementById('rag-active-branch-list');
    const title = document.getElementById('rag-active-status-title');
    const description = document.getElementById('rag-active-status-desc');
    const toggle = document.getElementById('btn-rag-toggle-master');
    const activeList = branches.filter(branch => activeBranchIds.has(branch.id));
    const activeCount = activeList.length;

    if (title) {
      if (activeCount === 0) title.textContent = t('rag_status_disabled') || 'Conocimiento desactivado';
      else if (activeCount === 1) title.textContent = activeList[0].name;
      else title.textContent = t('rag_status_active_count', { count: activeCount, list: activeList.map(b => b.name).join(', ') }) || `${activeCount} ramas activas (${activeList.map(b => b.name).join(', ')})`;
    }
    if (description) {
      if (activeCount === 0) description.textContent = t('rag_status_disabled_desc') || 'Selecciona una o varias ramas para que el agente pueda buscar en tus documentos.';
      else if (activeCount === 1) description.textContent = t('rag_status_desc_single') || 'El agente puede buscar fragmentos de esta rama mediante Orama.';
      else description.textContent = t('rag_status_desc_multi', { count: activeCount }) || `El agente consultará en paralelo las ${activeCount} ramas activas en cada búsqueda.`;
    }
    if (toggle) {
      toggle.disabled = activeCount === 0;
      toggle.textContent = t('rag_disable_all') || 'Desactivar todas';
    }
    if (!list) return;
    if (!branches.length) {
      list.innerHTML = `<div class="rag-empty-state">${t('rag_no_branches_active') || 'No hay ramas. Crea la primera desde RAG en Configuración.'}</div>`;
      return;
    }
    list.innerHTML = branches.map(branch => {
      const isActive = activeBranchIds.has(branch.id);
      const metrics = branchMetrics.get(branch.id);
      const formatted = formatBranchMetrics(metrics);
      const loadedText = t('rag_branch_loaded', { summary: formatted }) || `Esta rama cargó ${formatted}`;
      const descText = branch.description || t('rag_branch_no_desc') || 'Sin descripción';
      const badgeIcon = isActive ? getIcon('check', { size: 12 }) : getIcon('plus', { size: 12 });
      const badgeText = isActive ? (t('rag_branch_active_badge') || 'Activa') : (t('rag_branch_activate_badge') || 'Activar');
      const langLabel = formatBranchLanguage(branch.language);
      return `
      <button type="button" class="setting-toggle-card rag-branch-select-card${isActive ? ' active' : ''}" data-branch-id="${escapeHtml(branch.id)}">
        <span class="toggle-card-info"><strong>${escapeHtml(branch.name)}</strong><span class="toggle-card-desc">${escapeHtml(descText)}</span><span class="rag-branch-metrics">${escapeHtml(loadedText)} · <span class="rag-branch-lang-inline">${getIcon('globe', { size: 12 })} <span>${escapeHtml(langLabel)}</span></span></span></span>
        <span class="rag-branch-badge-status">${badgeIcon} <span>${escapeHtml(badgeText)}</span></span>
      </button>`;
    }).join('');
    list.querySelectorAll('[data-branch-id]').forEach(button => button.addEventListener('click', async () => {
      await toggleBranchActiveWithLanguageNotice(button.dataset.branchId);
      await renderActivationDialog();
    }));
  }

  function progressMarkup(event) {
    const isError = event.status === 'error';
    const isCancelled = event.status === 'cancelled';
    const isSkipped = event.status === 'skipped';
    const itemClass = isError ? 'error' : (isCancelled || isSkipped) ? 'skipped' : '';
    return `<div class="rag-ingestion-progress-item ${itemClass}"><strong>${escapeHtml(event.fileName)}</strong><span>${escapeHtml(event.message)}</span><progress max="100" value="${Number(event.percent) || 0}"></progress></div>`;
  }

  function globalProgressMarkup(event, isRunning = true) {
    const total = Number(event.totalFiles) || 0;
    const finished = Number(event.finishedFiles) || 0;
    const processed = Number(event.processedFiles) || 0;
    const replaced = Number(event.replacedFiles) || 0;
    const skipped = Number(event.skippedFiles) || 0;
    const failed = Number(event.failedFiles) || 0;
    const overallPercent = Math.round(Number(event.overallPercent) || 0);

    const parts = [];
    if (processed > 0) parts.push(`${processed} nuevos`);
    if (replaced > 0) parts.push(`${replaced} reemplazados`);
    if (skipped > 0) parts.push(`${skipped} omitidos`);
    if (failed > 0) parts.push(`${failed} con error`);
    const status = parts.length
      ? parts.join(' · ')
      : (t('rag_ingestion_status', { processed }) || `${processed} indexados`);

    const header = t('rag_ingestion_global', { finished, total }) || `Carga global: ${finished} de ${total}`;
    const stopIcon = '<svg class="ui-icon" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>';
    const stopBtn = isRunning
      ? `<button type="button" id="btn-rag-stop-ingestion" class="btn-danger-outline rag-stop-ingestion-btn" title="${escapeHtml(t('rag_btn_stop_ingestion') || 'Detener')}">${stopIcon} <span>${escapeHtml(t('rag_btn_stop_ingestion') || 'Detener')}</span></button>`
      : '';

    return `<div class="rag-ingestion-global-progress"><div><strong>${escapeHtml(header)}</strong><span>${escapeHtml(status)}</span></div><progress max="100" value="${overallPercent}"></progress><div class="rag-ingestion-global-actions"><span>${overallPercent}%</span>${stopBtn}</div></div>`;
  }

  function ingestionResultMarkup(result) {
    const processed = Number(result?.processed) || 0;
    const replaced = Number(result?.replaced) || 0;
    const skipped = Number(result?.skipped) || 0;
    const cancelled = Number(result?.cancelled) || 0;
    const failed = Number(result?.failed) || 0;
    const total = Number(result?.total) || 0;
    const totalIndexed = processed + replaced;

    let summaryText = `${totalIndexed} indexados · ${failed} no indexados`;
    if (replaced > 0 || skipped > 0 || cancelled > 0) {
      const extra = [];
      if (replaced > 0) extra.push(`${replaced} reemplazados`);
      if (skipped > 0) extra.push(`${skipped} omitidos`);
      if (cancelled > 0) extra.push(`${cancelled} cancelados`);
      summaryText += ` (${extra.join(', ')})`;
    }

    const header = cancelled > 0
      ? (t('rag_ingestion_cancelled') || 'Ingesta detenida por el usuario') + `: ${summaryText}`
      : (t('rag_ingestion_complete', { processed: totalIndexed, failed, total }) || `Ingesta completada: ${summaryText}`);

    const errors = Array.isArray(result?.errors) ? result.errors : [];
    return `<div class="rag-ingestion-global-progress${failed ? ' error' : ''}"><div><strong>${escapeHtml(header)}</strong></div>${errors.length ? `<div class="rag-ingestion-progress-recent">${errors.map(error => `<div class="rag-ingestion-progress-item error"><strong>${escapeHtml(error.fileName)}</strong><span>${escapeHtml(error.error)}</span></div>`).join('')}</div>` : ''}</div>`;
  }

  async function renderWorkspace(branchId, ingestionResult) {
    if (typeof document === 'undefined') return;
    await updateBranchFields(branchId);
    const workspace = document.getElementById('rag-manage-workspace');
    if (!workspace) return;
    if (!branchId) {
      workspace.innerHTML = `<div class="rag-empty-state">${t('rag_workspace_empty') || 'Escribe un nombre arriba y pulsa "Crear rama" para empezar.'}</div>`;
      return;
    }
    const documents = await storage().getDocumentsByBranch(branchId);
    const branch = await storage().getBranchById(branchId);
    const dropzoneTitle = t('rag_dropzone_title') || 'Arrastra o selecciona archivos';
    const dropzoneHint = t('rag_dropzone_hint') || 'PDF o archivos de texto · guardado privado en IndexedDB';
    const deleteDocTitle = t('rag_delete_doc_title') || 'Eliminar documento';
    const emptyDocsText = t('rag_branch_empty_docs') || 'La rama todavía no contiene documentos.';
    const langLabel = formatBranchLanguage(branch?.language);

    workspace.innerHTML = `
      <div class="rag-workspace-header-bar">
        <span>${escapeHtml(t('rag_branch_label') || 'Rama:')} <strong>${escapeHtml(branch?.name || '')}</strong></span>
        <span class="rag-workspace-lang">${getIcon('globe', { size: 14 })} ${escapeHtml(t('rag_branch_lang') || 'Idioma de la documentación:')} <strong>${escapeHtml(langLabel)}</strong></span>
      </div>
      <label class="rag-dropzone" id="rag-dropzone">
        <strong>${escapeHtml(dropzoneTitle)}</strong>
        <span>${escapeHtml(dropzoneHint)}</span>
        <input id="rag-file-input" type="file" multiple hidden>
      </label>
      <div id="rag-ingestion-progress"></div>
      <div class="rag-documents-list">${documents.length ? documents.map(document => `
        <div class="rag-document-card" data-document-id="${escapeHtml(document.id)}">
          <div><strong>${escapeHtml(document.title)}</strong><div class="toggle-card-desc">${formatDocumentMetrics(document)}</div></div>
          <button type="button" class="btn-danger-outline btn-rag-delete-document" data-delete-document="${escapeHtml(document.id)}" title="${escapeHtml(deleteDocTitle)}" aria-label="${escapeHtml(deleteDocTitle)}">${getIcon('trash', { size: 13 })}</button>
        </div>`).join('') : `<div class="rag-empty-state">${escapeHtml(emptyDocsText)}</div>`}</div>`;

    const input = document.getElementById('rag-file-input');
    const dropzone = document.getElementById('rag-dropzone');
    const progress = document.getElementById('rag-ingestion-progress');
    if (progress && ingestionResult) progress.innerHTML = ingestionResultMarkup(ingestionResult);
    const handleFiles = files => {
      ingestFiles(Array.from(files || []), branchId);
      if (input) input.value = '';
    };
    if (input) input.addEventListener('change', () => handleFiles(input.files));
    if (dropzone) {
      dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('drag-over'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
      dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('drag-over'); handleFiles(event.dataTransfer.files); });
    }
    workspace.querySelectorAll('[data-delete-document]').forEach(button => button.addEventListener('click', async () => {
      const documentId = button.dataset.deleteDocument;
      const confirmMsg = t('rag_delete_doc_confirm') || '¿Eliminar este documento y todos sus fragmentos?';
      if (!await ChatDialogs.confirm(confirmMsg)) return;
      const document = await storage().getDocumentById(documentId);
      if (!document || document.branchId !== branchId || !(await storage().getBranchById(branchId))) return;
      await storage().deleteDocument(documentId);
      indexer()?.invalidateBranch(branchId);
      await renderWorkspace(branchId);
    }));
  }

  let currentIngestionController = null;

  async function ingestFiles(files, branchId) {
    if (!files.length) return;
    if (currentIngestionController) return;

    const maxBytes = 50 * 1024 * 1024;
    const validFiles = [];
    const oversizedFiles = [];
    for (const f of files) {
      if (f && typeof f.size === 'number' && f.size > maxBytes) {
        oversizedFiles.push(f);
      } else {
        validFiles.push(f);
      }
    }
    if (oversizedFiles.length > 0) {
      const Dialogs = typeof window !== 'undefined' ? window.ChatDialogs : null;
      if (Dialogs?.alert) {
        const names = oversizedFiles.map(f => f.name || 'documento').join(', ');
        await Dialogs.alert(t('err_file_too_large', { name: names, max: '50 MB' }), { type: 'error' });
      }
    }
    if (!validFiles.length) return;

    const container = document.getElementById('rag-ingestion-progress');
    const events = new Map();
    const abortController = new AbortController();
    currentIngestionController = abortController;

    const attachStopListener = () => {
      const stopBtn = document.getElementById('btn-rag-stop-ingestion');
      if (stopBtn && !stopBtn.dataset.bound) {
        stopBtn.dataset.bound = 'true';
        stopBtn.addEventListener('click', () => {
          stopBtn.disabled = true;
          stopBtn.textContent = t('rag_ingestion_stopping') || 'Deteniendo...';
          abortController.abort();
        });
      }
    };

    const onDuplicateConflict = async ({ fullPath }) => {
      const Dialogs = typeof window !== 'undefined' ? window.ChatDialogs : null;
      if (!Dialogs?.askDuplicate && !Dialogs?.confirm) {
        return { action: 'ignore', applyToAll: false };
      }
      const promptMsg = t('rag_duplicate_prompt', { name: fullPath }) ||
        `Ya existe un documento con el mismo nombre y ruta en esta rama ("${fullPath}"). ¿Deseas reemplazarlo o ignorarlo?`;
      const options = {
        title: t('rag_duplicate_title') || 'Documento duplicado',
        acceptText: t('rag_btn_replace') || 'Reemplazar',
        cancelText: t('rag_btn_ignore') || 'Ignorar',
        checkbox: t('rag_duplicate_apply_all') || 'Aplicar a todos los duplicados restantes de esta carga'
      };
      const res = Dialogs.askDuplicate
        ? await Dialogs.askDuplicate(promptMsg, options)
        : await Dialogs.confirm(promptMsg, options);
      const accepted = (typeof res === 'object' && res !== null) ? res.accepted : Boolean(res);
      const applyToAll = (typeof res === 'object' && res !== null) ? Boolean(res.applyToAll || res.checkboxChecked) : false;
      return {
        action: accepted ? 'replace' : 'ignore',
        applyToAll
      };
    };

    try {
      const result = await ingestion().processDocumentQueue(validFiles, branchId, event => {
        events.set(event.fileIndex, event);
        if (container) {
          const recentEvents = Array.from(events.values()).slice(-12).reverse();
          container.innerHTML = `${globalProgressMarkup(event, true)}<div class="rag-ingestion-progress-recent">${recentEvents.map(progressMarkup).join('')}</div>`;
          attachStopListener();
        }
      }, {
        signal: abortController.signal,
        onDuplicateConflict
      });
      await renderWorkspace(branchId, result);
    } finally {
      currentIngestionController = null;
    }
  }

  async function syncActivationIfOpen() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('rag-modal');
    if (modal?.open) {
      await renderActivationDialog();
    }
  }

  let manageDialogSeq = 0;
  async function renderManageDialog(preferredBranchId) {
    if (typeof document === 'undefined') return;
    const seq = ++manageDialogSeq;
    const branches = await storage().getBranches();
    if (seq !== manageDialogSeq) return;
    const branchMetrics = await getBranchMetrics(branches);
    if (seq !== manageDialogSeq) return;
    const select = document.getElementById('rag-manage-branch-select');
    if (!select) return;
    const selected = preferredBranchId || (isCreatingBranch ? '__new__' : select.value) || branches[0]?.id || '__new__';
    const newBranchLabel = uiText('rag_opt_new_branch', '+ Nueva rama...');
    const options = branches.map(branch => `<option value="${escapeHtml(branch.id)}"${branch.id === selected ? ' selected' : ''}>${escapeHtml(branch.name)} (${escapeHtml(formatBranchMetrics(branchMetrics.get(branch.id)))})</option>`);
    options.push(`<option value="__new__"${selected === '__new__' ? ' selected' : ''}>${escapeHtml(newBranchLabel)}</option>`);
    select.innerHTML = options.join('');
    select.disabled = false;
    if (seq !== manageDialogSeq) return;
    if (selected === '__new__' || !branches.length) {
      prepareNewBranch();
    } else {
      await renderWorkspace(selected);
    }
  }

  let isCreatingBranch = false;
  let loadedBranchId = '';
  let loadedBranchName = '';
  let loadedBranchDesc = '';
  let loadedBranchLang = 'spanish';

  function getSaveButton() {
    return document.getElementById('btn-rag-save-branch') || document.getElementById('btn-rag-new-branch');
  }

  function canSaveBranch() {
    const name = document.getElementById('rag-branch-name-input')?.value?.trim() || '';
    if (!name) return false;
    if (isCreatingBranch) return true;
    return hasPendingBranchChanges();
  }

  function updateSaveButtonState() {
    const btn = getSaveButton();
    if (!btn) return;
    btn.disabled = !canSaveBranch();
  }

  function hasPendingBranchChanges() {
    const name = document.getElementById('rag-branch-name-input')?.value?.trim() || '';
    const description = document.getElementById('rag-branch-desc-input')?.value?.trim() || '';
    const language = (document.getElementById('rag-branch-lang-select')?.value || 'spanish').trim().toLowerCase();
    if (isCreatingBranch) return Boolean(name || description || language !== 'spanish');
    return name !== loadedBranchName.trim() ||
      description !== (loadedBranchDesc || '').trim() ||
      language !== (loadedBranchLang || 'spanish').trim().toLowerCase();
  }

  async function closeManageDialog() {
    const modal = document.getElementById('rag-manage-modal');
    if (!modal) return false;
    if (hasPendingBranchChanges()) {
      const Dialogs = typeof window !== 'undefined' ? window.ChatDialogs : null;
      if (!Dialogs?.confirm || !await Dialogs.confirm(t('confirm_rag_branch_unsaved_changes'))) return false;
    }
    modal.close();
    return true;
  }

  async function updateBranchFields(branchId) {
    if (typeof document === 'undefined') return;
    const nameInput = document.getElementById('rag-branch-name-input');
    const descInput = document.getElementById('rag-branch-desc-input');
    const langSelect = document.getElementById('rag-branch-lang-select');
    const select = document.getElementById('rag-manage-branch-select');
    const btnDelete = document.getElementById('btn-rag-delete-branch');
    const feedback = document.getElementById('rag-branch-feedback');
    if (feedback) feedback.style.display = 'none';

    if (!branchId || branchId === '__new__') {
      isCreatingBranch = true;
      loadedBranchId = '';
      loadedBranchName = '';
      loadedBranchDesc = '';
      loadedBranchLang = 'spanish';
      if (select) select.value = '__new__';
      if (nameInput) nameInput.value = '';
      if (descInput) descInput.value = '';
      if (langSelect) langSelect.value = 'spanish';
      if (btnDelete) btnDelete.disabled = true;
      updateSaveButtonState();
      return;
    }

    isCreatingBranch = false;
    loadedBranchId = branchId;
    const branch = await storage().getBranchById(branchId);
    if (select && select.value !== branchId) return;
    loadedBranchName = branch?.name || '';
    loadedBranchDesc = branch?.description || '';
    loadedBranchLang = branch?.language || 'spanish';
    if (select) select.value = branchId;
    if (nameInput) nameInput.value = loadedBranchName;
    if (descInput) descInput.value = loadedBranchDesc;
    if (langSelect) langSelect.value = loadedBranchLang;
    if (btnDelete) btnDelete.disabled = false;
    updateSaveButtonState();
  }

  function prepareNewBranch() {
    isCreatingBranch = true;
    loadedBranchId = '';
    loadedBranchName = '';
    loadedBranchDesc = '';
    loadedBranchLang = 'spanish';
    const nameInput = document.getElementById('rag-branch-name-input');
    const descInput = document.getElementById('rag-branch-desc-input');
    const langSelect = document.getElementById('rag-branch-lang-select');
    const select = document.getElementById('rag-manage-branch-select');
    const btnDelete = document.getElementById('btn-rag-delete-branch');
    const feedback = document.getElementById('rag-branch-feedback');
    if (feedback) feedback.style.display = 'none';

    if (select) select.value = '__new__';
    if (btnDelete) btnDelete.disabled = true;
    if (nameInput) {
      nameInput.value = '';
      nameInput.focus();
    }
    if (descInput) descInput.value = '';
    if (langSelect) langSelect.value = 'spanish';
    updateSaveButtonState();
    const workspace = document.getElementById('rag-manage-workspace');
    if (workspace) {
      workspace.innerHTML = `<div class="rag-empty-state">${t('rag_workspace_empty') || 'Escribe un nombre arriba y pulsa "Guardar" para empezar.'}</div>`;
    }
  }

  function showBranchFeedback(msg, type = 'success') {
    const el = document.getElementById('rag-branch-feedback');
    if (!el) return;
    el.style.display = 'block';
    el.className = `server-query-status status-${type}`;
    el.textContent = msg;
    setTimeout(() => {
      if (el) el.style.display = 'none';
    }, 4000);
  }

  async function saveOrUpdateBranch() {
    const nameInput = document.getElementById('rag-branch-name-input');
    const descInput = document.getElementById('rag-branch-desc-input');
    const langSelect = document.getElementById('rag-branch-lang-select');
    const name = nameInput?.value?.trim();
    const description = descInput?.value?.trim() || '';
    const language = (langSelect?.value || 'spanish').trim().toLowerCase();

    if (!name) {
      showBranchFeedback(t('rag_branch_name_empty') || 'Por favor, escribe un nombre para la rama.', 'error');
      nameInput?.focus();
      return;
    }

    if (isCreatingBranch) {
      const branch = await storage().createBranch({ name, description, language });
      isCreatingBranch = false;
      loadedBranchId = branch.id;
      loadedBranchName = name;
      loadedBranchDesc = description;
      loadedBranchLang = language;
      await renderManageDialog(branch.id);
      await syncActivationIfOpen();
      await updateToolbarStatus();
      updateSaveButtonState();
      showBranchFeedback(t('rag_branch_created', { name }) || `Rama "${name}" creada con éxito.`, 'success');
    } else {
      const select = document.getElementById('rag-manage-branch-select');
      const id = select?.value;
      if (!id || id === '__new__') {
        const branch = await storage().createBranch({ name, description, language });
        isCreatingBranch = false;
        loadedBranchId = branch.id;
        loadedBranchName = name;
        loadedBranchDesc = description;
        loadedBranchLang = language;
        await renderManageDialog(branch.id);
        await syncActivationIfOpen();
        await updateToolbarStatus();
        updateSaveButtonState();
        showBranchFeedback(t('rag_branch_created', { name }) || `Rama "${name}" creada con éxito.`, 'success');
        return;
      }
      await storage().updateBranch(id, { name, description, language });
      indexer()?.invalidateBranch(id);
      loadedBranchId = id;
      loadedBranchName = name;
      loadedBranchDesc = description;
      loadedBranchLang = language;
      await renderManageDialog(id);
      await syncActivationIfOpen();
      await updateToolbarStatus();
      updateSaveButtonState();
      showBranchFeedback(t('rag_branch_updated', { name }) || `Rama "${name}" guardada con éxito.`, 'success');
    }
  }

  async function deleteBranch() {
    const select = document.getElementById('rag-manage-branch-select');
    const id = select?.value;
    const confirmMsg = t('rag_delete_branch_confirm') || '¿Eliminar la rama y todos sus documentos?';
    if (!id || id === '__new__' || !await ChatDialogs.confirm(confirmMsg)) return;
    if (!(await storage().getBranchById(id))) return;
    await storage().deleteBranch(id);
    indexer()?.invalidateBranch(id);
    if (activeBranchIds.has(id)) {
      activeBranchIds.delete(id);
      setActiveBranchIds(Array.from(activeBranchIds));
    }
    await renderManageDialog();
    await syncActivationIfOpen();
  }

  async function isGzipBlob(blob) {
    try {
      if (!blob || blob.size < 2) return false;
      const slice = blob.slice(0, 2);
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);
      return bytes[0] === 0x1F && bytes[1] === 0x8B;
    } catch (_) {
      return false;
    }
  }

  async function decompressFileIfNeeded(file) {
    if (!file) return '';
    const isGz = file.name?.toLowerCase().endsWith('.gz') || await isGzipBlob(file);
    if (isGz && typeof DecompressionStream !== 'undefined') {
      const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    }
    return await file.text();
  }

  async function exportBranch() {
    const select = document.getElementById('rag-manage-branch-select');
    const branchId = select?.value;
    if (!branchId) return;

    const btnExport = document.getElementById('btn-rag-export-branch');
    const prevHtml = btnExport?.innerHTML;
    try {
      if (btnExport) {
        btnExport.disabled = true;
        btnExport.textContent = 'Exportando 0%...';
      }
      const { blob, filename } = await storage().exportBranchBlob(branchId, {
        compress: true,
        onProgress: ({ current, total, percent }) => {
          if (btnExport) btnExport.textContent = `Exportando ${percent}% (${current}/${total})...`;
        }
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      if (btnExport) btnExport.textContent = '¡Exportado!';
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      ChatDialogs.alert(t('notice_export_error', { err: error.message || error }), { type: 'error' });
    } finally {
      if (btnExport) {
        btnExport.disabled = false;
        if (prevHtml) btnExport.innerHTML = prevHtml;
      }
    }
  }

  async function importBranchFile(file) {
    if (!file) return null;
    const btnImport = document.getElementById('btn-rag-import-branch');
    const prevHtml = btnImport?.innerHTML;
    try {
      if (btnImport) {
        btnImport.disabled = true;
        btnImport.textContent = 'Descomprimiendo...';
      }
      let text;
      try {
        text = await decompressFileIfNeeded(file);
      } catch (err) {
        if (err.name === 'RangeError' || err.code === 'ERR_STRING_TOO_LONG' || String(err).includes('string')) {
          throw new Error('El archivo supera el límite de memoria del navegador (512 MB). Utiliza el respaldo ligero optimizado.');
        }
        throw err;
      }
      if (!text) throw new Error('El archivo de respaldo está vacío o no se pudo leer.');
      if (btnImport) btnImport.textContent = 'Restaurando 0%...';

      const branch = await storage().importBranch(text, ({ current, total, percent }) => {
        if (btnImport) btnImport.textContent = `Restaurando ${percent}% (${current}/${total})...`;
      });
      indexer()?.invalidateBranch(branch.id);
      await renderManageDialog(branch.id);
      await syncActivationIfOpen();
      await updateToolbarStatus();
      ChatDialogs.alert(t('notice_branch_restored', { name: branch.name }), { type: 'success' });
      return branch;
    } finally {
      if (btnImport) {
        btnImport.disabled = false;
        if (prevHtml) btnImport.innerHTML = prevHtml;
      }
    }
  }

  async function refresh() {
    if (typeof document !== 'undefined') {
      const activationModal = document.getElementById('rag-modal');
      const manageModal = document.getElementById('rag-manage-modal');
      if (activationModal?.open) await renderActivationDialog();
      if (manageModal?.open) await renderManageDialog();
    }
    await updateToolbarStatus();
  }

  function openActivationModal() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('rag-modal');
    if (!modal) return;
    renderActivationDialog().catch(() => {});
    modal.showModal();
  }

  function openManageModal() {
    if (typeof document === 'undefined') return;
    const modal = document.getElementById('rag-manage-modal');
    if (!modal) return;
    renderManageDialog().catch(() => {});
    modal.showModal();
  }

  function openRagModal(mode = 'activate') {
    if (mode === 'manage') openManageModal();
    else openActivationModal();
  }

  function bindActivationDialog() {
    const modal = document.getElementById('rag-modal');
    if (!modal) return;

    document.getElementById('btn-close-rag')?.addEventListener('click', () => modal?.close());
    document.getElementById('btn-rag-toggle-master')?.addEventListener('click', async () => {
      setActiveBranchIds([]);
      await renderActivationDialog();
    });
    document.getElementById('btn-rag-activate-all')?.addEventListener('click', async () => {
      const branches = await storage().getBranches();
      const activeIds = setActiveBranchIds(branches.map(b => b.id));
      await warnAboutMixedBranchLanguages(activeIds);
      await renderActivationDialog();
    });
  }

  function bindManageDialog() {
    const modal = document.getElementById('rag-manage-modal');
    if (!modal) return;

    document.getElementById('btn-close-rag-manage')?.addEventListener('click', () => { closeManageDialog(); });
    modal.addEventListener('cancel', event => {
      if (!hasPendingBranchChanges()) return;
      event.preventDefault();
      closeManageDialog();
    });
    const handleSave = () => {
      if (!canSaveBranch()) return;
      saveOrUpdateBranch();
    };
    document.getElementById('btn-rag-save-branch')?.addEventListener('click', handleSave);
    document.getElementById('btn-rag-new-branch')?.addEventListener('click', handleSave);

    document.getElementById('rag-branch-name-input')?.addEventListener('input', updateSaveButtonState);
    document.getElementById('rag-branch-desc-input')?.addEventListener('input', updateSaveButtonState);
    document.getElementById('rag-branch-lang-select')?.addEventListener('change', updateSaveButtonState);

    const handleBranchKeyEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    };
    document.getElementById('rag-branch-name-input')?.addEventListener('keydown', handleBranchKeyEnter);
    document.getElementById('rag-branch-desc-input')?.addEventListener('keydown', handleBranchKeyEnter);

    document.getElementById('btn-rag-delete-branch')?.addEventListener('click', deleteBranch);
    document.getElementById('btn-rag-export-branch')?.addEventListener('click', () => exportBranch().catch(error => ChatDialogs.alert(t('notice_export_error', { err: error.message || error }), { type: 'error' })));
    const importInput = document.getElementById('rag-import-input');
    document.getElementById('btn-rag-import-branch')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      try { await importBranchFile(importInput.files?.[0]); }
      catch (error) { ChatDialogs.alert(t('notice_import_error', { err: error.message || error }), { type: 'error' }); }
      finally { importInput.value = ''; }
    });
    document.getElementById('rag-manage-branch-select')?.addEventListener('change', async event => {
      const val = event.target.value;
      if (hasPendingBranchChanges()) {
        const Dialogs = typeof window !== 'undefined' ? window.ChatDialogs : null;
        if (Dialogs?.confirm && !await Dialogs.confirm(t('confirm_rag_branch_unsaved_changes') || 'Hay cambios sin guardar en la rama. ¿Deseas descartarlos?')) {
          const select = document.getElementById('rag-manage-branch-select');
          if (select) select.value = isCreatingBranch ? '__new__' : (loadedBranchId || '');
          return;
        }
      }
      if (val === '__new__') {
        prepareNewBranch();
      } else {
        await renderWorkspace(val);
      }
    });
  }

  function initRagUI() {
    if (initialized || typeof document === 'undefined') return;
    initialized = true;
    const cfg = runtimeConfig()?.getActive?.() || {};
    if (Array.isArray(cfg.activeRagBranchIds) && cfg.activeRagBranchIds.length > 0) {
      activeBranchIds = new Set(cfg.activeRagBranchIds.map(String).filter(Boolean));
    } else if (cfg.activeRagBranchId) {
      activeBranchIds = new Set([String(cfg.activeRagBranchId)]);
    } else {
      activeBranchIds = new Set();
    }
    ensureDialogMarkup();

    document.getElementById('btn-open-rag')?.addEventListener('click', () => openActivationModal());
    bindActivationDialog();
    bindManageDialog();

    updateToolbarStatus();

    if (typeof window !== 'undefined') {
      if (window.ChatI18n?.onChange) {
        window.ChatI18n.onChange(() => {
          refresh().catch(() => {});
        });
      } else {
        window.addEventListener('zerochat:languagechange', () => {
          refresh().catch(() => {});
        });
      }
    }
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
          <span class="rag-active-tip-icon">${getIcon('lightbulb', { size: 18 })}</span>
          <div class="rag-active-tip-content">
            <strong data-i18n="rag_active_tip_title">Eficacia del RAG y modelo:</strong>
            <span data-i18n-html="rag_active_tip_desc">La eficacia del RAG se basa en gran medida en la <strong>inteligencia, visión multimodal</strong> (para interpretar tablas, gráficos e imágenes) y la <strong>capacidad de razonamiento agéntico</strong> del modelo elegido: es clave para formular búsquedas precisas, examinar fragmentos contiguos y contrastar evidencias sin desorientarse. Si utilizas modelos compactos o con menor autonomía agéntica, activa el <strong>Punto de Control agéntico (agent_checkpoint)</strong> desde el menú de Razonamiento para consolidar hallazgos y mantener un plan de investigación claro.</span>
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
          <div id="rag-branch-feedback" class="server-query-status" style="display: none;"></div>
        </div>
        <div id="rag-manage-workspace" class="rag-manage-workspace"></div>
      </div>
    </div>`;
  }

  function ensureDialogMarkup() {
    if (typeof document === 'undefined') return;
    const activationDialog = document.getElementById('rag-modal');
    const manageDialog = document.getElementById('rag-manage-modal');
    if (activationDialog && !activationDialog.firstElementChild) activationDialog.innerHTML = getRagActivationModalHTML();
    if (manageDialog && !manageDialog.firstElementChild) manageDialog.innerHTML = getRagManageModalHTML();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureDialogMarkup);
    } else {
      ensureDialogMarkup();
    }
  }

  return {
    initRagUI, refresh,
    renderActivationDialog, renderManageDialog,
    getActiveBranchId, setActiveBranchId,
    getActiveBranchIds, setActiveBranchIds, toggleBranchActive, isBranchActive,
    updateToolbarStatus, exportBranch, importBranchFile, ingestionResultMarkup,
    ensureDialogMarkup, getRagActivationModalHTML, getRagManageModalHTML,
    openActivationModal, openManageModal, openRagModal
  };
});
