/**
 * Aviso en título y favicon de la pestaña: cuando un turno termina o pide permiso en segundo plano, y mientras haya
 * conversaciones que necesitan atención (ejecuciones en servidor esperando al usuario o con error, de cualquier
 * proyecto), con su número en el título.
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
  // Con la pestaña oculta, el título alterna con el aviso de atención a este ritmo.
  const BLINK_MS = 1500;
  let activeKind = null; // null | 'done' | 'permission'
  let attention = { needsInput: 0, error: 0 };
  // El título alterna solo si llegó algo nuevo con la pestaña oculta, hasta que se vuelve a ella.
  let blinkTimer = null;
  let blinkPhase = false;
  // El favicon de zerochat.html es la única fuente del icono: el aviso le añade un punto de color.
  let baseFavicon = null;

  function readToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const attentionTotal = () => attention.needsInput + attention.error;

  // Un error pesa más que una espera, y cualquiera de los dos más que un turno terminado.
  function dotToken() {
    if (attention.error > 0) return '--danger';
    if (attention.needsInput > 0 || activeKind === 'permission') return '--warning';
    return activeKind === 'done' ? '--success' : null;
  }

  function buildFaviconHref() {
    const token = dotToken();
    if (token === null) return baseFavicon;
    const dot = `<circle cx="19" cy="5" r="4.5" fill="${readToken(token)}" stroke="${readToken('--bg-app')}" stroke-width="1.5"/>`;
    const svg = decodeURIComponent(baseFavicon.slice(SVG_DATA_PREFIX.length)).replace('</svg>', `${dot}</svg>`);
    return SVG_DATA_PREFIX + encodeURIComponent(svg);
  }

  function buildTitle() {
    const baseTitle = t('app_title');
    const total = attentionTotal();
    if (blinkPhase && total > 0) return t('tab_alert_attention', { count: total, title: baseTitle });
    let title = baseTitle;
    if (activeKind === 'permission') title = t('tab_alert_permission', { title: baseTitle });
    else if (activeKind === 'done') title = t('tab_alert_done', { title: baseTitle });
    return total > 0 ? `(${total}) ${title}` : title;
  }

  function render() {
    document.title = buildTitle();
    document.getElementById('app-favicon').href = buildFaviconHref();
  }

  function stopBlink() {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkPhase = false;
  }

  function startBlink() {
    if (blinkTimer !== null) return;
    blinkTimer = setInterval(() => {
      blinkPhase = !blinkPhase;
      render();
    }, BLINK_MS);
  }

  function clear() {
    stopBlink();
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

  /**
   * Conversaciones que necesitan atención ({ needsInput, error }). El número sale siempre en el título; si alguno
   * crece con la pestaña oculta, el título alterna con el aviso hasta volver a ella o quedar sin ninguna.
   */
  function setAttention(next) {
    const grew = next.needsInput > attention.needsInput || next.error > attention.error;
    attention = { needsInput: next.needsInput, error: next.error };
    if (attentionTotal() === 0) stopBlink();
    else if (grew && document.hidden) startBlink();
    render();
  }

  function mount() {
    listeners.dispose();
    baseFavicon ??= document.getElementById('app-favicon').getAttribute('href');
    listen(document, 'visibilitychange', () => {
      if (!document.hidden) clear();
    });
    const unsubscribeI18n = I18n.onChange(render);
    onDispose(unsubscribeI18n);
    onDispose(stopBlink);
    render();
  }

  return {
    mount,
    notifyDone,
    notifyPermission,
    clearPermission,
    setAttention
  };
}));
