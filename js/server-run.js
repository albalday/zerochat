/**
 * Control de la ejecución en servidor: el agente de una conversación corre en zerochat.py y la página
 * sigue su estado vivo (`mcp.serverRuns`, que mantiene ChatMCP). Decide si la ejecución en servidor está
 * disponible, qué ejecución corresponde a la conversación activa, si esta bloquea el compositor, qué
 * ejecuciones han terminado y si hay pasos grabados que la página aún no muestra; arranca y cancela
 * ejecuciones con la política de herramientas vigente.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatServerRun = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;
  const getState = () => resolveDep('ChatState', './state.js');
  const getMcpManager = () => resolveDep('ChatMCP', './mcp.js').manager;
  const getToolSecurity = () => resolveDep('ChatToolSecurity', './tool-security.js').manager;

  const getRuns = () => getState().get('mcp').serverRuns;
  const getActiveId = () => getState().get('sessions').activeId;

  /** La ejecución en servidor exige el servidor local conectado. */
  function isAvailable() {
    return getState().get('mcp').status === 'connected';
  }

  /** La conversación se guardó como ejecución en servidor o tiene una en el estado vivo. */
  function isServerConversation(conversation) {
    if (!conversation) return false;
    if (conversation.serverRun) return true;
    return getRuns().some(run => run.conversationId === conversation.id);
  }

  /** Ejecución en curso, con error o detenida por un límite de la conversación activa, o null. */
  function getActiveRun() {
    const activeId = getActiveId();
    return getRuns().find(run => run.conversationId === activeId && ['running', 'error', 'limit'].includes(run.status)) || null;
  }

  function isActiveSessionRunning() {
    const activeId = getActiveId();
    return getRuns().some(run => run.conversationId === activeId && run.status === 'running');
  }

  /** El compositor está ocupado mientras genera la página o el servidor para la conversación activa. */
  function isComposerBusy() {
    return getState().get('streaming').isGenerating || isActiveSessionRunning();
  }

  /** Conversaciones que estaban en curso en `previousRuns` y ya no lo están en `runs`. */
  function finishedRunIds(previousRuns, runs) {
    const running = list => new Set(list.filter(run => run.status === 'running').map(run => run.conversationId));
    const current = running(runs);
    return [...running(previousRuns)].filter(id => !current.has(id));
  }

  /** Arranca la ejecución con la política de herramientas vigente y, al reanudar, la decisión del usuario. */
  function start({ conversationId, profile, toolDecision = null, subagents = false }) {
    const snapshot = getToolSecurity().snapshot();
    return getMcpManager().startServerRun({
      conversationId,
      profile,
      toolSecurity: toolDecision ? { ...snapshot, tool_decision: toolDecision } : snapshot,
      subagents
    });
  }

  function cancelActive() {
    return getMcpManager().cancelServerRun(getActiveId());
  }

  /**
   * Al cambiar de conversación, relee el estado vivo si hay ejecuciones o la abierta es de servidor: así
   * se reanuda la consulta frecuente al volver a una en marcha y se detiene al salir de ella.
   */
  function refreshLiveState() {
    const mcp = getMcpManager();
    if (!mcp.isProxyConnected()) return Promise.resolve();
    const active = getState().get('sessions').list.find(session => session.id === getActiveId());
    if (getRuns().length === 0 && !isServerConversation(active)) return Promise.resolve();
    return mcp.readLiveState();
  }

  /**
   * La conversación abierta tiene grabado en el servidor algo más nuevo que lo que muestra la página:
   * `focusRun` es de ella y su `conversation_updated_at` supera la fecha de la cabecera cargada.
   */
  function hasNewerSavedSteps(focusRun) {
    if (!focusRun || focusRun.conversation_id !== getActiveId()) return false;
    const savedAt = focusRun.conversation_updated_at;
    const shown = getState().get('sessions').list.find(session => session.id === getActiveId());
    return Number.isFinite(savedAt) && savedAt > (shown?.updatedAt || 0);
  }

  return {
    isAvailable,
    isServerConversation,
    getActiveRun,
    isActiveSessionRunning,
    isComposerBusy,
    finishedRunIds,
    start,
    cancelActive,
    refreshLiveState,
    hasNewerSavedSteps
  };
}));
