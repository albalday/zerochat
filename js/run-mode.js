/**
 * Modo ejecución desatendida (zerochat.py --prompt, --conversation y --run-file) en el runner de
 * Node.js: pide el prompt o carga la conversación existente, informa del paso en curso, termina en
 * needs_input si el servidor pausa una herramienta sin permiso (tool_approval), exporta si se pidió
 * (--export) y devuelve el resultado o el estado de espera al usuario (needs_input).
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

  const { resolveDep } = Utils;
  const getState = () => resolveDep('ChatState', './state.js');
  const getMcpManager = () => resolveDep('ChatMCP', './mcp.js').manager;
  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getProfileCheck = () => resolveDep('ChatProfileCheck', './profile-check.js');

  // El streaming informa como mucho cada este intervalo; el resto de avisos, siempre.
  const STREAM_PROGRESS_INTERVAL_MS = 2000;
  const CONNECT_ATTEMPTS = 30;
  const CONNECT_RETRY_MS = 1000;

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
   * reintenta, `activateSessionProfile` activa sin guardarlo el perfil pedido (nombre o id),
   * `submitComposerText` envía el prompt como el usuario (o continúa con `{ resume: true }`), con el
   * tope `maxSteps`, y devuelve { text }, { error } o { limit }, `exportConversation` da la
   * conversación activa en un formato de ChatExport, `switchToSession` cambia a una conversación
   * existente y `startNewSession` abre sin --conversation la conversación nueva cuyo id eligió el
   * servidor (el de --run-file o uno propio).
   */
  async function start(runId, {
    startupConnection,
    connectBackend,
    activateSessionProfile,
    submitComposerText,
    exportConversation,
    switchToSession,
    startNewSession
  }) {
    const send = (method, params = {}) => getMcpManager().requestExternalControl(method, { run_id: runId, ...params });
    const report = createProgressReporter(event => {
      send('zerochat/run/progress', event).catch(error => console.warn('[RunMode] Could not report progress:', error));
    });
    // El consumo acumulado tras cada llamada al modelo, en orden: el resultado espera al último para que la
    // fila de la ejecución quede con el total aunque el proceso termine justo después.
    let usageSent = Promise.resolve();
    const reportUsage = usage => {
      usageSent = usageSent.then(() => send('zerochat/run/usage', {
        model_calls: usage.modelCalls,
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cached_tokens: usage.cachedTokens,
        reasoning_tokens: usage.reasoningTokens,
        estimated: usage.estimated
      })).catch(error => console.warn('[RunMode] Could not report usage:', error));
    };
    try {
      await waitForBackend(startupConnection, connectBackend);
      const {
        prompt,
        profile,
        profile_data: profileData,
        profiles: serverProfiles,
        export: exportFormat,
        conversation_id: conversationId,
        new_conversation_id: newConversationId,
        max_steps: maxSteps = null,
        project_mode: projectMode = null,
        reasoning = null
      } = await send('zerochat/run/prompt');
      // --run-file decide si se inyectan las normas y el estado del proyecto; --prompt y --conversation, no (null).
      if (typeof projectMode === 'boolean') getConfig().updateRuntime({ projectMode });

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
      // El razonamiento de --run-file va después del perfil, que trae el suyo; sin él (null) queda el del perfil.
      if (typeof reasoning === 'string') getConfig().updateRuntime({ reasoningEffort: reasoning });

      // La comprobación del perfil, como en la interfaz: da el límite de contexto real y avisa si el modelo no está listo.
      getProfileCheck().start();
      await getProfileCheck().settled();
      const check = getState().get('ui').profileCheck;
      if (check.status === 'error') console.warn(`[RunMode] The model is not ready (${check.reason}): ${check.message}`);

      if (isConversationMode) {
        await switchToSession(conversationId);
      } else if (newConversationId) {
        // El runner de Node solo puede guardar la conversación que eligió el servidor, y quien lanzó la ejecución
        // la busca por ese id.
        await startNewSession(newConversationId);
      }

      await getMcpManager().reconcileProjectServers();

      let generated = null;
      if (isConversationMode && (!prompt || typeof prompt !== 'string')) {
        const State = getState();
        const messages = State.get('messages');
        const cleaned = prepareConversationForContinuation(messages);
        if (cleaned.length !== messages.length) {
          State.replaceMessages(cleaned);
        }
        generated = await submitComposerText('', { resume: true, onProgress: report, onUsage: reportUsage, maxSteps });
      } else {
        generated = await submitComposerText(prompt, { onProgress: report, onUsage: reportUsage, maxSteps });
      }

      const question = pendingAskUserQuestion(getState().get('messages'));
      const pendingAuth = pendingToolApproval(getState().get('messages'));
      if (question) report({ kind: 'user_request', text: question });

      // La conversación queda guardada con la pausa, nueva o no: se reanuda por su id.
      let result;
      if (generated?.error) {
        result = { error: generated.error };
      } else if (generated?.limit) {
        result = { limit: generated.limit };
      } else if (question) {
        result = { needs_input: { kind: 'ask_user', text: question } };
      } else if (pendingAuth) {
        result = { needs_input: { kind: 'tool_approval', text: pendingAuth } };
      } else {
        result = { text: generated?.text || '' };
      }

      if (exportFormat) {
        try {
          await send('zerochat/run/export', { content: await exportConversation(exportFormat) });
        } catch (error) {
          console.error('[RunMode] Could not export the conversation:', error);
        }
      }

      await usageSent;
      if (result.needs_input) {
        await send('zerochat/run/result', { needs_input: result.needs_input });
      } else if (result.limit) {
        await send('zerochat/run/result', { limit: result.limit });
      } else if (result.error) {
        await send('zerochat/run/result', { error: result.error });
      } else {
        await send('zerochat/run/result', { text: result.text });
      }
    } catch (error) {
      console.error('[RunMode] Unattended run failed:', error);
      await usageSent;
      await send('zerochat/run/result', { error: error?.message || String(error) })
        .catch(sendError => console.error('[RunMode] Could not send the result:', sendError));
    } finally {
      getProfiles().clearSessionProfile();
      window.close();
    }
  }

  return {
    createProgressReporter,
    pendingAskUserQuestion,
    pendingToolApproval,
    prepareConversationForContinuation,
    start
  };
}));
