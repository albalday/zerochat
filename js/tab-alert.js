/**
 * Aviso en título y favicon de la pestaña cuando un turno termina o pide permiso en segundo plano.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatTabAlert = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { t } = I18n;
  const listeners = Utils.createListenerGroup();
  const { listen, onDispose } = listeners;

  let activeKind = null; // null | 'done' | 'permission'

  function readToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function buildFaviconHref(kind) {
    const primary = readToken('--primary');
    const dotColor = kind === 'permission' ? readToken('--warning') : kind === 'done' ? readToken('--success') : '';
    const dot = dotColor
      ? `<circle cx="19" cy="5" r="4.5" fill="${dotColor}" stroke="${readToken('--bg-app')}" stroke-width="1.5"/>`
      : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${primary}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${Icons.GLYPHS.terminal}${dot}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function render() {
    const baseTitle = t('app_title');
    if (activeKind === 'permission') document.title = t('tab_alert_permission', { title: baseTitle });
    else if (activeKind === 'done') document.title = t('tab_alert_done', { title: baseTitle });
    else document.title = baseTitle;

    document.getElementById('app-favicon').href = buildFaviconHref(activeKind);
  }

  function clear() {
    if (activeKind === null) return;
    activeKind = null;
    render();
  }

  function notifyDone() {
    if (!document.hidden || activeKind === 'permission') return;
    activeKind = 'done';
    render();
  }

  function notifyPermission() {
    if (!document.hidden) return;
    activeKind = 'permission';
    render();
  }

  function clearPermission() {
    if (activeKind !== 'permission') return;
    activeKind = null;
    render();
  }

  function mount() {
    listeners.dispose();
    listen(document, 'visibilitychange', () => {
      if (!document.hidden) clear();
    });
    const unsubscribeI18n = I18n.onChange(() => {
      if (activeKind !== null) render();
    });
    onDispose(unsubscribeI18n);
    render();
  }

  return {
    mount,
    notifyDone,
    notifyPermission,
    clearPermission
  };
}));
