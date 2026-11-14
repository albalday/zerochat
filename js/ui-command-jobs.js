/**
 * Aviso de comandos en segundo plano que siguen en marcha al terminar un turno: una tarjeta más
 * al final del chat, plegada, con la situación en ese momento. El tiempo no corre; cuando un comando
 * termina (deja de figurar en el latido), su línea pasa a su final, con la duración y las últimas
 * líneas de salida, aunque el turno ya haya acabado. Avisa también antes de cerrar la pestaña si
 * cerrarla los detendría.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUICommandJobs = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml } = Utils;

  const MAX_COMMAND_CHARS = 60;
  // Últimas líneas de salida de un comando terminado en su línea del aviso.
  const FINISHED_TAIL_LINES = 5;
  // Color del final según la insignia del comando.
  const FINISHED_STATUS_CLASSES = { 'status-success': 'command-jobs-status-success', 'status-error': 'command-jobs-status-error' };
  const CARD_CLASS = 'command-jobs-card';

  const getState = () => resolveDep('ChatState', './state.js');
  const getCommandCard = () => resolveDep('ChatCommandCard', './command-card.js');
  const getConversation = () => resolveDep('ChatUIConversation', './ui-conversation.js');
  const getMcp = () => resolveDep('ChatMCP', './mcp.js').manager;
  const { t } = I18n;
  const icon = (name, size = 14) => Icons.get(name, { size });

  function shortCommand(command) {
    const firstLine = String(command || '').split('\n')[0].trim();
    return firstLine.length > MAX_COMMAND_CHARS ? `${firstLine.slice(0, MAX_COMMAND_CHARS - 1)}…` : firstLine;
  }

  function findCard(root, jobId) {
    return root.querySelector(`.command-card-wrapper[data-job-id="${Number(jobId)}"]`);
  }

  /** Tarjeta con los comandos en marcha y el tiempo que llevaban al crearla. */
  function createSummaryCard(jobs, messagesList) {
    const now = Date.now();
    const format = getCommandCard().formatDuration;
    // Plegada por defecto: con varios comandos, la lista no debe ocupar la respuesta.
    const card = document.createElement('details');
    card.className = CARD_CLASS;
    const items = jobs.map(job => {
      const inView = Boolean(findCard(messagesList, job.id));
      const label = `<code title="${escapeHtml(job.command)}">${escapeHtml(shortCommand(job.command))}</code>`
        + `<span class="command-jobs-time">${escapeHtml(format((now - job.startedAt) / 1000))}</span>`;
      // Lleva a la tarjeta del comando si está en esta conversación.
      return `<li data-job-id="${escapeHtml(String(job.id))}" data-running="true">${inView
        ? `<button type="button" class="command-jobs-link">${label}</button>`
        : `<span class="command-jobs-link">${label}</span>`}</li>`;
    }).join('');
    card.innerHTML = `<summary class="command-jobs-card-title">${icon('terminal')}<span class="command-jobs-card-label">${escapeHtml(t('command_jobs_title', { count: jobs.length }))}</span></summary>`
      + `<ul class="command-jobs-list">${items}</ul>`
      + `<p class="command-jobs-hint">${escapeHtml(t('command_jobs_hint'))}</p>`;
    card.addEventListener('click', event => {
      const button = event.target.closest('button.command-jobs-link');
      if (button) showCard(messagesList, Number(button.closest('[data-job-id]').dataset.jobId));
    });
    return card;
  }

  function showCard(messagesList, jobId) {
    const card = findCard(messagesList, jobId);
    if (!card) return false;
    const history = card.closest('details');
    if (history && !history.open) history.open = true;
    card.querySelector('.tool-execution-card').classList.remove('collapsed');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('command-card-highlight');
    setTimeout(() => card.classList.remove('command-card-highlight'), 1600);
    return true;
  }

  /** Últimas líneas no vacías de la salida de un comando. */
  function lastLines(text) {
    return String(text || '').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-FINISHED_TAIL_LINES).join('\n');
  }

  /** La línea de un comando que ha terminado: su final, su duración y sus últimas líneas. */
  async function finishItem(card, item) {
    item.dataset.running = 'false';
    const CommandCard = getCommandCard();
    const time = item.querySelector('.command-jobs-time');
    let details = null;
    try {
      details = await getMcp().requestExternalControl('zerochat/jobs/get', { id: Number(item.dataset.jobId) });
    } catch (_) {
      // ZeroChat se ha reiniciado o el comando se ha descartado.
    }
    const view = CommandCard.getBadgeView(details
      ? CommandCard.withDetails(CommandCard.initialState(), details)
      : { status: 'unavailable' });
    time.textContent = view.text;
    if (FINISHED_STATUS_CLASSES[view.className]) time.classList.add(FINISHED_STATUS_CLASSES[view.className]);
    const tail = lastLines(details?.tail);
    if (tail) {
      const pre = document.createElement('pre');
      pre.className = 'command-jobs-tail';
      pre.textContent = tail;
      item.appendChild(pre);
    }
    const running = card.querySelectorAll('li[data-running="true"]').length;
    const total = card.querySelectorAll('li').length;
    card.querySelector('.command-jobs-card-label').textContent = running
      ? t('command_jobs_title', { count: running })
      : t('command_jobs_title_done', { count: total });
    card.querySelector('.command-jobs-hint').hidden = running === 0;
  }

  /** Los comandos del aviso que ya no figuran entre los que siguen en marcha han terminado. */
  function updateFinished(messagesList, runningIds) {
    messagesList.querySelectorAll(`.${CARD_CLASS}`).forEach(card => {
      card.querySelectorAll('li[data-running="true"]').forEach(item => {
        if (!runningIds.has(Number(item.dataset.jobId))) finishItem(card, item);
      });
    });
  }

  /** Sustituye el aviso anterior por la situación actual, al final del chat. */
  async function appendSummary(messagesList) {
    await getMcp().refreshCommandJobs();
    messagesList.querySelectorAll(`.${CARD_CLASS}`).forEach(card => card.remove());
    const jobs = getState().get('mcp').commandJobs;
    if (!jobs.length) return;
    messagesList.appendChild(createSummaryCard(jobs, messagesList));
    getConversation().scrollToBottom(messagesList);
  }

  function mount({ messagesList }) {
    const State = getState();
    State.subscribe(state => ({ generating: state.streaming.isGenerating }), ({ generating }, previous) => {
      if (previous.generating && !generating) appendSummary(messagesList);
    });
    State.subscribe(state => ({ ids: JSON.stringify(state.mcp.commandJobs.map(job => job.id)) }), ({ ids }) => {
      updateFinished(messagesList, new Set(JSON.parse(ids)));
    });
    window.addEventListener('beforeunload', event => {
      const mcp = State.get('mcp');
      // Cerrar la última pestaña detiene el servidor, y con él los comandos.
      if (mcp.exitOnClose === true && mcp.commandJobs.length > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  return { mount };
}));
