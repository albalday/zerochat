/**
 * Modo ejecución desatendida (zerochat.py --prompt). El backend abre la interfaz con `run=<id>` en
 * el fragmento de arranque: la página pide el prompt, lo envía en la conversación nueva con la que
 * arranca, informa del progreso, aprueba para la sesión las herramientas que lo piden (las que
 * escriben o ejecutan, solo con --allow-dangerous-tools), termina con error si algo pregunta al
 * usuario (un diálogo o ask_user), exporta la conversación si se pidió (--export), devuelve el
 * resultado y se cierra salvo con --keep-open. Todo viaja por JSON-RPC zerochat/run/*.
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
  // Herramientas del servidor local que escriben o ejecutan: sin --allow-dangerous-tools se deniegan.
  const DANGEROUS_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

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

  /**
   * Vigila lo que pregunta al usuario: cada diálogo se cierra como cancelado y cada pregunta de
   * ask_user se anota; la primera detiene la generación. Devuelve { text } con esa primera petición.
   */
  function watchUserRequests(container, report, stopGeneration) {
    const State = getState();
    const request = { text: '' };
    const handled = new Set();
    const requestUser = text => {
      report({ kind: 'user_request', text });
      if (request.text) return;
      request.text = text;
      stopGeneration();
    };
    const dismissPending = () => {
      for (const notice of State.get('ui').notices || []) {
        if (handled.has(notice.id)) continue;
        handled.add(notice.id);
        requestUser(`${notice.title}: ${notice.message}`);
        // ChatDialogs se suscribe al resultado justo después de encolar el aviso.
        queueMicrotask(() => State.dismissNotice(notice.id, false));
      }
    };
    State.subscribe(state => (state.ui.notices || []).map(notice => notice.id).join(','), dismissPending);
    dismissPending();
    const askPending = () => {
      container.querySelectorAll('.ask-user-question').forEach(question => {
        if (handled.has(question)) return;
        handled.add(question);
        requestUser(question.textContent.trim());
      });
    };
    new MutationObserver(askPending).observe(container, { childList: true, subtree: true });
    return request;
  }

  /**
   * Responde cada petición de aprobación que se pinte en la conversación: permitida para la sesión,
   * salvo las herramientas que escriben o ejecutan sin `allowDangerous`, que se deniegan.
   */
  function answerToolApprovals(container, allowDangerous, report) {
    const answerPending = () => {
      container.querySelectorAll('.tool-card-auth-prompt').forEach(prompt => {
        const toolName = prompt.dataset.toolName || '';
        const allowed = allowDangerous || !DANGEROUS_TOOLS.has(toolName);
        report({ kind: allowed ? 'approval_allowed' : 'approval_denied', text: toolName });
        prompt.querySelector(allowed ? '.btn-auth-allow-session' : '.btn-auth-deny').click();
      });
    };
    new MutationObserver(answerPending).observe(container, { childList: true, subtree: true });
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
   * sin guardarlo el perfil de conexión pedido (nombre o id), `submitComposerText` envía el prompt
   * como el usuario y devuelve { text } o { error }, `stopGeneration` la detiene y
   * `exportConversation` da la conversación activa en un formato de ChatExport.
   */
  async function start(runId, { messagesList, startupConnection, connectBackend, sessionsLoaded, activateSessionProfile, submitComposerText, stopGeneration, exportConversation }) {
    const send = (method, params = {}) => getMcpManager().requestExternalControl(method, { run_id: runId, ...params });
    const report = createProgressReporter(event => {
      send('zerochat/run/progress', event).catch(error => console.warn('[RunMode] Could not report progress:', error));
    });
    let keepOpen = false;
    const userRequest = watchUserRequests(messagesList, report, stopGeneration);
    try {
      await sessionsLoaded;
      await waitForBackend(startupConnection, connectBackend);
      const { prompt, profile, export: exportFormat, keep_open: keepOpenRequested, allow_dangerous_tools: allowDangerous } = await send('zerochat/run/prompt');
      keepOpen = keepOpenRequested === true;
      if (typeof prompt !== 'string' || !prompt) throw new Error('The local server returned no prompt.');
      if (profile) {
        const match = getProfiles().findByName(profile) || getProfiles().get(profile);
        if (!match) throw new Error(`Connection profile not found: ${profile}`);
        activateSessionProfile(match.id);
        report({ kind: 'profile', text: match.name });
      }
      answerToolApprovals(messagesList, allowDangerous === true, report);
      const generated = userRequest.text ? null : await submitComposerText(prompt, { onProgress: report });
      // Una ejecución desatendida no puede contestar al usuario: su petición es el error.
      const result = userRequest.text ? { error: `The run needs the user: ${userRequest.text}` } : generated;
      // La conversación se exporta también tras un error de generación; si falla, el resultado sigue.
      if (exportFormat) {
        try {
          await send('zerochat/run/export', { content: await exportConversation(exportFormat) });
        } catch (error) {
          console.error('[RunMode] Could not export the conversation:', error);
        }
      }
      await send('zerochat/run/result', result.error ? { error: result.error } : { text: result.text });
    } catch (error) {
      console.error('[RunMode] Unattended run failed:', error);
      await send('zerochat/run/result', { error: error?.message || String(error) })
        .catch(sendError => console.error('[RunMode] Could not send the result:', sendError));
    } finally {
      if (!keepOpen) window.close();
    }
  }

  return {
    readRunId,
    createProgressReporter,
    start
  };
}));
