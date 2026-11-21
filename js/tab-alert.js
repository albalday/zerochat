/**
 * Aviso en título y favicon de la pestaña cuando un turno termina o pide permiso en segundo plano.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatTabAlert = factory(root.ChatUtils, root.ChatI18n);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { t } = I18n;
  const listeners = Utils.createListenerGroup();
  const { listen, onDispose } = listeners;

  const SVG_DATA_PREFIX = 'data:image/svg+xml,';
  let activeKind = null; // null | 'done' | 'permission'
  // El favicon de zerochat.html es la única fuente del icono: el aviso le añade un punto de color.
  let baseFavicon = null;

  function readToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function buildFaviconHref(kind) {
    if (kind === null) return baseFavicon;
    const dotColor = readToken(kind === 'permission' ? '--warning' : '--success');
    const dot = `<circle cx="19" cy="5" r="4.5" fill="${dotColor}" stroke="${readToken('--bg-app')}" stroke-width="1.5"/>`;
    const svg = decodeURIComponent(baseFavicon.slice(SVG_DATA_PREFIX.length)).replace('</svg>', `${dot}</svg>`);
    return SVG_DATA_PREFIX + encodeURIComponent(svg);
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
    baseFavicon ??= document.getElementById('app-favicon').getAttribute('href');
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
