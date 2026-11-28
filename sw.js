/**
 * ZeroChat Service Worker (PWA & Offline Fast-Startup)
 * Proporciona carga instantánea desde almacenamiento local (0 ms de latencia)
 * y actualización en segundo plano (Stale-While-Revalidate).
 */

const CACHE_NAME = 'zerochat-v10.54.0';

const PRECACHE_ASSETS = [
  './zerochat.html',
  './files.html',
  './css/files.css',
  './css/text-view.css',
  './js/files-page.js',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/base.css',
  './css/layout.css',
  './css/components/icons.css',
  './css/components/header.css',
  './css/components/sidebar.css',
  './css/components/messages.css',
  './css/components/markdown.css',
  './css/components/composer.css',
  './css/components/modals.css',
  './css/components/tools.css',
  './css/components/debug.css',
  './css/theme-overrides.css',
  './css/print.css',
  './js/vendor/orama.browser.js',
  './js/utils.js',
  './js/vendor-loader.js',
  './js/html-document.js',
  './js/defaults.js',
  './js/mcp-status.js',
  './js/i18n.js',
  './js/icons.js',
  './js/storage-db.js',
  './js/message-turns.js',
  './js/text-tool-calls.js',
  './js/state.js',
  './js/storage.js',
  './js/ragStorage.js',
  './js/rag-index.js',
  './js/ingestionEngine.js',
  './js/rag-service.js',
  './js/rag-ui.js',
  './js/ui-dialogs.js',
  './js/ui-generation-status.js',
  './js/tab-alert.js',
  './js/sandbox.js',
  './js/charts.js',
  './js/web-browser.js',
  './js/web-search.js',
  './js/markdown.js',
  './js/providers.js',
  './js/providers-webllm.js',
  './js/api.js',
  './js/office-parser.js',
  './js/file-parser.js',
  './js/tool-cards.js',
  './js/tools/builtin/execute-javascript.tool.js',
  './js/tools/builtin/search-web.tool.js',
  './js/tools/builtin/fetch-web-page.tool.js',
  './js/tools/builtin/download-doc.tool.js',
  './js/tools/builtin/download-image.tool.js',
  './js/tools/builtin/render-chart.tool.js',
  './js/tools/builtin/list-documents.tool.js',
  './js/tools/builtin/search-knowledge-base.tool.js',
  './js/tools/builtin/read-knowledge-chunk.tool.js',
  './js/tools/builtin/read-knowledge-image.tool.js',
  './js/tools/builtin/ask-user.tool.js',
  './js/tools/builtin/wait.tool.js',
  './js/tools/builtin/switch-model.tool.js',
  './js/tools/builtin/delegate-task.tool.js',
  './js/tool-security.js',
  './js/agent-core.js',
  './js/mcp-results.js',
  './js/mcp-external.js',
  './js/mcp.js',
  './js/debug.js',
  './js/command-card.js',
  './js/ui-command-jobs.js',
  './js/attachments.js',
  './js/export.js',
  './js/profile-secrets.js',
  './js/profile-repository.js',
  './js/config-store.js',
  './js/project-context.js',
  './js/context-manager.js',
  './js/model-catalog.js',
  './js/profile-check.js',
  './js/chat-engine.js',
  './js/ui-reasoning.js',
  './js/ui-folder-picker.js',
  './js/ui-project.js',
  './js/ui-inspector.js',
  './js/ui-sidebar.js',
  './js/pwa-install.js',
  './js/ui-settings.js',
  './js/ui-telemetry.js',
  './js/ui-mcp.js',
  './js/ui-browser.js',
  './js/backend-session.js',
  './js/ui-connection.js',
  './js/ui-shell.js',
  './js/data-reset-service.js',
  './js/ui-transfer.js',
  './js/ui-profiles.js',
  './js/ui-composer.js',
  './js/conversation-service.js',
  './js/ui-conversation.js',
  './js/generation-controller.js',
  './js/server-run.js',
  './js/run-mode.js',
  './js/app.js'
];

self.addEventListener('install', event => {
  // addAll es atómico: si falta un recurso, la instalación falla y sigue activa la versión anterior.
  // Una versión nueva queda en espera, sin tocar las pestañas abiertas ni sus cachés, hasta que la persona
  // acepta el aviso de actualización (o se cierran todas las pestañas de ZeroChat).
  event.waitUntil(caches.open(CACHE_NAME).then(cache => {
    return cache.addAll(PRECACHE_ASSETS.map(asset => new Request(asset, { cache: 'no-cache' })));
  }));
});

// Lo envía js/app.js al pulsar «Recargar ahora».
self.addEventListener('message', event => {
  if (event.data?.type === 'zerochat-skip-waiting') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key.startsWith('zerochat-') && key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Solo rutas estáticas conocidas de ZeroChat: evita interceptar o cachear endpoints API/proxy del mismo origen.
const STATIC_ASSET_PATTERN = /(?:^|\/)(?:(?:zerochat|files|index)\.html|manifest\.webmanifest|favicon\.(?:ico|svg)|apple-touch-icon\.png|(?:css|js|help|templates|icons)\/[^?#]+)$/;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);

  // Exclusivamente para recursos estáticos conocidos del mismo origen.
  if (url.origin !== self.location.origin || !STATIC_ASSET_PATTERN.test(url.pathname)) {
    return;
  }

  // Stale-While-Revalidate. La clave no lleva la consulta: zerochat.html?project=… y files.html?path=… son la
  // misma página (sin copias repetidas ni rutas locales guardadas en Cache Storage, y abren sin conexión).
  const key = url.origin + url.pathname;
  const cachePromise = caches.open(CACHE_NAME);
  const revalidatePromise = fetch(req).then(networkResponse => {
    if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
      const copy = networkResponse.clone();
      return cachePromise
        .then(cache => cache.put(key, copy))
        .catch(() => undefined)
        .then(() => networkResponse);
    }
    return networkResponse;
  });

  // Registrado síncronamente dentro del evento fetch para mantener viva la revalidación y la escritura en caché.
  event.waitUntil(revalidatePromise.catch(() => undefined));
  event.respondWith(
    cachePromise
      .then(cache => cache.match(key))
      .then(cachedResponse => cachedResponse || revalidatePromise.catch(() => Response.error()))
  );
});
