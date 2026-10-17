/** Tarjetas de herramientas: grupos de llamadas, autorización y la vista que declara cada herramienta. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  else root.ChatToolCards = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  const { escapeHtml, resolveDep } = Utils;
  const { t } = I18n;
  const getRegistry = () => resolveDep('ChatAgentCore', './agent-core.js').registry;
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');
  const getView = name => getRegistry().getTool(name)?.view || null;

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
    const lastChild = container.lastElementChild;
    return lastChild?.classList.contains('tool-call-group') ? lastChild : null;
  }

  function updateToolCallGroup(group) {
    if (!group) return;
    const cards = Array.from(group.querySelectorAll(`${GROUP_CARDS} > .tool-card-wrapper, ${GROUP_ACTIVE_CARDS} > .tool-card-wrapper`));
    const isRunning = cards.some(card => card.dataset.toolCallStatus === 'running');
    const failed = cards.filter(card => card.dataset.toolCallStatus === 'error').length;
    const count = cards.length;
    group.classList.toggle('is-running', isRunning);
    group.classList.toggle('has-error', !isRunning && failed > 0);
    group.querySelector(':scope > .tool-call-group-history > .tool-call-group-summary > .tool-call-group-status').textContent = isRunning
      ? t('tool_calls_group_running', { count })
      : t('tool_calls_group_complete', { count, failed });
  }

  function createToolCallGroup(container) {
    const group = container.ownerDocument.createElement('div');
    group.className = 'tool-call-group is-running';
    group.innerHTML = `<details class="tool-call-group-history"><summary class="tool-call-group-summary">${TOOL_CALLS_SVG}<span class="tool-call-group-label">${escapeHtml(t('tool_calls_group_title'))}</span><span class="tool-call-group-status"></span></summary><div class="tool-call-group-cards"></div></details><div class="tool-call-group-active-cards"></div>`;
    container.appendChild(group);
    return group;
  }

  function appendToolCard(container, card, options = {}) {
    // Las visualizaciones y las preguntas al usuario son resultado principal, no ruido de ejecución.
    // El subagente ya agrupa sus propias herramientas: dentro de un grupo quedaría doblemente
    // enmarcado y, mientras se ejecuta, el grupo no podría ocultarlo.
    if (card.querySelector('.chat-chart-card, .ask-user-card, .subagent-card')) {
      container.appendChild(card);
      return null;
    }
    // Cada paso del runtime crea un bloque de asistente antes de saber si emitirá
    // texto. Si queda vacío, no representa una respuesta y no debe cortar el grupo.
    const trailingAssistantBlock = container.lastElementChild;
    if (trailingAssistantBlock?.classList.contains('agentic-turn-block') && !trailingAssistantBlock.textContent.trim()) {
      trailingAssistantBlock.remove();
    }
    const group = getToolCallGroup(container) || createToolCallGroup(container);
    card.dataset.toolCallStatus = options.completed ? (options.success === false ? 'error' : 'success') : 'running';
    group.querySelector(options.completed ? GROUP_CARDS : GROUP_ACTIVE_CARDS).appendChild(card);
    updateToolCallGroup(group);
    return group;
  }

  /** Mueve la tarjeta a la zona del grupo que corresponde a su estado. */
  function moveCardInGroup(card, status) {
    card.dataset.toolCallStatus = status;
    const group = card.closest('.tool-call-group');
    group?.querySelector(status === 'running' ? GROUP_ACTIVE_CARDS : GROUP_CARDS).appendChild(card);
    updateToolCallGroup(group);
  }

  function completeToolCard(card, result) {
    moveCardInGroup(card, result.success === false || result.error ? 'error' : 'success');
  }

  /** Devuelve a la zona visible del grupo una tarjeta cuya tarea sigue en marcha tras terminar la llamada. */
  function reactivateToolCard(card) {
    moveCardInGroup(card, 'running');
  }

  function createCardWrapper(extraClass = '') {
    const cardDiv = document.createElement('div');
    cardDiv.className = extraClass ? `tool-card-wrapper ${extraClass}` : 'tool-card-wrapper';
    return cardDiv;
  }

  // HTML slots are internal markup: callers must escape external text before passing it.
  function renderCardHtml({ titleHtml = '', badgeHtml = '', bodyHtml = '', className = '', collapsed = false, collapsible = true, buttonTitle = '', titleSuffixHtml = '' } = {}) {
    const classes = ['tool-execution-card', ...String(className).split(/\s+/).filter(c => c && c !== 'tool-execution-card' && c !== 'collapsed')];
    if (collapsed) classes.push('collapsed');
    const label = buttonTitle || t(collapsed ? 'tool_btn_expand' : 'tool_btn_collapse');
    return `<div class="${escapeHtml(classes.join(' '))}"><div class="tool-card-header"><div class="tool-card-title">${titleHtml}</div>${titleSuffixHtml}<div class="tool-card-header-actions">${badgeHtml}${collapsible ? `<button type="button" class="btn-tool-collapse" title="${escapeHtml(label)}">${CHEVRON_SVG}</button>` : ''}</div></div><div class="tool-card-collapsible-body">${bodyHtml}</div></div>`;
  }

  /** Insignia de resultado: correcto o error, con el texto ya traducido. */
  function renderStatusBadge(badge, success, label) {
    badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
    badge.innerHTML = `${success ? CHECK_SVG : ERROR_SVG} <span>${escapeHtml(label)}</span>`;
  }

  const isSuccessResult = result => result.success !== false && !result.error;

  /** URL de una llamada: los modelos la envían con nombres distintos. */
  function getUrlArg(args) {
    return args.url || args.URL || args.uri || args.link || args.href || args.path || args.input || '';
  }

  /**
   * Vista de las herramientas que descargan una URL (fetch_web_page, download_doc): la misma
   * tarjeta con el icono, los textos y la etiqueta de estado de cada una.
   */
  function createWebRequestView({ icon, className, titleKey, badgeKey, loadingKey, statusLabel }) {
    const iconSvg = Icons.get(icon, { size: 14 });
    return {
      createLiveCard(args, ui) {
        const cardDiv = ui.createCardWrapper();
        const url = getUrlArg(args);
        cardDiv.innerHTML = renderCardHtml({
          className,
          titleHtml: `<span>${iconSvg}</span><span>${t(titleKey)}</span>`,
          badgeHtml: `<span class="tool-card-badge status-loading">${SPINNER_SVG} <span>${t(badgeKey)}</span></span>`,
          bodyHtml: `<div class="web-card-section web-request-section"><div class="section-label">${t('tool_web_requested_url')}</div><div class="url-badge"><a href="${ui.markdown.sanitizeUrl(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></div></div><div class="web-card-section web-response-section"><div class="section-label section-response-label">${t('tool_web_receiving')}</div><div class="web-response-body tool-loading-placeholder">${SPINNER_SVG} <span>${t(loadingKey)}</span></div></div>`
        });
        return cardDiv;
      },
      updateLiveCard(cardDiv, _args, result, elapsedMs) {
        const success = isSuccessResult(result);
        const content = result.content || result.error || '';
        renderStatusBadge(cardDiv.querySelector('.tool-card-badge'), success, `${statusLabel(result, success)} (${elapsedMs}ms)`);
        cardDiv.querySelector('.section-response-label').textContent = t('tool_web_content_received', { size: `${content.length} chars` });
        const body = cardDiv.querySelector('.web-response-body');
        body.className = 'web-response-body';
        body.innerHTML = `<code>${escapeHtml(content.slice(0, 1500))}${content.length > 1500 ? '...' : ''}</code>`;
      }
    };
  }

  /**
   * Vista de las herramientas cuyo resultado es texto (las de conocimiento local): título,
   * insignia de estado y el comienzo del texto. Las etiquetas llegan ya traducidas.
   */
  function createTextResultView({ icon, title, loadingLabel, placeholderKey, successLabel, errorKey, getText }) {
    const iconSvg = Icons.get(icon, { size: 14 });
    return {
      createLiveCard(args, ui) {
        const card = ui.createCardWrapper();
        card.innerHTML = renderCardHtml({
          className: 'rag-execution-card',
          titleHtml: `<span>${iconSvg}</span><span>${escapeHtml(title(args))}</span>`,
          badgeHtml: `<span class="tool-card-badge status-loading">${SPINNER_SVG} <span>${escapeHtml(loadingLabel(args))}</span></span>`,
          bodyHtml: `<div class="tool-card-result"><div class="tool-loading-placeholder">${SPINNER_SVG} <span>${t(placeholderKey)}</span></div></div>`
        });
        return card;
      },
      updateLiveCard(card, _args, result, elapsedMs) {
        const success = isSuccessResult(result);
        renderStatusBadge(card.querySelector('.tool-card-badge'), success, success ? successLabel(result, elapsedMs) : (result.error || t(errorKey)));
        const text = success ? getText(result) : (result.error || '');
        card.querySelector('.tool-card-result').innerHTML = `<pre class="tool-result-pre"><code>${escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? `\n${escapeHtml(t('tool_card_truncated'))}` : ''}</code></pre>`;
      }
    };
  }

  // Contexto que reciben las vistas de las herramientas.
  const viewContext = () => ({
    markdown: resolveDep('ChatMarkdown', './markdown.js'),
    charts: resolveDep('ChatCharts', './charts.js'),
    t,
    createCardWrapper,
    SPINNER_SVG,
    CHECK_SVG,
    ERROR_SVG,
    CHEVRON_SVG
  });

  const resolveToolDisplayMode = name => getRegistry().getTool(name)?.displayMode || null;

  function keepAuthorizationVisible(element, overlayElement = null) {
    const reveal = () => {
      if (!element.isConnected) return;
      const messagesList = element.closest('#messages-list');
      if (!messagesList) {
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const elementRect = element.getBoundingClientRect();
      const overlayRect = overlayElement?.isConnected ? overlayElement.getBoundingClientRect() : null;
      const listRect = messagesList.getBoundingClientRect();
      const bottom = Math.max(elementRect.bottom, overlayRect?.bottom || -Infinity);
      const overflow = bottom - listRect.bottom + 16;
      if (overflow <= 0) return;
      const targetTop = Math.min(messagesList.scrollHeight - messagesList.clientHeight, messagesList.scrollTop + overflow);
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      messagesList.scrollTo({ top: targetTop, behavior: reducedMotion ? 'auto' : 'smooth' });
    };
    requestAnimationFrame(() => requestAnimationFrame(reveal));
  }

  function collapseCard(card) {
    const cardEl = card.querySelector('.tool-execution-card, .chat-chart-card');
    if (!cardEl) return;
    cardEl.classList.add('collapsed');
    const btn = cardEl.querySelector('.btn-tool-collapse');
    if (btn) btn.title = t('tool_btn_expand');
  }

  /** Tarjeta de una herramienta sin vista propia: nombre, argumentos y estado. */
  function createGenericCard(name, args, completed) {
    const card = createCardWrapper();
    const hasArgs = Object.keys(args).length > 0;
    const icon = Icons.has(name) ? Icons.get(name, { size: 14 }) : (getRegistry().getTool(name)?.metadata.iconSvg || DEFAULT_TOOL_ICON);
    const badge = completed
      ? `<span class="tool-card-badge status-success">${CHECK_SVG} <span>${t('tool_status_success')}</span></span>`
      : `<span class="tool-card-badge status-loading">${SPINNER_SVG} <span>${t('tool_badge_executing')}</span></span>`;
    card.innerHTML = renderCardHtml({
      collapsed: completed,
      titleHtml: `<span>${icon}</span><span>${escapeHtml(name)}</span>`,
      badgeHtml: badge,
      bodyHtml: hasArgs ? `<div class="tool-card-result"><pre class="tool-card-code"><code>${escapeHtml(JSON.stringify(args, null, 2))}</code></pre></div>` : ''
    });
    return card;
  }

  function createLiveToolCard(name, args) {
    const view = getView(name);
    return view ? view.createLiveCard(args, viewContext()) : createGenericCard(name, args, false);
  }

  /** Muestra el resultado; la vista puede devolver true para mantener la tarjeta abierta. */
  function updateLiveToolCard(card, name, args, result, elapsedMs, options = {}) {
    const view = getView(name);
    let keepExpanded = false;
    if (view) {
      keepExpanded = view.updateLiveCard(card, args, result, elapsedMs, viewContext()) === true;
    } else {
      renderStatusBadge(card.querySelector('.tool-card-badge'), isSuccessResult(result), isSuccessResult(result)
        ? `${t('tool_status_success')} (${elapsedMs}ms)`
        : t('tool_status_error', { ms: elapsedMs }));
    }
    const displayMode = options.displayMode || resolveToolDisplayMode(name) || 'collapsed';
    if (displayMode === 'collapsed' && !keepExpanded) collapseCard(card);
  }

  /**
   * Resultado guardado en un mensaje `tool`: su contenido es lo que recibió el modelo, en JSON o
   * en texto. `content` conserva siempre el texto original.
   */
  function parseToolMessage(message) {
    const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { content, ...parsed };
    } catch (_) { /* el resultado es texto */ }
    return { content };
  }

  /** Tarjeta de una llamada del historial: la vista la reconstruye con el mensaje `tool` guardado. */
  function renderHistoricalToolCard(call, message) {
    let args;
    try {
      args = typeof call.function.arguments === 'object' ? call.function.arguments : JSON.parse(call.function.arguments || '{}');
    } catch (e) {
      args = { input: call.function.arguments || '' };
    }
    if (!args || typeof args !== 'object') args = {};
    const toolName = call.function.name;
    const view = getView(toolName);
    const displayMode = resolveToolDisplayMode(toolName) || 'collapsed';
    let card;
    let keepExpanded = message?.images?.some(image => image.action === 'screenshot') || false;
    if (view?.renderHistoricalCard) {
      card = view.renderHistoricalCard(args, message, viewContext());
    } else if (view) {
      const ui = viewContext();
      card = view.createLiveCard(args, ui);
      keepExpanded = view.updateLiveCard(card, args, parseToolMessage(message), 0, ui) === true || keepExpanded;
    } else {
      card = createGenericCard(toolName, args, displayMode === 'collapsed');
    }
    if (displayMode === 'collapsed' && !keepExpanded) collapseCard(card);
    return card;
  }

  /**
   * Muestra en la tarjeta de la herramienta la petición de autorización y espera la decisión:
   * 'allow_once', 'allow_session', 'allow_always', 'deny' o un objeto con la regla concedida.
   */
  function promptToolAuthorization(card, toolCall, options = {}) {
    const toolName = toolCall.function.name;
    const serverName = options.serverName || '';
    const serverId = options.serverId || '';
    const signal = options.signal;

    // La tarjeta se despliega para que la petición quede a la vista.
    const cardEl = card.querySelector('.tool-execution-card') || card;
    const toolGroup = card.closest('.tool-call-group');
    cardEl.classList.remove('collapsed');
    cardEl.classList.add('tool-card-auth-active');
    toolGroup?.classList.add('tool-call-group-auth-active');

    const badge = card.querySelector('.tool-card-badge');
    if (badge) {
      badge.className = 'tool-card-badge status-pending-auth';
      badge.innerHTML = `${SHIELD_SVG} <span>${t('tool_auth_badge')}</span>`;
    }

    let authPromptEl = card.querySelector('.tool-card-auth-prompt');
    if (!authPromptEl) {
      authPromptEl = document.createElement('div');
      authPromptEl.className = 'tool-card-auth-prompt';
      (card.querySelector('.tool-card-collapsible-body') || cardEl).prepend(authPromptEl);
    }

    const parsedArgs = options.args || {};
    const cmdArg = parsedArgs.command || parsedArgs.cmd || parsedArgs.script;
    const pathArg = parsedArgs.path || parsedArgs.filepath || parsedArgs.file;
    const requestedDirectoryAccess = options.directoryAccess || '';
    const requestedDirectoryPath = options.directoryPath || '';
    const isWritePathTool = /(?:^|_)edit_file$/.test(toolName);
    const isDirectoryTool = /(?:^|_)list_directory$/.test(toolName);

    const ToolSecurity = getToolSecurity();
    let contextualButtonsHtml = '';
    let baseCmd = '';
    if (typeof cmdArg === 'string' && cmdArg.trim()) {
      // Con "cd <dir> && git status" se ofrece autorizar git, no cd.
      baseCmd = ToolSecurity.getCommandBaseName(cmdArg);
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
    } else if (typeof pathArg === 'string' && pathArg.trim() && ToolSecurity.canBuildDirectoryRule(pathArg)) {
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
        authPromptEl.remove();
        cardEl.classList.remove('tool-card-auth-active');
        if (!toolGroup?.querySelector('.tool-card-auth-active')) {
          toolGroup?.classList.remove('tool-call-group-auth-active');
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
          const resEl = card.querySelector('.tool-card-result');
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

  /**
   * Vista de tarjetas en vivo dentro de `container` para AgentCore.dispatchToolCall: cada tarjeta
   * abierta pide en ella la autorización y se completa con el resultado. `nest` abre otra vista
   * dentro de la tarjeta, donde el subagente pinta las suyas.
   */
  function createCardView(container, { attachListeners, scrollToBottom }) {
    return {
      open(name, args, invocationId) {
        const element = createLiveToolCard(name, args);
        element.dataset.invocationId = invocationId;
        appendToolCard(container, element);
        attachListeners(element);
        scrollToBottom();
        return {
          element,
          attachListeners,
          nest: nestedContainer => createCardView(nestedContainer, { attachListeners, scrollToBottom }),
          requestAuthorization(toolCall, authorization) {
            scrollToBottom();
            return promptToolAuthorization(element, toolCall, authorization);
          },
          complete(result, elapsedMs, displayMode) {
            updateLiveToolCard(element, name, args, result, elapsedMs, { displayMode });
            completeToolCard(element, result);
            attachListeners(element);
            scrollToBottom();
          }
        };
      }
    };
  }

  return {
    createCardView,
    renderCardHtml,
    renderStatusBadge,
    getUrlArg,
    createWebRequestView,
    createTextResultView,
    createLiveToolCard,
    updateLiveToolCard,
    renderHistoricalToolCard,
    appendToolCard,
    completeToolCard,
    reactivateToolCard,
    promptToolAuthorization
  };
}));
