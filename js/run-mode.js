/**
 * Modo ejecución desatendida (zerochat.py --prompt y --conversation). El backend abre la interfaz
 * con `run=<id>` en el fragmento de arranque: la página pide el prompt o carga la conversación
 * existente, informa del paso en curso, gestiona las autorizaciones
 * de herramientas (permitiendo, denegando o pausando según el modo), exporta si se pidió (--export),
 * devuelve el resultado o el estado de espera al usuario (needs_input) y se cierra salvo con --keep-page.
 * Todo viaja por JSON-RPC zerochat/run/*.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatRunMode = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep, EPHEMERAL_ID_PATTERN, readLaunchFragment } = Utils;
  const getState = () => resolveDep('ChatState', './state.js');
  const getMcpManager = () => resolveDep('ChatMCP', './mcp.js').manager;
  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');
  const getToolCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  // El streaming informa como mucho cada este intervalo; el resto de avisos, siempre.
  const STREAM_PROGRESS_INTERVAL_MS = 2000;
  const CONNECT_ATTEMPTS = 30;
  const CONNECT_RETRY_MS = 1000;

  /** Identificador de la ejecución en el fragmento de arranque, o null fuera del modo ejecución. */
  function readRunId(hash) {
    const runId = readLaunchFragment(hash).get('run');
    return runId && EPHEMERAL_ID_PATTERN.test(runId) ? runId : null;
  }

  /** Envía cada aviso de progreso, salvo los de streaming más seguidos que el intervalo, que se descartan. */
  function createProgressReporter(send, intervalMs = STREAM_PROGRESS_INTERVAL_MS) {
    let lastStreamAt = -Infinity;
    return event => {
      if (event.kind === 'stream') {
        const now = Date.now();
        if (now - lastStreamAt < intervalMs) return;
        lastStreamAt = now;
      }
      send(event);
    };
  }

  /**
   * Vigila los diálogos: cada uno se cierra como cancelado y se anota; el primero detiene la
   * generación. Devuelve { text } con esa primera petición.
   */
  function watchUserDialogs(report, stopGeneration) {
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
    return request;
  }

  /**
   * Pregunta de ask_user con la que terminó el turno (entre los mensajes tool del final del
   * historial), o null. ask_user cede el turno, así que la generación ya terminó con ella.
   */
  function pendingAskUserQuestion(messages) {
    const asked = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) {
      if (messages[i].name === 'ask_user') asked.push(messages[i]);
    }
    if (asked.length === 0) return null;
    const assistant = messages.findLast(message => message.role === 'assistant' && Array.isArray(message.tool_calls));
    const calls = (assistant?.tool_calls || []).filter(call => call.function?.name === 'ask_user');
    const call = calls.find(item => asked.some(message => message.tool_call_id === item.id)) || calls[0];
    try {
      const question = JSON.parse(call?.function?.arguments || '{}').question;
      if (typeof question === 'string' && question.trim()) return question.trim();
    } catch (_) { /* argumentos sin JSON: basta el nombre de la herramienta */ }
    return 'ask_user';
  }

  /**
   * Nombre de la herramienta que quedó pendiente de autorización en el último turno, o null.
   */
  function pendingToolApproval(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) {
      try {
        const parsed = JSON.parse(messages[i].content || '{}');
        if (parsed?.awaitingApproval) return messages[i].name || 'tool';
      } catch (_) { /* contenido no json */ }
    }
    return null;
  }

  /**
   * Si el último turno se quedó pausado esperando autorización, retira ese paso incompleto
   * (el assistant con sus llamadas y los mensajes tool correspondientes) para que la reanudación
   * vuelva a invocar al modelo con las nuevas políticas concedidas.
   */
  function prepareConversationForContinuation(messages) {
    if (!pendingToolApproval(messages)) return messages;
    const lastAssistantIdx = messages.findLastIndex(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    return lastAssistantIdx !== -1 ? messages.slice(0, lastAssistantIdx) : messages;
  }

  /**
   * Contesta cada petición de autorización aprobándola para la sesión.
   */
  function answerToolApprovals(report) {
    getToolCards().setAuthorizationResponder(toolName => {
      report({ kind: 'approval_allowed', text: toolName });
      return 'allow_session';
    });
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
   * sin guardarlo el perfil pedido (nombre o id), arranca sus servicios MCP y devuelve
   * { started, unavailable }, `submitComposerText` envía el prompt
   * como el usuario (o continúa con `{ resume: true }`) y devuelve { text } o { error },
   * `stopGeneration` la detiene, `exportConversation` da la conversación activa en un formato de
   * ChatExport y `switchToSession` cambia a una conversación existente. `startNewSession`, solo en el
   * runner de Node, abre sin --conversation la conversación nueva cuyo id eligió el servidor.
   */
  async function start(runId, {
    startupConnection,
    connectBackend,
    sessionsLoaded,
    activateSessionProfile,
    submitComposerText,
    stopGeneration,
    exportConversation,
    switchToSession,
    startNewSession = null
  }) {
    const send = (method, params = {}) => getMcpManager().requestExternalControl(method, { run_id: runId, ...params });
    const report = createProgressReporter(event => {
      send('zerochat/run/progress', event).catch(error => console.warn('[RunMode] Could not report progress:', error));
    });
    let keepPage = false;
    const userRequest = watchUserDialogs(report, stopGeneration);
    try {
      await sessionsLoaded;
      await waitForBackend(startupConnection, connectBackend);
      const {
        prompt,
        profile,
        profile_data: profileData,
        profiles: serverProfiles,
        export: exportFormat,
        keep_page: keepPageRequested,
        conversation_id: conversationId,
        new_conversation_id: newConversationId
      } = await send('zerochat/run/prompt');
      keepPage = keepPageRequested === true;

      const isConversationMode = Boolean(conversationId);
      if (!isConversationMode && (typeof prompt !== 'string' || !prompt)) {
        throw new Error('The local server returned no prompt.');
      }

      // Los perfiles del servidor quedan en memoria para esta ejecución: el de la ejecución y los que
      // switch_model puede activar si el usuario los nombra. La credencial del runner no los puede listar.
      // Llegan sin API key: la de uno se pide al servidor al activarlo; la del de la ejecución viene en profile_data.
      getProfiles().setSessionKeyLoader(async id => (await send('zerochat/run/profile', { id }))?.profile);
      for (const serverProfile of Array.isArray(serverProfiles) ? serverProfiles : []) {
        try {
          getProfiles().registerSessionProfile(serverProfile, { keyless: true });
        } catch (error) {
          console.warn('[RunMode] Skipping an invalid server profile:', error);
        }
      }
      if (profileData) getProfiles().registerSessionProfile(profileData);

      if (profile) {
        const match = getProfiles().findByName(profile) || getProfiles().get(profile);
        if (!match) throw new Error(`Profile not found: ${profile}`);
        await activateSessionProfile(match.id);
        report({ kind: 'profile', text: match.name });
      }

      answerToolApprovals(report);

      if (isConversationMode) {
        await switchToSession(conversationId);
      } else if (newConversationId && startNewSession) {
        // El runner de Node solo puede guardar la conversación que eligió el servidor.
        startNewSession(newConversationId);
      }

      let generated = null;
      if (!userRequest.text) {
        if (isConversationMode && (!prompt || typeof prompt !== 'string')) {
          const State = getState();
          const messages = State.get('messages');
          const cleaned = prepareConversationForContinuation(messages);
          if (cleaned.length !== messages.length) {
            State.replaceMessages(cleaned);
          }
          generated = await submitComposerText('', { resume: true, onProgress: report });
        } else {
          generated = await submitComposerText(prompt, { onProgress: report });
        }
      }

      const question = userRequest.text ? null : pendingAskUserQuestion(getState().get('messages'));
      const pendingAuth = userRequest.text ? null : pendingToolApproval(getState().get('messages'));
      if (question) report({ kind: 'user_request', text: question });

      let result;
      if (userRequest.text) {
        result = { error: `The run needs the user: ${userRequest.text}` };
      } else if (generated?.error) {
        result = { error: generated.error };
      } else if (isConversationMode) {
        if (question) {
          result = { needs_input: { kind: 'ask_user', text: question } };
        } else if (pendingAuth) {
          result = { needs_input: { kind: 'tool_approval', text: pendingAuth } };
        } else {
          result = { text: generated?.text || '' };
        }
      } else {
        const needsUser = question || pendingAuth;
        result = needsUser ? { error: `The run needs the user: ${needsUser}` } : generated;
      }

      if (exportFormat) {
        try {
          await send('zerochat/run/export', { content: await exportConversation(exportFormat) });
        } catch (error) {
          console.error('[RunMode] Could not export the conversation:', error);
        }
      }

      if (result.needs_input) {
        await send('zerochat/run/result', { needs_input: result.needs_input });
      } else if (result.error) {
        await send('zerochat/run/result', { error: result.error });
      } else {
        await send('zerochat/run/result', { text: result.text });
      }
    } catch (error) {
      console.error('[RunMode] Unattended run failed:', error);
      await send('zerochat/run/result', { error: error?.message || String(error) })
        .catch(sendError => console.error('[RunMode] Could not send the result:', sendError));
    } finally {
      getProfiles().clearSessionProfile();
      if (!keepPage) window.close();
    }
  }

  return {
    readRunId,
    createProgressReporter,
    pendingAskUserQuestion,
    pendingToolApproval,
    prepareConversationForContinuation,
    answerToolApprovals,
    start
  };
}));
