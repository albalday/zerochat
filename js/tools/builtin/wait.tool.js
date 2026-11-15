/**
 * Herramienta nativa wait: espera unos segundos o hasta una hora local y devuelve el turno al modelo.
 * Es una espera optimista del navegador: solo dura mientras el chat siga abierto, se corta con «Detener»
 * y no existe en las ejecuciones sin interfaz (--prompt y ejecución en servidor).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../i18n.js'), require('../../icons.js'));
  else root.ChatBuiltinWaitTool = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml, resolveDep } = Utils;
  const { t } = I18n;
  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  const MAX_WAIT_SECONDS = 24 * 60 * 60;
  // Se compara con la hora de llegada en cada comprobación: una suspensión del equipo o los temporizadores
  // frenados de una pestaña oculta retrasan el final, pero no lo desplazan.
  const CHECK_INTERVAL_MS = 1000;
  const UNTIL_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  const CLOCK_ICON_SVG = Icons.get('clock', { size: 14 });
  const SPINNER_SVG = Icons.get('spinner', { size: 12, strokeWidth: 2.5, className: 'ui-icon-spin' });

  const pad = value => String(value).padStart(2, '0');
  const formatClock = ms => {
    const date = new Date(ms);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  /** Momento en que termina la espera (ms) a partir de now, o { error } si los argumentos no valen. */
  function resolveTarget(args, now) {
    const hasSeconds = args?.seconds !== undefined && args?.seconds !== null;
    const hasUntil = typeof args?.until === 'string' && args.until.trim() !== '';
    if (hasSeconds === hasUntil) return { error: 'Give either seconds or until, not both.' };
    if (hasSeconds) {
      const seconds = Number(args.seconds);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) {
        return { error: `seconds must be a number from 1 to ${MAX_WAIT_SECONDS}.` };
      }
      return { target: now + Math.round(seconds * 1000) };
    }
    const match = UNTIL_PATTERN.exec(args.until.trim());
    const [hours, minutes, seconds] = match ? match.slice(1).map(part => Number(part || 0)) : [];
    if (!match || hours > 23 || minutes > 59 || seconds > 59) return { error: 'until must be a local time HH:MM or HH:MM:SS.' };
    const target = new Date(now);
    target.setHours(hours, minutes, seconds, 0);
    // Una hora que ya ha pasado hoy es la de mañana.
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return { target: target.getTime() };
  }

  function sleepUntil(target, signal) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Wait cancelled by the user.'));
      };
      const tick = () => {
        const remaining = target - Date.now();
        if (remaining <= 0) {
          signal?.removeEventListener('abort', onAbort);
          resolve();
          return;
        }
        timer = setTimeout(tick, Math.min(remaining, CHECK_INTERVAL_MS));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      tick();
    });
  }

  function showWaiting(card, target) {
    const badge = card?.querySelector('.tool-card-badge');
    if (!badge) return;
    badge.className = 'tool-card-badge status-loading';
    badge.innerHTML = `${SPINNER_SVG} <span>${escapeHtml(t('tool_wait_waiting', { time: formatClock(target) }))}</span>`;
  }

  function createLiveCard(args, ui) {
    const card = ui.createCardWrapper();
    card.innerHTML = getCards().renderCardHtml({
      className: 'wait-tool-card',
      collapsible: false,
      titleHtml: `${CLOCK_ICON_SVG}<span>${escapeHtml(t('tool_wait_title'))}</span>`,
      badgeHtml: '<span class="tool-card-badge status-loading"></span>'
    });
    const { target } = resolveTarget(args, Date.now());
    if (target) showWaiting(card, target);
    return card;
  }

  function updateLiveCard(card, _args, result) {
    const success = result.success !== false && !result.error;
    const label = success
      ? t('tool_wait_done', { time: typeof result.until === 'string' ? result.until : '' })
      : String(result.error || result.content || '');
    getCards().renderStatusBadge(card.querySelector('.tool-card-badge'), success, label);
  }

  return {
    definition: {
      name: 'wait',
      description: 'Wait before going on: a number of seconds or until a local time (at most 24 h), only while the user keeps the chat open; the user can stop it. When it ends, carry on with what you were doing. To wait for a command started with run_command, use check_command(job_id, wait_seconds) instead: it returns as soon as the command ends.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS, description: 'Seconds to wait.' },
          until: { type: 'string', description: 'Local time to wait until, HH:MM or HH:MM:SS (24 h); if it has passed today, the same time tomorrow.' }
        }
      }
    },
    aliases: ['sleep'],
    category: 'interaction',
    settings: { titleKey: 'agent_wait_title', descKey: 'agent_wait_desc' },
    promptGuide: '- `wait(seconds=600)` or `wait(until="14:30")`: Waits while the chat stays open, then you carry on with what you were doing.',
    execute: async (args, context = {}) => {
      const started = Date.now();
      const { target, error } = resolveTarget(args, started);
      if (error) return { success: false, error };
      showWaiting(context.toolCard?.element, target);
      await sleepUntil(target, context.signal);
      return { success: true, until: formatClock(target), waited_s: Math.round((Date.now() - started) / 1000) };
    },
    result: {
      toModel: (_args, result) => JSON.stringify(result.success === false
        ? { success: false, error: result.error }
        : { success: true, until: result.until, waited_s: result.waited_s, note: 'Wait finished, continue.' }),
      toMarkdown: (_args, result) => result.success === false
        ? `> **wait** (error: ${result.error})\n\n`
        : `> **wait** (${result.until})\n\n`
    },
    displayMode: 'expanded',
    view: { createLiveCard, updateLiveCard }
  };
});
