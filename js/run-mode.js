/**
 * Modo ejecución desatendida (zerochat.py --prompt). El backend abre la interfaz con `run=<id>` en
 * el fragmento de arranque: la página pide el prompt, lo envía en la conversación nueva con la que
 * arranca, informa del progreso, resuelve sola los diálogos, deniega las herramientas que piden
 * aprobación, devuelve el resultado y se cierra. Todo viaja por JSON-RPC zerochat/run/*.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatRunMode = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;
  const getState = () => resolveDep('ChatState', './state.js');
  const getMcpManager = () => resolveDep('ChatMCP', './mcp.js').manager;
  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');

  const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
  // El streaming informa como mucho cada este intervalo; el resto de avisos, siempre.
  const STREAM_PROGRESS_INTERVAL_MS = 2000;
  const CONNECT_ATTEMPTS = 30;
  const CONNECT_RETRY_MS = 1000;

  /** Identificador de la ejecución en el fragmento de arranque, o null fuera del modo ejecución. */
  function readRunId(hash) {
    const runId = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('run');
    return runId && RUN_ID_PATTERN.test(runId) ? runId : null;
  }

  /** Envía cada aviso de progreso, salvo los de streaming más seguidos que el intervalo. */
  function createProgressReporter(send) {
    let lastStreamAt = -Infinity;
    return event => {
      if (event.kind === 'stream') {
        const now = Date.now();
        if (now - lastStreamAt < STREAM_PROGRESS_INTERVAL_MS) return;
        lastStreamAt = now;
      }
      send(event);
    };
  }

  /** Cierra cada diálogo en cuanto aparece como si se cancelara, y lo notifica como progreso. */
  function dismissDialogs(report) {
    const State = getState();
    const handled = new Set();
    const dismissPending = () => {
      for (const notice of State.get('ui').notices || []) {
        if (handled.has(notice.id)) continue;
        handled.add(notice.id);
        report({ kind: 'dialog', text: `${notice.title}: ${notice.message}` });
        // ChatDialogs se suscribe al resultado justo después de encolar el aviso.
        queueMicrotask(() => State.dismissNotice(notice.id, false));
      }
    };
    State.subscribe(state => (state.ui.notices || []).map(notice => notice.id).join(','), dismissPending);
    dismissPending();
  }

  /** Deniega cada petición de aprobación de herramienta que se pinte en la conversación. */
  function denyToolApprovals(container, report) {
    const denyPending = () => {
      container.querySelectorAll('.tool-card-auth-prompt .btn-auth-deny').forEach(button => {
        const card = button.closest('.tool-execution-card');
        report({ kind: 'approval_denied', text: card?.querySelector('.tool-card-title')?.textContent.trim() || '' });
        button.click();
      });
    };
    new MutationObserver(denyPending).observe(container, { childList: true, subtree: true });
    denyPending();
  }

  async function waitForBackend(startupConnection, connectBackend) {
    let connection = await startupConnection;
    for (let attempt = 1; !connection.success && attempt < CONNECT_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, CONNECT_RETRY_MS));
      connection = await connectBackend();
    }
    if (!connection.success) throw new Error('Could not connect to the local server.');
  }

  /**
   * Ejecuta la petición: `startupConnection` es la conexión del arranque, `connectBackend` la
   * reintenta, `sessionsLoaded` espera a la conversación inicial, `activateSessionProfile` activa
   * sin guardarlo el perfil de conexión pedido (nombre o id) y `submitComposerText` envía el prompt
   * como el usuario y devuelve { text } o { error }.
   */
  async function start(runId, { messagesList, startupConnection, connectBackend, sessionsLoaded, activateSessionProfile, submitComposerText }) {
    const send = (method, params = {}) => getMcpManager().requestExternalControl(method, { run_id: runId, ...params });
    const report = createProgressReporter(event => {
      send('zerochat/run/progress', event).catch(error => console.warn('[RunMode] Could not report progress:', error));
    });
    try {
      dismissDialogs(report);
      denyToolApprovals(messagesList, report);
      await sessionsLoaded;
      await waitForBackend(startupConnection, connectBackend);
      const { prompt, profile } = await send('zerochat/run/prompt');
      if (typeof prompt !== 'string' || !prompt) throw new Error('The local server returned no prompt.');
      if (profile) {
        const match = getProfiles().findByName(profile) || getProfiles().get(profile);
        if (!match) throw new Error(`Connection profile not found: ${profile}`);
        activateSessionProfile(match.id);
        report({ kind: 'profile', text: match.name });
      }
      const result = await submitComposerText(prompt, { onProgress: report });
      await send('zerochat/run/result', result.error ? { error: result.error } : { text: result.text });
    } catch (error) {
      console.error('[RunMode] Unattended run failed:', error);
      await send('zerochat/run/result', { error: error?.message || String(error) })
        .catch(sendError => console.error('[RunMode] Could not send the result:', sendError));
    } finally {
      window.close();
    }
  }

  return {
    readRunId,
    createProgressReporter,
    start
  };
}));
