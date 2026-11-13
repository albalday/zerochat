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

  const { escapeHtml, projectName } = Utils;
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
  // Proyectos que el usuario ha plegado (false) o desplegado (true) en la vista de todos; el resto sigue la regla por defecto.
  let projectGroupChoices = {};
  let renderedProjectKeys = [];

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

  /** Selector de proyecto: solo con un proyecto, con su nombre en la primera opción. Devuelve si se ven todos. */
  function renderProjectFilter(select, project) {
    select.hidden = !project;
    if (!project) return false;
    const current = select.querySelector('option[value="current"]');
    current.textContent = t('sidebar_project_current', { name: projectName(project) });
    current.title = project;
    return select.value === 'all';
  }

  /**
   * Conversaciones en el orden en que se muestran, cada una con su grupo ({ key, kind, label, title },
   * de tipo 'date' o 'project'):
   * sin proyecto, todas por fecha; con proyecto, las suyas por fecha y después las que no tienen
   * ninguno; y al ver todos, por proyecto (el de conversación más reciente primero) con las que no
   * tienen ninguno al final. Las listas llegan de la más reciente a la más antigua.
   */
  function groupSessions(sessions, project, showAll) {
    const byDate = session => {
      const category = getChronologicalCategory(sessionDate(session));
      return { session, group: { key: category, kind: 'date', label: t(GROUP_LABEL_KEYS[category]) } };
    };
    const noProject = { key: '', kind: 'project', label: t('sidebar_no_project') };
    const orphans = sessions.filter(session => !session.project).map(session => ({ session, group: noProject }));
    if (!project) return sessions.map(byDate);
    if (!showAll) return [...sessions.filter(session => session.project === project).map(byDate), ...orphans];
    const projects = [...new Set(sessions.map(session => session.project).filter(Boolean))];
    return [
      ...projects.flatMap(path => sessions.filter(session => session.project === path)
        .map(session => ({ session, group: { key: path, kind: 'project', label: projectName(path), title: path } }))),
      ...orphans
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
   * las de fecha. Con `expanded` booleano es un botón que pliega o despliega el grupo.
   */
  function renderGroupHeader(group, count, expanded = null) {
    const label = `<span class="sidebar-group-label">${escapeHtml(group.label)}</span>`;
    if (group.kind !== 'project') return `<div class="sidebar-group-header">${label}</div>`;
    const title = group.title ? ` title="${escapeHtml(group.title)}"` : '';
    const content = `${Icons.get('folder', { size: 14 })}${label}<span class="sidebar-group-count">${count}</span>`;
    if (expanded === null) return `<div class="sidebar-group-header sidebar-project-header"${title}>${content}</div>`;
    return `<button type="button" class="sidebar-group-header sidebar-project-header sidebar-group-toggle" data-group-key="${escapeHtml(group.key)}" aria-expanded="${expanded}"${title}>${Icons.get('chevron-right', { size: 14, className: 'sidebar-group-chevron' })}${content}</button>`;
  }

  /** Un proyecto de la vista de todos se ve desplegado si el usuario lo eligió o, si no, si es el actual o tiene la conversación abierta. */
  function isGroupExpanded(group, sessions, project, currentSessionId) {
    if (Object.hasOwn(projectGroupChoices, group.key)) return projectGroupChoices[group.key] === true;
    return group.key === project || sessions.some(session => session.id === currentSessionId);
  }

  /**
   * Lista de conversaciones de la vista elegida, agrupada. Con texto en el buscador se filtra por título
   * y solo quedan las cabeceras de proyecto de los grupos con coincidencias, desplegados.
   */
  function renderSidebarChats(elements, sessions, currentSessionId, serverRuns, project) {
    const filter = elements.sidebarSearchInput.value.toLowerCase().trim();
    const showAll = renderProjectFilter(elements.sidebarProjectFilter, project);
    const visible = groupSessions(sessions, project, showAll);
    const matching = filter ? visible.filter(({ session }) => session.title?.toLowerCase().includes(filter)) : visible;
    if (matching.length === 0) {
      const emptyKey = project && !showAll ? 'sidebar_no_project_chats' : 'sidebar_no_chats';
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
    const runs = toRuns(matching);
    if (collapsible) renderedProjectKeys = runs.map(({ group }) => group.key);
    elements.sidebarChatsList.innerHTML = runs.map(({ group, sessions: items }) => {
      const chats = () => renderChats(group, items);
      if (filter) return (group.kind === 'project' ? renderGroupHeader(group, items.length) : '') + chats();
      if (!collapsible) return renderGroupHeader(group, items.length) + chats();
      // Un grupo plegado no pinta sus conversaciones: con miles serían miles de nodos ocultos.
      const expanded = isGroupExpanded(group, items, project, currentSessionId);
      return renderGroupHeader(group, items.length, expanded) + (expanded ? chats() : '');
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
   * onRenameSession, onDeleteSession, onExportSession, onNewSession, onDeleteAllSessions), el
   * repintado de la lista (renderList, también al buscar o cambiar el filtro de proyecto), los proyectos
   * plegados (loadProjectGroups, que devuelve las elecciones guardadas, y onProjectGroupsChange, que las
   * recibe para guardarlas) y la navegación de ajustes (onOpenSettingsMode, onBackToChats, onSelectSettingsSection).
   */
  function mount(elements, callbacks) {
    cleanups.forEach(cleanup => cleanup());
    cleanups = [];
    const listen = (target, type, handler) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };
    const list = elements.sidebarChatsList;
    projectGroupChoices = callbacks.loadProjectGroups();

    listen(elements.btnToggleSidebar, 'click', () => toggleSidebar(elements));
    listen(elements.btnCloseSidebar, 'click', () => closeSidebar(elements));
    listen(elements.sidebarBackdrop, 'click', () => closeSidebar(elements));
    listen(elements.btnCloseSidebarSettings, 'click', () => closeSidebar(elements));
    listen(elements.btnSidebarNewChat, 'click', () => callbacks.onNewSession());
    listen(elements.sidebarSearchInput, 'input', () => callbacks.renderList());
    listen(elements.sidebarProjectFilter, 'change', () => callbacks.renderList());
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
      const toggle = event.target.closest('.sidebar-group-toggle');
      if (toggle) {
        const key = toggle.dataset.groupKey;
        // Solo se guardan las elecciones de proyectos que aún tienen conversaciones.
        projectGroupChoices = Object.fromEntries(Object.entries({ ...projectGroupChoices, [key]: toggle.getAttribute('aria-expanded') !== 'true' })
          .filter(([groupKey]) => renderedProjectKeys.includes(groupKey)));
        callbacks.onProjectGroupsChange(projectGroupChoices);
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
    getChronologicalCategory,
    mount
  };
});
