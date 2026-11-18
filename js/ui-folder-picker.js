/**
 * Selector de la carpeta de trabajo del servidor local: una ruta escrita o pegada, los proyectos recientes
 * con la carpeta general fija arriba, la navegación por subcarpetas (zerochat/project/browse) y la creación
 * de una carpeta nueva (zerochat/project/create_directory), que es lo que en realidad es un proyecto.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUIFolderPicker = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml, joinPath, projectName, NO_PROJECT_NAME, resolveDep } = Utils;
  const { t } = I18n;

  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const request = (method, params) => getMCP().manager.requestExternalControl(method, params);
  // Proyectos recientes que se ofrecen además de la carpeta general.
  const MAX_RECENT = 8;

  let els = null;
  // Carpeta que se está viendo y promesa del diálogo abierto.
  let browsed = '';
  let settle = null;

  const reason = error => String(error?.message || error).replace(/^Error MCP \(-?\d+\): /, '');

  function showError(error) {
    els.error.textContent = error ? reason(error) : '';
  }

  const folderButton = (path, label, title = path) =>
    `<button type="button" class="folder-picker-item" data-path="${escapeHtml(path)}" title="${escapeHtml(title)}">${Icons.get('folder', { size: 15 })}<span>${escapeHtml(label)}</span></button>`;

  /** Muestra la carpeta `path` con sus subcarpetas; si no se puede leer, se queda en la anterior y avisa. */
  async function browse(path) {
    showError(null);
    let listing;
    try {
      listing = await request('zerochat/project/browse', { path });
    } catch (error) {
      showError(error);
      return false;
    }
    browsed = listing.path;
    els.path.value = listing.path;
    els.current.textContent = listing.path;
    els.current.title = listing.path;
    const parent = listing.parent ? folderButton(listing.parent, '..') : '';
    const children = listing.directories.map(name => folderButton(joinPath(listing.path, name), name)).join('');
    els.list.innerHTML = parent + (children || `<p class="label-hint">${escapeHtml(t('folder_picker_empty'))}</p>`);
    els.truncated.hidden = !listing.truncated;
    els.truncated.textContent = listing.truncated ? t('folder_picker_truncated', { shown: listing.directories.length, total: listing.total }) : '';
    return true;
  }

  function close(path) {
    const done = settle;
    settle = null;
    if (els.dialog.open) els.dialog.close();
    done?.(path || null);
  }

  async function createFolder() {
    const name = els.newName.value.trim();
    if (!name) return;
    try {
      const { path } = await request('zerochat/project/create_directory', { parent: browsed, name });
      els.newName.value = '';
      els.newForm.hidden = true;
      // Se entra en la carpeta nueva: usarla, o crear otra dentro, queda a un toque.
      if (await browse(path)) els.use.focus();
    } catch (error) {
      showError(error);
    }
  }

  /**
   * Abre el selector en `current` y resuelve con la carpeta elegida, o null si se cancela. `recent` son los
   * proyectos de las conversaciones, del más reciente al más antiguo, y `generalDir` la carpeta general.
   */
  async function open({ current = '', recent = [], generalDir = '' } = {}) {
    if (settle) close(null);
    const recentDirs = [...new Set(recent.filter(path => path && path !== generalDir))].slice(0, MAX_RECENT);
    els.recent.innerHTML = [
      ...(generalDir ? [folderButton(generalDir, t('folder_picker_general', { name: NO_PROJECT_NAME }))] : []),
      ...recentDirs.map(path => folderButton(path, projectName(path)))
    ].join('');
    els.recentSection.hidden = !generalDir && recentDirs.length === 0;
    els.newForm.hidden = true;
    els.newName.value = '';
    const result = new Promise(resolve => { settle = resolve; });
    els.dialog.showModal();
    await browse(current);
    els.path.focus();
    return result;
  }

  /** Enlaza el diálogo una sola vez. */
  function mount(elements) {
    els = elements;
    els.recent.addEventListener('click', event => {
      const item = event.target.closest('.folder-picker-item');
      if (item) close(item.dataset.path);
    });
    els.list.addEventListener('click', event => {
      const item = event.target.closest('.folder-picker-item');
      if (item) browse(item.dataset.path);
    });
    els.pathForm.addEventListener('submit', event => {
      event.preventDefault();
      const path = els.path.value.trim();
      if (path) browse(path);
    });
    els.newToggle.addEventListener('click', () => {
      els.newForm.hidden = !els.newForm.hidden;
      if (!els.newForm.hidden) els.newName.focus();
    });
    els.newForm.addEventListener('submit', event => {
      event.preventDefault();
      createFolder();
    });
    els.use.addEventListener('click', () => close(browsed));
    els.cancel.addEventListener('click', () => close(null));
    els.dialog.addEventListener('close', () => close(null));
  }

  return { open, mount };
});
