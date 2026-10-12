/**
 * Página autónoma para importar perfiles: al pulsar su botón abre zerochat.html en modo importación
 * y le envía los perfiles cifrados por postMessage. Sus textos se generan en el idioma activo.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatProfileExportBundle = factory(root.ChatUtils, root.ChatI18n);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { escapeHtml } = Utils;
  const { t } = I18n;

  // Textos que la página muestra mientras importa; {nombre} se sustituye en la propia página.
  const STATUS_KEYS = {
    opening: 'profile_bundle_opening',
    sent: 'profile_bundle_sent',
    windowClosed: 'profile_bundle_window_closed',
    imported: 'profile_bundle_imported',
    importFailed: 'profile_bundle_import_failed',
    popupBlocked: 'profile_bundle_popup_blocked',
    timeout: 'profile_bundle_timeout',
    openFailed: 'profile_bundle_open_failed'
  };

  /** URL de zerochat.html: absoluta si se sirve por http(s) y relativa con file://. */
  function getZeroChatURL() {
    const { protocol, host, pathname } = window.location;
    const basePath = pathname.substring(0, pathname.lastIndexOf('/') + 1);
    return protocol.startsWith('http') ? `${protocol}//${host}${basePath}zerochat.html` : 'zerochat.html';
  }

  /**
   * HTML completo de la página de importación con los perfiles cifrados.
   * @param {string} encryptedPayload - Perfiles cifrados (JSON).
   * @param {{ profileCount: number }} metadata
   */
  function generateExportHTML(encryptedPayload, metadata) {
    const lang = I18n.getLanguage();
    const exportDate = new Date().toLocaleString(lang === 'en' ? 'en-GB' : 'es-ES', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const count = metadata.profileCount;
    const text = Object.fromEntries(Object.entries(STATUS_KEYS).map(([name, key]) => [name, t(key)]));
    // Los datos van en un JSON embebido: "<" se escapa para que no pueda cerrar el script.
    const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(t('profile_bundle_title'))}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: white;
      border-radius: 16px;
      padding: 24px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
    }

    @media (min-width: 600px) {
      .container {
        padding: 32px;
      }
    }

    .icon {
      font-size: 44px;
      margin-bottom: 16px;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    h1 {
      color: #333;
      font-size: 28px;
      margin-bottom: 10px;
      font-weight: 600;
    }

    .subtitle {
      color: #666;
      font-size: 14px;
      margin-bottom: 30px;
    }

    .info-box {
      background: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 16px 18px;
      margin: 16px 0;
      text-align: left;
      border-radius: 8px;
    }

    .info-box h2 {
      font-size: 16px;
      color: #333;
      margin-bottom: 12px;
      font-weight: 600;
    }

    .info-box p {
      font-size: 14px;
      color: #555;
      line-height: 1.6;
      margin: 8px 0;
    }

    .import-button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 16px 32px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      margin: 20px 0;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .import-button:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
    }

    .import-button:active:not(:disabled) {
      transform: translateY(0);
    }

    .import-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .status {
      padding: 20px;
      border-radius: 12px;
      margin: 20px 0;
      font-size: 16px;
      line-height: 1.6;
      font-weight: 500;
      transition: all 0.3s ease;
    }

    .status.loading {
      background: #e3f2fd;
      color: #1565c0;
      border: 2px solid #1976d2;
    }

    .status.success {
      background: #e8f5e9;
      color: #2e7d32;
      border: 2px solid #4caf50;
    }

    .status.error {
      background: #ffebee;
      color: #c62828;
      border: 2px solid #f44336;
    }

    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 3px solid #1976d2;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 10px;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .meta {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 2px solid #f0f0f0;
      font-size: 13px;
      color: #666;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      margin: 8px 0;
      padding: 8px 12px;
      background: #f8f9fa;
      border-radius: 6px;
    }

    .meta-label {
      font-weight: 600;
      color: #555;
    }

    .meta-value {
      color: #666;
    }

    .help-text {
      font-size: 12px;
      color: #999;
      margin-top: 20px;
      line-height: 1.5;
    }

    .warning-box {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 16px;
      margin-top: 20px;
      text-align: left;
      border-radius: 8px;
      font-size: 13px;
      color: #856404;
      line-height: 1.5;
    }

    .warning-box strong {
      display: block;
      margin-bottom: 8px;
      color: #856404;
    }

    #status.hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔐</div>
    <h1>ZeroChat</h1>
    <div class="subtitle">${escapeHtml(t('profile_bundle_subtitle'))}</div>

    <div class="info-box">
      <h2>${escapeHtml(t('profile_bundle_contents'))}</h2>
      <p>${escapeHtml(t('profile_bundle_count', { count }))}</p>
      <p>${escapeHtml(t('profile_bundle_exported', { date: exportDate }))}</p>
      <p>${escapeHtml(t('profile_bundle_format'))}</p>
    </div>

    <div class="info-box">
      <h2>${escapeHtml(t('profile_bundle_process_title'))}</h2>
      <p>${escapeHtml(t('profile_bundle_process_desc'))}</p>
    </div>

    <button id="importButton" class="import-button">${escapeHtml(t('profile_bundle_button'))}</button>

    <div id="status" class="status loading hidden"></div>

    <div class="warning-box">
      <strong>${escapeHtml(t('profile_bundle_permissions_title'))}</strong>
      ${escapeHtml(t('profile_bundle_permissions_desc'))}
    </div>
  </div>

  <script>
    (function () {
      'use strict';

      const ENCRYPTED_PAYLOAD = ${json(encryptedPayload)};
      const TARGET_URL = ${json(getZeroChatURL())};
      const METADATA = ${json(metadata)};
      const TEXT = ${json(text)};
      const TIMEOUT_MS = 20000;

      const statusEl = document.getElementById('status');
      const importButton = document.getElementById('importButton');

      let targetWindow = null;
      let timeoutId = null;
      let messageReceived = false;
      let activeTransferId = '';

      function createTransferId() {
        return crypto.randomUUID().replace(/-/g, '');
      }

      function getImportUrl(transferId) {
        return TARGET_URL + '#mode=import&transferId=' + encodeURIComponent(transferId);
      }

      function format(message, params) {
        return message.replace(/\\{(\\w+)\\}/g, (match, key) => (key in params ? String(params[key]) : match));
      }

      /** Muestra un estado como texto; los de carga llevan un indicador giratorio. */
      function updateStatus(message, type) {
        statusEl.className = 'status ' + type;
        statusEl.replaceChildren();
        if (type === 'loading') {
          const spinner = document.createElement('span');
          spinner.className = 'spinner';
          statusEl.appendChild(spinner);
        }
        statusEl.appendChild(document.createTextNode(message));
      }

      function fail(message) {
        updateStatus(message, 'error');
        importButton.disabled = false;
      }

      /** Mensajes de la pestaña de ZeroChat abierta para esta transferencia. */
      function handleMessage(event) {
        if (event.source !== targetWindow || !event.data || event.data.transferId !== activeTransferId) {
          return;
        }

        if (event.data.type === 'zerochat_import_ready') {
          if (!targetWindow || targetWindow.closed) {
            fail(TEXT.windowClosed);
            return;
          }
          targetWindow.postMessage({
            type: 'import_profiles',
            version: 1,
            transferId: activeTransferId,
            payload: ENCRYPTED_PAYLOAD,
            metadata: METADATA
          }, '*');
          updateStatus(TEXT.sent, 'loading');
          return;
        }

        if (event.data.type === 'import_result') {
          messageReceived = true;
          clearTimeout(timeoutId);
          if (event.data.success) {
            const result = event.data.result || {};
            updateStatus(format(TEXT.imported, { added: result.added || 0, replaced: result.replaced || 0 }), 'success');
            setTimeout(() => window.close(), 3000);
          } else {
            fail(format(TEXT.importFailed, { error: String(event.data.error || '') }));
          }
        }
      }

      /** Abre ZeroChat en modo importación; cada intento usa un identificador de transferencia nuevo. */
      function startImport() {
        activeTransferId = createTransferId();
        const targetName = 'zerochat_import_' + activeTransferId;
        if (timeoutId) clearTimeout(timeoutId);
        messageReceived = false;
        importButton.disabled = true;
        updateStatus(TEXT.opening, 'loading');

        try {
          targetWindow = window.open(getImportUrl(activeTransferId), targetName);
          if (!targetWindow || targetWindow.closed) {
            fail(TEXT.popupBlocked);
            return;
          }
          timeoutId = setTimeout(() => {
            if (!messageReceived) fail(format(TEXT.timeout, { seconds: TIMEOUT_MS / 1000 }));
          }, TIMEOUT_MS);
        } catch (error) {
          fail(format(TEXT.openFailed, { error: error.message }));
        }
      }

      importButton.addEventListener('click', startImport);
      window.addEventListener('message', handleMessage);
      window.addEventListener('beforeunload', () => {
        if (timeoutId) clearTimeout(timeoutId);
        window.removeEventListener('message', handleMessage);
      });
    })();
  </script>
</body>
</html>`;
  }

  return { generateExportHTML };
}));
