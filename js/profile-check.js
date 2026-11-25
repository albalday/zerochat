/**
 * Comprobación del perfil activo, la misma en la interfaz y en el runner de Node: cada vez que cambian el perfil
 * activo o su conexión (tipo, URL o modelo) consulta con su API key el listado de modelos del servidor y publica si
 * el modelo está listo (ui.profileCheck: estado y motivo) y su límite de contexto (config.modelContextLimit), real si
 * el servidor lo publica y, si no, null para que el gestor de contexto use el calculado. No guarda nada en el perfil.
 * La interfaz la repite con recheck() al pulsar el perfil activo o inspeccionarlo, y si quedó en error, al volver a
 * la pestaña o terminar un turno.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatProfileCheck = factory(root.ChatUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const { resolveDep } = Utils;
  const getState = () => resolveDep('ChatState', './state.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getProfiles = () => resolveDep('ChatProfileRepository', './profile-repository.js');
  const getApi = () => resolveDep('ChatAPI', './api.js');
  const getProviders = () => resolveDep('ChatProviders', './providers.js');
  const getContextManager = () => resolveDep('ChatContextManager', './context-manager.js');

  let sequence = 0;
  let latest = Promise.resolve();
  let unsubscribe = null;

  /** Lo que decide la comprobación: cambia al activar otro perfil, al guardarlo de nuevo o al cambiar su conexión. */
  const checkKey = config => JSON.stringify([
    config.activeProfile?.id || '', config.activeProfile?.version || 0, config.activeProfile?.updatedAt || 0,
    config.apiType, config.apiUrl, config.model, config.contextWindow || '', config.webllmConfig?.context_window_size || ''
  ]);

  /** Motivo de un listado fallido: la clave rechazada, otro error HTTP del servidor o el servidor que no responde. */
  function failureReason(message) {
    if (/\bHTTP 40[13]\b/.test(message)) return 'auth';
    if (/\bHTTP \d{3}\b/.test(message)) return 'server';
    return 'unreachable';
  }

  /**
   * Resultado de comprobar una conexión: { status, reason, message, contextLimit }. `unchecked` cuando no se puede
   * comprobar por red (WebLLM, que da su ventana de contexto; un proveedor sin listado, o la clave sin desbloquear).
   */
  async function evaluate(config) {
    const manualNum = Number(config.contextWindow);
    const manualLimit = Number.isFinite(manualNum) && manualNum > 0 ? Math.floor(manualNum) : null;
    if (config.apiType === 'webllm') {
      const size = manualLimit || Number(config.webllmConfig?.context_window_size) || getContextManager().WEBLLM_DEFAULT_CONTEXT;
      return { status: 'unchecked', reason: '', message: '', contextLimit: size };
    }
    const unchecked = reason => ({ status: 'unchecked', reason, message: '', contextLimit: manualLimit });
    if (getProviders().registry.resolve(config.apiUrl, config.apiType).getCapabilities().modelListing === false) return unchecked('');
    let apiKey = '';
    try {
      apiKey = (await getProfiles().loadUnlocked(config.activeProfile?.id))?.settings?.apiKey || '';
    } catch (_) {
      return unchecked('locked'); // Sin la contraseña de las claves no se consulta: se comprobará al volver a activarlo.
    }
    let listing;
    try {
      listing = await getApi().fetchServerModels(config.apiUrl, apiKey, config.apiType);
    } catch (error) {
      listing = { success: false, error: error?.message || String(error) };
    }
    if (!listing.success) {
      const message = String(listing.error || '');
      return { status: 'error', reason: failureReason(message), message, contextLimit: manualLimit };
    }
    const models = Array.isArray(listing.models) ? listing.models : [];
    const ContextManager = getContextManager();
    if (!ContextManager.findModelInCatalog(models, config.model)) {
      return { status: 'error', reason: 'model_not_found', message: config.model, contextLimit: manualLimit };
    }
    return { status: 'ready', reason: '', message: '', contextLimit: manualLimit || ContextManager.getModelContextLimit(config.model, models) };
  }

  /** Comprueba la configuración dada y publica el resultado, salvo que otra comprobación posterior la haya relevado. */
  async function run(config) {
    const current = ++sequence;
    getState().setProfileCheck({ status: 'checking' });
    const { contextLimit, ...status } = await evaluate(config);
    if (current !== sequence) return;
    getConfig().updateRuntime({ modelContextLimit: contextLimit });
    getState().setProfileCheck(status);
  }

  /** Comprueba el perfil activo ahora y cada vez que cambien el perfil o su conexión. */
  function start() {
    unsubscribe?.();
    latest = run(getConfig().getActive());
    unsubscribe = getConfig().subscribe((next, previous) => {
      if (checkKey(next) !== checkKey(previous)) latest = run(next);
    });
  }

  /**
   * Vuelve a comprobar el perfil activo aunque no haya cambiado: el servidor pudo arrancar, cargar el modelo o
   * aceptar la clave después de la última comprobación.
   */
  function recheck() {
    latest = run(getConfig().getActive());
    return latest;
  }

  /** Espera a la última comprobación lanzada (el runner, antes de su primer turno). */
  const settled = () => latest;

  return { start, recheck, settled };
}));
