/** Renderer genérico: cada tool declara su propia vista con iconos vectoriales SVG. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatToolCards = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const safeEscapeHtml = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getMarkdown = () => (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
  const t = (key, params) => (typeof window !== 'undefined' && window.ChatI18n?.t) ? window.ChatI18n.t(key, params) : key;
  const normalizeName = name => String(name || '').trim().toLowerCase().replace(/_/g, '');
  const Icons = (typeof window !== 'undefined' && window.ChatIcons) || require('./icons.js');
  const getView = name => (typeof window !== 'undefined' && window.ChatAgentCore?.registry?.getTool) ? window.ChatAgentCore.registry.getTool(name)?.view : null;

  const SPINNER_SVG = Icons.get('spinner', { size: 12, strokeWidth: 2.5, className: 'ui-icon-spin' });
  const CHECK_SVG = Icons.get('check', { size: 12, strokeWidth: 2.5 });
  const ERROR_SVG = Icons.get('x-circle', { size: 12, strokeWidth: 2.5 });
  const CHEVRON_SVG = Icons.get('chevron-down', { size: 12 });
  const SHIELD_SVG = Icons.get('shield', { size: 12 });
  const CLOCK_SVG = Icons.get('clock', { size: 12 });
  const SERVER_SVG = Icons.get('server', { size: 12 });
  const DEFAULT_TOOL_ICON = Icons.get('settings', { size: 14 });

  const TOOL_CALLS_SVG = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m14 6 4 4-8 8-4-4z"></path><path d="m5 19-2 2"></path><path d="m17 7 2-2"></path></svg>';

  function getToolCallGroup(container) {
    const lastChild = container?.lastElementChild;
    return lastChild?.classList?.contains('tool-call-group') ? lastChild : null;
  }

  function updateToolCallGroup(group) {
    if (!group) return;
    const cards = Array.from(group.querySelectorAll('.tool-card-wrapper'));
    const running = cards.filter(card => card.dataset.toolCallStatus === 'running');
    const failed = cards.filter(card => card.dataset.toolCallStatus === 'error').length;
    const count = cards.length;
    const label = group.querySelector('.tool-call-group-label');
    const status = group.querySelector('.tool-call-group-status');
    const isRunning = running.length > 0;
    group.classList.toggle('is-running', isRunning);
    group.classList.toggle('has-error', !isRunning && failed > 0);
    if (label) label.textContent = t('tool_calls_group_title') || 'Tool calls';
    if (status) status.textContent = isRunning
      ? (t('tool_calls_group_running', { count }) || `${count} tool call${count === 1 ? '' : 's'} running`)
      : (t('tool_calls_group_complete', { count, failed }) || `${count} tool call${count === 1 ? '' : 's'} completed`);
  }

  function createToolCallGroup(container) {
    const doc = container?.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || !container) return null;
    const group = doc.createElement('div');
    group.className = 'tool-call-group is-running';
    group.innerHTML = `<details class="tool-call-group-history"><summary class="tool-call-group-summary">${TOOL_CALLS_SVG}<span class="tool-call-group-label"></span><span class="tool-call-group-status"></span></summary><div class="tool-call-group-cards"></div></details><div class="tool-call-group-active-cards"></div>`;
    container.appendChild(group);
    return group;
  }

  function appendToolCard(container, card, options = {}) {
    if (!container || !card) return null;
    // Las visualizaciones y las preguntas al usuario son resultado principal, no ruido de ejecución.
    if (card.querySelector?.('.chat-chart-card, .ask-user-card')) {
      container.appendChild(card);
      return null;
    }
    // Cada paso del runtime crea un bloque de asistente antes de saber si emitirá
    // texto. Si queda vacío, no representa una respuesta y no debe cortar el grupo.
    const trailingAssistantBlock = container.lastElementChild;
    if (trailingAssistantBlock?.classList?.contains('agentic-turn-block')
      && !trailingAssistantBlock.textContent.trim()) {
      trailingAssistantBlock.remove();
    }
    const group = getToolCallGroup(container) || createToolCallGroup(container);
    const cards = group?.querySelector(options.completed ? '.tool-call-group-cards' : '.tool-call-group-active-cards');
    if (!cards) {
      container.appendChild(card);
      return null;
    }
    card.dataset.toolCallStatus = options.completed ? (options.success === false ? 'error' : 'success') : 'running';
    cards.appendChild(card);
    updateToolCallGroup(group);
    return group;
  }

  function completeToolCard(card, result = {}) {
    if (!card) return;
    card.dataset.toolCallStatus = result?.success === false || result?.error ? 'error' : 'success';
    const group = card.closest?.('.tool-call-group');
    const completedCards = group?.querySelector('.tool-call-group-cards');
    if (completedCards) completedCards.appendChild(card);
    updateToolCallGroup(group);
  }

  function createCardWrapper(ui, extraClass = '') {
    if (ui?.createCardWrapper) return ui.createCardWrapper(extraClass);
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = extraClass ? `tool-card-wrapper ${extraClass}` : 'tool-card-wrapper';
    return cardDiv;
  }

  // HTML slots are internal markup: callers must escape external text before passing it.
  function renderCardHtml({ titleHtml = '', badgeHtml = '', bodyHtml = '', className = '', collapsed = false, collapsible = true, buttonTitle = '', titleSuffixHtml = '' } = {}, ui = {}) {
    const translate = ui.t || t;
    const classes = ['tool-execution-card', ...String(className).split(/\s+/).filter(c => c && c !== 'tool-execution-card' && c !== 'collapsed')];
    if (collapsed) classes.push('collapsed');
    const label = buttonTitle || translate(collapsed ? 'tool_btn_expand' : 'tool_btn_collapse');
    return `<div class="${safeEscapeHtml(classes.join(' '))}"><div class="tool-card-header"><div class="tool-card-title">${titleHtml}</div>${titleSuffixHtml}<div class="tool-card-header-actions">${badgeHtml}${collapsible ? `<button type="button" class="btn-tool-collapse" title="${safeEscapeHtml(label)}">${ui.CHEVRON_SVG || CHEVRON_SVG}</button>` : ''}</div></div><div class="tool-card-collapsible-body">${bodyHtml}</div></div>`;
  }

  const context = () => ({
    document: typeof document === 'undefined' ? null : document,
    markdown: getMarkdown(),
    charts: typeof window !== 'undefined' ? window.ChatCharts : null,
    icons: typeof window !== 'undefined' ? window.ChatIcons : null,
    t,
    createCardWrapper: (extraClass) => createCardWrapper({ document: typeof document === 'undefined' ? null : document }, extraClass),
    SPINNER_SVG,
    CHECK_SVG,
    ERROR_SVG,
    CHEVRON_SVG
  });

  const resolveToolDisplayMode = name => {
    const view = getView(name);
    if (view?.displayMode) return view.displayMode;
    if (typeof window !== 'undefined' && window.ChatAgentCore?.registry?.getTool) {
      const tool = window.ChatAgentCore.registry.getTool(name);
      return tool?.displayMode || tool?.view?.displayMode || null;
    }
    return null;
  };

  function keepAuthorizationVisible(element, overlayElement = null) {
    if (!element || typeof document === 'undefined') return;
    const reveal = () => {
      if (!element.isConnected) return;
      const messagesList = element.closest?.('#messages-list') || document.getElementById('messages-list');
      if (!messagesList) {
        element.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const elementRect = element.getBoundingClientRect();
      const overlayRect = overlayElement?.isConnected ? overlayElement.getBoundingClientRect() : null;
      const listRect = messagesList.getBoundingClientRect();
      const bottom = Math.max(elementRect.bottom, overlayRect?.bottom || -Infinity);
      const overflow = bottom - listRect.bottom + 16;
      if (overflow <= 0) return;
      const targetTop = Math.min(
        messagesList.scrollHeight - messagesList.clientHeight,
        messagesList.scrollTop + overflow
      );
      const reducedMotion = typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      messagesList.scrollTo?.({ top: targetTop, behavior: reducedMotion ? 'auto' : 'smooth' });
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(reveal));
    } else {
      setTimeout(reveal, 0);
    }
  }

  function collapseCard(card) {
    if (!card) return;
    const cardEl = card.querySelector?.('.tool-execution-card, .chat-chart-card')
      || (card.matches?.('.tool-execution-card, .chat-chart-card') ? card : null);
    if (cardEl) {
      cardEl.classList.add('collapsed');
      const btn = cardEl.querySelector('.btn-tool-collapse');
      if (btn) btn.title = t('tool_btn_expand') || 'Expandir herramienta';
    }
  }

  function fallback(name, args, isCollapsed = false) {
    if (typeof document === 'undefined') return null;
    const card = document.createElement('div'); card.className = 'tool-card-wrapper';
    const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;
    const tool = (typeof window !== 'undefined' && window.ChatAgentCore?.registry?.getTool) ? window.ChatAgentCore.registry.getTool(name) : null;
    const icon = (typeof window !== 'undefined' && window.ChatIcons?.has(name))
      ? window.ChatIcons.get(name, { size: 14 })
      : (tool?.metadata?.iconSvg || DEFAULT_TOOL_ICON);
    const badgeClass = isCollapsed ? 'tool-card-badge status-success' : 'tool-card-badge status-loading';
    const badgeContent = isCollapsed
      ? `${CHECK_SVG} <span>${t('tool_status_success') || 'Completado'}</span>`
      : `${SPINNER_SVG} <span>${t('tool_badge_executing') || 'Ejecutando...'}</span>`;
    card.innerHTML = renderCardHtml({
      collapsed: isCollapsed,
      titleHtml: `<span>${icon}</span><span>${getMarkdown().escapeHtml(name)}</span>`,
      badgeHtml: `<span class="${badgeClass}">${badgeContent}</span>`,
      bodyHtml: hasArgs ? `<div class="tool-card-result"><pre class="tool-card-code"><code>${getMarkdown().escapeHtml(JSON.stringify(args, null, 2))}</code></pre></div>` : ''
    });
    return card;
  }

  function createLiveToolCard(name, args = {}) { if (typeof document === 'undefined') return null; const view = getView(name); return view?.createLiveCard ? view.createLiveCard(args, context()) : fallback(name, args, false); }
  function updateLiveToolCard(card, name, args = {}, result = {}, elapsedMs = 0, options = {}) {
    const view = getView(name);
    if (view?.updateLiveCard) {
      view.updateLiveCard(card, args, result, elapsedMs, context());
    } else {
      const badge = card?.querySelector('.tool-card-badge');
      if (badge) {
        const isSuccess = result?.success !== false && !result?.error;
        badge.className = `tool-card-badge ${isSuccess ? 'status-success' : 'status-error'}`;
        badge.innerHTML = isSuccess
          ? `${CHECK_SVG} <span>${t('tool_status_success') || 'Completado'} (${elapsedMs}ms)</span>`
          : `${ERROR_SVG} <span>${t('tool_status_error', { ms: elapsedMs }) || `Error (${elapsedMs}ms)`}</span>`;
      }
    }
    const displayMode = options?.displayMode
      || result?.displayMode
      || result?.outcome?.meta?.displayMode
      || view?.displayMode
      || resolveToolDisplayMode(name)
      || 'collapsed';

    if (displayMode === 'collapsed' && !result?.keepExpanded) {
      collapseCard(card);
    }
  }
  function renderHistoricalToolCard(call, message) {
    if (!call?.function || typeof document === 'undefined') return null;
    let args = {};
    try {
      args = typeof call.function.arguments === 'object' ? call.function.arguments : JSON.parse(call.function.arguments || '{}');
    } catch (e) {
      args = { input: call.function.arguments || '' };
    }
    const toolName = call.function.name;
    const view = getView(toolName);
    const displayMode = view?.displayMode || resolveToolDisplayMode(toolName) || 'collapsed';
    const card = view?.renderHistoricalCard
      ? view.renderHistoricalCard(args, message, context())
      : fallback(toolName, args, displayMode === 'collapsed');
    const keepExpanded = Array.isArray(message?.images) && message.images.some(image => image?.action === 'screenshot');
    if (displayMode === 'collapsed' && !keepExpanded) {
      collapseCard(card);
    }
    return card;
  }

  /**
   * Muestra la petición interactiva de autorización en la tarjeta de la herramienta y espera la decisión del usuario.
   *
   * @param {HTMLElement} card - Elemento DOM de la tarjeta en vivo.
   * @param {object} toolCall - Objeto de llamada de herramienta.
   * @param {object} [options={}] - Opciones adicionales (serverName, args, signal).
   * @returns {Promise<'allow_once'|'allow_always'|'deny'>}
   */
  function promptToolAuthorization(card, toolCall, options = {}) {
    if (!card || typeof document === 'undefined') {
      return Promise.resolve('deny');
    }
    const tFn = (key, params) => t(key, params);
    const esc = getMarkdown().escapeHtml;
    const toolName = toolCall?.function?.name || options.toolName || 'tool';
    const serverName = options.serverName || '';
    const serverId = options.serverId || '';
    const signal = options.signal;

    // Asegurar que la tarjeta esté expandida para que el usuario visualice la petición
    const cardEl = card.querySelector?.('.tool-execution-card, .mcp-card, .tool-card-wrapper') || card;
    const toolGroup = card.closest?.('.tool-call-group');
    if (cardEl && cardEl.classList) {
      cardEl.classList.remove('collapsed');
      cardEl.classList.add('tool-card-auth-active');
    }
    toolGroup?.classList?.add('tool-call-group-auth-active');

    // Actualizar badge a pendiente de autorización
    const badge = card.querySelector?.('.tool-card-badge');
    if (badge) {
      badge.className = 'tool-card-badge status-pending-auth';
      badge.innerHTML = `${SHIELD_SVG} <span>${tFn('tool_auth_badge') || 'Requiere Autorización'}</span>`;
    }

    // Crear o insertar el bloque de autorización dentro del cuerpo de la tarjeta
    const bodyEl = card.querySelector?.('.tool-card-collapsible-body') || cardEl;
    let authPromptEl = card.querySelector?.('.tool-card-auth-prompt');
    if (!authPromptEl) {
      authPromptEl = document.createElement('div');
      authPromptEl.className = 'tool-card-auth-prompt';
      if (bodyEl) {
        bodyEl.prepend(authPromptEl);
      } else {
        card.appendChild(authPromptEl);
      }
    }

    const parsedArgs = options.args || {};
    const cmdArg = parsedArgs.command || parsedArgs.cmd || parsedArgs.script;
    const pathArg = parsedArgs.path || parsedArgs.filepath || parsedArgs.file;
    const requestedDirectoryAccess = options.directoryAccess || '';
    const requestedDirectoryPath = options.directoryPath || '';
    const isWritePathTool = /(?:^|_)edit_file$/.test(toolName);
    const isDirectoryTool = /(?:^|_)list_directory$/.test(toolName);

    const ToolSecurity = typeof window !== 'undefined' ? window.ChatToolSecurity : null;
    let contextualButtonsHtml = '';
    let baseCmd = '';
    if (typeof cmdArg === 'string' && cmdArg.trim()) {
      // Con "cd <dir> && git status" se ofrece autorizar git, no cd.
      baseCmd = ToolSecurity?.getCommandBaseName
        ? ToolSecurity.getCommandBaseName(cmdArg)
        : cmdArg.trim().split(/\s+/)[0];
      if (baseCmd && !requestedDirectoryAccess) {
        contextualButtonsHtml = `
          <button type="button" class="btn-auth-action btn-auth-allow-cmd" title="${esc(tFn('tool_auth_allow_cmd_title', { cmd: baseCmd }))}">${SHIELD_SVG} <span>${esc(tFn('tool_auth_allow_cmd_btn', { cmd: baseCmd + ' *' }))}</span></button>
        `;
      }
      if (requestedDirectoryAccess && requestedDirectoryPath) {
        contextualButtonsHtml = `
          <button type="button" class="btn-auth-action btn-auth-allow-path" title="${esc(tFn('tool_auth_allow_path_title'))}">${SHIELD_SVG} <span>${esc(tFn('tool_auth_allow_path_btn', { access: requestedDirectoryAccess }))}</span></button>
        `;
      }
    } else if (typeof pathArg === 'string' && pathArg.trim() &&
      ToolSecurity?.canBuildDirectoryRule?.(pathArg) !== false) {
      // Sin botón para ~, variables o ".." fuera de la raíz: la regla resultante sería inválida.
      const access = isWritePathTool ? 'W' : 'R';
      contextualButtonsHtml = `
        <button type="button" class="btn-auth-action btn-auth-allow-path" title="${esc(tFn('tool_auth_allow_path_title'))}">${SHIELD_SVG} <span>${esc(tFn('tool_auth_allow_path_btn', { access }))}</span></button>
      `;
    }

    let serverButtonHtml = '';
    if (serverId) {
      const sLabel = serverName || serverId;
      serverButtonHtml = `
        <button type="button" class="btn-auth-action btn-auth-allow-server" title="${esc(tFn('tool_auth_allow_server_title', { server: sLabel }) || `Confiar permanentemente en todas las herramientas del servidor ${sLabel}`)}">${SERVER_SVG} <span>${esc(tFn('tool_auth_allow_server_btn', { server: sLabel }) || `Confiar en ${sLabel}`)}</span></button>
      `;
    }

    const morePermissionsLabel = tFn('tool_auth_more_permissions') || 'Más permisos';
    const morePermissionsTitle = esc(tFn('tool_auth_more_permissions_title') || 'Elegir una autorización ampliada');
    authPromptEl.innerHTML = `
      <div class="tool-auth-header">
        <div class="tool-auth-title-row">
          <span class="tool-auth-shield-icon">${SHIELD_SVG}</span>
          <strong class="tool-auth-title">${tFn('tool_auth_title') || 'Autorización de Ejecución'}</strong>
        </div>
        <p class="tool-auth-desc">${tFn('tool_auth_desc') || 'Esta herramienta MCP requiere tu confirmación antes de interactuar con el sistema:'}</p>
      </div>
      <div class="tool-auth-actions">
        <button type="button" class="btn-auth-action btn-auth-allow-once" title="${esc(tFn('tool_auth_allow_once') || 'Permitir solo esta llamada')}">${CHECK_SVG} <span>${tFn('tool_auth_allow_once') || 'Permitir una vez'}</span></button>
        <div class="tool-auth-more">
          <button type="button" class="btn-auth-action btn-auth-more" title="${morePermissionsTitle}" aria-label="${morePermissionsTitle}" aria-expanded="false">${CHEVRON_SVG} <span class="btn-auth-more-label">${morePermissionsLabel}</span></button>
          <div class="tool-auth-more-menu" role="group" aria-label="${morePermissionsTitle}" hidden>
            <button type="button" class="btn-auth-action btn-auth-allow-session" title="${esc(tFn('tool_auth_allow_session') || 'Permitir durante toda la sesión activa de chat')}">${CLOCK_SVG} <span>${tFn('tool_auth_allow_session') || 'En esta sesión'}</span></button>
            <button type="button" class="btn-auth-action btn-auth-allow-always" title="${esc(tFn('tool_auth_allow_always') || 'Permitir siempre esta herramienta')}">${SHIELD_SVG} <span>${tFn('tool_auth_allow_always') || 'Permitir siempre'}</span></button>
            ${contextualButtonsHtml}
            ${serverButtonHtml}
          </div>
        </div>
        <button type="button" class="btn-auth-action btn-auth-deny" title="${esc(tFn('tool_auth_deny') || 'Denegar')}">${ERROR_SVG} <span>${tFn('tool_auth_deny') || 'Denegar'}</span></button>
      </div>
    `;
    keepAuthorizationVisible(cardEl);

    return new Promise((resolve) => {
      let resolved = false;

      const cleanup = () => {
        if (authPromptEl && authPromptEl.parentNode) {
          authPromptEl.remove();
        }
        cardEl?.classList?.remove('tool-card-auth-active');
        if (!toolGroup?.querySelector?.('.tool-card-auth-active')) {
          toolGroup?.classList?.remove('tool-call-group-auth-active');
        }
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const handleDecision = (decision) => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const decisionType = (typeof decision === 'object' && decision !== null) ? decision.decision : decision;

        if (decisionType === 'deny') {
          if (badge) {
            badge.className = 'tool-card-badge status-error';
            badge.innerHTML = `${ERROR_SVG} <span>${tFn('tool_auth_denied_badge') || 'Denegado'}</span>`;
          }
          const resEl = card.querySelector?.('.tool-card-result');
          if (resEl) {
            resEl.innerHTML = `<div class="tool-auth-denied-notice">${esc(tFn('tool_auth_denied_msg') || 'Ejecución denegada por el usuario.')}</div>`;
          }
        } else {
          // Permitido: restaurar badge a ejecutando
          if (badge) {
            badge.className = 'tool-card-badge status-loading';
            badge.innerHTML = `${SPINNER_SVG} <span>${tFn('tool_badge_executing') || 'Ejecutando...'}</span>`;
          }
        }

        resolve(decision);
      };

      const btnAllowOnce = authPromptEl.querySelector('.btn-auth-allow-once');
      const btnAllowSession = authPromptEl.querySelector('.btn-auth-allow-session');
      const btnAllowAlways = authPromptEl.querySelector('.btn-auth-allow-always');
      const btnAllowServer = authPromptEl.querySelector('.btn-auth-allow-server');
      const btnAllowCmd = authPromptEl.querySelector('.btn-auth-allow-cmd');
      const btnAllowPath = authPromptEl.querySelector('.btn-auth-allow-path');
      const btnDeny = authPromptEl.querySelector('.btn-auth-deny');
      const btnMore = authPromptEl.querySelector('.btn-auth-more');
      const moreMenu = authPromptEl.querySelector('.tool-auth-more-menu');

      btnMore?.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = btnMore.getAttribute('aria-expanded') === 'true';
        btnMore.setAttribute('aria-expanded', String(!isOpen));
        if (moreMenu) moreMenu.hidden = isOpen;
        if (!isOpen) keepAuthorizationVisible(cardEl, moreMenu);
      });
      moreMenu?.addEventListener('click', (e) => e.stopPropagation());

      btnAllowOnce?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDecision('allow_once');
      });

      btnAllowSession?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDecision('allow_session');
      });

      btnAllowAlways?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDecision('allow_always');
      });

      btnAllowServer?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDecision({
          decision: 'allow_server_always',
          serverId
        });
      });

      btnAllowCmd?.addEventListener('click', (e) => {
        e.stopPropagation();
        const baseNameOnly = (baseCmd.includes('/') ? baseCmd.split('/').pop() : baseCmd).trim();
        handleDecision({
          decision: 'allow_always',
          constraints: {
            command: {
              allowedPrefixes: [baseNameOnly],
              allowChaining: false,
              allowPipes: false
            }
          }
        });
      });

      btnAllowPath?.addEventListener('click', (e) => {
        e.stopPropagation();
        // La regla cubre la carpeta (la del archivo, o la propia en list_directory), no un único archivo.
        const cleanPath = (requestedDirectoryPath || pathArg || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
        const parent = isDirectoryTool
          ? cleanPath
          : (cleanPath.includes('/') ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : '.');
        const access = requestedDirectoryAccess || (isWritePathTool ? 'W' : 'R');
        handleDecision({
          decision: 'allow_always',
          directoryRule: `${access}:${parent || '/'}${parent === '/' ? '' : '/**'}`
        });
      });

      btnDeny?.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDecision('deny');
      });

      let abortHandler = null;
      if (signal) {
        abortHandler = () => handleDecision('deny');
        if (signal.aborted) {
          handleDecision('deny');
        } else {
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      }
    });
  }

  return {
    normalizeName,
    resolveToolView: getView,
    resolveToolDisplayMode,
    createCardWrapper,
    renderCardHtml,
    createLiveToolCard,
    updateLiveToolCard,
    renderHistoricalToolCard,
    appendToolCard,
    completeToolCard,
    promptToolAuthorization,
    collapseCard,
    SPINNER_SVG,
    CHECK_SVG,
    ERROR_SVG,
    CHEVRON_SVG,
    SHIELD_SVG
  };
}));
