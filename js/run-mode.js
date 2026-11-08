/**
 * Modo ejecución desatendida (zerochat.py --prompt y --conversation). El backend abre la interfaz
 * con `run=<id>` en el fragmento de arranque: la página pide el prompt o carga la conversación
 * existente, informa del progreso (con texto de asistente y razonamiento), gestiona las autorizaciones
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
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js');

  // El streaming informa como mucho cada este intervalo; el resto de avisos, siempre.
  const STREAM_PROGRESS_INTERVAL_MS = 2000;
  const CONNECT_ATTEMPTS = 30;
  const CONNECT_RETRY_MS = 1000;
  // Herramientas del servidor local que escriben o ejecutan: sin --allow-dangerous-tools se deniegan.
  const DANGEROUS_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

  /** Identificador de la ejecución en el fragmento de arranque, o null fuera del modo ejecución. */
  function readRunId(hash) {
    const runId = readLaunchFragment(hash).get('run');
    return runId && EPHEMERAL_ID_PATTERN.test(runId) ? runId : null;
  }

  /** Envía cada aviso de progreso, salvo los de streaming más seguidos que el intervalo. */
  function createProgressReporter(send, intervalMs = STREAM_PROGRESS_INTERVAL_MS) {
    let lastStreamAt = -Infinity;
    let deferredStream = null;
    return event => {
      if (event.kind === 'stream') {
        const now = Date.now();
        if (now - lastStreamAt < intervalMs) {
          deferredStream = {
            ...deferredStream,
            ...(typeof event.assistant_text === 'string' ? { assistant_text: event.assistant_text } : {}),
            ...(typeof event.reasoning_text === 'string' ? { reasoning_text: event.reasoning_text } : {})
          };
          return;
        }
        lastStreamAt = now;
      }
      if (deferredStream) {
        event = { ...deferredStream, ...event };
        deferredStream = null;
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
   * Hidrata en ChatToolSecurity las políticas de herramientas enviadas para la sesión.
   */
  function hydrateToolSecurity(toolSecurity) {
    if (!toolSecurity) return;
    const security = getToolSecurity()?.manager;
    if (!security) return;
    const data = typeof toolSecurity === 'string' ? JSON.parse(toolSecurity) : toolSecurity;
    if (typeof data !== 'object' || data === null) return;
    if (typeof data.globalMcpPolicy === 'string') {
      try {
        security.setGlobalMcpPolicy(data.globalMcpPolicy);
      } catch (_) { /* invalid global policy ignored */ }
    }
    if (data.tools && typeof data.tools === 'object') {
      Object.entries(data.tools).forEach(([id, item]) => {
        if (typeof item === 'string') {
          security.setToolPolicy(id, item, { scope: 'session' });
        } else if (item && typeof item === 'object') {
          security.setToolPolicy(id, item.policy || 'allow', {
            scope: item.scope || 'session',
            constraints: item.constraints,
            serverName: item.serverName,
            originalName: item.originalName
          });
        }
      });
    }
    if (Array.isArray(data.directoryRules)) {
      data.directoryRules.forEach(rule => {
        try {
          security.addDirectoryRule(rule);
        } catch (_) { /* invalid directory rule ignored */ }
      });
    }
    if (data.servers && typeof data.servers === 'object') {
      Object.entries(data.servers).forEach(([id, item]) => {
        const policy = typeof item === 'string' ? item : item?.policy;
        if (policy) security.setServerPolicy(id, policy, { scope: 'session' });
      });
    }
  }

  /**
   * Contesta cada petición de autorización:
   * - Si la herramienta está en `allowOnce`, la permite una sola vez ('allow_once') y la retira.
   * - En modo conversación (pauseOnApproval = true sin allowDangerous): devuelve 'pause_for_user'
   *   y emite un aviso de tipo 'user_request'.
   * - En modo clásico (pauseOnApproval = false): permitida para la sesión, salvo las herramientas que
   *   escriben o ejecutan sin allowDangerous, que se deniegan.
   */
  function answerToolApprovals(allowDangerous, report, { pauseOnApproval = false, allowOnce = [] } = {}) {
    const onceList = Array.isArray(allowOnce) ? allowOnce : (allowOnce ? [allowOnce] : []);
    const onceSet = new Set(onceList.filter(name => typeof name === 'string' && name));
    getToolCards().setAuthorizationResponder(toolName => {
      if (onceSet.has(toolName)) {
        onceSet.delete(toolName);
        report({ kind: 'approval_allowed', text: toolName });
        return 'allow_once';
      }
      if (pauseOnApproval && !allowDangerous) {
        report({ kind: 'user_request', text: toolName });
        return 'pause_for_user';
      }
      const allowed = allowDangerous || !DANGEROUS_TOOLS.has(toolName);
      report({ kind: allowed ? 'approval_allowed' : 'approval_denied', text: toolName });
      return allowed ? 'allow_session' : 'deny';
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
   * ChatExport y `switchToSession` cambia a una conversación existente.
   */
  async function start(runId, {
    startupConnection,
    connectBackend,
    sessionsLoaded,
    activateSessionProfile,
    submitComposerText,
    stopGeneration,
    exportConversation,
    switchToSession
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
        export: exportFormat,
        keep_page: keepPageRequested,
        allow_dangerous_tools: allowDangerous,
        conversation_id: conversationId,
        tool_security: toolSecurity
      } = await send('zerochat/run/prompt');
      keepPage = keepPageRequested === true;

      const isConversationMode = Boolean(conversationId);
      if (!isConversationMode && (typeof prompt !== 'string' || !prompt)) {
        throw new Error('The local server returned no prompt.');
      }

      if (profile) {
        let match = getProfiles().findByName(profile) || getProfiles().get(profile);
        if (!match && profileData && (profileData.name === profile || profileData.id === profile)) {
          match = getProfiles().registerSessionProfile(profileData);
        }
        if (!match) {
          const serverProfiles = await getMcpManager().listServerProfiles();
          const target = String(profile).trim().toLowerCase();
          const serverMatch = serverProfiles.find(item => item.id === profile || String(item.name || '').trim().toLowerCase() === target);
          if (serverMatch) {
            match = getProfiles().registerSessionProfile(serverMatch);
          }
        }
        if (!match) throw new Error(`Profile not found: ${profile}`);
        const { unavailable } = await activateSessionProfile(match.id);
        if (unavailable.length > 0) throw new Error(`MCP servers of the profile are not available: ${unavailable.join(', ')}`);
        report({ kind: 'profile', text: match.name });
      }

      const parsedSecurity = typeof toolSecurity === 'string' ? JSON.parse(toolSecurity) : toolSecurity;
      if (parsedSecurity) hydrateToolSecurity(parsedSecurity);

      answerToolApprovals(allowDangerous === true, report, {
        pauseOnApproval: isConversationMode,
        allowOnce: parsedSecurity?.allow_once
      });

      if (isConversationMode) {
        await switchToSession(conversationId);
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
    hydrateToolSecurity,
    answerToolApprovals,
    start
  };
}));
