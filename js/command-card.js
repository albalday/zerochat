/**
 * Tarjeta de run_command: sigue al comando mientras su proceso vive en el servidor local y
 * muestra su estado y un botón para detenerlo. El reloj se calcula en el navegador y el final
 * se detecta con el latido, que trae los comandos en marcha: plegada, la tarjeta no hace
 * peticiones propias. Desplegada, pide su log mientras el comando sigue en marcha.
 *
 * Mientras la llamada está en curso la tarjeta identifica al comando por la clave de la
 * invocación (`data-invocation-id`); en cuanto el resultado trae su `job_id`, por este.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatCommandCard = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep, escapeHtml, formatBytes } = Utils;

  // Solo una tarjeta desplegada pide su log, y con este intervalo.
  const LOG_POLL_MS = 2000;
  const FIRST_LOG_POLL_MS = 700;
  const LOG_PAGE_BYTES = 256 * 1024;
  const MAX_LOG_CHARS = 512 * 1024;
  const FINAL_STATUSES = new Set(['exited', 'timeout', 'stopped', 'error', 'unavailable']);
  const COMMAND_TOOLS = new Set(['run_command', 'check_command']);

  const controllers = new WeakMap();

  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const getConversation = () => resolveDep('ChatUIConversation', './ui-conversation.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getMcp = () => resolveDep('ChatMCP', './mcp.js').manager;
  const getState = () => resolveDep('ChatState', './state.js');
  const { t } = I18n;
  const icon = (name, size = 13) => Icons.get(name, { size });

  /** Resultado de run_command (texto JSON del servidor) como objeto, o null si no lo es. */
  function parseResult(raw) {
    const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : null);
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      return data && typeof data === 'object' && typeof data.status === 'string' ? data : null;
    } catch (_) {
      return null;
    }
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    if (total < 60) return `${total < 10 ? total.toFixed(1) : Math.floor(total)} s`;
    const whole = Math.floor(total);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = String(whole % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function isFailure(state) {
    return state.status === 'timeout' || state.status === 'error' || (state.status === 'exited' && state.exitCode !== 0);
  }

  /** Estado de una tarjeta nueva: el comando en marcha desde ahora, aún sin confirmar por el servidor. */
  function initialState() {
    return {
      status: 'running',
      exitCode: null,
      elapsed: 0,
      startedAt: Date.now(),
      id: null,
      toolReturned: false,
      // El servidor ya conoce el comando: hasta entonces no se toca la insignia, que puede
      // estar pidiendo permiso al usuario.
      confirmed: false,
      output: '',
      reactivated: false
    };
  }

  /** Estado tras los detalles que da el servidor del comando (zerochat/jobs/get o stop). */
  function withDetails(state, details) {
    if (!details || typeof details !== 'object') return state;
    return {
      ...state,
      confirmed: true,
      id: Number.isInteger(details.id) ? details.id : state.id,
      status: typeof details.status === 'string' ? details.status : state.status,
      exitCode: details.exit_code !== undefined ? details.exit_code : state.exitCode,
      startedAt: Number.isFinite(details.started_at) ? details.started_at : state.startedAt,
      elapsed: Number.isFinite(details.elapsed_s) ? details.elapsed_s : state.elapsed
    };
  }

  /**
   * Estado tras el resultado de la herramienta (`data`, ya interpretado con parseResult): final, o
   * el comando sigue en segundo plano. Sin resultado legible el comando no llegó a ejecutarse y su
   * salida es `fallbackError`.
   */
  function withResult(state, data, fallbackError = '') {
    const returned = { ...state, toolReturned: true, confirmed: true };
    if (!data) return { ...returned, status: 'error', output: fallbackError };
    return {
      ...returned,
      id: Number.isInteger(data.job_id) ? data.job_id : state.id,
      status: data.status,
      exitCode: data.exit_code ?? null,
      elapsed: Number.isFinite(data.duration_s) ? data.duration_s : state.elapsed,
      startedAt: Number.isFinite(data.elapsed_s) ? Date.now() - data.elapsed_s * 1000 : state.startedAt,
      output: [data.output ?? data.new_output ?? '', data.error ? `\n${data.error}` : ''].join('').trim()
    };
  }

  /** Cómo localiza el servidor al comando: por su id y, antes de conocerlo, por la clave de la invocación. */
  function jobRef(state, invocationId) {
    if (Number.isInteger(state.id)) return { id: state.id };
    return invocationId ? { key: invocationId } : null;
  }

  /** Solo se puede detener un comando en marcha que el servidor sepa localizar. */
  function canStop(state, invocationId) {
    return state.status === 'running' && jobRef(state, invocationId) !== null;
  }

  /** Un comando en segundo plano que ya no figura entre los que siguen en marcha ha terminado. */
  function hasLeftRunning(state, runningIds) {
    return state.toolReturned && Number.isInteger(state.id) && !runningIds.has(state.id);
  }

  /** Primera página del log: desde donde empiezan sus últimos LOG_PAGE_BYTES, con un aviso de lo omitido. */
  function firstLogPage(outputBytes) {
    const offset = Math.max(0, (Number(outputBytes) || 0) - LOG_PAGE_BYTES);
    return { offset, text: offset > 0 ? `${t('command_log_earlier', { size: formatBytes(offset) })}\n` : '' };
  }

  /** Log mostrado tras añadirle una página: solo sus últimos MAX_LOG_CHARS caracteres. */
  function appendLog(text, page) {
    const log = text + page;
    return log.length > MAX_LOG_CHARS ? log.slice(-MAX_LOG_CHARS) : log;
  }

  /**
   * Log cuando el servidor no lo tiene: la salida guardada en el chat, la misma que vio el modelo.
   * Null mientras la herramienta no ha devuelto nada.
   */
  function fallbackLog(state) {
    return state.toolReturned ? state.output || t('command_log_unavailable') : null;
  }

  /** Estado visible de la insignia según el estado del comando. */
  function getBadgeView(state) {
    const elapsed = state.status === 'running' && state.startedAt
      ? (Date.now() - state.startedAt) / 1000
      : state.elapsed;
    const time = formatDuration(elapsed);
    switch (state.status) {
      case 'running':
        return { className: 'status-loading', icon: 'spinner', text: t(state.toolReturned ? 'command_status_background' : 'command_status_running', { time }) };
      case 'exited':
        return state.exitCode === 0
          ? { className: 'status-success', icon: 'check', text: t('command_status_done', { time }) }
          : { className: 'status-error', icon: 'x-circle', text: t('command_status_exit_code', { code: state.exitCode, time }) };
      case 'timeout':
        return { className: 'status-error', icon: 'x-circle', text: t('command_status_timeout', { time }) };
      case 'stopped':
        return { className: 'status-stopped', icon: 'stop', text: t('command_status_stopped', { time }) };
      case 'error':
        return { className: 'status-error', icon: 'x-circle', text: t('command_status_failed') };
      default:
        return { className: 'status-stopped', icon: 'clock', text: t('command_status_unavailable') };
    }
  }

  /** Insignia de una vista ({ className, icon, text }), con un título opcional al pasar el ratón. */
  function renderBadgeView(view, title = '') {
    const svg = view.icon === 'spinner'
      ? Icons.get('spinner', { size: 12, strokeWidth: 2.5, className: 'ui-icon-spin' })
      : icon(view.icon, 12);
    return `<span class="tool-card-badge ${view.className}"${title ? ` title="${escapeHtml(title)}"` : ''}>${svg} <span>${escapeHtml(view.text)}</span></span>`;
  }

  function renderBadge(state) {
    return renderBadgeView(getBadgeView(state));
  }

  function replaceBadge(card, html) {
    card.querySelector('.tool-card-badge').outerHTML = html;
  }

  /**
   * Tarjeta de comando: título, insignia, log y un botón que pide `stop()` a su controlador (detener
   * el comando en run_command, cortar la espera en check_command).
   */
  function buildCardShell(ui, { titleHtml, actionLabel, collapsed = false }) {
    const card = ui.createCardWrapper('mcp-card command-card-wrapper');
    card.innerHTML = getToolCards().renderCardHtml({
      className: 'command-card',
      collapsed,
      titleHtml,
      badgeHtml: '<span class="tool-card-badge"></span>',
      bodyHtml: `<pre class="tool-card-code command-card-log" tabindex="0" hidden><code></code></pre>`
        + `<div class="command-card-actions">`
        + `<button type="button" class="btn-command-action btn-command-stop" data-command-action="stop" hidden>${icon('stop')}<span>${escapeHtml(actionLabel)}</span></button>`
        + `</div>`
    });
    card.addEventListener('click', event => {
      const button = event.target.closest('[data-command-action="stop"]');
      if (!button || !card.contains(button)) return;
      event.stopPropagation();
      controllers.get(card)?.stop();
    });
    return card;
  }

  function buildCard(args, ui, { collapsed = false } = {}) {
    const command = typeof args?.command === 'string' ? args.command : '';
    const firstLine = command.split('\n')[0] + (command.includes('\n') ? ' …' : '');
    return buildCardShell(ui, {
      collapsed,
      actionLabel: t('command_action_stop'),
      titleHtml: `${icon('terminal', 14)}<code class="command-card-command" title="${escapeHtml(command)}">${escapeHtml(firstLine)}</code>`
        + '<span class="command-card-last-line" hidden></span>'
    });
  }

  /** Última línea de salida que publica el latido para el comando `id`, o vacía. */
  function lastLineOf(id) {
    return getState().get('mcp').commandJobs.find(job => job.id === id)?.lastLine || '';
  }

  // Tarjetas de comandos en marcha: un único reloj para todas y una única suscripción al latido.
  const tracked = new Set();
  let clockTimer = null;
  let jobsSubscribed = false;

  function track(controller) {
    tracked.add(controller);
    if (clockTimer === null) {
      clockTimer = setInterval(() => {
        for (const item of tracked) {
          if (!item.card.isConnected) untrack(item);
          else if (item.state.confirmed) item.renderBadge();
        }
      }, 1000);
    }
    if (!jobsSubscribed) {
      jobsSubscribed = true;
      // Un comando que deja de figurar entre los que siguen en marcha ha terminado: su tarjeta
      // pregunta una vez cómo acabó.
      getState().subscribe(state => ({ ids: JSON.stringify(state.mcp.commandJobs.map(job => job.id)) }), ({ ids }) => {
        const running = new Set(JSON.parse(ids));
        for (const item of tracked) {
          if (hasLeftRunning(item.state, running)) item.refreshStatus();
        }
      });
      // Plegada, la tarjeta de un comando en marcha muestra su última línea de salida.
      getState().subscribe(state => ({ lines: JSON.stringify(state.mcp.commandJobs.map(job => [job.id, job.lastLine])) }), () => {
        for (const item of tracked) item.renderLastLine();
      });
    }
  }

  function untrack(controller) {
    tracked.delete(controller);
    controller.stopLogPolling();
    if (!tracked.size && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  class CommandCardController {
    constructor(card) {
      this.card = card;
      this.state = initialState();
      this.logTimer = null;
      this.log = { loaded: false, next: 0, loading: false };
      controllers.set(card, this);
      // El log se pide al desplegar la tarjeta, la despliegue quien la despliegue.
      new MutationObserver(() => {
        if (!this.isExpanded()) {
          this.stopLogPolling();
          return;
        }
        if (!this.log.loaded) this.loadLog();
        this.scheduleLog();
      }).observe(card.querySelector('.tool-execution-card'), { attributes: true, attributeFilter: ['class'] });
    }

    ref() {
      return jobRef(this.state, this.card.dataset.invocationId);
    }

    isFinal() {
      return FINAL_STATUSES.has(this.state.status);
    }

    isExpanded() {
      return !this.card.querySelector('.tool-execution-card').classList.contains('collapsed');
    }

    renderBadge() {
      replaceBadge(this.card, renderBadge(this.state));
    }

    render() {
      const { state, card } = this;
      if (Number.isInteger(state.id)) card.dataset.jobId = String(state.id);
      this.renderBadge();
      card.querySelector('[data-command-action="stop"]').hidden = !canStop(state, card.dataset.invocationId);
      this.renderLastLine();
    }

    renderLastLine() {
      const element = this.card.querySelector('.command-card-last-line');
      const text = this.state.status === 'running' && Number.isInteger(this.state.id) ? lastLineOf(this.state.id) : '';
      element.textContent = text;
      element.title = text;
      element.hidden = !text;
    }

    applyDetails(details) {
      this.state = withDetails(this.state, details);
    }

    /** Aplica el resultado de la herramienta: final, o el comando sigue en segundo plano. */
    applyResult(data, fallbackError = '') {
      this.state = withResult(this.state, data, fallbackError);
      if (!data) {
        untrack(this);
        this.render();
        this.showText(this.state.output);
        return;
      }
      if (this.state.status === 'running') {
        track(this);
        this.scheduleLog();
        // El aviso de fin de turno y el latido lo cuentan sin esperar al siguiente latido.
        getMcp().refreshCommandJobs();
      } else {
        untrack(this);
        // El log se recargará entero si se vuelve a desplegar.
        this.log.loaded = false;
      }
      this.render();
    }

    scheduleLog() {
      if (this.logTimer === null && !this.isFinal() && this.isExpanded()) {
        this.logTimer = setTimeout(() => this.pollLog(), LOG_POLL_MS);
      }
    }

    stopLogPolling() {
      if (this.logTimer !== null) clearTimeout(this.logTimer);
      this.logTimer = null;
    }

    async pollLog() {
      this.logTimer = null;
      if (!this.card.isConnected) {
        untrack(this);
        return;
      }
      if (!document.hidden) {
        const done = await this.loadLog();
        if (done && this.state.toolReturned) {
          await this.refreshStatus();
          return;
        }
        // La clave de la invocación llega después de crear la tarjeta: el botón de detener
        // aparece cuando el servidor ya conoce el comando.
        if (this.state.confirmed) this.render();
      }
      this.scheduleLog();
    }

    /** Pregunta una vez al servidor cómo está el comando. */
    async refreshStatus() {
      const ref = this.ref();
      if (!ref) return;
      try {
        this.applyDetails(await getMcp().requestExternalControl('zerochat/jobs/get', ref));
      } catch (_) {
        if (!this.state.toolReturned) return;
        this.state.status = 'unavailable';
      }
      if (this.isFinal()) {
        untrack(this);
        if (this.isExpanded() && this.state.status !== 'unavailable') await this.loadLog();
        this.finish();
      }
      this.render();
    }

    /** Un comando que sigue en segundo plano vuelve a la zona visible de su grupo de herramientas. */
    reactivate() {
      if (this.state.reactivated || !this.state.toolReturned || this.state.status !== 'running') return;
      this.state.reactivated = true;
      this.card.querySelector('.tool-execution-card').classList.remove('collapsed');
      getToolCards().reactivateToolCard(this.card);
      const messagesList = this.card.closest('#messages-list');
      if (messagesList) getConversation().scrollToBottom(messagesList);
    }

    finish() {
      if (this.state.toolReturned) getMcp().refreshCommandJobs();
      if (this.state.reactivated) {
        this.state.reactivated = false;
        getToolCards().completeToolCard(this.card, { success: !isFailure(this.state) });
      }
    }

    async stop() {
      const ref = this.ref();
      const mcp = getMcp();
      const button = this.card.querySelector('[data-command-action="stop"]');
      if (!ref) return;
      button.disabled = true;
      try {
        this.applyDetails(await mcp.requestExternalControl('zerochat/jobs/stop', ref));
        if (this.isExpanded()) await this.loadLog();
        this.render();
        if (this.isFinal() && this.state.toolReturned) {
          untrack(this);
          this.finish();
        } else {
          mcp.refreshCommandJobs();
        }
      } catch (error) {
        await getDialogs().alert(t('command_stop_error', { error: error?.message || String(error) }), { type: 'error' });
      } finally {
        button.disabled = false;
      }
    }

    showText(text) {
      const logEl = this.card.querySelector('.command-card-log');
      logEl.querySelector('code').textContent = text || '';
      logEl.hidden = !text;
    }

    showFallback() {
      const text = fallbackLog(this.state);
      if (text !== null) this.showText(text);
    }

    /**
     * La primera vez carga el final del log; después, solo lo nuevo. Devuelve si el comando ya
     * ha terminado, según el servidor.
     */
    async loadLog() {
      if (this.log.loading) return false;
      if (this.state.status === 'error') {
        this.showText(this.state.output);
        return true;
      }
      const ref = this.ref();
      const mcp = getMcp();
      const logEl = this.card.querySelector('.command-card-log');
      if (!ref) {
        this.showFallback();
        return false;
      }
      this.log.loading = true;
      const initial = !this.log.loaded;
      try {
        let text = logEl.querySelector('code').textContent;
        if (initial) {
          const details = await mcp.requestExternalControl('zerochat/jobs/get', ref);
          this.applyDetails(details);
          const first = firstLogPage(details?.output_bytes);
          this.log.next = first.offset;
          text = first.text;
        }
        const atBottom = logEl.hidden || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
        const page = await mcp.requestExternalControl('zerochat/jobs/log', { ...ref, offset: this.log.next, limit: LOG_PAGE_BYTES });
        this.state.confirmed = true;
        this.log.next = Number(page?.next) || this.log.next;
        this.log.loaded = true;
        this.showText(appendLog(text, String(page?.text || '')));
        if (atBottom) logEl.scrollTop = logEl.scrollHeight;
        return page?.done === true;
      } catch (_) {
        // Antes de registrarse el comando se reintentará; si ya no existe, queda la salida guardada.
        if (initial) this.showFallback();
        return false;
      } finally {
        this.log.loading = false;
      }
    }
  }

  function createView() {
    return {
      createLiveCard: (args, ui) => {
        const card = buildCard(args, ui);
        const controller = new CommandCardController(card);
        controller.render();
        track(controller);
        // La primera consulta llega antes para que el reloj y el log arranquen enseguida.
        controller.logTimer = setTimeout(() => controller.pollLog(), FIRST_LOG_POLL_MS);
        return card;
      },
      updateLiveCard: (card, args, result) => {
        const controller = controllers.get(card) || new CommandCardController(card);
        controller.applyResult(parseResult(result), result.error || result.content || '');
        // La tarjeta de un comando que sigue en marcha permanece abierta y a la vista, también
        // después de que el turno la archive con el resto de herramientas terminadas.
        if (controller.state.status !== 'running') return false;
        setTimeout(() => controller.reactivate(), 0);
        return true;
      },
      renderHistoricalCard: (args, message, ui) => {
        const data = parseResult(message?.content);
        const running = data?.status === 'running';
        const card = buildCard(args, ui, { collapsed: true });
        const controller = new CommandCardController(card);
        controller.applyResult(data, typeof message?.content === 'string' ? message.content : '');
        if (running) {
          // La duración real y el estado actual llegan con la primera consulta al servidor.
          controller.state = { ...controller.state, startedAt: null, elapsed: Number(data.elapsed_s) || 0 };
          controller.render();
          setTimeout(() => {
            controller.reactivate();
            controller.refreshStatus();
          }, 0);
        }
        return card;
      }
    };
  }

  // --- check_command: la espera a la vista ---------------------------------------------

  const WAIT_REASON_VIEWS = {
    pattern_matched: { className: 'status-success', icon: 'check', key: 'wait_status_matched' },
    command_finished: { className: 'status-success', icon: 'check', key: 'wait_status_finished' },
    wait_elapsed: { className: 'status-stopped', icon: 'clock', key: 'wait_status_elapsed' },
    wait_ended_by_user: { className: 'status-stopped', icon: 'stop', key: 'wait_status_ended' }
  };

  /** Resultado de check_command (texto JSON del servidor) como objeto, o null si no lo es. */
  function parseWaitResult(raw) {
    const text = typeof raw === 'string' ? raw : (typeof raw?.content === 'string' ? raw.content : null);
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      return data && typeof data === 'object' && typeof data.success === 'boolean' ? data : null;
    } catch (_) {
      return null;
    }
  }

  /** Lo que pide la llamada: a qué comando, cuánto tiempo y con qué patrón. */
  function waitRequest(args) {
    const jobId = Number.isInteger(args?.job_id) ? args.job_id : null;
    // El servidor acota la espera; aquí solo se muestra lo pedido.
    const seconds = Math.max(0, Math.floor(Number(args?.wait_seconds) || 0));
    const pattern = typeof args?.pattern === 'string' && args.pattern ? args.pattern : '';
    const stop = args?.stop === true && jobId !== null;
    return { jobId, seconds, pattern, stop, waits: !stop && (seconds > 0 || (jobId !== null && pattern !== '')) };
  }

  function waitTitle(request) {
    if (request.jobId === null) return t('wait_title_plain', { time: formatDuration(request.seconds) });
    if (request.stop) return t('wait_title_stop', { id: request.jobId });
    return t(request.waits ? 'wait_title_job' : 'wait_title_check', { id: request.jobId });
  }

  /** Insignia de la espera: en curso, por qué volvió o que falló. */
  function getWaitBadgeView(state) {
    if (!state.returned) {
      const elapsed = (Date.now() - state.startedAt) / 1000;
      return {
        className: 'status-loading',
        icon: 'spinner',
        text: t('wait_status_waiting', { time: formatDuration(elapsed), total: formatDuration(state.request.seconds) })
      };
    }
    const data = state.result;
    if (!data || data.success === false) {
      return { className: 'status-error', icon: 'x-circle', text: t('wait_status_failed') };
    }
    const time = formatDuration(Number.isFinite(data.waited_s) ? data.waited_s : state.elapsed);
    const view = WAIT_REASON_VIEWS[data.returned_because];
    if (view) return { className: view.className, icon: view.icon, text: t(view.key, { time }) };
    return { className: 'status-success', icon: 'check', text: t(state.request.stop ? 'wait_status_stopped' : 'wait_status_checked') };
  }

  /**
   * Controlador de la tarjeta de check_command: mientras espera cuenta el tiempo y, si espera a un
   * comando, muestra su salida nueva según llega; su botón corta la espera, no el comando.
   */
  class WaitCardController {
    constructor(card, args) {
      this.card = card;
      this.state = { request: waitRequest(args), startedAt: Date.now(), elapsed: 0, returned: false, result: null };
      this.clockTimer = null;
      this.logTimer = null;
      this.logNext = null;
      this.logText = '';
      controllers.set(card, this);
    }

    start() {
      this.render();
      if (!this.state.request.waits) return;
      // La tarjeta entra en el historial plegado de su grupo: mientras espera pasa a la zona visible.
      setTimeout(() => {
        if (!this.card.isConnected || this.state.returned) return;
        getToolCards().reactivateToolCard(this.card);
        const messagesList = this.card.closest('#messages-list');
        if (messagesList) getConversation().scrollToBottom(messagesList);
      }, 0);
      this.clockTimer = setInterval(() => {
        if (!this.card.isConnected) this.stopTimers();
        else this.render();
      }, 1000);
      if (this.state.request.jobId !== null) this.logTimer = setTimeout(() => this.pollLog(), FIRST_LOG_POLL_MS);
    }

    stopTimers() {
      if (this.clockTimer !== null) clearInterval(this.clockTimer);
      if (this.logTimer !== null) clearTimeout(this.logTimer);
      this.clockTimer = null;
      this.logTimer = null;
    }

    renderBadge() {
      replaceBadge(this.card, renderBadgeView(getWaitBadgeView(this.state), this.state.result?.matched_line || ''));
    }

    render() {
      this.renderBadge();
      const canEnd = !this.state.returned && this.state.request.waits && Boolean(this.card.dataset.invocationId);
      this.card.querySelector('[data-command-action="stop"]').hidden = !canEnd;
    }

    showText(text) {
      const logEl = this.card.querySelector('.command-card-log');
      logEl.querySelector('code').textContent = text || '';
      logEl.hidden = !text;
    }

    /** La salida nueva del comando que se espera: desde donde iba al empezar la espera. */
    async pollLog() {
      this.logTimer = null;
      if (this.state.returned || !this.card.isConnected) return;
      const mcp = getMcp();
      const ref = { id: this.state.request.jobId };
      if (!document.hidden) {
        try {
          if (this.logNext === null) {
            const details = await mcp.requestExternalControl('zerochat/jobs/get', ref);
            this.logNext = Number(details?.output_bytes) || 0;
          } else {
            const page = await mcp.requestExternalControl('zerochat/jobs/log', { ...ref, offset: this.logNext, limit: LOG_PAGE_BYTES });
            this.logNext = Number(page?.next) || this.logNext;
            if (page?.text) {
              this.logText = appendLog(this.logText, String(page.text));
              if (!this.state.returned) this.showText(this.logText);
            }
          }
        } catch (_) {
          // El comando ya no existe: queda lo que devuelva la herramienta.
        }
      }
      if (!this.state.returned) this.logTimer = setTimeout(() => this.pollLog(), LOG_POLL_MS);
    }

    /** Corta la espera: la herramienta vuelve enseguida con lo que haya. */
    async stop() {
      const key = this.card.dataset.invocationId;
      const button = this.card.querySelector('[data-command-action="stop"]');
      if (!key || this.state.returned) return;
      button.disabled = true;
      try {
        await getMcp().requestExternalControl('zerochat/jobs/end_wait', { key });
      } catch (error) {
        button.disabled = false;
        await getDialogs().alert(t('wait_end_error', { error: error?.message || String(error) }), { type: 'error' });
      }
    }

    applyResult(data, fallbackError = '') {
      this.stopTimers();
      this.state = { ...this.state, returned: true, result: data, elapsed: (Date.now() - this.state.startedAt) / 1000 };
      const output = data ? [data.new_output || '', data.error ? `\n${data.error}` : ''].join('').trim() : String(fallbackError || '');
      this.showText(output || this.logText);
      this.render();
    }
  }

  function createWaitView() {
    const build = (args, ui, collapsed) => {
      const request = waitRequest(args);
      const pattern = request.pattern ? ` <code class="command-card-command" title="${escapeHtml(request.pattern)}">${escapeHtml(request.pattern)}</code>` : '';
      return buildCardShell(ui, {
        collapsed,
        actionLabel: t('wait_action_end'),
        titleHtml: `${icon('clock', 14)}<span>${escapeHtml(waitTitle(request))}</span>${pattern}`
      });
    };
    return {
      createLiveCard: (args, ui) => {
        const card = build(args, ui, false);
        new WaitCardController(card, args).start();
        return card;
      },
      updateLiveCard: (card, args, result) => {
        const controller = controllers.get(card) || new WaitCardController(card, args);
        controller.applyResult(parseWaitResult(result), result.error || result.content || '');
        return false;
      },
      renderHistoricalCard: (args, message, ui) => {
        const card = build(args, ui, true);
        const controller = new WaitCardController(card, args);
        controller.applyResult(parseWaitResult(message?.content), typeof message?.content === 'string' ? message.content : '');
        return card;
      }
    };
  }

  /**
   * Nota en inglés para el modelo con los comandos en segundo plano de esta conversación que
   * han terminado sin que los haya visto terminar. Vacía si no hay ninguno.
   */
  async function buildCommandNotes(messages, requestReport) {
    const lastStatus = new Map();
    for (const message of messages) {
      if (message.role !== 'tool' || !COMMAND_TOOLS.has(message.name)) continue;
      const data = parseResult(message.content);
      if (data && Number.isInteger(data.job_id)) lastStatus.set(data.job_id, data.status);
    }
    const ids = [...lastStatus].filter(([, status]) => status === 'running').map(([id]) => id).slice(-100);
    if (!ids.length) return '';
    let reports = [];
    try {
      reports = (await requestReport(ids))?.reports || [];
    } catch (_) {
      return '';
    }
    if (!reports.length) return '';
    const lines = ['Background commands that finished since your last turn:'];
    for (const report of reports) {
      const duration = formatDuration(report.elapsed_s);
      const outcome = report.status === 'stopped'
        ? `was stopped by ${report.stop_reason === 'user' ? 'the user' : 'ZeroChat'} after ${duration}`
        : `exited with code ${report.exit_code} after ${duration}`;
      lines.push(`- job_id ${report.id} \`${String(report.command || '').split('\n')[0]}\` ${outcome}.`);
      if (report.tail) lines.push('  Last lines:', ...String(report.tail).split('\n').map(line => `    ${line}`));
    }
    lines.push('For more output, read the log file with read_file or search_files: ' + reports.map(report => `job_id ${report.id}: ${report.log_file}`).join('; ') + '.');
    return lines.join('\n');
  }

  return {
    createView,
    createWaitView,
    parseWaitResult,
    waitRequest,
    getWaitBadgeView,
    parseResult,
    formatDuration,
    buildCommandNotes,
    initialState,
    withDetails,
    withResult,
    jobRef,
    canStop,
    hasLeftRunning,
    getBadgeView,
    firstLogPage,
    appendLog,
    fallbackLog
  };
}));
