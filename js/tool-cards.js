/** Renderer genérico: cada tool declara su propia vista con iconos vectoriales SVG. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatToolCards = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const safeEscapeHtml = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getMarkdown = () => (typeof window !== 'undefined' && window.ChatMarkdown) || (typeof window !== 'undefined' && window.ChatUtils) || { escapeHtml: safeEscapeHtml };
  const t = (key, params) => (typeof window !== 'undefined' && window.ChatI18n?.t) ? window.ChatI18n.t(key, params) : key;
  const normalizeName = name => String(name || '').trim().toLowerCase().replace(/_/g, '');
  const getView = name => (typeof window !== 'undefined' && window.ChatAgentCore?.registry?.getTool) ? window.ChatAgentCore.registry.getTool(name)?.view : null;

  const SPINNER_SVG = '<svg class="ui-icon ui-icon-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>';
  const CHECK_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const ERROR_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
  const CHEVRON_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>';
  const SHIELD_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>';
  const CLOCK_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
  const SERVER_SVG = '<svg class="ui-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>';
  const DEFAULT_TOOL_ICON = '<svg class="ui-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

  function createCardWrapper(ui, extraClass = '') {
    const doc = ui?.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const cardDiv = doc.createElement('div');
    cardDiv.className = extraClass ? `tool-card-wrapper ${extraClass}` : 'tool-card-wrapper';
    return cardDiv;
  }

  const context = () => ({
    document: typeof document === 'undefined' ? null : document,
    markdown: getMarkdown(),
    charts: typeof window !== 'undefined' ? window.ChatCharts : null,
    icons: typeof window !== 'undefined' ? window.ChatIcons : null,
    t,
    createCardWrapper: (extraClass) => createCardWrapper(context(), extraClass),
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
    const cardEl = card.querySelector?.('.tool-execution-card, .web-request-card, .web-search-card, .chat-chart-card')
      || (card.matches?.('.tool-execution-card, .web-request-card, .web-search-card, .chat-chart-card') ? card : null);
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
    const collapseBtnTitle = isCollapsed ? (t('tool_btn_expand') || 'Expandir herramienta') : (t('tool_btn_collapse') || 'Minimizar');
    const collapseBtn = hasArgs
      ? `<button type="button" class="btn-tool-collapse" title="${collapseBtnTitle}">${CHEVRON_SVG}</button>`
      : '';
    const bodyHtml = hasArgs
      ? `<div class="tool-card-collapsible-body"><div class="tool-card-result"><pre class="tool-card-code"><code>${getMarkdown().escapeHtml(JSON.stringify(args, null, 2))}</code></pre></div></div>`
      : '';
    const cardClass = isCollapsed ? 'tool-execution-card collapsed' : 'tool-execution-card';
    card.innerHTML = `<div class="${cardClass}"><div class="tool-card-header"><div class="tool-card-title"><span>${icon}</span><span>${getMarkdown().escapeHtml(name)}</span></div><div class="tool-card-header-actions"><span class="${badgeClass}">${badgeContent}</span>${collapseBtn}</div></div>${bodyHtml}</div>`;
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
    if (cardEl && cardEl.classList) {
      cardEl.classList.remove('collapsed');
      cardEl.classList.add('tool-card-auth-active');
    }

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

    let contextualButtonsHtml = '';
    let baseCmd = '';
    if (typeof cmdArg === 'string' && cmdArg.trim()) {
      baseCmd = cmdArg.trim().split(/\s+/)[0];
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
    } else if (typeof pathArg === 'string' && pathArg.trim()) {
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
              allowChaining: true,
              allowPipes: true
            }
          }
        });
      });

      btnAllowPath?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (requestedDirectoryAccess && requestedDirectoryPath) {
          handleDecision({ decision: 'allow_always', directoryRule: `${requestedDirectoryAccess}:${requestedDirectoryPath}` });
          return;
        }
        const cleanPath = (pathArg || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
        const parent = isDirectoryTool
          ? cleanPath
          : (cleanPath.includes('/') ? cleanPath.slice(0, cleanPath.lastIndexOf('/')) : '.');
        const access = isWritePathTool ? 'W' : 'R';
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
    createLiveToolCard,
    updateLiveToolCard,
    renderHistoricalToolCard,
    promptToolAuthorization,
    collapseCard,
    SPINNER_SVG,
    CHECK_SVG,
    ERROR_SVG,
    CHEVRON_SVG,
    SHIELD_SVG
  };
}));
