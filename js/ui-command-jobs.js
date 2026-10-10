/**
 * Franja de comandos en marcha al final del chat: los comandos de run_command que siguen vivos
 * en el servidor local, con su tiempo, acceso a su tarjeta y botones para detenerlos. Avisa
 * también antes de cerrar la pestaña si cerrarla los detendría.
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

  const MAX_COMMAND_CHARS = 48;

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getState = () => resolveDep('ChatState', './state.js');
  const getDialogs = () => resolveDep('ChatDialogs', null);
  const getCommandCard = () => resolveDep('ChatCommandCard', './command-card.js');
  const getMcp = () => resolveDep('ChatMCP', null)?.manager || null;
  const t = (key, params) => getI18n()?.t?.(key, params) || key;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, size = 13) => getIcons()?.get?.(name, { size }) || '';

  function shortCommand(command) {
    const firstLine = String(command || '').split('\n')[0].trim();
    return firstLine.length > MAX_COMMAND_CHARS ? `${firstLine.slice(0, MAX_COMMAND_CHARS - 1)}…` : firstLine;
  }

  function elapsedText(job, now = Date.now()) {
    const format = getCommandCard()?.formatDuration || (s => `${Math.floor(s)} s`);
    return format((now - job.startedAt) / 1000);
  }

  function findCard(root, jobId) {
    return root?.querySelector?.(`.command-card-wrapper[data-job-id="${Number(jobId)}"]`) || null;
  }

  /** Pinta la franja; vacía, queda oculta. */
  function render(bar, jobs, { now = Date.now(), messagesList = null } = {}) {
    if (!bar) return;
    const list = Array.isArray(jobs) ? jobs : [];
    bar.hidden = list.length === 0;
    if (!list.length) {
      bar.replaceChildren();
      return;
    }
    const items = list.map(job => {
      const inView = Boolean(findCard(messagesList, job.id));
      const label = escapeHtml(shortCommand(job.command));
      const title = escapeHtml(inView ? job.command : t('command_jobs_elsewhere', { command: job.command }));
      return `<li class="command-job" data-job-id="${job.id}">`
        + `<button type="button" class="command-job-link" data-jobs-action="show" title="${title}"${inView ? '' : ' aria-disabled="true"'}>`
        + `<code>${label}</code><span class="command-job-time" data-started-at="${job.startedAt}">${escapeHtml(elapsedText(job, now))}</span></button>`
        + `<button type="button" class="command-job-stop" data-jobs-action="stop" title="${escapeHtml(t('command_jobs_stop_one', { command: shortCommand(job.command) }))}" aria-label="${escapeHtml(t('command_jobs_stop_one', { command: shortCommand(job.command) }))}">${icon('stop', 12)}</button>`
        + `</li>`;
    }).join('');
    bar.innerHTML = `<span class="command-jobs-title">${icon('terminal', 14)}<span>${escapeHtml(t('command_jobs_title', { count: list.length }))}</span></span>`
      + `<ul class="command-jobs-list">${items}</ul>`
      + (list.length > 1 ? `<button type="button" class="command-jobs-stop-all" data-jobs-action="stop-all">${icon('stop', 12)}<span>${escapeHtml(t('command_jobs_stop_all'))}</span></button>` : '');
  }

  /** Actualiza solo los relojes, sin volver a pintar la franja. */
  function updateClocks(bar, now = Date.now()) {
    const format = getCommandCard()?.formatDuration;
    bar?.querySelectorAll?.('.command-job-time').forEach(el => {
      const startedAt = Number(el.dataset.startedAt);
      if (format && Number.isFinite(startedAt)) el.textContent = format((now - startedAt) / 1000);
    });
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

  async function stopJobs(ids) {
    const mcp = getMcp();
    if (!mcp?.requestExternalControl) return;
    const results = await Promise.allSettled(ids.map(id => mcp.requestExternalControl('zerochat/jobs/stop', { id })));
    await mcp.refreshCommandJobs?.();
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      await getDialogs()?.alert?.(t('command_stop_error', { error: failed.reason?.message || String(failed.reason) }), { type: 'error' });
    }
  }

  function mount({ bar, messagesList } = {}) {
    const State = getState();
    if (!bar || !State?.subscribe) return null;
    let clock = null;
    const currentJobs = () => State.get?.('mcp')?.commandJobs || [];
    const sync = () => {
      const jobs = currentJobs();
      render(bar, jobs, { messagesList });
      if (jobs.length && clock === null) clock = setInterval(() => updateClocks(bar), 1000);
      if (!jobs.length && clock !== null) {
        clearInterval(clock);
        clock = null;
      }
    };
    State.subscribe(state => ({ jobs: JSON.stringify(state.mcp?.commandJobs || []) }), sync);
    // Al cambiar de conversación, o al añadirse mensajes, cambia qué tarjetas están a la vista.
    State.subscribe(
      state => ({ session: state.sessions?.activeId || null, count: Array.isArray(state.messages) ? state.messages.length : 0 }),
      () => { if (currentJobs().length) setTimeout(sync, 0); }
    );

    bar.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-jobs-action]');
      if (!button) return;
      const action = button.dataset.jobsAction;
      const jobId = Number(button.closest('[data-job-id]')?.dataset.jobId);
      if (action === 'show') {
        if (!showCard(messagesList, jobId)) render(bar, currentJobs(), { messagesList });
      } else if (action === 'stop') {
        button.disabled = true;
        await stopJobs([jobId]);
      } else if (action === 'stop-all') {
        const ids = currentJobs().map(job => job.id);
        const confirmed = await getDialogs()?.confirm?.(t('command_jobs_stop_all_confirm', { count: ids.length }), { type: 'warning' });
        if (!confirmed) return;
        // Solo los que siguen en marcha tras la confirmación.
        const stillRunning = new Set(currentJobs().map(job => job.id));
        await stopJobs(ids.filter(id => stillRunning.has(id)));
      }
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
    sync();
    return { sync };
  }

  return {
    mount,
    render,
    updateClocks,
    shortCommand
  };
}));
