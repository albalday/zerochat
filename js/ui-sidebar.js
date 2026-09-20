/**
 * Módulo de Interfaz de Usuario para Barra Lateral y Gestión de Sesiones de Chat.
 * ZeroChat - js/ui-sidebar.js
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatUISidebar = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function resolveDep(globalName, relPath) {
    if (typeof window !== 'undefined' && window[globalName]) return window[globalName];
    if (typeof require !== 'undefined') { try { return require(relPath); } catch (e) { return null; } }
    return null;
  }

  const getI18n = () => resolveDep('ChatI18n', './i18n.js');
  const getMarkdown = () => resolveDep('ChatMarkdown', './markdown.js');
  const getIcons = () => resolveDep('ChatIcons', './icons.js');

  function t(key, params) {
    const I18n = getI18n();
    if (I18n && typeof I18n.t === 'function') return I18n.t(key, params);
    return key;
  }

  function escapeHtml(str) {
    const Markdown = getMarkdown();
    if (Markdown && typeof Markdown.escapeHtml === 'function') {
      return Markdown.escapeHtml(str);
    }
    return String(str || '').replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return m;
      }
    });
  }

  function isMobile() {
    return typeof window !== 'undefined' && window.innerWidth <= 768;
  }

  function openSidebar(elements) {
    if (!elements || !elements.chatSidebar) return;
    if (elements.chatSidebar.classList) {
      elements.chatSidebar.classList.remove('sidebar-hidden');
      elements.chatSidebar.classList.add('sidebar-visible');
    }
    if (elements.chatSidebar.style) {
      elements.chatSidebar.style.display = 'flex';
    }
    if (elements.btnToggleSidebar && elements.btnToggleSidebar.style) {
      elements.btnToggleSidebar.style.display = 'none';
    }
    if (isMobile()) {
      const chatContainer = (typeof document !== 'undefined') ? (
        document.getElementById('chat-container') ||
        document.querySelector('main') ||
        document.querySelector('.chat-container')
      ) : null;
      if (chatContainer && chatContainer.setAttribute) chatContainer.setAttribute('inert', '');
      const backdrop = elements?.sidebarBackdrop || ((typeof document !== 'undefined') ? document.getElementById('sidebar-backdrop') : null);
      if (backdrop && backdrop.classList) backdrop.classList.add('visible');
      if (typeof requestAnimationFrame === 'function' && elements.chatSidebar.querySelector) {
        requestAnimationFrame(() => {
          const firstFocusable = elements.chatSidebar.querySelector(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          if (firstFocusable && typeof firstFocusable.focus === 'function') firstFocusable.focus();
        });
      }
    }
  }

  function closeSidebar(elements) {
    if (!elements || !elements.chatSidebar) return;
    if (elements.chatSidebar.classList) {
      elements.chatSidebar.classList.add('sidebar-hidden');
      elements.chatSidebar.classList.remove('sidebar-visible');
    }
    if (elements.chatSidebar.style) {
      elements.chatSidebar.style.display = 'none';
    }
    if (elements.btnToggleSidebar && elements.btnToggleSidebar.style) {
      elements.btnToggleSidebar.style.display = 'inline-flex';
    }
    const chatContainer = (typeof document !== 'undefined') ? (
      document.getElementById('chat-container') ||
      document.querySelector('main') ||
      document.querySelector('.chat-container')
    ) : null;
    if (chatContainer && chatContainer.removeAttribute) chatContainer.removeAttribute('inert');
    const backdrop = elements?.sidebarBackdrop || ((typeof document !== 'undefined') ? document.getElementById('sidebar-backdrop') : null);
    if (backdrop && backdrop.classList) backdrop.classList.remove('visible');
  }

  function toggleSidebar(elements) {
    if (!elements || !elements.chatSidebar) return;
    const isHidden = elements.chatSidebar.classList
      ? elements.chatSidebar.classList.contains('sidebar-hidden')
      : (elements.chatSidebar.style && (elements.chatSidebar.style.display === 'none' || !elements.chatSidebar.style.display));
    if (isHidden) {
      openSidebar(elements);
    } else {
      closeSidebar(elements);
    }
  }
  function getSidebarMode(elements) {
    const settingsView = elements?.sidebarViewSettings || (typeof document !== 'undefined' ? document.getElementById('sidebar-view-settings') : null);
    if (settingsView && !settingsView.hidden && settingsView.style?.display !== 'none') {
      return 'settings';
    }
    return 'chat';
  }

  function setSidebarMode(elements, mode = 'chat') {
    if (!elements) return;
    const chatView = elements.sidebarViewChat || (typeof document !== 'undefined' ? document.getElementById('sidebar-view-chat') : null);
    const settingsView = elements.sidebarViewSettings || (typeof document !== 'undefined' ? document.getElementById('sidebar-view-settings') : null);

    if (mode === 'settings') {
      if (chatView) {
        chatView.hidden = true;
        if (chatView.style) chatView.style.display = 'none';
      }
      if (settingsView) {
        settingsView.hidden = false;
        if (settingsView.style) settingsView.style.display = 'flex';
      }
      if (elements.chatSidebar?.classList) {
        elements.chatSidebar.classList.add('mode-settings');
      }
    } else {
      if (settingsView) {
        settingsView.hidden = true;
        if (settingsView.style) settingsView.style.display = 'none';
      }
      if (chatView) {
        chatView.hidden = false;
        if (chatView.style) chatView.style.display = 'flex';
      }
      if (elements.chatSidebar?.classList) {
        elements.chatSidebar.classList.remove('mode-settings');
      }
      setActiveSettingsSection(elements, '');
    }
  }

  function setActiveSettingsSection(elements, sectionId = '') {
    const items = elements?.sidebarSettingsItems || (typeof document !== 'undefined' ? document.querySelectorAll('#sidebar-settings-nav .sidebar-settings-item') : []);
    items.forEach(item => {
      const match = (item.dataset?.section || item.getAttribute?.('data-section')) === sectionId;
      if (item.classList) {
        if (match) item.classList.add('active');
        else item.classList.remove('active');
      }
    });
  }


  function filterSessions(sessions, filterText = '') {
    if (!Array.isArray(sessions)) return [];
    const filter = String(filterText || '').toLowerCase().trim();
    if (!filter) return sessions;
    return sessions.filter(s => {
      if (s.title && s.title.toLowerCase().includes(filter)) return true;
      return false;
    });
  }

  function getChronologicalCategory(date) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const last7Days = today - (7 * 86400000);
    const last30Days = today - (30 * 86400000);

    const d = new Date(date).getTime();
    if (d >= today) return 'today';
    if (d >= yesterday) return 'yesterday';
    if (d >= last7Days) return 'last7days';
    if (d >= last30Days) return 'last30days';
    return 'older';
  }

  function getCategoryLabel(category) {
    switch (category) {
      case 'today': return t('sidebar_group_today', 'Hoy');
      case 'yesterday': return t('sidebar_group_yesterday', 'Ayer');
      case 'last7days': return t('sidebar_group_last7days', 'Últimos 7 días');
      case 'last30days': return t('sidebar_group_last30days', 'Últimos 30 días');
      case 'older': return t('sidebar_group_older', 'Anteriores');
      default: return '';
    }
  }

  function renderSidebarChats(elements, savedSessions, currentSessionId, callbacks = {}, options = {}) {
    if (!elements || !elements.sidebarChatsList) return;
    elements.sidebarChatsList.innerHTML = '';

    const filterText = elements.sidebarSearchInput ? elements.sidebarSearchInput.value : '';
    const matching = filterSessions(savedSessions, filterText);

    const doc = elements.sidebarChatsList.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    if (matching.length === 0) {
      const emptyDiv = doc.createElement('div');
      emptyDiv.className = 'sidebar-no-chats';
      emptyDiv.style.cssText = 'padding: 1rem; text-align: center; color: var(--text-muted); font-size: 0.8rem;';
      emptyDiv.textContent = t('sidebar_no_chats');
      elements.sidebarChatsList.appendChild(emptyDiv);
      return;
    }

    const Icons = getIcons();
    const exportSvg = Icons && typeof Icons.get === 'function' ? Icons.get('download', { size: 13 }) : '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
    const editSvg = Icons && typeof Icons.get === 'function' ? Icons.get('edit', { size: 13 }) : '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    const trashSvg = Icons && typeof Icons.get === 'function' ? Icons.get('trash', { size: 13 }) : '<svg class="ui-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';

    let currentCategory = null;
    matching.forEach(s => {
      const d = new Date(s.updatedAt || s.createdAt || Date.now());

      if (options && options.groupByDate && !filterText) {
        const cat = getChronologicalCategory(d);
        if (cat !== currentCategory) {
          currentCategory = cat;
          const groupHeader = doc.createElement('div');
          groupHeader.className = 'sidebar-group-header';
          groupHeader.textContent = getCategoryLabel(cat);
          elements.sidebarChatsList.appendChild(groupHeader);
        }
      }

      const item = doc.createElement('div');
      item.className = 'sidebar-chat-item' + (s.id === currentSessionId ? ' active' : '');
      item.setAttribute('data-session-id', s.id);

      const timeStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const rawTitle = s.title || t('chat_untitled') || 'Nueva conversación';
      const safeTitle = escapeHtml(rawTitle);

      item.innerHTML = `
        <div class="sidebar-chat-info">
          <span class="sidebar-chat-title" title="${safeTitle}">${safeTitle}</span>
          <span class="sidebar-chat-time">${timeStr}</span>
        </div>
        <div class="sidebar-chat-actions">
          <button type="button" class="btn-chat-action btn-export" title="${escapeHtml(t('sidebar_export_chat_title') || t('btn_export_chat_title') || 'Exportar chat')}">${exportSvg}</button>
          <button type="button" class="btn-chat-action btn-rename" title="${escapeHtml(t('sidebar_rename_chat_title') || 'Renombrar chat')}">${editSvg}</button>
          <button type="button" class="btn-chat-action btn-delete" title="${escapeHtml(t('sidebar_delete_chat_title') || 'Eliminar chat')}">${trashSvg}</button>
        </div>
      `;

      item.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.sidebar-chat-actions')) return;
        if (typeof callbacks.onSwitchSession === 'function') {
          callbacks.onSwitchSession(s.id);
        }
      });

      const btnExport = item.querySelector('.btn-export');
      if (btnExport) {
        btnExport.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (typeof callbacks.onExportSession === 'function') {
            callbacks.onExportSession(s.id, e);
          }
        });
      }

      const btnRename = item.querySelector('.btn-rename');
      if (btnRename) {
        btnRename.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (typeof callbacks.onRenameSession === 'function') {
            callbacks.onRenameSession(s.id, e);
          }
        });
      }

      const btnDelete = item.querySelector('.btn-delete');
      if (btnDelete) {
        btnDelete.addEventListener('click', (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          if (typeof callbacks.onDeleteSession === 'function') {
            callbacks.onDeleteSession(s.id, e);
          }
        });
      }

      elements.sidebarChatsList.appendChild(item);
    });
  }

  let activeCleanupFns = [];
  let cachedElements = null;

  function mount(elements, callbacks = {}) {
    dispose();
    cachedElements = elements || {};
    const els = cachedElements;

    if (els.btnToggleSidebar) {
      const onToggle = () => toggleSidebar(els);
      els.btnToggleSidebar.addEventListener('click', onToggle);
      activeCleanupFns.push(() => els.btnToggleSidebar.removeEventListener('click', onToggle));
    }

    if (els.btnCloseSidebar) {
      const onClose = () => closeSidebar(els);
      els.btnCloseSidebar.addEventListener('click', onClose);
      activeCleanupFns.push(() => els.btnCloseSidebar.removeEventListener('click', onClose));
    }

    if (els.sidebarBackdrop) {
      const onBackdrop = () => closeSidebar(els);
      els.sidebarBackdrop.addEventListener('click', onBackdrop);
      activeCleanupFns.push(() => els.sidebarBackdrop.removeEventListener('click', onBackdrop));
    }

    if (els.btnSidebarNewChat) {
      const onNew = () => {
        if (typeof callbacks.onNewSession === 'function') callbacks.onNewSession();
      };
      els.btnSidebarNewChat.addEventListener('click', onNew);
      activeCleanupFns.push(() => els.btnSidebarNewChat.removeEventListener('click', onNew));
    }

    if (els.sidebarSearchInput) {
      const onSearch = () => {
        if (typeof callbacks.onSearchInput === 'function') {
          callbacks.onSearchInput(els.sidebarSearchInput.value);
        }
      };
      els.sidebarSearchInput.addEventListener('input', onSearch);
      activeCleanupFns.push(() => els.sidebarSearchInput.removeEventListener('input', onSearch));
    }

    if (els.btnDeleteAllChats) {
      const onDeleteAll = () => {
        if (typeof callbacks.onDeleteAllSessions === 'function') callbacks.onDeleteAllSessions();
      };
      els.btnDeleteAllChats.addEventListener('click', onDeleteAll);
      activeCleanupFns.push(() => els.btnDeleteAllChats.removeEventListener('click', onDeleteAll));
    }

    if (els.btnImportChatFile && els.importJsonInput) {
      const onImportClick = () => els.importJsonInput.click();
      els.btnImportChatFile.addEventListener('click', onImportClick);
      activeCleanupFns.push(() => els.btnImportChatFile.removeEventListener('click', onImportClick));

      const onImportChange = (e) => {
        if (typeof callbacks.onImportFileSelected === 'function') {
          callbacks.onImportFileSelected(e);
        }
      };
      els.importJsonInput.addEventListener('change', onImportChange);
      activeCleanupFns.push(() => els.importJsonInput.removeEventListener('change', onImportChange));
    }
    if (els.btnOpenSettings) {
      const onOpenSettings = () => {
        setSidebarMode(els, 'settings');
        if (typeof callbacks.onOpenSettingsMode === 'function') callbacks.onOpenSettingsMode();
      };
      els.btnOpenSettings.addEventListener('click', onOpenSettings);
      activeCleanupFns.push(() => els.btnOpenSettings.removeEventListener('click', onOpenSettings));
    }

    if (els.btnSidebarBackToChats) {
      const onBackToChats = () => {
        setSidebarMode(els, 'chat');
        if (typeof callbacks.onBackToChats === 'function') callbacks.onBackToChats();
      };
      els.btnSidebarBackToChats.addEventListener('click', onBackToChats);
      activeCleanupFns.push(() => els.btnSidebarBackToChats.removeEventListener('click', onBackToChats));
    }

    if (els.btnCloseSidebarSettings) {
      const onCloseSettings = () => closeSidebar(els);
      els.btnCloseSidebarSettings.addEventListener('click', onCloseSettings);
      activeCleanupFns.push(() => els.btnCloseSidebarSettings.removeEventListener('click', onCloseSettings));
    }

    if (els.sidebarSettingsItems) {
      els.sidebarSettingsItems.forEach(item => {
        const onSelect = () => {
          const sectionId = item.dataset?.section || item.getAttribute('data-section');
          if (typeof callbacks.onSelectSettingsSection === 'function') {
            callbacks.onSelectSettingsSection(sectionId);
          }
        };
        item.addEventListener('click', onSelect);
        activeCleanupFns.push(() => item.removeEventListener('click', onSelect));
      });
    }
  }

  function dispose() {
    activeCleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    activeCleanupFns = [];
    cachedElements = null;
  }

  return {
    isMobile,
    getSidebarMode,
    setSidebarMode,
    setActiveSettingsSection,
    toggleSidebar,
    openSidebar,
    closeSidebar,
    filterSessions,
    getChronologicalCategory,
    renderSidebarChats,
    mount,
    dispose
  };
});
