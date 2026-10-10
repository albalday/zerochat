/**
 * Tarjeta de run_command: sigue al comando mientras su proceso vive en el servidor local y
 * muestra su estado, su salida reciente, el log completo y un botón para detenerlo.
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

  const POLL_MS = 1000;
  const TAIL_LINES = 4;
  const LOG_PAGE_BYTES = 256 * 1024;
  const MAX_LOG_CHARS = 512 * 1024;
  const FINAL_STATUSES = new Set(['exited', 'timeout', 'stopped']);

  const controllers = new WeakMap();

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');
  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const getDialogs = () => resolveDep('ChatDialogs', null);
  const getMcp = () => resolveDep('ChatMCP', null)?.manager || null;
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

  function lastLines(text, count = TAIL_LINES) {
    const lines = String(text || '').replace(/\n$/, '').split('\n');
    return lines.slice(-count).join('\n');
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
      bodyHtml: `<pre class="tool-card-code command-card-output" hidden><code></code></pre>`
        + `<pre class="tool-card-code command-card-log" tabindex="0" hidden><code></code></pre>`
        + `<div class="command-card-actions">`
        + `<button type="button" class="btn-command-action" data-command-action="log" aria-expanded="false" hidden>${icon('file-text')}<span>${escapeHtml(t('command_action_log'))}</span></button>`
        + `<button type="button" class="btn-command-action btn-command-stop" data-command-action="stop" hidden>${icon('stop')}<span>${escapeHtml(t('command_action_stop'))}</span></button>`
        + `</div>`
    }, ui || {});
    card.addEventListener('click', event => {
      const button = event.target.closest?.('[data-command-action]');
      if (!button || !card.contains(button)) return;
      event.stopPropagation();
      const controller = controllers.get(card);
      if (!controller) return;
      if (button.dataset.commandAction === 'stop') controller.stop();
      else controller.toggleLog();
    });
    return card;
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
        output: '',
        tail: '',
        logOpen: false,
        logNext: 0,
        reactivated: false,
        ...state
      };
      this.timer = null;
      this.polling = false;
      controllers.set(card, this);
    }

    ref() {
      if (Number.isInteger(this.state.id)) return { id: this.state.id };
      const key = this.card.dataset.invocationId;
      return key ? { key } : null;
    }

    isFinal() {
      return FINAL_STATUSES.has(this.state.status) || this.state.status === 'error' || this.state.status === 'unavailable';
    }

    render() {
      const { state, card } = this;
      if (Number.isInteger(state.id)) card.dataset.jobId = String(state.id);
      const badge = card.querySelector('.tool-card-badge');
      if (badge) badge.outerHTML = renderBadge(state);
      const output = card.querySelector('.command-card-output');
      const text = state.status === 'running' ? state.tail : (state.output || state.tail);
      if (output) {
        output.hidden = !text || state.logOpen;
        output.querySelector('code').textContent = state.status === 'running' ? lastLines(text) : text;
      }
      const logButton = card.querySelector('[data-command-action="log"]');
      if (logButton) {
        logButton.hidden = !this.ref() || state.status === 'error' || state.status === 'unavailable';
        logButton.setAttribute('aria-expanded', String(state.logOpen));
        logButton.querySelector('span').textContent = t(state.logOpen ? 'command_action_hide_log' : 'command_action_log');
      }
      const stopButton = card.querySelector('[data-command-action="stop"]');
      if (stopButton) stopButton.hidden = state.status !== 'running' || !this.ref();
    }

    applyDetails(details) {
      if (!details || typeof details !== 'object') return;
      const { state } = this;
      if (Number.isInteger(details.id)) state.id = details.id;
      if (typeof details.status === 'string') state.status = details.status;
      if (details.exit_code !== undefined) state.exitCode = details.exit_code;
      if (Number.isFinite(details.started_at)) state.startedAt = details.started_at;
      if (Number.isFinite(details.elapsed_s)) state.elapsed = details.elapsed_s;
      if (typeof details.tail === 'string') state.tail = details.tail;
      if (Number.isFinite(details.output_bytes)) state.outputBytes = details.output_bytes;
    }

    /** Aplica el resultado de la herramienta: final, o el comando sigue en segundo plano. */
    applyResult(data, fallbackError = '') {
      const { state } = this;
      state.toolReturned = true;
      if (!data) {
        state.status = 'error';
        state.output = fallbackError;
        this.stopPolling();
        this.render();
        return;
      }
      if (Number.isInteger(data.job_id)) state.id = data.job_id;
      state.status = data.status;
      state.exitCode = data.exit_code ?? null;
      if (Number.isFinite(data.duration_s)) state.elapsed = data.duration_s;
      if (Number.isFinite(data.elapsed_s)) state.startedAt = Date.now() - data.elapsed_s * 1000;
      state.output = [data.output ?? data.new_output ?? '', data.error ? `\n${data.error}` : ''].join('').trim();
      if (state.status === 'running') {
        state.tail = data.output || '';
        this.ensurePolling();
        // La franja de comandos en marcha lo muestra sin esperar al siguiente latido.
        getMcp()?.refreshCommandJobs?.();
      } else {
        this.stopPolling();
      }
      this.render();
    }

    ensurePolling() {
      if (this.timer === null && !this.isFinal()) this.timer = setTimeout(() => this.tick(), POLL_MS);
    }

    stopPolling() {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
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

    async tick() {
      this.timer = null;
      if (!this.card.isConnected) return;
      if (typeof document !== 'undefined' && document.hidden) {
        this.ensurePolling();
        return;
      }
      const ref = this.ref();
      const mcp = getMcp();
      if (!ref || !mcp?.requestExternalControl) {
        if (this.state.toolReturned) {
          this.state.status = 'unavailable';
          this.render();
        } else {
          this.ensurePolling();
        }
        return;
      }
      this.reactivate();
      try {
        this.applyDetails(await mcp.requestExternalControl('zerochat/jobs/get', ref));
      } catch (_) {
        if (this.state.toolReturned) {
          this.state.status = 'unavailable';
          this.finish();
          this.render();
          return;
        }
        // Antes de que el servidor registre el comando (por ejemplo, mientras se pide permiso al
        // usuario) la consulta falla: se reintenta sin tocar la tarjeta.
        this.ensurePolling();
        return;
      }
      if (this.state.logOpen) await this.loadLog(false);
      this.render();
      if (this.isFinal()) this.finish();
      else this.ensurePolling();
    }

    async stop() {
      const ref = this.ref();
      const mcp = getMcp();
      const button = this.card.querySelector('[data-command-action="stop"]');
      if (!ref || !mcp?.requestExternalControl) return;
      if (button) button.disabled = true;
      try {
        this.applyDetails(await mcp.requestExternalControl('zerochat/jobs/stop', ref));
        if (this.state.logOpen) await this.loadLog(false);
        this.render();
        if (this.isFinal() && this.state.toolReturned) {
          this.stopPolling();
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

    async toggleLog() {
      this.state.logOpen = !this.state.logOpen;
      const logEl = this.card.querySelector('.command-card-log');
      if (logEl) logEl.hidden = !this.state.logOpen;
      this.render();
      if (this.state.logOpen) await this.loadLog(true);
    }

    /** Carga el final del log al abrirlo y, después, solo lo nuevo. */
    async loadLog(initial) {
      const ref = this.ref();
      const mcp = getMcp();
      const code = this.card.querySelector('.command-card-log code');
      const logEl = this.card.querySelector('.command-card-log');
      if (!code || !logEl) return;
      if (!ref || !mcp?.requestExternalControl) {
        code.textContent = t('command_log_unavailable');
        return;
      }
      try {
        let prefix = '';
        if (initial) {
          const details = await mcp.requestExternalControl('zerochat/jobs/get', ref);
          this.applyDetails(details);
          const total = Number(details?.output_bytes) || 0;
          this.state.logNext = Math.max(0, total - LOG_PAGE_BYTES);
          if (this.state.logNext > 0) prefix = `${t('command_log_earlier', { size: formatBytes(this.state.logNext) })}\n`;
          code.textContent = '';
        }
        const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
        const page = await mcp.requestExternalControl('zerochat/jobs/log', { ...ref, offset: this.state.logNext, limit: LOG_PAGE_BYTES });
        this.state.logNext = Number(page?.next) || this.state.logNext;
        let text = code.textContent + prefix + String(page?.text || '');
        if (text.length > MAX_LOG_CHARS) text = text.slice(text.length - MAX_LOG_CHARS);
        code.textContent = text;
        if (initial || atBottom) logEl.scrollTop = logEl.scrollHeight;
      } catch (_) {
        code.textContent = t('command_log_unavailable');
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
        controller.ensurePolling();
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
        const card = buildCard(args, ui, { collapsed: !running });
        if (!card) return null;
        const controller = new CommandCardController(card, { startedAt: null });
        controller.applyResult(data, typeof message?.content === 'string' ? message.content : '');
        if (running) {
          // La duración real llega con la primera consulta al servidor.
          controller.state.startedAt = null;
          controller.state.elapsed = Number(data.elapsed_s) || 0;
          controller.render();
          setTimeout(() => controller.reactivate(), 0);
        }
        return card;
      }
    };
  }

  return {
    createView,
    parseResult,
    formatDuration,
    getBadgeView,
    lastLines
  };
}));
