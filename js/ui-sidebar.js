/**
 * Barra lateral: lista de conversaciones agrupada por fecha, su menú de acciones y la navegación
 * de las secciones de ajustes.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'));
  } else {
    root.ChatUISidebar = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml } = Utils;
  const { t } = I18n;

  const GROUP_LABEL_KEYS = {
    today: 'sidebar_group_today',
    yesterday: 'sidebar_group_yesterday',
    last7days: 'sidebar_group_last7days',
    last30days: 'sidebar_group_last30days',
    older: 'sidebar_group_older'
  };

  let cleanups = [];

  const isMobile = () => window.innerWidth <= 768;

  /** Abre la barra; en móvil el chat queda inerte detrás del fondo y el foco pasa a la barra. */
  function openSidebar(elements) {
    elements.chatSidebar.classList.remove('sidebar-hidden');
    elements.chatSidebar.classList.add('sidebar-visible');
    elements.chatSidebar.hidden = false;
    elements.btnToggleSidebar.hidden = true;
    if (!isMobile()) return;
    elements.chatContainer.setAttribute('inert', '');
    elements.sidebarBackdrop.classList.add('visible');
    requestAnimationFrame(() => {
      elements.chatSidebar.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    });
  }

  function closeSidebar(elements) {
    elements.chatSidebar.classList.add('sidebar-hidden');
    elements.chatSidebar.classList.remove('sidebar-visible');
    elements.chatSidebar.hidden = true;
    elements.btnToggleSidebar.hidden = false;
    elements.chatContainer.removeAttribute('inert');
    elements.sidebarBackdrop.classList.remove('visible');
  }

  function toggleSidebar(elements) {
    if (elements.chatSidebar.classList.contains('sidebar-hidden')) openSidebar(elements);
    else closeSidebar(elements);
  }

  /** Muestra la lista de conversaciones ('chat') o la de secciones de ajustes ('settings'). */
  function setSidebarMode(elements, mode = 'chat') {
    const settings = mode === 'settings';
    elements.sidebarViewChat.hidden = settings;
    elements.sidebarViewSettings.hidden = !settings;
    elements.chatSidebar.classList.toggle('mode-settings', settings);
    if (!settings) setActiveSettingsSection(elements, '');
  }

  function setActiveSettingsSection(elements, sectionId = '') {
    elements.sidebarSettingsItems.forEach(item => item.classList.toggle('active', item.dataset.section === sectionId));
  }

  /** Grupo de la barra para una fecha: hoy, ayer, últimos 7 o 30 días naturales, o anterior. */
  function getChronologicalCategory(date) {
    const now = new Date();
    // Inicio del día natural de hace `days` días: con cambio de hora un día no dura 24 h.
    const dayStart = days => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
    const time = new Date(date).getTime();
    if (time >= dayStart(0)) return 'today';
    if (time >= dayStart(1)) return 'yesterday';
    if (time >= dayStart(7)) return 'last7days';
    if (time >= dayStart(30)) return 'last30days';
    return 'older';
  }

  function renderChatItem(session, date, isActive) {
    const title = escapeHtml(session.title || t('chat_untitled'));
    const time = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const action = (className, icon, labelKey) => {
      const label = escapeHtml(t(labelKey));
      return `<button type="button" role="menuitem" class="btn-chat-action ${className}" title="${label}">${Icons.get(icon, { size: 13 })}<span>${label}</span></button>`;
    };
    const optionsLabel = escapeHtml(t('sidebar_chat_options_title'));
    return `<div class="sidebar-chat-item${isActive ? ' active' : ''}" data-session-id="${escapeHtml(session.id)}">
        <div class="sidebar-chat-info">
          <span class="sidebar-chat-title" title="${title}">${title}</span>
          <span class="sidebar-chat-time">${time}</span>
        </div>
        <div class="sidebar-chat-menu">
          <button type="button" class="btn-chat-menu" aria-haspopup="menu" aria-expanded="false" title="${optionsLabel}" aria-label="${optionsLabel}">${Icons.get('more-vertical', { size: 18 })}</button>
          <div class="sidebar-chat-actions" role="menu" hidden>
            ${action('btn-export', 'download', 'sidebar_export_chat_title')}
            ${action('btn-rename', 'edit', 'sidebar_rename_chat_title')}
            ${action('btn-delete', 'trash', 'sidebar_delete_chat_title')}
          </div>
        </div>
      </div>`;
  }

  /** Lista de conversaciones filtrada por el buscador; sin filtro, agrupada por fecha. */
  function renderSidebarChats(elements, sessions, currentSessionId) {
    const filter = elements.sidebarSearchInput.value.toLowerCase().trim();
    const matching = filter ? sessions.filter(session => session.title?.toLowerCase().includes(filter)) : sessions;
    if (matching.length === 0) {
      elements.sidebarChatsList.innerHTML = `<div class="sidebar-no-chats">${escapeHtml(t('sidebar_no_chats'))}</div>`;
      return;
    }
    let currentCategory = null;
    elements.sidebarChatsList.innerHTML = matching.map(session => {
      const date = new Date(session.updatedAt || session.createdAt || Date.now());
      let header = '';
      const category = getChronologicalCategory(date);
      if (!filter && category !== currentCategory) {
        currentCategory = category;
        header = `<div class="sidebar-group-header">${escapeHtml(t(GROUP_LABEL_KEYS[category]))}</div>`;
      }
      return header + renderChatItem(session, date, session.id === currentSessionId);
    }).join('');
  }

  function closeChatMenus(list) {
    list.querySelectorAll('.sidebar-chat-actions:not([hidden])').forEach(menu => {
      menu.hidden = true;
      menu.closest('.sidebar-chat-menu').querySelector('.btn-chat-menu').setAttribute('aria-expanded', 'false');
    });
  }

  /**
   * Conecta la barra. `callbacks` aporta las acciones de las conversaciones (onSwitchSession,
   * onRenameSession, onDeleteSession, onExportSession, onNewSession, onSearchInput,
   * onDeleteAllSessions) y de la navegación de ajustes (onOpenSettingsMode, onBackToChats,
   * onSelectSettingsSection).
   */
  function mount(elements, callbacks) {
    cleanups.forEach(cleanup => cleanup());
    cleanups = [];
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    const list = elements.sidebarChatsList;

    listen(elements.btnToggleSidebar, 'click', () => toggleSidebar(elements));
    listen(elements.btnCloseSidebar, 'click', () => closeSidebar(elements));
    listen(elements.sidebarBackdrop, 'click', () => closeSidebar(elements));
    listen(elements.btnCloseSidebarSettings, 'click', () => closeSidebar(elements));
    listen(elements.btnSidebarNewChat, 'click', () => callbacks.onNewSession());
    listen(elements.sidebarSearchInput, 'input', () => callbacks.onSearchInput(elements.sidebarSearchInput.value));
    listen(elements.btnDeleteAllChats, 'click', () => callbacks.onDeleteAllSessions());
    listen(elements.btnOpenSettings, 'click', () => {
      setSidebarMode(elements, 'settings');
      callbacks.onOpenSettingsMode();
    });
    listen(elements.btnOpenConnection, 'click', () => callbacks.onOpenConnection());
    listen(elements.btnSidebarBackToChats, 'click', () => {
      setSidebarMode(elements, 'chat');
      callbacks.onBackToChats();
    });
    // Los botones de las navegaciones secundarias comparten la clase pero no abren una sección.
    elements.sidebarSettingsItems.forEach(item => {
      if (item.dataset.section) listen(item, 'click', () => callbacks.onSelectSettingsSection(item.dataset.section));
    });

    const actions = { 'btn-export': callbacks.onExportSession, 'btn-rename': callbacks.onRenameSession, 'btn-delete': callbacks.onDeleteSession };
    listen(list, 'click', event => {
      const item = event.target.closest('.sidebar-chat-item');
      if (!item) return;
      const sessionId = item.dataset.sessionId;
      const menuButton = event.target.closest('.btn-chat-menu');
      if (menuButton) {
        const menu = item.querySelector('.sidebar-chat-actions');
        const willOpen = menu.hidden;
        closeChatMenus(list);
        menu.hidden = !willOpen;
        menuButton.setAttribute('aria-expanded', String(willOpen));
        return;
      }
      const actionButton = event.target.closest('.btn-chat-action');
      if (actionButton) {
        closeChatMenus(list);
        const className = Object.keys(actions).find(name => actionButton.classList.contains(name));
        actions[className](sessionId, event);
        return;
      }
      if (!event.target.closest('.sidebar-chat-menu')) callbacks.onSwitchSession(sessionId);
    });
    listen(list, 'keydown', event => {
      if (event.key !== 'Escape') return;
      const menu = event.target.closest('.sidebar-chat-menu');
      if (!menu || menu.querySelector('.sidebar-chat-actions').hidden) return;
      event.preventDefault();
      closeChatMenus(list);
      menu.querySelector('.btn-chat-menu').focus();
    });
  }

  return {
    isMobile,
    setSidebarMode,
    setActiveSettingsSection,
    openSidebar,
    closeSidebar,
    renderSidebarChats,
    getChronologicalCategory,
    mount
  };
});
