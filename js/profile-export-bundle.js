/**
 * Generador de HTML autónomo para importación de perfiles via postMessage.
 * Sistema único sin fallbacks: el HTML exportado abre zerochat.html en modo importación
 * y transfiere los perfiles cifrados mediante postMessage cross-origin.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatProfileExportBundle = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Detecta la URL base de zerochat.html según el contexto actual
   */
  function getZeroChatURL() {
    if (typeof window === 'undefined') return './zerochat.html';

    const protocol = window.location.protocol;
    const host = window.location.host;
    const pathname = window.location.pathname;
    const basePath = pathname.substring(0, pathname.lastIndexOf('/') + 1);

    // Si estamos en http/https, construir URL absoluta
    if (protocol.startsWith('http')) {
      return `${protocol}//${host}${basePath}zerochat.html`;
    }

    // Si estamos en file://, usar URL relativa
    // Asumimos que zerochat.html está en el mismo directorio
    return 'zerochat.html';
  }

  /**
   * Genera el HTML autónomo con el bundle cifrado embebido
   * @param {string} encryptedPayload - JSON string del payload cifrado
   * @param {object} metadata - Metadatos (profileCount, exportDate)
   * @returns {string} HTML completo listo para descargar
   */
  function generateExportHTML(encryptedPayload, metadata) {
    const zeroChatURL = getZeroChatURL();
    const exportDate = new Date().toLocaleString('es-ES', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    const profileCount = metadata?.profileCount || 0;

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="ZeroChat - Archivo de importación de perfiles cifrados">
  <title>ZeroChat - Importar ${profileCount} Perfil${profileCount !== 1 ? 'es' : ''}</title>
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
      padding: 40px;
      max-width: 500px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      text-align: center;
    }

    .icon {
      font-size: 64px;
      margin-bottom: 20px;
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
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔐</div>
    <h1>ZeroChat</h1>
    <div class="subtitle">Importación de Perfiles Cifrados</div>

    <div id="status" class="status loading">
      <span class="spinner"></span>
      Abriendo ZeroChat y transfiriendo perfiles...
    </div>

    <div class="meta">
      <div class="meta-row">
        <span class="meta-label">Perfiles:</span>
        <span class="meta-value">${profileCount} cifrado${profileCount !== 1 ? 's' : ''}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Exportado:</span>
        <span class="meta-value">${exportDate}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Formato:</span>
        <span class="meta-value">AES-GCM</span>
      </div>
    </div>

    <div class="help-text">
      Si se abrió una ventana emergente, espera la confirmación.<br>
      Si no se abrió nada, permite ventanas emergentes y recarga esta página.
    </div>
  </div>

  <script>
    (function() {
      'use strict';

      // Bundle cifrado embebido (generado en tiempo de exportación)
      const ENCRYPTED_PAYLOAD = ${JSON.stringify(encryptedPayload)};
      const TARGET_URL = ${JSON.stringify(zeroChatURL + '#mode=import')};
      const METADATA = ${JSON.stringify(metadata)};
      const TIMEOUT_MS = 20000; // 20 segundos

      // Referencias DOM
      const statusEl = document.getElementById('status');

      // Estado
      let targetWindow = null;
      let timeoutId = null;
      let messageReceived = false;

      /**
       * Actualizar el estado visual
       */
      function updateStatus(message, type) {
        statusEl.className = 'status ' + type;
        statusEl.innerHTML = message;
      }

      /**
       * Manejar mensajes desde zerochat.html
       */
      function handleMessage(event) {
        // Mensaje de "estoy listo" desde zerochat
        if (event.data === 'zerochat_ready') {
          console.log('[Export] ZeroChat ready, sending payload...');

          if (targetWindow && !targetWindow.closed) {
            // Enviar el payload cifrado
            targetWindow.postMessage({
              type: 'import_profiles',
              version: 1,
              payload: ENCRYPTED_PAYLOAD,
              metadata: METADATA
            }, '*');

            updateStatus(
              '<span class="spinner"></span>Datos enviados, esperando confirmación...',
              'loading'
            );
          } else {
            updateStatus(
              '❌ La ventana de ZeroChat se cerró inesperadamente.',
              'error'
            );
          }
          return;
        }

        // Resultado de la importación
        if (event.data && event.data.type === 'import_result') {
          messageReceived = true;
          clearTimeout(timeoutId);

          if (event.data.success) {
            const result = event.data.result || {};
            updateStatus(
              '✅ Perfiles importados correctamente<br>' +
              '<small style="font-size: 14px;">' +
              (result.added || 0) + ' añadido(s), ' +
              (result.replaced || 0) + ' actualizado(s)' +
              '</small><br><br>' +
              '<small style="font-size: 13px; opacity: 0.8;">Esta ventana se cerrará en 3 segundos...</small>',
              'success'
            );

            // Auto-cerrar después de 3 segundos
            setTimeout(() => {
              window.close();
            }, 3000);
          } else {
            const errorMsg = event.data.error || 'Error desconocido';
            updateStatus(
              '❌ Error al importar perfiles<br>' +
              '<small style="font-size: 14px;">' + errorMsg + '</small>',
              'error'
            );
          }
        }
      }

      /**
       * Inicializar el proceso de importación
       */
      function init() {
        console.log('[Export] Initializing import process...');
        console.log('[Export] Target URL:', TARGET_URL);
        console.log('[Export] Payload size:', ENCRYPTED_PAYLOAD.length, 'bytes');

        try {
          // Abrir zerochat.html en nueva ventana con parámetro mode=import
          targetWindow = window.open(
            TARGET_URL,
            'zerochat_import',
            'width=1200,height=800,menubar=no,toolbar=no,location=no,status=no'
          );

          // Verificar si el popup fue bloqueado
          if (!targetWindow || targetWindow.closed || typeof targetWindow.closed === 'undefined') {
            console.error('[Export] Popup blocked');
            updateStatus(
              '❌ No se pudo abrir ZeroChat<br><br>' +
              '<small style="font-size: 14px;">' +
              'Asegúrate de <strong>permitir ventanas emergentes</strong> para este sitio ' +
              'y recarga esta página.' +
              '</small>',
              'error'
            );
            return;
          }

          console.log('[Export] Window opened successfully');

          // Escuchar mensajes desde zerochat
          window.addEventListener('message', handleMessage);

          // Timeout de seguridad
          timeoutId = setTimeout(() => {
            if (!messageReceived) {
              console.error('[Export] Timeout waiting for response');
              updateStatus(
                '⏱️ Timeout: ZeroChat no respondió en ' + (TIMEOUT_MS / 1000) + ' segundos<br><br>' +
                '<small style="font-size: 14px;">' +
                'Verifica que la ventana de ZeroChat se abrió correctamente. ' +
                'Si es necesario, recarga esta página e intenta de nuevo.' +
                '</small>',
                'error'
              );
            }
          }, TIMEOUT_MS);

        } catch (error) {
          console.error('[Export] Error opening window:', error);
          updateStatus(
            '❌ Error al abrir ZeroChat<br><br>' +
            '<small style="font-size: 14px;">' + error.message + '</small>',
            'error'
          );
        }
      }

      // Iniciar cuando el DOM esté listo
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }

      // Limpiar al cerrar
      window.addEventListener('beforeunload', () => {
        if (timeoutId) clearTimeout(timeoutId);
        window.removeEventListener('message', handleMessage);
      });
    })();
  </script>
</body>
</html>`;
  }

  // Exportar API pública
  return {
    generateExportHTML,
    getZeroChatURL
  };
}));
