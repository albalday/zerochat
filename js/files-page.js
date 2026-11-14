/**
 * Navegador de ficheros del proyecto (files.html): una página aparte, abierta desde el historial, que
 * conecta con la sesión guardada en la cookie (la misma que usa la aplicación) sin cargar la aplicación
 * entera. El proyecto viaja en la URL (`?project=`) y en la cabecera X-ZeroChat-Project de cada petición;
 * el servidor no deja salir de su carpeta (zerochat/files/*).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./defaults.js'), require('./storage.js'), require('./backend-session.js'), require('./mcp.js'));
  } else {
    root.ChatFilesPage = factory(root.ChatUtils, root.ChatI18n, root.ChatDefaults, root.ChatStorage, root.ChatBackendSession, root.ChatMCP);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Defaults, Storage, BackendSession, MCP) {
  'use strict';
  const { projectName } = Utils;
  const { t } = I18n;
  const PROJECT_GONE_CODE = -32003;

  /** Proyecto y carpeta de la URL de la página; la carpeta es relativa al proyecto ('' es su raíz). */
  function readPageParams(search) {
    const params = new URLSearchParams(search);
    return { project: (params.get('project') || '').trim(), path: (params.get('path') || '').replace(/^\/+|\/+$/g, '') };
  }

  /** URL de la página para otra carpeta del mismo proyecto. */
  function pageUrl(project, path) {
    const params = new URLSearchParams({ project });
    if (path) params.set('path', path);
    return `?${params.toString()}`;
  }

  /** Clave del texto que explica por qué no se puede mostrar el proyecto. */
  function errorKey(error) {
    if (error?.status === 401) return 'files_error_login';
    if (error?.rpcError?.code === PROJECT_GONE_CODE) return 'files_error_project_gone';
    if (error?.rpcError) return null;
    return 'files_error_unreachable';
  }

  /** Cliente de zerochat/files/* para el proyecto, con la sesión guardada; null si no hay sesión. */
  function createFilesClient(project) {
    const connection = BackendSession.sessionConnection(Storage.getBackendSession(), Storage.loadRuntimeConfigV2() || {}, Defaults.LOCAL_BACKEND_URL);
    if (!connection) return null;
    const client = new MCP.McpClient({
      id: 'files_page',
      name: 'zerochat',
      url: connection.url,
      token: connection.token,
      headers: { ...MCP.proxyHeaders(connection.proxyKey), 'X-ZeroChat-Project': encodeURIComponent(project) }
    });
    return {
      list: path => client.request('zerochat/files/list', { path }),
      read: path => client.request('zerochat/files/read', { path }),
      download: (path, offset) => client.request('zerochat/files/download', { path, offset })
    };
  }

  function applyPreferences() {
    const config = Storage.loadRuntimeConfigV2() || {};
    I18n.setLanguage(config.language);
    if (config.theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  function showStatus(elements, text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle('files-status-error', isError);
    elements.status.hidden = !text;
  }

  function mount(doc = document) {
    const elements = {
      title: doc.getElementById('files-project'),
      status: doc.getElementById('files-status'),
      list: doc.getElementById('files-list')
    };
    applyPreferences();
    const { project } = readPageParams(location.search);
    if (!project) {
      showStatus(elements, t('files_error_no_project'), true);
      return null;
    }
    elements.title.textContent = projectName(project);
    elements.title.title = project;
    doc.title = `${projectName(project)} · ${t('files_title')}`;
    const client = createFilesClient(project);
    if (!client) {
      showStatus(elements, t('files_error_not_connected'), true);
      return null;
    }
    const page = { client, project, elements };
    const load = async path => {
      showStatus(elements, t('files_loading'));
      try {
        const listing = await client.list(path);
        showStatus(elements, '');
        return listing;
      } catch (error) {
        const key = errorKey(error);
        showStatus(elements, key ? t(key) : error.message, true);
        return null;
      }
    };
    page.load = load;
    load(readPageParams(location.search).path);
    return page;
  }

  if (typeof document !== 'undefined' && document.getElementById('files-list')) {
    document.addEventListener('DOMContentLoaded', () => mount());
  }

  return { readPageParams, pageUrl, errorKey, mount };
}));
