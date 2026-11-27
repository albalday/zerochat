/**
 * Herramienta nativa switch_model: cambia, por instrucción del usuario, de perfil (modelo) y/o de nivel de
 * razonamiento a mitad del trabajo; vale desde la siguiente llamada al modelo del mismo turno.
 * El modelo no recibe la lista de perfiles: solo vale un perfil cuyo nombre aparece en un mensaje del usuario,
 * para que un texto ajeno (una página, un resultado) no pueda mandar la conversación a otro proveedor.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../i18n.js'), require('../../icons.js'));
  else root.ChatBuiltinSwitchModelTool = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { escapeHtml, resolveDep } = Utils;
  const { t } = I18n;
  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');

  // Los niveles del selector de razonamiento, con su etiqueta.
  const REASONING_LEVELS = Utils.resolveDep('ChatDefaults', './defaults.js').REASONING_LEVEL_LABEL_KEYS;
  const MODEL_ICON_SVG = Icons.get('shuffle', { size: 14 });
  const WORD_CHAR = /[\p{L}\p{N}_]/u;

  /** Texto de un mensaje del usuario, también si lleva adjuntos (partes). */
  function messageText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n');
  }

  /** Si text contiene name como palabra completa, sin distinguir mayúsculas. */
  function mentions(text, name) {
    const haystack = text.toLowerCase();
    const needle = name.toLowerCase();
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      const before = haystack[at - 1];
      const after = haystack[at + needle.length];
      if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) return true;
    }
    return false;
  }

  /** Perfil con ese nombre (sin distinguir mayúsculas; si hay varios, el de la misma grafía). */
  function findProfile(profiles, name) {
    const matches = profiles.filter(profile => String(profile?.name || '').trim().toLowerCase() === name.toLowerCase());
    return matches.find(profile => profile.name.trim() === name) || matches[0] || null;
  }

  /** Valida los argumentos y devuelve { profile, reasoningEffort } o { error }. */
  function resolveRequest(args, { profiles, userMessages }) {
    const name = typeof args?.profile === 'string' ? args.profile.trim() : '';
    const reasoning = typeof args?.reasoning === 'string' ? args.reasoning.trim().toLowerCase() : '';
    if (!name && !reasoning) return { error: 'Give profile, reasoning or both.' };
    if (reasoning && !Object.hasOwn(REASONING_LEVELS, reasoning)) {
      return { error: `reasoning must be one of: ${Object.keys(REASONING_LEVELS).join(', ')}.` };
    }
    if (!name) return { profile: null, reasoningEffort: reasoning };

    const profile = findProfile(profiles, name);
    if (!profile) return { error: `There is no profile named "${name}". Ask the user for the exact profile name.` };
    const texts = userMessages.map(messageText);
    if (!texts.some(text => mentions(text, profile.name.trim()))) {
      return { error: `The user has not named the "${profile.name}" profile in this conversation: only a profile the user names can be used.` };
    }
    return { profile, reasoningEffort: reasoning || null };
  }

  function describe(result) {
    const level = REASONING_LEVELS[result.reasoning] ? t(REASONING_LEVELS[result.reasoning]).toLocaleLowerCase() : result.reasoning;
    return t('tool_switch_model_done', { profile: result.profile, model: result.model, reasoning: level });
  }

  function createLiveCard(_args, ui) {
    const card = ui.createCardWrapper();
    card.innerHTML = getCards().renderCardHtml({
      className: 'switch-model-tool-card',
      collapsible: false,
      titleHtml: `${MODEL_ICON_SVG}<span>${escapeHtml(t('tool_switch_model_title'))}</span>`,
      badgeHtml: '<span class="tool-card-badge status-loading"></span>'
    });
    return card;
  }

  function updateLiveCard(card, _args, result) {
    const success = result.success !== false && !result.error;
    const label = success ? describe(result) : String(result.error || result.content || '');
    getCards().renderStatusBadge(card.querySelector('.tool-card-badge'), success, label);
  }

  return {
    definition: {
      name: 'switch_model',
      description: 'Switch the model profile and/or the reasoning level for the rest of the work, from your next step on. Use it only when the user asks for it (for example "analyse with profile X and high reasoning, then implement it with Y"), at the point of the work the user indicated. The profile must be a name the user wrote; there is no list of profiles to choose from. Reasoning: none, low, medium (normal), high or xhigh (maximum).',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: 'Profile name exactly as the user wrote it. Omit it to keep the current model.' },
          reasoning: { type: 'string', enum: Object.keys(REASONING_LEVELS), description: 'Reasoning level. Omit it to keep the current one (or the one of the new profile).' }
        }
      }
    },
    category: 'interaction',
    settings: { titleKey: 'agent_switch_model_title', descKey: 'agent_switch_model_desc' },
    promptGuide: '- `switch_model(profile="Name", reasoning="high")`: Only when the user asks: switches the profile and/or reasoning level from your next step on.',
    execute: async (args, context = {}) => {
      const modelSwitch = context.modelSwitch;
      if (typeof modelSwitch?.apply !== 'function') return { success: false, error: 'Switching the model is not available here.' };
      let profiles;
      try {
        // En una ejecución en el servidor, los perfiles del servidor van primero, como en la elección del perfil inicial.
        const repository = context.services.profiles;
        const session = repository.listSessionProfiles?.() || [];
        profiles = [...session, ...repository.list().filter(profile => !session.some(item => item.id === profile.id))];
      } catch (error) {
        return { success: false, error: `The profiles could not be read: ${error?.message || String(error)}` };
      }
      const request = resolveRequest(args, { profiles, userMessages: modelSwitch.userMessages || [] });
      if (request.error) return { success: false, error: request.error };
      try {
        const applied = await modelSwitch.apply({ profileId: request.profile?.id || null, reasoningEffort: request.reasoningEffort });
        return { success: true, profile: applied.profile, model: applied.model, reasoning: applied.reasoningEffort };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    },
    result: {
      toModel: (_args, result) => JSON.stringify(result.success === false
        ? { success: false, error: result.error }
        : { success: true, profile: result.profile, model: result.model, reasoning: result.reasoning, note: 'From your next step on you run with this profile and reasoning level.' }),
      toMarkdown: (_args, result) => result.success === false
        ? `> **switch_model** (error: ${result.error})\n\n`
        : `> **switch_model** (${result.profile} · ${result.model} · ${result.reasoning})\n\n`
    },
    displayMode: 'expanded',
    view: { createLiveCard, updateLiveCard }
  };
});
