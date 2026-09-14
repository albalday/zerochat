/**
 * Módulo UI de Conversación y Canvas de Mensajes (ZeroChat).
 * Encargado del renderizado de la lista de mensajes, turnos de usuario, placeholders del asistente,
 * tarjetas de herramientas recuperadas, acciones de mensaje (copiar, reusar, borrar, ramificar),
 * listeners de código, e indicadores visuales (typing, scroll-to-bottom).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUIConversation = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require !== 'undefined') {
      try { return require(relPath); } catch (_) {}
    }
    return null;
  }

  function getI18n() { return resolveDep('ChatI18n', './i18n.js'); }
  function getIcons() { return resolveDep('ChatIcons', './icons.js'); }
  function getState() { return resolveDep('ChatState', './state.js'); }
  function getMarkdown() { return resolveDep('ChatMarkdown', './markdown.js'); }
  function getSandbox() { return resolveDep('ChatSandbox', './sandbox.js'); }
  function getToolCards() { return resolveDep('ChatToolCards', './tool-cards.js'); }

  function t(key, params) {
    const I18n = getI18n();
    return I18n?.t ? I18n.t(key, params) : key;
  }

  function getMsgIcon(name, size = 14) {
    const Icons = getIcons();
    if (Icons && Icons.has && Icons.has(name)) {
      return Icons.get(name, { size, className: 'ui-icon' });
    }
    return '';
  }

  function extractBaseId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.replace(/(?:_turn_\d+_(?:assistant|tool.*)|_final)$/, '');
  }

  function isDateTimeInitialTurn(m) {
    if (!m || m.role !== 'user') return false;
    const content = typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '');
    return content.startsWith('La fecha y hora actual es:') ||
           content.startsWith('Fecha y hora actual:') ||
           content.startsWith('The current date and time is:') ||
           content.startsWith('Current date and time:');
  }

  function scrollToBottom(container) {
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }

  let typingIndicatorEl = null;

  function showTypingIndicator(container) {
    if (typingIndicatorEl) return;
    const doc = (container && container.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    const wrapper = doc.createElement('div');
    wrapper.id = 'typing-indicator-wrapper';
    wrapper.className = 'message-wrapper assistant';
    const row = doc.createElement('div');
    row.className = 'message-row assistant';
    const indicator = doc.createElement('div');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    row.appendChild(indicator);
    wrapper.appendChild(row);
    typingIndicatorEl = wrapper;

    if (container) {
      container.appendChild(wrapper);
      scrollToBottom(container);
    }
  }

  function removeTypingIndicator() {
    if (typingIndicatorEl && typingIndicatorEl.parentNode) {
      typingIndicatorEl.parentNode.removeChild(typingIndicatorEl);
    }
    typingIndicatorEl = null;
  }

  function renderStoredToolCard(tc, toolMsg) {
    const ToolCards = getToolCards();
    if (ToolCards?.renderHistoricalToolCard) {
      return ToolCards.renderHistoricalToolCard(tc, toolMsg);
    }
    return null;
  }

  function attachListenersToContainer(container, options = {}) {
    if (!container) return;
    const Markdown = getMarkdown();
    const Sandbox = getSandbox();

    if (Markdown?.attachCopyCodeListeners) {
      Markdown.attachCopyCodeListeners(container);
    }

    if (Markdown?.attachRunJsListeners) {
      Markdown.attachRunJsListeners(container, (code, outputEl) => {
        if (typeof options.onRunJs === 'function') {
          options.onRunJs(code, outputEl);
        } else if (Sandbox?.execute) {
          Sandbox.execute(code).then(res => {
            if (outputEl) {
              outputEl.textContent = res.success
                ? (res.result || res.logs.join('\n') || 'undefined')
                : `Error: ${res.error}`;
            }
          });
        }
      });
    }
  }

  function removeMessage(wrapper, options = {}) {
    if (!wrapper) return;
    const State = getState();
    const isBusy = typeof options.isBusy === 'function' ? options.isBusy() : (State?.isConversationBusy?.() === true);
    if (isBusy) return;

    const msgId = wrapper.getAttribute('data-msg-id') || '';
    const baseId = wrapper.getAttribute('data-base-id') || extractBaseId(msgId);
    const rawMsgIds = wrapper.getAttribute('data-msg-ids') || '';
    const explicitIds = rawMsgIds ? rawMsgIds.split(',').filter(Boolean) : [];

    let removedCount = 0;
    if (explicitIds.length > 0 || baseId || msgId) {
      if (typeof options.removeTurn === 'function') {
        const res = options.removeTurn({ msgId, baseId, explicitIds });
        if (!res || !res.ok) return;
        removedCount = res.removedCount || 0;
      } else if (State?.removeTurn) {
        const res = State.removeTurn({ msgId, baseId, explicitIds });
        if (!res || !res.ok) return;
        removedCount = res.removedCount || 0;
      }
    }
    if (removedCount === 0) return;

    wrapper.remove();

    if (typeof options.addDebugLog === 'function') {
      options.addDebugLog('system', t('msg_deleted_log', { id: msgId || baseId, count: removedCount }));
    }

    const messagesList = options.messagesList || wrapper.parentNode;
    const welcomeBanner = options.welcomeBanner;
    if (messagesList) {
      const remainingMessages = messagesList.querySelectorAll('.message-wrapper');
      if (remainingMessages.length === 0 && welcomeBanner) {
        messagesList.appendChild(welcomeBanner);
        welcomeBanner.style.display = '';
      }
    }

    if (typeof options.saveSession === 'function') {
      options.saveSession();
    }
  }

  function appendUserMessage(container, welcomeBanner, payload = {}, callbacks = {}) {
    const text = payload.text || '';
    const originalPrompt = payload.originalPrompt !== undefined ? payload.originalPrompt : text;
    const attachedImages = payload.attachedImages || [];
    const existingMsgId = payload.existingMsgId;

    if (welcomeBanner && welcomeBanner.parentNode) {
      welcomeBanner.style.display = 'none';
    }

    const doc = (container && container.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!doc) return existingMsgId || '';

    const msgId = existingMsgId || ((typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'msg_usr_' + crypto.randomUUID()
      : 'msg_usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9));

    const wrapper = doc.createElement('div');
    wrapper.className = 'message-wrapper user';
    wrapper.setAttribute('data-msg-id', msgId);

    const row = doc.createElement('div');
    row.className = 'message-row user';

    const contentWrapper = doc.createElement('div');
    contentWrapper.className = 'message-content-wrapper';

    const content = doc.createElement('div');
    content.className = 'message-content';
    content.textContent = text;

    const Markdown = getMarkdown();

    // Miniaturas visuales de imágenes adjuntas
    if (attachedImages && attachedImages.length > 0) {
      const imagesGrid = doc.createElement('div');
      imagesGrid.className = 'message-images-grid';
      attachedImages.forEach(img => {
        const itemDiv = doc.createElement('div');
        itemDiv.className = 'message-image-item';
        const safeName = Markdown?.escapeHtml ? Markdown.escapeHtml(img.name || '') : (img.name || '');
        itemDiv.innerHTML = `
          <img src="${img.dataUrl}" alt="${safeName}" class="message-image-thumb" title="${safeName}">
          <div class="message-image-caption">${safeName}</div>
        `;
        const imgEl = itemDiv.querySelector('img');
        if (imgEl) {
          imgEl.addEventListener('click', () => {
            if (typeof window !== 'undefined') window.open(img.dataUrl, '_blank');
          });
        }
        imagesGrid.appendChild(itemDiv);
      });
      content.appendChild(imagesGrid);
    }

    const footerRow = doc.createElement('div');
    footerRow.className = 'message-footer-row';

    const actions = doc.createElement('div');
    actions.className = 'message-actions';

    const btnCopy = doc.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn-msg-action btn-copy-user';
    btnCopy.innerHTML = getMsgIcon('copy', 14);
    btnCopy.title = t('btn_copy_user_title');
    btnCopy.setAttribute('aria-label', t('btn_copy_user_title'));
    btnCopy.addEventListener('click', async () => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(originalPrompt || text);
        }
        btnCopy.innerHTML = getMsgIcon('check', 14);
        btnCopy.title = t('copied_text');
        btnCopy.setAttribute('aria-label', t('copied_text'));
        btnCopy.classList.add('copied');
        setTimeout(() => {
          btnCopy.innerHTML = getMsgIcon('copy', 14);
          btnCopy.title = t('btn_copy_user_title');
          btnCopy.setAttribute('aria-label', t('btn_copy_user_title'));
          btnCopy.classList.remove('copied');
        }, 2000);
      } catch (err) {
        console.error('Error copying user message:', err);
      }
    });

    const btnReuse = doc.createElement('button');
    btnReuse.type = 'button';
    btnReuse.className = 'btn-msg-action';
    btnReuse.innerHTML = getMsgIcon('edit', 14);
    btnReuse.title = t('btn_reuse_title');
    btnReuse.setAttribute('aria-label', t('btn_reuse_title'));
    btnReuse.addEventListener('click', () => {
      if (typeof callbacks.onReuse === 'function') {
        callbacks.onReuse(originalPrompt || text);
      }
    });

    const btnDelete = doc.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-msg-action btn-delete';
    btnDelete.innerHTML = getMsgIcon('trash', 14);
    btnDelete.title = t('btn_delete_usr_title');
    btnDelete.setAttribute('aria-label', t('btn_delete_usr_title'));
    btnDelete.addEventListener('click', () => {
      if (typeof callbacks.onDelete === 'function') {
        callbacks.onDelete(wrapper);
      } else {
        removeMessage(wrapper, { messagesList: container, welcomeBanner, ...callbacks });
      }
    });

    actions.appendChild(btnReuse);
    actions.appendChild(btnCopy);
    actions.appendChild(btnDelete);
    footerRow.appendChild(actions);

    contentWrapper.appendChild(content);
    contentWrapper.appendChild(footerRow);

    row.appendChild(contentWrapper);
    wrapper.appendChild(row);

    if (container) {
      container.appendChild(wrapper);
      if (!existingMsgId && wrapper.classList?.add) {
        wrapper.classList.add('is-new-message');
        wrapper.addEventListener?.('animationend', () => wrapper.classList.remove('is-new-message'), { once: true });
      }
      scrollToBottom(container);
    }

    return msgId;
  }

  function createAssistantMessagePlaceholder(container, existingMsgId, callbacks = {}) {
    const doc = (container && container.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    const rawId = existingMsgId || ((typeof crypto !== 'undefined' && crypto.randomUUID)
      ? 'msg_ast_' + crypto.randomUUID()
      : 'msg_ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9));
    const baseId = extractBaseId(rawId) || rawId;
    const msgId = existingMsgId ? rawId : baseId;

    if (!doc) {
      return { wrapper: null, row: null, content: null, footerRow: null, actions: null, btnCopy: null, statsContainer: null, msgId };
    }

    const wrapper = doc.createElement('div');
    wrapper.className = 'message-wrapper assistant';
    wrapper.setAttribute('data-msg-id', msgId);
    wrapper.setAttribute('data-base-id', baseId);

    const row = doc.createElement('div');
    row.className = 'message-row assistant';

    const contentWrapper = doc.createElement('div');
    contentWrapper.className = 'message-content-wrapper';

    const content = doc.createElement('div');
    content.className = 'message-content';
    content.innerHTML = '<span class="streaming-cursor initial-cursor"></span>';

    const footerRow = doc.createElement('div');
    footerRow.className = 'message-footer-row';

    const statsContainer = doc.createElement('div');
    statsContainer.className = 'message-stats';
    statsContainer.style.display = 'none';

    const actions = doc.createElement('div');
    actions.className = 'message-actions';
    actions.style.display = 'none';

    const btnCopy = doc.createElement('button');
    btnCopy.type = 'button';
    btnCopy.className = 'btn-msg-action btn-copy-full';
    btnCopy.innerHTML = getMsgIcon('copy', 14);
    btnCopy.title = t('btn_copy_title');
    btnCopy.setAttribute('aria-label', t('btn_copy_title'));

    const btnBranch = doc.createElement('button');
    btnBranch.type = 'button';
    btnBranch.className = 'btn-msg-action btn-branch-conversation';
    btnBranch.innerHTML = getMsgIcon('git-branch', 14);
    btnBranch.title = t('btn_branch_title');
    btnBranch.setAttribute('aria-label', t('btn_branch_title'));
    btnBranch.addEventListener('click', () => {
      if (typeof callbacks.onBranch === 'function') {
        callbacks.onBranch(wrapper);
      }
    });

    const btnDelete = doc.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn-msg-action btn-delete';
    btnDelete.innerHTML = getMsgIcon('trash', 14);
    btnDelete.title = t('btn_delete_ast_title');
    btnDelete.setAttribute('aria-label', t('btn_delete_ast_title'));
    btnDelete.addEventListener('click', () => {
      if (typeof callbacks.onDelete === 'function') {
        callbacks.onDelete(wrapper);
      } else {
        removeMessage(wrapper, { messagesList: container, welcomeBanner: callbacks.welcomeBanner, ...callbacks });
      }
    });

    actions.appendChild(btnBranch);
    actions.appendChild(btnCopy);
    actions.appendChild(btnDelete);

    footerRow.appendChild(statsContainer);
    footerRow.appendChild(actions);

    contentWrapper.appendChild(content);
    contentWrapper.appendChild(footerRow);

    row.appendChild(contentWrapper);
    wrapper.appendChild(row);

    if (container) {
      container.appendChild(wrapper);
      if (!existingMsgId && wrapper.classList?.add) {
        wrapper.classList.add('is-new-message');
        wrapper.addEventListener?.('animationend', () => wrapper.classList.remove('is-new-message'), { once: true });
      }
      scrollToBottom(container);
    }

    return { wrapper, row, content, footerRow, actions, btnCopy, statsContainer, msgId };
  }

  function renderSessionMessages(elements, history, options = {}) {
    const messagesList = elements?.messagesList;
    if (!messagesList) return;
    messagesList.innerHTML = '';

    const nonSystem = (history || []).filter(m => m && m.role !== 'system');
    let validMessages = nonSystem;
    if (nonSystem.length >= 2 &&
        isDateTimeInitialTurn(nonSystem[0]) &&
        nonSystem[1].role === 'assistant' &&
        (nonSystem[1].content === 'OK' || nonSystem[1].content === 'OK.')) {
      validMessages = nonSystem.slice(2);
    }

    if (validMessages.length === 0) {
      if (elements.welcomeBanner) {
        messagesList.appendChild(elements.welcomeBanner);
        elements.welcomeBanner.style.display = '';
      }
      if (typeof options.resetTelemetry === 'function') {
        options.resetTelemetry();
      }
      return;
    }

    if (elements.welcomeBanner) {
      elements.welcomeBanner.style.display = 'none';
    }

    const doc = messagesList.ownerDocument || document;
    const Markdown = getMarkdown();
    let i = 0;

    while (i < validMessages.length) {
      const msg = validMessages[i];

      if (msg.role === 'user') {
        let text = '';
        const images = msg.images ? [...msg.images] : [];
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find(c => c.type === 'text');
          text = textPart ? textPart.text : '';
          msg.content.forEach(c => {
            if (c.type === 'image_url' && c.image_url?.url) {
              if (!images.some(img => img.dataUrl === c.image_url.url)) {
                images.push({ name: 'Imagen adjunta', dataUrl: c.image_url.url });
              }
            }
          });
        }

        appendUserMessage(messagesList, elements.welcomeBanner, {
          text,
          originalPrompt: text,
          attachedImages: images,
          existingMsgId: msg.id
        }, options);

        i++;
      } else {
        const assistantGroup = [];
        const firstAssistantId = msg.id || ('msg_ast_' + Date.now());

        while (i < validMessages.length && validMessages[i].role !== 'user') {
          const item = validMessages[i];
          if (item && !item.id) {
            item.id = (typeof crypto !== 'undefined' && crypto.randomUUID)
              ? 'msg_ast_' + crypto.randomUUID()
              : 'msg_ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
          }
          assistantGroup.push(item);
          i++;
        }

        const groupMsgIds = assistantGroup.map(m => m.id).filter(Boolean);
        let groupBaseId = '';
        for (const item of assistantGroup) {
          if (item.id) {
            const base = extractBaseId(item.id);
            if (base && base !== item.id) {
              groupBaseId = base;
              break;
            }
          }
        }
        if (!groupBaseId && assistantGroup.length > 0 && assistantGroup[0].id) {
          groupBaseId = extractBaseId(assistantGroup[0].id) || assistantGroup[0].id;
        }

        const placeholderCallbacks = {
          welcomeBanner: elements.welcomeBanner,
          onBranch: options.onBranch,
          onDelete: options.onDelete,
          ...options
        };

        const { wrapper, content, actions, btnCopy } = createAssistantMessagePlaceholder(
          messagesList,
          groupBaseId || firstAssistantId,
          placeholderCallbacks
        );

        if (groupBaseId && wrapper) {
          wrapper.setAttribute('data-base-id', groupBaseId);
        }
        if (groupMsgIds.length > 0 && wrapper) {
          wrapper.setAttribute('data-msg-ids', groupMsgIds.join(','));
        }
        if (content) content.innerHTML = '';

        let fullAssistantMarkdown = '';

        for (let g = 0; g < assistantGroup.length; g++) {
          const item = assistantGroup[g];

          if (item.role === 'assistant') {
            if (item.content) {
              const turnBlock = doc.createElement('div');
              turnBlock.className = 'agentic-turn-block';
              turnBlock.innerHTML = Markdown?.renderMarkdown ? Markdown.renderMarkdown(item.content) : item.content;
              content?.appendChild(turnBlock);
              fullAssistantMarkdown += (fullAssistantMarkdown ? '\n\n' : '') + item.content;
            }

            if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
              item.tool_calls.forEach(tc => {
                const toolMsg = assistantGroup.find(m => m.role === 'tool' && (m.tool_call_id === tc.id || m.name === tc.function?.name));
                const cardEl = renderStoredToolCard(tc, toolMsg);
                if (cardEl && content) {
                  content.appendChild(cardEl);
                }
              });
            }
          }
        }

        if (content && content.children.length === 0) {
          const emptyText = t('no_text_response');
          const safeEmpty = Markdown?.escapeHtml ? Markdown.escapeHtml(emptyText) : emptyText;
          content.innerHTML = `<p><em>${safeEmpty}</em></p>`;
        }

        if (btnCopy) {
          btnCopy.onclick = async () => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              await navigator.clipboard.writeText(fullAssistantMarkdown || (content ? content.innerText : ''));
              btnCopy.innerHTML = getMsgIcon('check', 14);
              btnCopy.title = t('copied_text');
              btnCopy.setAttribute('aria-label', t('copied_text'));
              btnCopy.classList.add('copied');
              setTimeout(() => {
                btnCopy.innerHTML = getMsgIcon('copy', 14);
                btnCopy.title = t('btn_copy_title');
                btnCopy.setAttribute('aria-label', t('btn_copy_title'));
                btnCopy.classList.remove('copied');
              }, 2000);
            }
          };
        }

        if (actions) actions.style.display = 'inline-flex';

        if (content) {
          attachListenersToContainer(content, options);
        }
      }
    }

    scrollToBottom(messagesList);
    if (typeof options.updateTelemetry === 'function') {
      options.updateTelemetry();
    }
  }

  return {
    extractBaseId,
    isDateTimeInitialTurn,
    scrollToBottom,
    showTypingIndicator,
    removeTypingIndicator,
    renderStoredToolCard,
    attachListenersToContainer,
    removeMessage,
    appendUserMessage,
    createAssistantMessagePlaceholder,
    renderSessionMessages
  };
}));
