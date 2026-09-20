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
    <div class="subtitle">Importación de Perfiles Cifrados</div>

    <div class="info-box">
      <h2>📦 Contenido del paquete</h2>
      <p><strong>${profileCount}</strong> perfil${profileCount !== 1 ? 'es' : ''} de conexión cifrado${profileCount !== 1 ? 's' : ''}</p>
      <p>Exportado: <strong>${exportDate}</strong></p>
      <p>Formato: <strong>AES-GCM</strong></p>
    </div>

    <div class="info-box">
      <h2>🔄 Proceso de importación</h2>
      <p>Al hacer clic en el botón, se abrirá ZeroChat en una nueva pestaña donde podrás importar ${profileCount !== 1 ? 'estos perfiles' : 'este perfil'} de forma segura.</p>
    </div>

    <button id="importButton" class="import-button">
      🚀 Importar Perfil${profileCount !== 1 ? 'es' : ''} en ZeroChat
    </button>

    <div id="status" class="status loading hidden">
      <span class="spinner"></span>
      Abriendo ZeroChat y transfiriendo perfiles...
    </div>

    <div class="warning-box">
      <strong>⚠️ Nota sobre permisos del navegador</strong>
      Es posible que tu navegador muestre un aviso solicitando permiso para abrir una nueva pestaña.
      Esto es normal por seguridad. Si aparece, autoriza la acción para continuar con la importación.
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
      const importButton = document.getElementById('importButton');

      // Estado
      let targetWindow = null;
      let timeoutId = null;
      let messageReceived = false;

      /**
       * Actualizar el estado visual
       */
      function updateStatus(message, type) {
        statusEl.className = 'status ' + type;
        statusEl.classList.remove('hidden');
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
            importButton.disabled = false;
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
            importButton.disabled = false;
          }
        }
      }

      /**
       * Inicializar el proceso de importación (llamado desde el botón)
       */
      function startImport() {
        console.log('[Export] Starting import process...');
        console.log('[Export] Target URL:', TARGET_URL);
        console.log('[Export] Payload size:', ENCRYPTED_PAYLOAD.length, 'bytes');

        // Deshabilitar el botón
        importButton.disabled = true;
        updateStatus(
          '<span class="spinner"></span>Abriendo ZeroChat...',
          'loading'
        );

        try {
          // Abrir zerochat.html en nueva pestaña con parámetro mode=import
          // Ejecutado desde user gesture (click) para mejorar compatibilidad
          targetWindow = window.open(TARGET_URL, 'zerochat_import');

          // Verificar si el popup fue bloqueado
          if (!targetWindow || targetWindow.closed || typeof targetWindow.closed === 'undefined') {
            console.error('[Export] Popup blocked');
            updateStatus(
              '❌ No se pudo abrir ZeroChat<br><br>' +
              '<small style="font-size: 14px;">' +
              'Tu navegador bloqueó la apertura de la nueva pestaña. ' +
              'Por favor, <strong>permite ventanas emergentes</strong> para este sitio ' +
              'y haz clic de nuevo en el botón.' +
              '</small>',
              'error'
            );
            importButton.disabled = false;
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
                'Verifica que la pestaña de ZeroChat se abrió correctamente. ' +
                'Si es necesario, haz clic de nuevo en el botón.' +
                '</small>',
                'error'
              );
              importButton.disabled = false;
            }
          }, TIMEOUT_MS);

        } catch (error) {
          console.error('[Export] Error opening window:', error);
          updateStatus(
            '❌ Error al abrir ZeroChat<br><br>' +
            '<small style="font-size: 14px;">' + error.message + '</small>',
            'error'
          );
          importButton.disabled = false;
        }
      }

      // Conectar el botón al proceso de importación
      importButton.addEventListener('click', startImport);

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
