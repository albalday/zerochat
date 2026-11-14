/**
 * Navegador de ficheros del proyecto (files.html): una página aparte, abierta desde el historial, que
 * conecta con la sesión guardada en la cookie (la misma que usa la aplicación) sin cargar la aplicación
 * entera. El proyecto viaja en la URL (`?project=`) y en la cabecera X-ZeroChat-Project de cada petición;
 * el servidor no deja salir de su carpeta (zerochat/files/*).
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'), require('./icons.js'), require('./defaults.js'), require('./storage.js'), require('./backend-session.js'), require('./mcp.js'));
  } else {
    root.ChatFilesPage = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons, root.ChatDefaults, root.ChatStorage, root.ChatBackendSession, root.ChatMCP);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons, Defaults, Storage, BackendSession, MCP) {
  'use strict';
  const { projectName, formatBytes, openTextInNewTab, downloadFile } = Utils;
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

  /** Migas de una carpeta: el proyecto y cada carpeta del camino, con la ruta a la que llevan. */
  function breadcrumbs(project, path) {
    const parts = path ? path.split('/') : [];
    return [{ label: projectName(project), path: '' }, ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join('/') }))];
  }

  /** Ruta de una entrada dentro de la carpeta `path`. */
  function childPath(path, name) {
    return path ? `${path}/${name}` : name;
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

  let folderIcon = null;
  /** Icono de carpeta, el único de la lista: se crea una vez y se clona en cada fila. */
  function folderIconNode(doc) {
    if (!folderIcon) {
      const template = doc.createElement('template');
      template.innerHTML = Icons.get('folder', { size: 16 });
      folderIcon = template.content.firstElementChild;
    }
    return folderIcon.cloneNode(true);
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleString(I18n.getLanguage(), { dateStyle: 'short', timeStyle: 'short' });
  }

  function link(doc, project, path, label, className) {
    const anchor = doc.createElement('a');
    anchor.className = className;
    anchor.href = pageUrl(project, path);
    anchor.dataset.path = path;
    anchor.textContent = label;
    return anchor;
  }

  function renderBreadcrumbs(page, path) {
    const { elements, project } = page;
    const doc = elements.breadcrumbs.ownerDocument;
    const crumbs = breadcrumbs(project, path);
    elements.breadcrumbs.replaceChildren(...crumbs.flatMap((crumb, index) => {
      const last = index === crumbs.length - 1;
      const node = last ? Object.assign(doc.createElement('span'), { className: 'files-crumb files-crumb-current', textContent: crumb.label })
        : link(doc, project, crumb.path, crumb.label, 'files-crumb');
      return index ? [Object.assign(doc.createElement('span'), { className: 'files-crumb-separator', textContent: '/' }), node] : [node];
    }));
  }

  /** Una fila por entrada: las carpetas llevan a su lista; los ficheros, su tamaño y su fecha. */
  function renderListing(page, listing) {
    const { elements, project } = page;
    const doc = elements.list.ownerDocument;
    renderBreadcrumbs(page, listing.path);
    const rows = listing.entries.map(entry => {
      const item = doc.createElement('li');
      item.className = `files-entry files-entry-${entry.type === 'dir' ? 'dir' : 'file'}`;
      const icon = doc.createElement('span');
      icon.className = 'files-entry-icon';
      if (entry.type === 'dir') icon.appendChild(folderIconNode(doc));
      const name = entry.type === 'dir'
        ? link(doc, project, childPath(listing.path, entry.name), entry.name, 'files-entry-name')
        : Object.assign(doc.createElement('button'), { type: 'button', className: 'files-entry-name files-entry-open', textContent: entry.name });
      if (entry.type !== 'dir') name.dataset.file = childPath(listing.path, entry.name);
      name.title = entry.name;
      const size = Object.assign(doc.createElement('span'), { className: 'files-entry-size', textContent: entry.type === 'dir' ? '' : formatBytes(entry.size) });
      const date = Object.assign(doc.createElement('span'), { className: 'files-entry-date', textContent: formatDate(entry.modified) });
      item.append(icon, name, size, date);
      return item;
    });
    elements.list.replaceChildren(...rows);
    if (!listing.entries.length) showStatus(elements, t('files_empty'));
    else if (listing.truncated) showStatus(elements, t('files_truncated', { shown: listing.entries.length, total: listing.total }));
  }

  /** Bytes de un fichero, pedidos por páginas en base64 hasta que el servidor dice que ha terminado. */
  async function fetchFileBytes(client, path) {
    const pieces = [];
    let offset = 0;
    let name = path.split('/').pop();
    for (;;) {
      const page = await client.download(path, offset);
      name = page.name || name;
      const binary = atob(page.data || '');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      pieces.push(bytes);
      if (page.done || page.next <= offset) break;
      offset = page.next;
    }
    return { name, blob: new Blob(pieces, { type: 'application/octet-stream' }) };
  }

  /**
   * Un fichero de texto se abre en una pestaña nueva; uno binario o demasiado grande para leerlo así, se
   * descarga. La pestaña se abre al pulsar (si no, el navegador la bloquearía) y se cierra si toca descargar.
   */
  async function openFile(page, path) {
    const { client, elements } = page;
    try {
      let download = false;
      await openTextInNewTab(async () => {
        const result = await client.read(path);
        if (result.binary || result.too_large) {
          download = true;
          return null;
        }
        return result.text;
      }, { title: path.split('/').pop(), loading: t('files_loading') });
      if (download) {
        showStatus(elements, t('files_downloading', { name: path.split('/').pop() }));
        const file = await fetchFileBytes(client, path);
        downloadFile(file.blob, file.name);
        showStatus(elements, '');
      }
    } catch (error) {
      const key = errorKey(error);
      showStatus(elements, key ? t(key) : error.message, true);
    }
  }

  function showStatus(elements, text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle('files-status-error', isError);
    elements.status.hidden = !text;
  }

  function mount(doc = document) {
    const elements = {
      title: doc.getElementById('files-project'),
      breadcrumbs: doc.getElementById('files-breadcrumbs'),
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
        renderListing(page, listing);
        doc.defaultView.scrollTo(0, 0);
        return listing;
      } catch (error) {
        const key = errorKey(error);
        elements.list.replaceChildren();
        renderBreadcrumbs(page, path);
        showStatus(elements, key ? t(key) : error.message, true);
        return null;
      }
    };
    page.load = load;
    // Las carpetas se recorren en la misma pestaña, con el historial del navegador: atrás vuelve a la anterior.
    doc.addEventListener('click', event => {
      const fileButton = event.target.closest('button[data-file]');
      if (fileButton) {
        openFile(page, fileButton.dataset.file);
        return;
      }
      const anchor = event.target.closest('a[data-path]');
      if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      doc.defaultView.history.pushState(null, '', anchor.href);
      load(anchor.dataset.path);
    });
    doc.defaultView.addEventListener('popstate', () => load(readPageParams(location.search).path));
    load(readPageParams(location.search).path);
    return page;
  }

  if (typeof document !== 'undefined' && document.getElementById('files-list')) {
    document.addEventListener('DOMContentLoaded', () => mount());
  }

  return { readPageParams, pageUrl, breadcrumbs, childPath, errorKey, mount };
}));
