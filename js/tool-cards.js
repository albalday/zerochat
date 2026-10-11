/** Renderer genérico: cada tool declara su propia vista con iconos vectoriales SVG. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'));
  else root.ChatToolCards = factory(root.ChatUtils);
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  const { escapeHtml, resolveDep } = Utils;
  const getMarkdown = () => resolveDep('ChatMarkdown', './markdown.js');
  const t = (key, params) => resolveDep('ChatI18n', './i18n.js').t(key, params);
  const normalizeName = name => String(name || '').trim().toLowerCase().replace(/_/g, '');
  const Icons = resolveDep('ChatIcons', './icons.js');
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

  // Un subagente anida grupos dentro de su tarjeta: cada grupo solo gestiona sus zonas directas.
  const GROUP_CARDS = ':scope > .tool-call-group-history > .tool-call-group-cards';
  const GROUP_ACTIVE_CARDS = ':scope > .tool-call-group-active-cards';

  function getToolCallGroup(container) {
    const lastChild = container?.lastElementChild;
    return lastChild?.classList?.contains('tool-call-group') ? lastChild : null;
  }

  function updateToolCallGroup(group) {
    if (!group) return;
    const cards = Array.from(group.querySelectorAll(`${GROUP_CARDS} > .tool-card-wrapper, ${GROUP_ACTIVE_CARDS} > .tool-card-wrapper`));
    const running = cards.filter(card => card.dataset.toolCallStatus === 'running');
    const failed = cards.filter(card => card.dataset.toolCallStatus === 'error').length;
    const count = cards.length;
    const label = group.querySelector(':scope > .tool-call-group-history > .tool-call-group-summary > .tool-call-group-label');
    const status = group.querySelector(':scope > .tool-call-group-history > .tool-call-group-summary > .tool-call-group-status');
    const isRunning = running.length > 0;
    group.classList.toggle('is-running', isRunning);
    group.classList.toggle('has-error', !isRunning && failed > 0);
    if (label) label.textContent = t('tool_calls_group_title');
    if (status) status.textContent = isRunning
      ? (t('tool_calls_group_running', { count }))
      : (t('tool_calls_group_complete', { count, failed }));
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
    // El subagente ya agrupa sus propias herramientas: dentro de un grupo quedaría doblemente
    // enmarcado y, mientras se ejecuta, el grupo no podría ocultarlo.
    if (card.querySelector?.('.chat-chart-card, .ask-user-card, .subagent-card')) {
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
    const cards = group?.querySelector(options.completed ? GROUP_CARDS : GROUP_ACTIVE_CARDS);
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
    const completedCards = group?.querySelector(GROUP_CARDS);
    if (completedCards) completedCards.appendChild(card);
    updateToolCallGroup(group);
  }

  /** Devuelve a la zona visible del grupo una tarjeta cuya tarea sigue en marcha tras terminar la llamada. */
  function reactivateToolCard(card) {
    if (!card) return;
    card.dataset.toolCallStatus = 'running';
    const group = card.closest?.('.tool-call-group');
    const activeCards = group?.querySelector(GROUP_ACTIVE_CARDS);
    if (activeCards) activeCards.appendChild(card);
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
    return `<div class="${escapeHtml(classes.join(' '))}"><div class="tool-card-header"><div class="tool-card-title">${titleHtml}</div>${titleSuffixHtml}<div class="tool-card-header-actions">${badgeHtml}${collapsible ? `<button type="button" class="btn-tool-collapse" title="${escapeHtml(label)}">${ui.CHEVRON_SVG || CHEVRON_SVG}</button>` : ''}</div></div><div class="tool-card-collapsible-body">${bodyHtml}</div></div>`;
  }

  /** URL de una llamada: los modelos la envían con nombres distintos. */
  function getUrlArg(args) {
    return args?.url || args?.URL || args?.uri || args?.link || args?.href || args?.path || args?.input || (typeof args === 'string' ? args : '');
  }

  /**
   * Vista de las herramientas que descargan una URL (fetch_web_page, download_pdf): la misma
   * tarjeta con el icono, los textos y la etiqueta de estado de cada una.
   */
  function createWebRequestView({ id, icon, className, titleKey, badgeKey, loadingKey, statusLabel }) {
    const iconSvg = Icons.get(icon, { size: 14 });

    function createLiveCard(args, ui) {
      const cardDiv = createCardWrapper(ui);
      const url = getUrlArg(args);
      cardDiv.innerHTML = renderCardHtml({
        className,
        titleHtml: `<span>${iconSvg}</span><span>${ui.t(titleKey)}</span>`,
        badgeHtml: `<span class="tool-card-badge status-loading">${ui.SPINNER_SVG} <span>${ui.t(badgeKey)}</span></span>`,
        bodyHtml: `<div class="web-card-section web-request-section"><div class="section-label">${ui.t('tool_web_requested_url')}</div><div class="url-badge"><a href="${ui.markdown.sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${ui.markdown.escapeHtml(url)}</a></div></div><div class="web-card-section web-response-section"><div class="section-label section-response-label">${ui.t('tool_web_receiving')}</div><div class="web-response-body tool-loading-placeholder">${ui.SPINNER_SVG} <span>${ui.t(loadingKey)}</span></div></div>`
      }, ui);
      return cardDiv;
    }

    function updateLiveCard(cardDiv, _args, result = {}, elapsedMs = 0, ui) {
      const success = result?.success !== false && !result?.error;
      const content = result?.content || result?.error || '';
      const badge = cardDiv.querySelector('.tool-card-badge');
      if (badge) {
        badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
        badge.innerHTML = `${success ? ui.CHECK_SVG : ui.ERROR_SVG} <span>${ui.markdown.escapeHtml(statusLabel(result, success))} (${elapsedMs || 0}ms)</span>`;
      }
      const label = cardDiv.querySelector('.section-response-label');
      if (label) label.textContent = ui.t('tool_web_content_received', { size: `${content.length} chars` });
      const body = cardDiv.querySelector('.web-response-body');
      if (body) {
        body.className = 'web-response-body';
        body.innerHTML = `<code>${ui.markdown.escapeHtml(content.slice(0, 1500))}${content.length > 1500 ? '...' : ''}</code>`;
      }
    }

    function renderHistoricalCard(args, toolMessage, ui) {
      const cardDiv = createLiveCard(args, ui);
      let result = {};
      if (toolMessage?.content) {
        try { result = JSON.parse(toolMessage.content); } catch (e) { result = { content: toolMessage.content }; }
      }
      updateLiveCard(cardDiv, args, result, 0, ui);
      return cardDiv;
    }

    return { id, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard };
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
      if (btn) btn.title = t('tool_btn_expand');
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
      ? `${CHECK_SVG} <span>${t('tool_status_success')}</span>`
      : `${SPINNER_SVG} <span>${t('tool_badge_executing')}</span>`;
    card.innerHTML = renderCardHtml({
      collapsed: isCollapsed,
      titleHtml: `<span>${icon}</span><span>${escapeHtml(name)}</span>`,
      badgeHtml: `<span class="${badgeClass}">${badgeContent}</span>`,
      bodyHtml: hasArgs ? `<div class="tool-card-result"><pre class="tool-card-code"><code>${escapeHtml(JSON.stringify(args, null, 2))}</code></pre></div>` : ''
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
          ? `${CHECK_SVG} <span>${t('tool_status_success')} (${elapsedMs}ms)</span>`
          : `${ERROR_SVG} <span>${t('tool_status_error', { ms: elapsedMs })}</span>`;
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
      badge.innerHTML = `${SHIELD_SVG} <span>${t('tool_auth_badge')}</span>`;
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
          <button type="button" class="btn-auth-action btn-auth-allow-cmd" title="${escapeHtml(t('tool_auth_allow_cmd_title', { cmd: baseCmd }))}">${SHIELD_SVG} <span>${escapeHtml(t('tool_auth_allow_cmd_btn', { cmd: baseCmd + ' *' }))}</span></button>
        `;
      }
      if (requestedDirectoryAccess && requestedDirectoryPath) {
        contextualButtonsHtml = `
          <button type="button" class="btn-auth-action btn-auth-allow-path" title="${escapeHtml(t('tool_auth_allow_path_title'))}">${SHIELD_SVG} <span>${escapeHtml(t('tool_auth_allow_path_btn', { access: requestedDirectoryAccess }))}</span></button>
        `;
      }
    } else if (typeof pathArg === 'string' && pathArg.trim() &&
      ToolSecurity?.canBuildDirectoryRule?.(pathArg) !== false) {
      // Sin botón para ~, variables o ".." fuera de la raíz: la regla resultante sería inválida.
      const access = isWritePathTool ? 'W' : 'R';
      contextualButtonsHtml = `
        <button type="button" class="btn-auth-action btn-auth-allow-path" title="${escapeHtml(t('tool_auth_allow_path_title'))}">${SHIELD_SVG} <span>${escapeHtml(t('tool_auth_allow_path_btn', { access }))}</span></button>
      `;
    }

    let serverButtonHtml = '';
    if (serverId) {
      const sLabel = serverName || serverId;
      serverButtonHtml = `
        <button type="button" class="btn-auth-action btn-auth-allow-server" title="${escapeHtml(t('tool_auth_allow_server_title', { server: sLabel }))}">${SERVER_SVG} <span>${escapeHtml(t('tool_auth_allow_server_btn', { server: sLabel }))}</span></button>
      `;
    }

    const morePermissionsLabel = t('tool_auth_more_permissions');
    const morePermissionsTitle = escapeHtml(t('tool_auth_more_permissions_title'));
    authPromptEl.innerHTML = `
      <div class="tool-auth-header">
        <div class="tool-auth-title-row">
          <span class="tool-auth-shield-icon">${SHIELD_SVG}</span>
          <strong class="tool-auth-title">${t('tool_auth_title')}</strong>
        </div>
        <p class="tool-auth-desc">${t('tool_auth_desc')}</p>
      </div>
      <div class="tool-auth-actions">
        <button type="button" class="btn-auth-action btn-auth-allow-once" title="${escapeHtml(t('tool_auth_allow_once'))}">${CHECK_SVG} <span>${t('tool_auth_allow_once')}</span></button>
        <div class="tool-auth-more">
          <button type="button" class="btn-auth-action btn-auth-more" title="${morePermissionsTitle}" aria-label="${morePermissionsTitle}" aria-expanded="false">${CHEVRON_SVG} <span class="btn-auth-more-label">${morePermissionsLabel}</span></button>
          <div class="tool-auth-more-menu" role="group" aria-label="${morePermissionsTitle}" hidden>
            <button type="button" class="btn-auth-action btn-auth-allow-session" title="${escapeHtml(t('tool_auth_allow_session'))}">${CLOCK_SVG} <span>${t('tool_auth_allow_session')}</span></button>
            <button type="button" class="btn-auth-action btn-auth-allow-always" title="${escapeHtml(t('tool_auth_allow_always'))}">${SHIELD_SVG} <span>${t('tool_auth_allow_always')}</span></button>
            ${contextualButtonsHtml}
            ${serverButtonHtml}
          </div>
        </div>
        <button type="button" class="btn-auth-action btn-auth-deny" title="${escapeHtml(t('tool_auth_deny'))}">${ERROR_SVG} <span>${t('tool_auth_deny')}</span></button>
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
            badge.innerHTML = `${ERROR_SVG} <span>${t('tool_auth_denied_badge')}</span>`;
          }
          const resEl = card.querySelector?.('.tool-card-result');
          if (resEl) {
            resEl.innerHTML = `<div class="tool-auth-denied-notice">${escapeHtml(t('tool_auth_denied_msg'))}</div>`;
          }
        } else {
          // Permitido: restaurar badge a ejecutando
          if (badge) {
            badge.className = 'tool-card-badge status-loading';
            badge.innerHTML = `${SPINNER_SVG} <span>${t('tool_badge_executing')}</span>`;
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
    getUrlArg,
    createWebRequestView,
    createLiveToolCard,
    updateLiveToolCard,
    renderHistoricalToolCard,
    appendToolCard,
    completeToolCard,
    reactivateToolCard,
    promptToolAuthorization,
    collapseCard,
    SPINNER_SVG,
    CHECK_SVG,
    ERROR_SVG,
    CHEVRON_SVG,
    SHIELD_SVG
  };
}));
