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

  function renderBadge(state) {
    const view = getBadgeView(state);
    const svg = view.icon === 'spinner'
      ? Icons.get('spinner', { size: 12, strokeWidth: 2.5, className: 'ui-icon-spin' })
      : icon(view.icon, 12);
    return `<span class="tool-card-badge ${view.className}">${svg} <span>${escapeHtml(view.text)}</span></span>`;
  }

  function buildCard(args, ui, { collapsed = false } = {}) {
    const command = typeof args?.command === 'string' ? args.command : '';
    const firstLine = command.split('\n')[0] + (command.includes('\n') ? ' …' : '');
    const card = ui.createCardWrapper('mcp-card command-card-wrapper');
    card.innerHTML = getToolCards().renderCardHtml({
      className: 'command-card',
      collapsed,
      titleHtml: `${icon('terminal', 14)}<code class="command-card-command" title="${escapeHtml(command)}">${escapeHtml(firstLine)}</code>`,
      badgeHtml: '<span class="tool-card-badge"></span>',
      bodyHtml: `<pre class="tool-card-code command-card-log" tabindex="0" hidden><code></code></pre>`
        + `<div class="command-card-actions">`
        + `<button type="button" class="btn-command-action btn-command-stop" data-command-action="stop" hidden>${icon('stop')}<span>${escapeHtml(t('command_action_stop'))}</span></button>`
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
          if (item.state.toolReturned && Number.isInteger(item.state.id) && !running.has(item.state.id)) item.refreshStatus();
        }
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
    constructor(card, state) {
      this.card = card;
      this.state = {
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
        reactivated: false,
        ...state
      };
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
      if (Number.isInteger(this.state.id)) return { id: this.state.id };
      const key = this.card.dataset.invocationId;
      return key ? { key } : null;
    }

    isFinal() {
      return FINAL_STATUSES.has(this.state.status);
    }

    isExpanded() {
      return !this.card.querySelector('.tool-execution-card').classList.contains('collapsed');
    }

    renderBadge() {
      this.card.querySelector('.tool-card-badge').outerHTML = renderBadge(this.state);
    }

    render() {
      const { state, card } = this;
      if (Number.isInteger(state.id)) card.dataset.jobId = String(state.id);
      this.renderBadge();
      card.querySelector('[data-command-action="stop"]').hidden = state.status !== 'running' || !this.ref();
    }

    applyDetails(details) {
      if (!details || typeof details !== 'object') return;
      const { state } = this;
      state.confirmed = true;
      if (Number.isInteger(details.id)) state.id = details.id;
      if (typeof details.status === 'string') state.status = details.status;
      if (details.exit_code !== undefined) state.exitCode = details.exit_code;
      if (Number.isFinite(details.started_at)) state.startedAt = details.started_at;
      if (Number.isFinite(details.elapsed_s)) state.elapsed = details.elapsed_s;
    }

    /** Aplica el resultado de la herramienta: final, o el comando sigue en segundo plano. */
    applyResult(data, fallbackError = '') {
      const { state } = this;
      state.toolReturned = true;
      state.confirmed = true;
      if (!data) {
        state.status = 'error';
        state.output = fallbackError;
        untrack(this);
        this.render();
        this.showText(state.output);
        return;
      }
      if (Number.isInteger(data.job_id)) state.id = data.job_id;
      state.status = data.status;
      state.exitCode = data.exit_code ?? null;
      if (Number.isFinite(data.duration_s)) state.elapsed = data.duration_s;
      if (Number.isFinite(data.elapsed_s)) state.startedAt = Date.now() - data.elapsed_s * 1000;
      state.output = [data.output ?? data.new_output ?? '', data.error ? `\n${data.error}` : ''].join('').trim();
      if (state.status === 'running') {
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

    /** Sin log en el servidor queda la salida guardada en el chat, la misma que vio el modelo. */
    showFallback() {
      if (this.state.toolReturned) this.showText(this.state.output || t('command_log_unavailable'));
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
        let prefix = '';
        let text = initial ? '' : logEl.querySelector('code').textContent;
        if (initial) {
          const details = await mcp.requestExternalControl('zerochat/jobs/get', ref);
          this.applyDetails(details);
          this.log.next = Math.max(0, (Number(details?.output_bytes) || 0) - LOG_PAGE_BYTES);
          if (this.log.next > 0) prefix = `${t('command_log_earlier', { size: formatBytes(this.log.next) })}\n`;
        }
        const atBottom = logEl.hidden || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
        const page = await mcp.requestExternalControl('zerochat/jobs/log', { ...ref, offset: this.log.next, limit: LOG_PAGE_BYTES });
        this.state.confirmed = true;
        this.log.next = Number(page?.next) || this.log.next;
        this.log.loaded = true;
        text += prefix + String(page?.text || '');
        if (text.length > MAX_LOG_CHARS) text = text.slice(text.length - MAX_LOG_CHARS);
        this.showText(text);
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
        const controller = new CommandCardController(card, {});
        controller.render();
        track(controller);
        // La primera consulta llega antes para que el reloj y el log arranquen enseguida.
        controller.logTimer = setTimeout(() => controller.pollLog(), FIRST_LOG_POLL_MS);
        return card;
      },
      updateLiveCard: (card, args, result) => {
        const controller = controllers.get(card) || new CommandCardController(card, {});
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
        const controller = new CommandCardController(card, {});
        controller.applyResult(data, typeof message?.content === 'string' ? message.content : '');
        if (running) {
          // La duración real y el estado actual llegan con la primera consulta al servidor.
          controller.state.startedAt = null;
          controller.state.elapsed = Number(data.elapsed_s) || 0;
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

  return {
    createView,
    parseResult,
    formatDuration
  };
}));
