/** Tool autocontenida: ask_user. Muestra una pregunta con opciones y cede el turno al usuario. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
  else root.ChatBuiltinAskUserTool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_OPTIONS = 2;
  const MAX_OPTIONS = 4;
  const MAX_QUESTION_LENGTH = 500;
  const MAX_LABEL_LENGTH = 120;
  const MAX_DESCRIPTION_LENGTH = 300;

  const definition = {
    name: 'ask_user',
    description: 'Asks the user a multiple-choice question and ends your turn; the chosen option arrives as the next user message. Use it only when you are blocked on a decision that genuinely belongs to the user (approving a proposal, choosing between incompatible approaches). Do not use it to ask permission to continue, for questions you can answer from the context, or for open-ended questions.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Clear, specific question ending with a question mark.' },
        options: {
          type: 'array',
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          description: `${MIN_OPTIONS} to ${MAX_OPTIONS} mutually exclusive choices. The user can always type a different answer instead.`,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short choice text (1-6 words), sent as the user reply when chosen.' },
              description: { type: 'string', description: 'Optional one-line explanation of the choice and its consequences.' }
            },
            required: ['label']
          }
        }
      },
      required: ['question', 'options']
    }
  };

  const getCards = () => typeof window !== 'undefined' && window.ChatToolCards || require('../../tool-cards.js');
  const getUtils = () => typeof window !== 'undefined' && window.ChatUtils || require('../../utils.js');

  function clip(value, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /** Valida y normaliza los argumentos del modelo. Devuelve { question, options } o { error }. */
  function normalizeArgs(args = {}) {
    const question = clip(args?.question, MAX_QUESTION_LENGTH);
    if (!question) return { error: 'question must be a non-empty string.' };
    const seen = new Set();
    const options = (Array.isArray(args?.options) ? args.options : [])
      .map(option => ({
        label: clip(typeof option === 'string' ? option : option?.label, MAX_LABEL_LENGTH),
        description: clip(option?.description, MAX_DESCRIPTION_LENGTH)
      }))
      .filter(option => option.label && !seen.has(option.label.toLowerCase()) && seen.add(option.label.toLowerCase()));
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return { error: `options must contain ${MIN_OPTIONS} to ${MAX_OPTIONS} distinct choices with a non-empty label.` };
    }
    return { question, options };
  }

  function getIcon(ui) {
    const Icons = ui?.icons || (typeof window !== 'undefined' && window.ChatIcons) || (typeof require !== 'undefined' ? require('../../icons.js') : null);
    return Icons?.get ? Icons.get('help-circle', { size: 15 }) : '';
  }

  /**
   * Los botones se pintan desactivados: la aplicación habilita solo los de la pregunta pendiente
   * (la última del historial, sin generación en curso).
   */
  function renderCard(args, ui, error = '') {
    const escapeHtml = ui?.markdown?.escapeHtml || getUtils().escapeHtml;
    const t = ui?.t || (key => key);
    const normalized = normalizeArgs(args);
    const question = normalized.question || clip(args?.question, MAX_QUESTION_LENGTH);
    const options = normalized.options || [];
    const problem = error || normalized.error || '';
    const buttons = options.map(option => `<button type="button" class="ask-user-option" data-ask-option="${escapeHtml(option.label)}" disabled><span class="ask-user-option-label">${escapeHtml(option.label)}</span>${option.description ? `<span class="ask-user-option-desc">${escapeHtml(option.description)}</span>` : ''}</button>`).join('');
    return `<div class="ask-user-card" role="group" aria-label="${escapeHtml(question)}">
      <div class="ask-user-question">${getIcon(ui)}<span>${escapeHtml(question)}</span></div>
      ${buttons ? `<div class="ask-user-options">${buttons}</div>` : ''}
      <div class="ask-user-hint${problem ? ' ask-user-error' : ''}">${escapeHtml(problem || t('tool_ask_user_hint'))}</div>
    </div>`;
  }

  function createLiveCard(args, ui) {
    const cardDiv = getCards().createCardWrapper(ui);
    if (cardDiv) cardDiv.innerHTML = renderCard(args, ui);
    return cardDiv;
  }

  function updateLiveCard(cardDiv, args, result = {}, _elapsedMs, ui) {
    if (cardDiv) cardDiv.innerHTML = renderCard(args, ui, result?.success === false ? String(result.error || '') : '');
  }

  function renderHistoricalCard(args, _toolMessage, ui) {
    return createLiveCard(args, ui);
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear ask_user.');
    return new Tool({
      id: definition.name,
      definition,
      category: 'interaction',
      metadata: { icon: 'help-circle', label: definition.name },
      settings: { titleKey: 'agent_ask_user_title', titleFallback: 'Preguntas con opciones', descKey: 'agent_ask_user_desc', descFallback: 'Permite al modelo pedirte una decisión con opciones para elegir.', icon: 'help-circle', defaultEnabled: true, showInSettings: true },
      promptGuide: () => '- `ask_user(question="...", options=[{"label": "...", "description": "..."}])`: Asks the user a multiple-choice question (2-4 options) and ends your turn. Use only when blocked on a decision that belongs to the user.',
      execute: async (args) => {
        const normalized = normalizeArgs(args);
        if (normalized.error) return { success: false, error: normalized.error };
        return { success: true, endTurn: true, question: normalized.question, options: normalized.options };
      },
      result: {
        toModel: (_args, result) => JSON.stringify(result?.success === false
          ? { success: false, error: result.error }
          : { status: 'shown_to_user', note: 'The user\'s answer will arrive as the next user message. Do not answer for them.' }),
        toMarkdown: (_args, result) => {
          if (result?.success === false) return `> **ask_user** (error: ${result.error})\n\n`;
          const lines = (result?.options || []).map(option => `> - ${option.label}${option.description ? ` — ${option.description}` : ''}`);
          return `> **ask_user**: ${result?.question || ''}\n${lines.join('\n')}\n\n`;
        }
      },
      displayMode: 'expanded',
      view: { id: definition.name, displayMode: 'expanded', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = {
    id: definition.name,
    definition,
    displayMode: 'expanded',
    createTool,
    normalizeArgs,
    view: { id: definition.name, displayMode: 'expanded', createLiveCard, updateLiveCard, renderHistoricalCard }
  };

  let manifestApi = null;
  if (typeof window !== 'undefined' && window.ChatToolManifest) manifestApi = window.ChatToolManifest;
  else if (typeof require !== 'undefined') { try { manifestApi = require('../tool-manifest.js'); } catch (e) { /* módulo opcional: no disponible en este entorno */ } }
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
