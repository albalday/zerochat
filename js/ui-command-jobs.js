/**
 * Aviso de comandos en segundo plano que siguen en marcha al terminar un turno: una tarjeta más
 * al final del chat, plegada, con la situación en ese momento. No se actualiza; el estado de cada comando
 * está en su propia tarjeta. Avisa también antes de cerrar la pestaña si cerrarla los detendría.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatUICommandJobs = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;

  const MAX_COMMAND_CHARS = 60;
  const CARD_CLASS = 'command-jobs-card';

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getCommandCard = () => resolveDep('ChatCommandCard', './command-card.js');
  const getConversation = () => resolveDep('ChatUIConversation', './ui-conversation.js');
  const getMcp = () => resolveDep('ChatMCP', null)?.manager || null;
  const t = (key, params) => getI18n()?.t?.(key, params) || key;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, size = 14) => getIcons()?.get?.(name, { size }) || '';

  function shortCommand(command) {
    const firstLine = String(command || '').split('\n')[0].trim();
    return firstLine.length > MAX_COMMAND_CHARS ? `${firstLine.slice(0, MAX_COMMAND_CHARS - 1)}…` : firstLine;
  }

  function findCard(root, jobId) {
    return root?.querySelector?.(`.command-card-wrapper[data-job-id="${Number(jobId)}"]`) || null;
  }

  /** Tarjeta con los comandos en marcha y el tiempo que llevaban al crearla. */
  function createSummaryCard(jobs, { now = Date.now(), messagesList = null } = {}) {
    if (typeof document === 'undefined' || !Array.isArray(jobs) || !jobs.length) return null;
    const format = getCommandCard()?.formatDuration || (seconds => `${Math.floor(seconds)} s`);
    // Plegada por defecto: con varios comandos, la lista no debe ocupar la respuesta.
    const card = document.createElement('details');
    card.className = CARD_CLASS;
    const items = jobs.map(job => {
      const inView = Boolean(findCard(messagesList, job.id));
      const label = `<code title="${escapeHtml(job.command)}">${escapeHtml(shortCommand(job.command))}</code>`
        + `<span class="command-jobs-time">${escapeHtml(format((now - job.startedAt) / 1000))}</span>`;
      // Lleva a la tarjeta del comando si está en esta conversación.
      return `<li data-job-id="${job.id}">${inView
        ? `<button type="button" class="command-jobs-link">${label}</button>`
        : `<span class="command-jobs-link">${label}</span>`}</li>`;
    }).join('');
    card.innerHTML = `<summary class="command-jobs-card-title">${icon('terminal')}<span>${escapeHtml(t('command_jobs_title', { count: jobs.length }))}</span></summary>`
      + `<ul class="command-jobs-list">${items}</ul>`
      + `<p class="command-jobs-hint">${escapeHtml(t('command_jobs_hint'))}</p>`;
    card.addEventListener('click', event => {
      const button = event.target.closest?.('button.command-jobs-link');
      if (button) showCard(messagesList, Number(button.closest('[data-job-id]')?.dataset.jobId));
    });
    return card;
  }

  function showCard(messagesList, jobId) {
    const card = findCard(messagesList, jobId);
    if (!card) return false;
    const history = card.closest('details');
    if (history && !history.open) history.open = true;
    card.querySelector('.tool-execution-card')?.classList.remove('collapsed');
    card.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    card.classList.add('command-card-highlight');
    setTimeout(() => card.classList.remove('command-card-highlight'), 1600);
    return true;
  }

  /** Sustituye el aviso anterior por la situación actual, al final del chat. */
  async function appendSummary(messagesList) {
    if (!messagesList) return null;
    await getMcp()?.refreshCommandJobs?.();
    messagesList.querySelectorAll(`.${CARD_CLASS}`).forEach(card => card.remove());
    const card = createSummaryCard(getState()?.get?.('mcp')?.commandJobs || [], { messagesList });
    if (!card) return null;
    messagesList.appendChild(card);
    getConversation()?.scrollToBottom?.(messagesList);
    return card;
  }

  function mount({ messagesList } = {}) {
    const State = getState();
    if (!messagesList || !State?.subscribe) return null;
    State.subscribe(state => ({ generating: state.streaming?.isGenerating === true }), ({ generating }, previous) => {
      if (previous?.generating && !generating) appendSummary(messagesList);
    });
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', event => {
        const mcp = State.get?.('mcp') || {};
        // Cerrar la última pestaña detiene el servidor, y con él los comandos.
        if (mcp.exitOnClose === true && (mcp.commandJobs || []).length > 0) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
    }
    return { appendSummary: () => appendSummary(messagesList) };
  }

  return {
    mount,
    createSummaryCard,
    appendSummary,
    shortCommand
  };
}));
