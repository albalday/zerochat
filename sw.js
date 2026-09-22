/**
 * ZeroChat Service Worker (PWA & Offline Fast-Startup)
 * Proporciona carga instantánea desde almacenamiento local (0 ms de latencia)
 * y actualización en segundo plano (Stale-While-Revalidate).
 */

const CACHE_NAME = 'zerochat-v7.8.0';

const PRECACHE_ASSETS = [
  './',
  './zerochat.html',
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
  './css/styles.css',
  './js/vendor/orama.browser.js',
  './js/utils.js',
  './js/storage-db.js',
  './js/message-turns.js',
  './js/state.js',
  './js/cookies.js',
  './js/ragStorage.js',
  './js/rag-index.js',
  './js/ingestionEngine.js',
  './js/rag-service.js',
  './js/rag-ui.js',
  './js/i18n.js',
  './js/icons.js',
  './js/ui-dialogs.js',
  './js/ui-generation-status.js',
  './js/sandbox.js',
  './js/charts.js',
  './js/web-browser.js',
  './js/web-search.js',
  './js/markdown.js',
  './js/providers.js',
  './js/providers-webllm.js',
  './js/api.js',
  './js/file-parser.js',
  './js/tools/tool-runtime.js',
  './js/tools/tool-manifest.js',
  './js/tools/builtin/execute-javascript.tool.js',
  './js/tools/builtin/search-web.tool.js',
  './js/tools/builtin/fetch-web-page.tool.js',
  './js/tools/builtin/download-pdf.tool.js',
  './js/tools/builtin/render-chart.tool.js',
  './js/tools/builtin/list-documents.tool.js',
  './js/tools/builtin/search-knowledge-base.tool.js',
  './js/tools/builtin/read-knowledge-chunk.tool.js',
  './js/tools/builtin/read-knowledge-image.tool.js',
  './js/tools/builtin/agent-checkpoint.tool.js',
  './js/tool-security.js',
  './js/agent-core.js',
  './js/mcp.js',
  './js/debug.js',
  './js/tool-cards.js',
  './js/attachments.js',
  './js/export.js',
  './js/profile-backup.js',
  './js/profile-repository.js',
  './js/config-store.js',
  './js/context-manager.js',
  './js/chat-engine.js',
  './js/ui-reasoning.js',
  './js/ui-inspector.js',
  './js/ui-sidebar.js',
  './js/ui-settings.js',
  './js/ui-telemetry.js',
  './js/ui-mcp.js',
  './js/ui-shell.js',
  './js/data-reset-service.js',
  './js/ui-transfer.js',
  './js/ui-profiles.js',
  './js/ui-composer.js',
  './js/conversation-service.js',
  './js/ui-conversation.js',
  './js/generation-controller.js',
  './js/app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.allSettled(
        PRECACHE_ASSETS.map(asset =>
          fetch(asset, { cache: 'no-cache' })
            .then(res => {
              if (res.ok) return cache.put(asset, res);
            })
            .catch(() => {})
        )
      );
    }).then(() => self.skipWaiting())
  );
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

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);

  // Exclusivamente para peticiones del mismo origen
  if (url.origin !== self.location.origin) {
    return;
  }

  // Ignorar endpoints de API, túneles o llamadas dinámicas
  if (url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/mcp') ||
      url.pathname.startsWith('/zerochat') ||
      url.pathname.startsWith('/sse') ||
      url.pathname.startsWith('/v1') ||
      url.pathname.startsWith('/ws')) {
    return;
  }

  // Estrategia Stale-While-Revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(req).then(cachedResponse => {
        const fetchPromise = fetch(req).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            cache.put(req, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => {
          return cachedResponse;
        });

        return cachedResponse || fetchPromise;
      });
    })
  );
});

