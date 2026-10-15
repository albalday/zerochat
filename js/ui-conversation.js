/**
 * Módulo UI de Conversación y Canvas de Mensajes (ZeroChat).
 * Encargado del renderizado de la lista de mensajes, turnos de usuario, placeholders del asistente,
 * tarjetas de herramientas recuperadas, acciones de mensaje (copiar, reusar, borrar, ramificar),
 * listeners de código, e indicadores visuales (typing y botón para volver al final).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./message-turns.js'));
  } else {
    root.ChatUIConversation = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatMessageTurns);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, MessageTurns) {
  'use strict';

  const { resolveDep, createId, copyToClipboard, escapeHtml, sanitizeImageUrl, openImageInNewTab } = Utils;
  const { t } = I18n;
  const { extractBaseId } = MessageTurns;

  const getState = () => resolveDep('ChatState', './state.js');
  const getMarkdown = () => resolveDep('ChatMarkdown', './markdown.js');
  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const getDebug = () => resolveDep('ChatDebug', './debug.js');

  function createActionButton(doc, { className, icon, titleKey, onClick }) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `btn-msg-action ${className}`.trim();
    button.innerHTML = Icons.get(icon, { size: 14 });
    button.title = t(titleKey);
    button.setAttribute('aria-label', t(titleKey));
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  /** El botón copia el texto que devuelva getText en el momento del clic. */
  function bindMessageCopy(button, getText) {
    button.onclick = () => copyToClipboard(getText(), button, Icons.get('check', { size: 14 }));
  }

  /** Tarjeta de error dentro de un mensaje: `detail` es texto; `hintHtml`, HTML propio ya escapado. */
  function renderErrorCard({ row, content, actions }, { title, detail = '', hintHtml = '' }) {
    row.classList.add('message-error');
    content.innerHTML = `
      <div class="message-error-card">
        <span class="message-error-card-icon">${Icons.get('alert-triangle', { size: 18 })}</span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
          ${hintHtml ? `<p class="message-error-card-hint">${hintHtml}</p>` : ''}
        </div>
      </div>`;
    actions.hidden = false;
  }

  function renderConnectionError(parts, message, url) {
    renderErrorCard(parts, {
      title: t('err_server_connect_title'),
      detail: message,
      hintHtml: t('err_server_connect_hint', { url: escapeHtml(url) })
    });
  }

  /** Error que el servidor envió dentro del streaming: ya había conectado, así que no se sugiere revisar la URL. */
  function renderStreamError(parts, serverMessage) {
    renderErrorCard(parts, { title: t('err_server_stream_title'), detail: serverMessage });
  }

  /** Aviso bajo una respuesta que el servidor cortó en el límite de salida; el texto recibido se conserva. */
  function renderTruncationNotice(content) {
    const notice = content.ownerDocument.createElement('p');
    notice.className = 'message-notice';
    notice.textContent = t('chat_response_truncated');
    content.appendChild(notice);
  }

  function injectStreamingCursor(html) {
    if (!html || html.trim() === '') return '<span class="streaming-cursor"></span>';
    const trimmed = html.trimEnd();
    const match = trimmed.match(/(<\/(?:p|li|h[1-6]|span|code|strong|em|td|blockquote|figcaption|figure)>)$/i);
    if (match) {
      const closingTag = match[1];
      return trimmed.slice(0, -closingTag.length) + '<span class="streaming-cursor"></span>' + closingTag;
    }
    return trimmed + '<span class="streaming-cursor"></span>';
  }

  function createAssistantBlock(container) {
    const block = container.ownerDocument.createElement('div');
    block.className = 'agentic-turn-block';
    container.appendChild(block);
    return block;
  }

  /**
   * Reconcilia los bloques de Markdown dentro de un turno sin destruir los elementos previos.
   * Conserva las instancias de imagen ya insertadas para evitar recargas, pérdidas de tamaño y parpadeos.
   */
  function updateBlockChildren(block, targetHtml) {
    const doc = block.ownerDocument;
    const template = doc.createElement('template');
    template.innerHTML = targetHtml;
    const newNodes = Array.from(template.content.childNodes).filter(node => node.nodeType !== 3 || node.textContent.trim() !== '');

    Array.from(block.childNodes).forEach(node => {
      if (node.nodeType === 3 && node.textContent.trim() === '') node.remove();
    });
    const currentNodes = Array.from(block.childNodes);

    const maxLen = Math.max(newNodes.length, currentNodes.length);
    for (let i = 0; i < maxLen; i++) {
      const cur = currentNodes[i];
      const next = newNodes[i];

      if (!cur && next) {
        block.appendChild(next);
      } else if (cur && !next) {
        cur.remove();
      } else if (cur && next) {
        if (cur.isEqualNode(next)) {
          continue;
        }

        if (cur.nodeType === 1 && next.nodeType === 1 && cur.tagName === next.tagName) {
          const curImg = cur.querySelector?.('img.chat-embedded-image');
          const nextImg = next.querySelector?.('img.chat-embedded-image');
          if (curImg && nextImg && curImg.getAttribute('src') === nextImg.getAttribute('src')) {
            if (curImg.getAttribute('alt') !== nextImg.getAttribute('alt')) {
              curImg.setAttribute('alt', nextImg.getAttribute('alt') || '');
            }
            if (curImg.getAttribute('title') !== nextImg.getAttribute('title')) {
              curImg.setAttribute('title', nextImg.getAttribute('title') || '');
            }
            const curCaption = cur.querySelector?.('.chat-image-caption');
            const nextCaption = next.querySelector?.('.chat-image-caption');
            if (curCaption && nextCaption) {
              if (curCaption.textContent !== nextCaption.textContent) {
                curCaption.textContent = nextCaption.textContent;
              }
            } else if (!curCaption && nextCaption) {
              cur.appendChild(nextCaption.cloneNode(true));
            } else if (curCaption && !nextCaption) {
              curCaption.remove();
            }
            const curCursor = cur.querySelector?.('.streaming-cursor');
            const nextCursor = next.querySelector?.('.streaming-cursor');
            if (!curCursor && nextCursor) {
              cur.appendChild(nextCursor.cloneNode(true));
            } else if (curCursor && !nextCursor) {
              curCursor.remove();
            }
            continue;
          }
        }

        block.replaceChild(next, cur);
      }
    }
  }

  function renderAssistantBlock(block, text, { streaming = false } = {}) {
    const Markdown = getMarkdown();
    const html = Markdown.parseMarkdown(text);
    const targetHtml = streaming ? injectStreamingCursor(html) : html;
    updateBlockChildren(block, targetHtml);
    Markdown.attachContentListeners(block);
  }

  const SCROLL_STICK_THRESHOLD_PX = 40;
  const SCROLL_UP_KEYS = new Set(['PageUp', 'ArrowUp', 'Home']);
  // Estado efímero de vista ligado a cada contenedor DOM; no se comparte entre subsistemas.
  const scrollStates = new WeakMap();

  function distanceFromBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight;
  }

  // Los gestos hacia arriba despegan la vista al instante: el siguiente chunk podría
  // devolverla al final antes de que llegue el evento scroll correspondiente.
  function getScrollState(container) {
    let state = scrollStates.get(container);
    if (state) return state;
    state = { stick: true, lastTop: container.scrollTop, touchY: null };
    scrollStates.set(container, state);

    const release = () => { state.stick = false; };
    container.addEventListener('wheel', event => {
      if (event.deltaY < 0) release();
    }, { passive: true });
    container.addEventListener('keydown', event => {
      if (SCROLL_UP_KEYS.has(event.key)) release();
    });
    container.addEventListener('touchstart', event => {
      state.touchY = event.touches?.[0]?.clientY ?? null;
    }, { passive: true });
    container.addEventListener('touchmove', event => {
      const y = event.touches?.[0]?.clientY;
      if (state.touchY !== null && typeof y === 'number' && y > state.touchY) release();
      state.touchY = y ?? state.touchY;
    }, { passive: true });
    container.addEventListener('scroll', () => {
      const top = container.scrollTop;
      if (distanceFromBottom(container) <= SCROLL_STICK_THRESHOLD_PX) {
        state.stick = true;
      } else if (top < state.lastTop) {
        // Arrastre de la barra u otro desplazamiento ascendente sin gesto previo detectado.
        release();
      }
      state.lastTop = top;
    }, { passive: true });
    return state;
  }

  function scrollToBottom(container, { force = false } = {}) {
    const state = getScrollState(container);
    if (force) state.stick = true;
    if (!state.stick) return;
    // 'instant' evita que el scroll-behavior: smooth del CSS compita con el gesto del usuario.
    container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  }

  /**
   * Muestra `button` mientras la vista no está al final de `container`; al pulsarlo vuelve al
   * final y la deja pegada. Se reevalúa al desplazarse, al cambiar el contenido y al redimensionar.
   */
  function mountScrollToBottomButton(container, button) {
    let pending = false;
    const update = () => {
      pending = false;
      button.hidden = container.hidden || distanceFromBottom(container) <= SCROLL_STICK_THRESHOLD_PX;
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(update);
    };
    container.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    new MutationObserver(schedule).observe(container, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'open', 'hidden']
    });
    button.addEventListener('click', () => {
      scrollToBottom(container, { force: true });
      button.hidden = true;
    });
    schedule();
  }

  let typingIndicatorEl = null;

  function showTypingIndicator(container) {
    if (typingIndicatorEl) return;
    const wrapper = container.ownerDocument.createElement('div');
    wrapper.id = 'typing-indicator-wrapper';
    wrapper.className = 'message-wrapper assistant';
    wrapper.innerHTML = '<div class="message-row assistant"><div class="typing-indicator"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>';
    typingIndicatorEl = wrapper;
    container.appendChild(wrapper);
    scrollToBottom(container);
  }

  function removeTypingIndicator() {
    typingIndicatorEl?.remove();
    typingIndicatorEl = null;
  }

  /** Borra el turno del mensaje y, si queda la conversación vacía, vuelve a mostrar la bienvenida. */
  function removeMessage(wrapper, { messagesList, welcomeBanner, saveSession }) {
    const State = getState();
    if (State.isConversationBusy()) return;

    const msgId = wrapper.getAttribute('data-msg-id') || '';
    const baseId = wrapper.getAttribute('data-base-id') || extractBaseId(msgId);
    const explicitIds = (wrapper.getAttribute('data-msg-ids') || '').split(',').filter(Boolean);
    const result = State.removeTurn({ msgId, baseId, explicitIds });
    if (!result.ok || result.removedCount === 0) return;

    wrapper.remove();
    getDebug().addLog('system', t('msg_deleted_log', { id: msgId || baseId, count: result.removedCount }));
    if (!messagesList.querySelector('.message-wrapper')) {
      messagesList.appendChild(welcomeBanner);
      welcomeBanner.hidden = false;
    }
    saveSession();
  }

  /** Estructura común de un mensaje: wrapper > row > content-wrapper > [content, footer > actions]. */
  function createMessageSkeleton(container, role, msgId) {
    const doc = container.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = `message-wrapper ${role}`;
    wrapper.setAttribute('data-msg-id', msgId);
    wrapper.innerHTML = `<div class="message-row ${role}"><div class="message-content-wrapper"><div class="message-content"></div><div class="message-footer-row"><div class="message-actions"></div></div></div></div>`;
    return {
      doc,
      wrapper,
      row: wrapper.querySelector('.message-row'),
      content: wrapper.querySelector('.message-content'),
      footerRow: wrapper.querySelector('.message-footer-row'),
      actions: wrapper.querySelector('.message-actions')
    };
  }

  function insertMessage(container, wrapper, isNew, scrollOptions) {
    container.appendChild(wrapper);
    if (isNew) {
      wrapper.classList.add('is-new-message');
      wrapper.addEventListener('animationend', () => wrapper.classList.remove('is-new-message'), { once: true });
    }
    scrollToBottom(container, scrollOptions);
  }

  function renderImageThumbnails(doc, content, images) {
    const grid = doc.createElement('div');
    grid.className = 'message-images-grid';
    for (const image of images) {
      const item = doc.createElement('div');
      item.className = 'message-image-item';
      const name = image.name || '';
      const safeUrl = sanitizeImageUrl(image.dataUrl);
      if (safeUrl) {
        const img = doc.createElement('img');
        img.src = safeUrl;
        img.alt = name;
        img.title = name ? `${name} — ${t('image_open_tab')}` : t('image_open_tab');
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.className = 'message-image-thumb';
        const open = () => openImageInNewTab(safeUrl);
        img.addEventListener('click', open);
        img.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        });
        item.appendChild(img);
      }
      const caption = doc.createElement('div');
      caption.className = 'message-image-caption';
      caption.textContent = name;
      item.appendChild(caption);
      grid.appendChild(item);
    }
    content.appendChild(grid);
  }

  function appendUserMessage(container, welcomeBanner, { text = '', originalPrompt = text, attachedImages = [], existingMsgId }, { onReuse, onDelete }) {
    welcomeBanner.hidden = true;
    const msgId = existingMsgId || createId('msg_usr');
    const { doc, wrapper, content, actions } = createMessageSkeleton(container, 'user', msgId);
    content.textContent = text;
    if (attachedImages.length > 0) renderImageThumbnails(doc, content, attachedImages);

    const btnCopy = createActionButton(doc, { className: 'btn-copy-user', icon: 'copy', titleKey: 'btn_copy_user_title' });
    bindMessageCopy(btnCopy, () => originalPrompt || text);
    actions.append(
      createActionButton(doc, { icon: 'edit', titleKey: 'btn_reuse_title', onClick: () => onReuse(originalPrompt || text) }),
      btnCopy,
      createActionButton(doc, { className: 'btn-delete', icon: 'trash', titleKey: 'btn_delete_usr_title', onClick: () => onDelete(wrapper) })
    );

    insertMessage(container, wrapper, !existingMsgId, { force: true });
    return msgId;
  }

  function createAssistantMessagePlaceholder(container, existingMsgId, { onBranch, onDelete }) {
    const rawId = existingMsgId || createId('msg_ast');
    const baseId = extractBaseId(rawId) || rawId;
    const { doc, wrapper, row, content, footerRow, actions } = createMessageSkeleton(container, 'assistant', existingMsgId ? rawId : baseId);
    wrapper.setAttribute('data-base-id', baseId);
    content.innerHTML = '<span class="streaming-cursor initial-cursor"></span>';
    actions.hidden = true;

    const statsContainer = doc.createElement('div');
    statsContainer.className = 'message-stats';
    statsContainer.hidden = true;
    footerRow.prepend(statsContainer);

    const btnBranch = createActionButton(doc, { className: 'btn-branch-conversation', icon: 'git-branch', titleKey: 'btn_branch_title', onClick: () => onBranch(wrapper) });
    const btnCopy = createActionButton(doc, { className: 'btn-copy-full', icon: 'copy', titleKey: 'btn_copy_title' });
    actions.append(
      btnBranch,
      btnCopy,
      createActionButton(doc, { className: 'btn-delete', icon: 'trash', titleKey: 'btn_delete_ast_title', onClick: () => onDelete(wrapper) })
    );

    insertMessage(container, wrapper, !existingMsgId);
    return { wrapper, row, content, footerRow, actions, btnCopy, statsContainer, msgId: wrapper.getAttribute('data-msg-id') };
  }

  function renderContextSummaryBanner(container, summaryBlock) {
    const banner = container.ownerDocument.createElement('details');
    banner.className = 'branch-summary-banner';
    banner.innerHTML = `<summary class="branch-summary-header"><span class="branch-summary-title">${Icons.get('git-branch', { size: 14 })}<span>${escapeHtml(t('chat_branch_summary_title'))}</span></span></summary>
      <div class="branch-summary-body">${getMarkdown().parseMarkdown(summaryBlock.content)}</div>`;
    container.appendChild(banner);
    return banner;
  }

  function setBranchButtonState(button, { loading, label = t('btn_branch_title') }) {
    button.disabled = loading;
    button.classList.toggle('is-loading', loading);
    button.innerHTML = loading ? Icons.get('spinner', { size: 14, className: 'ui-icon-spin' }) : Icons.get('git-branch', { size: 14 });
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function showBranchLoadingIndicator(wrapper, label = t('chat_branch_summarizing')) {
    setBranchButtonState(wrapper.querySelector('.btn-branch-conversation'), { loading: true, label });
    let indicator = wrapper.querySelector('.branch-progress-indicator');
    if (!indicator) {
      indicator = wrapper.ownerDocument.createElement('div');
      indicator.className = 'branch-progress-indicator';
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.innerHTML = Icons.get('spinner', { size: 14, className: 'ui-icon-spin' });
      const textSpan = wrapper.ownerDocument.createElement('span');
      textSpan.textContent = label;
      indicator.appendChild(textSpan);
      wrapper.querySelector('.message-footer-row').before(indicator);
    }
    return indicator;
  }

  function hideBranchLoadingIndicator(wrapper) {
    wrapper.querySelector('.branch-progress-indicator')?.remove();
    setBranchButtonState(wrapper.querySelector('.btn-branch-conversation'), { loading: false });
  }

  /** Pinta un grupo de mensajes del asistente (turnos y herramientas) en un solo bloque. */
  function renderAssistantGroup(messagesList, group, callbacks) {
    const groupMsgIds = group.map(message => message.id);
    const groupBaseId = group.map(message => extractBaseId(message.id)).find((base, index) => base !== group[index].id)
      || extractBaseId(group[0].id);
    const { wrapper, content, actions, btnCopy } = createAssistantMessagePlaceholder(messagesList, groupBaseId, callbacks);
    wrapper.setAttribute('data-msg-ids', groupMsgIds.join(','));
    content.innerHTML = '';

    const ToolCards = getToolCards();
    const markdownParts = [];
    for (const item of group) {
      if (item.role !== 'assistant') continue;
      if (item.content) {
        renderAssistantBlock(createAssistantBlock(content), item.content);
        markdownParts.push(item.content);
      }
      for (const toolCall of item.tool_calls || []) {
        const toolMsg = group.find(message => message.role === 'tool' && (message.tool_call_id === toolCall.id || message.name === toolCall.function?.name));
        const card = ToolCards.renderHistoricalToolCard(toolCall, toolMsg);
        const success = !toolMsg?.content || !/"success"\s*:\s*false|"error"\s*:/i.test(toolMsg.content);
        ToolCards.appendToolCard(content, card, { completed: true, success });
      }
    }

    if (content.children.length === 0) {
      content.innerHTML = `<p><em>${escapeHtml(t('no_text_response'))}</em></p>`;
    }
    const fullAssistantMarkdown = markdownParts.join('\n\n');
    bindMessageCopy(btnCopy, () => fullAssistantMarkdown || content.innerText);
    actions.hidden = false;
    getMarkdown().attachContentListeners(content);
  }

  function renderSessionMessages(elements, history, callbacks) {
    const { messagesList, welcomeBanner } = elements;
    messagesList.innerHTML = '';

    const summaryBlock = history.find(message => message._isSummaryBlock);
    if (summaryBlock) renderContextSummaryBanner(messagesList, summaryBlock);

    const messages = history.filter(message => message.role !== 'system');
    if (messages.length === 0 && !summaryBlock) {
      messagesList.appendChild(welcomeBanner);
      welcomeBanner.hidden = false;
      callbacks.resetTelemetry();
      return;
    }
    welcomeBanner.hidden = true;

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'user') {
        appendUserMessage(messagesList, welcomeBanner, {
          text: msg.content,
          attachedImages: msg.images || [],
          existingMsgId: msg.id
        }, callbacks);
        i++;
        continue;
      }
      const group = [];
      while (i < messages.length && messages[i].role !== 'user') group.push(messages[i++]);
      renderAssistantGroup(messagesList, group, callbacks);
    }

    scrollToBottom(messagesList, { force: true });
    callbacks.updateTelemetry();
  }

  return {
    bindMessageCopy,
    renderErrorCard,
    renderConnectionError,
    renderStreamError,
    renderTruncationNotice,
    createAssistantBlock,
    renderAssistantBlock,
    scrollToBottom,
    mountScrollToBottomButton,
    showTypingIndicator,
    removeTypingIndicator,
    removeMessage,
    appendUserMessage,
    createAssistantMessagePlaceholder,
    renderSessionMessages,
    showBranchLoadingIndicator,
    hideBranchLoadingIndicator
  };
}));
