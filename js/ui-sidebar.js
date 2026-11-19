/**
 * Barra lateral: lista de conversaciones agrupada por fecha o por proyecto, su menú de acciones y la navegación
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

  const { escapeHtml, projectName, NO_PROJECT_NAME, resolveDep } = Utils;
  const getFilesPage = () => resolveDep('ChatFilesPage', './files-page.js');
  const { t } = I18n;

  const GROUP_LABEL_KEYS = {
    today: 'sidebar_group_today',
    yesterday: 'sidebar_group_yesterday',
    last7days: 'sidebar_group_last7days',
    last30days: 'sidebar_group_last30days',
    older: 'sidebar_group_older'
  };

  let cleanups = [];
  // Conversaciones pintadas por grupo: la lista no crece con el historial; "Mostrar más" añade otra tanda.
  const GROUP_PAGE_SIZE = 50;
  let groupLimits = {};
  // Proyectos desplegados en la vista de todos: se vacía cada vez que se elige, porque sirve de selector.
  let expandedGroups = new Set();
  const SEARCH_DEBOUNCE_MS = 180;
  let searchState = { seq: 0, query: '', ids: null, timer: null };

  const isMobile = () => window.innerWidth <= 768;

  /** Abre la barra; en móvil ocupa toda la pantalla, el chat queda inerte detrás y el foco pasa a la barra. */
  function openSidebar(elements) {
    elements.chatSidebar.classList.remove('sidebar-hidden');
    elements.chatSidebar.classList.add('sidebar-visible');
    elements.chatSidebar.hidden = false;
    elements.btnToggleSidebar.hidden = true;
    if (!isMobile()) return;
    elements.chatContainer.setAttribute('inert', '');
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

  function renderChatItem(session, date, isActive, runStatus = null) {
    const title = escapeHtml(session.title || t('chat_untitled'));
    const time = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const action = (className, icon, labelKey) => {
      const label = escapeHtml(t(labelKey));
      return `<button type="button" role="menuitem" class="btn-chat-action ${className}" title="${label}">${Icons.get(icon, { size: 13 })}<span>${label}</span></button>`;
    };
    const optionsLabel = escapeHtml(t('sidebar_chat_options_title'));
    let statusIcon = '';
    if (runStatus === 'running') {
      statusIcon = Icons.get('clock', { size: 13, className: 'sidebar-chat-status-icon running', title: t('sidebar_run_running_title') });
    } else if (runStatus === 'needs_input' || runStatus === 'error') {
      statusIcon = Icons.get('help-circle', { size: 13, className: 'sidebar-chat-status-icon needs-input', title: t('sidebar_run_needs_input_title') });
    }
    return `<div class="sidebar-chat-item${isActive ? ' active' : ''}" data-session-id="${escapeHtml(session.id)}"${runStatus ? ` data-run-status="${escapeHtml(runStatus)}"` : ''}>
        <div class="sidebar-chat-info">
          <span class="sidebar-chat-title" title="${title}">${statusIcon}${title}</span>
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


  const sessionDate = session => new Date(session.updatedAt || session.createdAt || Date.now());

  /**
   * Proyecto seleccionado en el filtro del historial: `null` para todos los proyectos, `''` para la
   * carpeta general, o la ruta del proyecto actual.
   */
  function getSelectedProject(select, project) {
    if (select.value === 'all') return null;
    return select.value === 'none' || !project ? '' : project;
  }

  /**
   * Selector de proyecto, siempre visible: el actual (la carpeta general sin servidor), general si el actual es
   * otro, y todos. Devuelve el proyecto de la vista, o null para la de todos.
   */
  function renderProjectFilter(select, project) {
    const current = select.querySelector('option[value="current"]');
    current.textContent = t('sidebar_project_current', { name: project ? projectName(project) : NO_PROJECT_NAME });
    current.title = project;
    const none = select.querySelector('option[value="none"]');
    none.hidden = !project;
    if (none.hidden && select.value === 'none') select.value = 'current';
    return getSelectedProject(select, project);
  }

  /**
   * Conversaciones en el orden en que se muestran, cada una con su grupo ({ key, kind, label, title },
   * de tipo 'date' o 'project'): las de un proyecto (`project`, vacío para la carpeta general), por fecha; y al
   * ver todos (null), por proyecto (el de conversación más reciente primero) con la carpeta general al final.
   * Las listas llegan de la más reciente a la más antigua.
   */
  function groupSessions(sessions, project) {
    const byDate = session => {
      const category = getChronologicalCategory(sessionDate(session));
      return { session, group: { key: category, kind: 'date', label: t(GROUP_LABEL_KEYS[category]) } };
    };
    if (project !== null) return sessions.filter(session => (session.project || '') === project).map(byDate);
    const noProject = { key: '', kind: 'project', label: NO_PROJECT_NAME };
    const projects = [...new Set(sessions.map(session => session.project).filter(Boolean))];
    return [
      ...projects.flatMap(path => sessions.filter(session => session.project === path)
        .map(session => ({ session, group: { key: path, kind: 'project', label: projectName(path), title: path } }))),
      ...sessions.filter(session => !session.project).map(session => ({ session, group: noProject }))
    ];
  }

  /** Agrupa las conversaciones consecutivas del mismo grupo: [{ group, sessions }]. */
  function toRuns(entries) {
    const runs = [];
    for (const { session, group } of entries) {
      const last = runs[runs.length - 1];
      if (last && last.group.key === group.key) last.sessions.push(session);
      else runs.push({ group, sessions: [session] });
    }
    return runs;
  }

  /**
   * Cabecera de un grupo: la de proyecto lleva carpeta y número de conversaciones para distinguirse de
   * las de fecha, y a su derecha los ficheros del proyecto (de la carpeta general, solo si se conoce su carpeta,
   * `noProjectDir`) y un botón que abre un chat nuevo en él. Con `expanded` booleano la cabecera es un
   * botón que pliega o despliega el grupo.
   */
  function renderGroupHeader(group, count, expanded = null, noProjectDir = '') {
    const label = `<span class="sidebar-group-label">${escapeHtml(group.label)}</span>`;
    if (group.kind !== 'project') return `<div class="sidebar-group-header">${label}</div>`;
    const title = group.title ? ` title="${escapeHtml(group.title)}"` : '';
    const content = `${Icons.get('folder', { size: 14 })}${label}<span class="sidebar-group-count">${count}</span>`;
    const header = expanded === null
      ? `<div class="sidebar-group-header sidebar-project-header"${title}>${content}</div>`
      : `<button type="button" class="sidebar-group-header sidebar-project-header sidebar-group-toggle" data-group-key="${escapeHtml(group.key)}" aria-expanded="${expanded}"${title}>${Icons.get('chevron-right', { size: 14, className: 'sidebar-group-chevron' })}${content}</button>`;
    const newChatLabel = escapeHtml(t('sidebar_project_new_chat_title', { name: group.label }));
    const filesLabel = escapeHtml(t('sidebar_project_files_title', { name: group.label }));
    const directory = group.key || noProjectDir;
    // Los ficheros del proyecto se abren en una pestaña propia (files.html), sin salir del chat.
    const files = directory ? `<a class="btn-project-files" href="files.html${escapeHtml(getFilesPage().pageUrl(directory, ''))}" target="_blank" rel="noopener" title="${filesLabel}" aria-label="${filesLabel}">${Icons.get('folder', { size: 14 })}</a>` : '';
    const newChat = `<button type="button" class="btn-project-new-chat" data-project="${escapeHtml(group.key)}" title="${newChatLabel}" aria-label="${newChatLabel}">${Icons.get('square-pen', { size: 14 })}</button>`;
    return `<div class="sidebar-project-group">${header}${files}${newChat}</div>`;
  }

  /**
   * Un proyecto de la vista de todos solo se ve desplegado si el usuario lo desplegó. Desplegar solo el
   * actual o el de la conversación abierta movía la lista al cambiar de proyecto con su icono, y el
   * siguiente toque (en la tablet, enseguida) caía en otra fila.
   */
  const isGroupExpanded = group => expandedGroups.has(group.key);

  /**
   * Lista de conversaciones de la vista elegida, agrupada. `project` es el del servidor (vacío sin
   * servidor o en la carpeta general) y `noProjectDir` la carpeta general, si se conoce. Con texto en el
   * buscador se filtra por título y solo quedan las cabeceras de proyecto de los grupos con
   * coincidencias, desplegados.
   */
  function renderSidebarChats(elements, sessions, currentSessionId, serverRuns, project, noProjectDir = '') {
    const filter = elements.sidebarSearchInput.value.toLowerCase().trim();
    const viewProject = renderProjectFilter(elements.sidebarProjectFilter, project);
    const showAll = viewProject === null;
    const visible = groupSessions(sessions, viewProject);
    const contentIds = filter && searchState.query === filter ? searchState.ids : null;
    const matching = filter
      ? visible.filter(({ session }) => session.title?.toLowerCase().includes(filter) || contentIds?.has(session.id))
      : visible;
    if (matching.length === 0) {
      const emptyKey = showAll || filter ? 'sidebar_no_chats' : 'sidebar_no_project_chats';
      elements.sidebarChatsList.innerHTML = `<div class="sidebar-no-chats">${escapeHtml(t(emptyKey))}</div>`;
      return;
    }
    const runStatusMap = new Map(serverRuns.map(run => [run.conversationId, run.status]));
    const renderItem = session => renderChatItem(session, sessionDate(session), session.id === currentSessionId, runStatusMap.get(session.id) || null);
    const renderChats = (group, items) => {
      const shown = items.slice(0, groupLimits[group.key] || GROUP_PAGE_SIZE);
      const rest = Math.min(items.length - shown.length, GROUP_PAGE_SIZE);
      const more = rest > 0 ? `<button type="button" class="sidebar-show-more" data-group-key="${escapeHtml(group.key)}">${escapeHtml(t('sidebar_show_more', { count: rest }))}</button>` : '';
      return shown.map(renderItem).join('') + more;
    };
    const collapsible = showAll && !filter;
    elements.sidebarChatsList.innerHTML = toRuns(matching).map(({ group, sessions: items }) => {
      const chats = () => renderChats(group, items);
      if (filter) return (group.kind === 'project' ? renderGroupHeader(group, items.length, null, noProjectDir) : '') + chats();
      if (!collapsible) return renderGroupHeader(group, items.length) + chats();
      // Un grupo plegado no pinta sus conversaciones: con miles serían miles de nodos ocultos.
      const expanded = isGroupExpanded(group);
      return renderGroupHeader(group, items.length, expanded, noProjectDir) + (expanded ? chats() : '');
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
   * onRenameSession, onDeleteSession, onExportSession, onNewSession, onNewProjectSession, que recibe el
   * proyecto, vacío para la carpeta general, y onDeleteAllSessions), el repintado de la lista (renderList,
   * también al buscar o cambiar el filtro de proyecto) y la navegación de ajustes (onOpenSettingsMode,
   * onBackToChats, onSelectSettingsSection).
   */
  function mount(elements, callbacks) {
    cleanups.forEach(cleanup => cleanup());
    cleanups = [];
    clearTimeout(searchState.timer);
    searchState = { seq: searchState.seq + 1, query: '', ids: null, timer: null };
    const setSearchStatus = text => {
      if (!elements.sidebarSearchStatus) return;
      elements.sidebarSearchStatus.textContent = text;
      elements.sidebarSearchStatus.hidden = !text;
    };
    setSearchStatus('');
    cleanups.push(() => {
      clearTimeout(searchState.timer);
      searchState = { seq: searchState.seq + 1, query: '', ids: null, timer: null };
      setSearchStatus('');
    });
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    const list = elements.sidebarChatsList;

    listen(elements.btnToggleSidebar, 'click', () => toggleSidebar(elements));
    listen(elements.btnCloseSidebar, 'click', () => closeSidebar(elements));
    listen(elements.btnCloseSidebarSettings, 'click', () => closeSidebar(elements));
    listen(elements.btnSidebarNewChat, 'click', () => callbacks.onNewSession());
    listen(elements.sidebarSearchInput, 'input', () => {
      callbacks.renderList();
      const query = elements.sidebarSearchInput.value.toLowerCase().trim();
      clearTimeout(searchState.timer);
      if (!query) {
        searchState = { seq: searchState.seq + 1, query: '', ids: null, timer: null };
        setSearchStatus('');
        return;
      }
      if (!callbacks.searchConversations || (query === searchState.query && searchState.ids)) {
        setSearchStatus('');
        return;
      }
      const seq = ++searchState.seq;
      setSearchStatus(t('sidebar_search_searching'));
      searchState.timer = setTimeout(async () => {
        try {
          const ids = await callbacks.searchConversations(query, progress => {
            if (seq !== searchState.seq || elements.sidebarSearchInput.value.toLowerCase().trim() !== query) return;
            if (progress?.phase === 'syncing') {
              setSearchStatus(t('sidebar_search_syncing', { done: progress.done, total: progress.total }));
            } else if (progress?.phase === 'searching') {
              setSearchStatus(t('sidebar_search_searching'));
            }
          });
          if (seq !== searchState.seq || elements.sidebarSearchInput.value.toLowerCase().trim() !== query) return;
          searchState = { seq, query, ids: ids instanceof Set ? ids : new Set(ids || []), timer: null };
          setSearchStatus('');
          callbacks.renderList();
        } catch (error) {
          if (seq === searchState.seq) setSearchStatus('');
          console.warn('[UISidebar] Conversation search failed:', error);
        }
      }, SEARCH_DEBOUNCE_MS);
    });
    listen(elements.sidebarProjectFilter, 'change', () => {
      expandedGroups = new Set();
      callbacks.renderList();
    });
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
      const showMore = event.target.closest('.sidebar-show-more');
      if (showMore) {
        const key = showMore.dataset.groupKey;
        groupLimits = { ...groupLimits, [key]: (groupLimits[key] || GROUP_PAGE_SIZE) + GROUP_PAGE_SIZE };
        // El foco sigue en el botón del grupo si aún quedan más; si no, en el menú de la última conversación pintada.
        const lastId = showMore.previousElementSibling.dataset.sessionId;
        callbacks.renderList();
        (list.querySelector(`.sidebar-show-more[data-group-key="${CSS.escape(key)}"]`)
          || list.querySelector(`[data-session-id="${CSS.escape(lastId)}"]`)?.nextElementSibling?.querySelector('.btn-chat-menu'))?.focus();
        return;
      }
      const newProjectChat = event.target.closest('.btn-project-new-chat');
      if (newProjectChat) {
        callbacks.onNewProjectSession(newProjectChat.dataset.project);
        return;
      }
      const toggle = event.target.closest('.sidebar-group-toggle');
      if (toggle) {
        const key = toggle.dataset.groupKey;
        expandedGroups = new Set(expandedGroups);
        if (toggle.getAttribute('aria-expanded') === 'true') expandedGroups.delete(key);
        else expandedGroups.add(key);
        callbacks.renderList();
        list.querySelector(`.sidebar-group-toggle[data-group-key="${CSS.escape(key)}"]`)?.focus();
        return;
      }
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
    getSelectedProject,
    getChronologicalCategory,
    mount
  };
});
