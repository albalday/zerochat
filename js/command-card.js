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
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatCommandCard = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;

  // Solo una tarjeta desplegada pide su log, y con este intervalo.
  const LOG_POLL_MS = 2000;
  const FIRST_LOG_POLL_MS = 700;
  const LOG_PAGE_BYTES = 256 * 1024;
  const MAX_LOG_CHARS = 512 * 1024;
  const FINAL_STATUSES = new Set(['exited', 'timeout', 'stopped']);

  const controllers = new WeakMap();

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const getDialogs = () => resolveDep('ChatDialogs', null);
  const getMcp = () => resolveDep('ChatMCP', null)?.manager || null;
  const getState = () => resolveDep('ChatState', './state.js');
  const t = (key, params) => getI18n()?.t?.(key, params) || key;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, size = 13) => getIcons()?.get?.(name, { size }) || '';

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

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function isFailure(state) {
    return state.status === 'timeout' || state.status === 'error' || (state.status === 'exited' && state.exitCode !== 0);
  }

  /** Estado visible de la insignia según el estado del comando. */
  function getBadgeView(state, now = Date.now()) {
    const elapsed = state.status === 'running' && state.startedAt
      ? (now - state.startedAt) / 1000
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
      ? (getIcons()?.get?.('spinner', { size: 12, strokeWidth: 2.5, className: 'ui-icon-spin' }) || '')
      : icon(view.icon, 12);
    return `<span class="tool-card-badge ${view.className}">${svg} <span>${escapeHtml(view.text)}</span></span>`;
  }

  function buildCard(args, ui, { collapsed = false } = {}) {
    if (typeof document === 'undefined') return null;
    const command = typeof args?.command === 'string' ? args.command : '';
    const firstLine = command.split('\n')[0] + (command.includes('\n') ? ' …' : '');
    const ToolCards = getToolCards();
    const card = ui?.createCardWrapper ? ui.createCardWrapper('mcp-card command-card-wrapper') : document.createElement('div');
    card.className = 'tool-card-wrapper mcp-card command-card-wrapper';
    card.innerHTML = ToolCards.renderCardHtml({
      className: 'command-card',
      collapsed,
      titleHtml: `${icon('terminal', 14)}<code class="command-card-command" title="${escapeHtml(command)}">${escapeHtml(firstLine)}</code>`,
      badgeHtml: '<span class="tool-card-badge"></span>',
      bodyHtml: `<pre class="tool-card-code command-card-log" tabindex="0" hidden><code></code></pre>`
        + `<div class="command-card-actions">`
        + `<button type="button" class="btn-command-action btn-command-stop" data-command-action="stop" hidden>${icon('stop')}<span>${escapeHtml(t('command_action_stop'))}</span></button>`
        + `</div>`
    }, ui || {});
    card.addEventListener('click', event => {
      const button = event.target.closest?.('[data-command-action="stop"]');
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
    if (clockTimer === null && typeof setInterval === 'function') {
      clockTimer = setInterval(() => {
        for (const item of tracked) {
          if (!item.card.isConnected) untrack(item);
          else if (item.state.confirmed) item.renderBadge();
        }
      }, 1000);
    }
    const State = getState();
    if (!jobsSubscribed && State?.subscribe) {
      jobsSubscribed = true;
      // Un comando que deja de figurar entre los que siguen en marcha ha terminado: su tarjeta
      // pregunta una vez cómo acabó.
      State.subscribe(state => ({ ids: JSON.stringify((state.mcp?.commandJobs || []).map(job => job.id)) }), ({ ids }) => {
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
      const inner = card.querySelector('.tool-execution-card');
      if (inner && typeof MutationObserver !== 'undefined') {
        new MutationObserver(() => {
          if (!this.isExpanded()) {
            this.stopLogPolling();
            return;
          }
          if (!this.log.loaded) this.loadLog();
          this.scheduleLog();
        }).observe(inner, { attributes: true, attributeFilter: ['class'] });
      }
    }

    ref() {
      if (Number.isInteger(this.state.id)) return { id: this.state.id };
      const key = this.card.dataset.invocationId;
      return key ? { key } : null;
    }

    isFinal() {
      return FINAL_STATUSES.has(this.state.status) || this.state.status === 'error' || this.state.status === 'unavailable';
    }

    isExpanded() {
      const inner = this.card.querySelector('.tool-execution-card');
      return Boolean(inner) && !inner.classList.contains('collapsed');
    }

    renderBadge() {
      const badge = this.card.querySelector('.tool-card-badge');
      if (badge) badge.outerHTML = renderBadge(this.state);
    }

    render() {
      const { state, card } = this;
      if (Number.isInteger(state.id)) card.dataset.jobId = String(state.id);
      this.renderBadge();
      const stopButton = card.querySelector('[data-command-action="stop"]');
      if (stopButton) stopButton.hidden = state.status !== 'running' || !this.ref();
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
        getMcp()?.refreshCommandJobs?.();
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
      if (typeof document === 'undefined' || !document.hidden) {
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
      const mcp = getMcp();
      if (!ref || !mcp?.requestExternalControl) return;
      try {
        this.applyDetails(await mcp.requestExternalControl('zerochat/jobs/get', ref));
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
      this.card.querySelector('.tool-execution-card')?.classList.remove('collapsed');
      getToolCards()?.reactivateToolCard?.(this.card);
    }

    finish() {
      if (this.state.toolReturned) getMcp()?.refreshCommandJobs?.();
      if (this.state.reactivated) {
        this.state.reactivated = false;
        getToolCards()?.completeToolCard?.(this.card, { success: !isFailure(this.state) });
      }
    }

    async stop() {
      const ref = this.ref();
      const mcp = getMcp();
      const button = this.card.querySelector('[data-command-action="stop"]');
      if (!ref || !mcp?.requestExternalControl) return;
      if (button) button.disabled = true;
      try {
        this.applyDetails(await mcp.requestExternalControl('zerochat/jobs/stop', ref));
        if (this.isExpanded()) await this.loadLog();
        this.render();
        if (this.isFinal() && this.state.toolReturned) {
          untrack(this);
          this.finish();
        } else {
          getMcp()?.refreshCommandJobs?.();
        }
      } catch (error) {
        await getDialogs()?.alert?.(t('command_stop_error', { error: error?.message || String(error) }), { type: 'error' });
      } finally {
        if (button) button.disabled = false;
      }
    }

    showText(text) {
      const logEl = this.card.querySelector('.command-card-log');
      if (!logEl) return;
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
      if (!logEl) return false;
      if (!ref || !mcp?.requestExternalControl) {
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
      displayMode: 'collapsed',
      createLiveCard: (args, ui) => {
        const card = buildCard(args, ui);
        if (!card) return null;
        const controller = new CommandCardController(card, {});
        controller.render();
        track(controller);
        // La primera consulta llega antes para que el reloj y el log arranquen enseguida.
        controller.logTimer = setTimeout(() => controller.pollLog(), FIRST_LOG_POLL_MS);
        return card;
      },
      updateLiveCard: (card, args, result = {}, _elapsedMs = 0) => {
        const controller = controllers.get(card) || new CommandCardController(card, {});
        controller.applyResult(parseResult(result), result?.error || result?.content || '');
        // La tarjeta de un comando que sigue en marcha permanece abierta y a la vista, también
        // después de que el turno la archive con el resto de herramientas terminadas.
        if (controller.state.status === 'running') {
          result.keepExpanded = true;
          setTimeout(() => controller.reactivate(), 0);
        }
      },
      renderHistoricalCard: (args, message, ui) => {
        const data = parseResult(message?.content);
        const running = data?.status === 'running';
        const card = buildCard(args, ui, { collapsed: true });
        if (!card) return null;
        const controller = new CommandCardController(card, { startedAt: null });
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
    formatDuration,
    getBadgeView
  };
}));
