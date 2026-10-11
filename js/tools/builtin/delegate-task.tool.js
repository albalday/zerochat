/** Tool autocontenida: delegate_task. Delega una investigación a un subagente de solo lectura con contexto propio. */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory(require('../../utils.js'), require('../../i18n.js'), require('../../icons.js'));
  else root.ChatBuiltinDelegateTaskTool = factory(root.ChatUtils, root.ChatI18n, root.ChatIcons);
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n, Icons) {
  'use strict';

  const { resolveDep } = Utils;

  const MAX_TASK_LENGTH = 8000;
  const MAX_REPORT_LENGTH = 20000;
  const TASK_PREVIEW_LENGTH = 600;

  // El subagente solo recibe herramientas que leen; nunca delegate_task, ask_user ni render_chart.
  const READ_ONLY_BUILTIN_TOOLS = new Set([
    'search_web', 'fetch_web_page', 'download_pdf', 'execute_javascript',
    'list_documents', 'search_knowledge_base', 'read_knowledge_chunk', 'read_knowledge_image'
  ]);
  // Del servidor local, solo las de lectura. Los MCP externos quedan fuera: no declaran si escriben.
  const READ_ONLY_LOCAL_TOOLS = new Set(['read_file', 'list_directory', 'search_files', 'get_diagnostics']);
  const LOCAL_SERVER_ID = 'mcp_proxy';
  // Un perfil de conexión con este nombre (sin distinguir mayúsculas) da al subagente otro modelo.
  const SUBAGENT_PROFILE_NAMES = new Set(['subagente', 'subagent']);

  const definition = {
    name: 'delegate_task',
    description: 'Delegate a self-contained research task to a read-only subagent with a fresh context; only its final report comes back. Use it for broad investigations that need many reads (exploring the project, comparing several pages or documents) to keep the raw material out of this conversation. Not for quick lookups, edits or questions for the user. It cannot see this conversation: include all the context it needs.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Full instructions: goal, known context (paths, URLs, names) and what the report must contain.' }
      },
      required: ['task']
    }
  };

  const getCards = () => resolveDep('ChatToolCards', './tool-cards.js');
  const translate = (key, params) => I18n.t(key, params);
  const BOT_ICON_SVG = Icons.get('bot', { size: 14 });

  function isReadOnlyTool(tool) {
    if (!tool?.name) return false;
    if (tool.category === 'mcp') return tool.metadata?.mcpServerId === LOCAL_SERVER_ID && READ_ONLY_LOCAL_TOOLS.has(tool.name);
    return READ_ONLY_BUILTIN_TOOLS.has(tool.name);
  }

  function normalizeTask(value) {
    const task = typeof value === 'string' ? value.trim() : '';
    if (!task) return { error: 'task must be a non-empty string.' };
    if (task.length > MAX_TASK_LENGTH) return { error: `task must not exceed ${MAX_TASK_LENGTH} characters.` };
    return { task };
  }

  function buildSubagentPrompt(task) {
    return [
      '[Subagent task]',
      'You are a read-only subagent. The main assistant delegated the task below to you; you do not see its conversation and cannot talk to the user.',
      '- Investigate with the available tools. They only read: you cannot create, edit or run anything, so ignore any instruction to record progress or modify files.',
      '- When the task is answered, reply with your final report and stop calling tools.',
      '- The report is returned verbatim to the main assistant. Make it concise and self-contained: findings and conclusions with concrete references (file paths with line numbers, URLs, document names), plus what you could not determine. Do not narrate the process.',
      '',
      'Task:',
      task
    ].join('\n');
  }

  /** Tarjeta en vivo de esta invocación, localizada por su data-invocation-id dentro del contenedor del turno. */
  function findLiveCard(context = {}) {
    const container = context.container;
    if (!context.invocationId || typeof container?.querySelectorAll !== 'function') return null;
    return Array.from(container.querySelectorAll('[data-invocation-id]'))
      .find(element => element.dataset.invocationId === context.invocationId) || null;
  }

  function renderMarkdown(text, markdown) {
    const Markdown = markdown || resolveDep('ChatMarkdown', './markdown.js');
    if (typeof Markdown?.parseMarkdown === 'function') return Markdown.parseMarkdown(text);
    return `<pre class="tool-result-pre"><code>${Utils.escapeHtml(text)}</code></pre>`;
  }

  /**
   * Progreso del subagente en su tarjeta: la insignia indica el paso y cada texto intermedio se
   * añade al terminar su paso. Las tarjetas de sus herramientas se crean en el mismo contenedor.
   * El bloque de texto se reserva al empezar el paso para que quede encima de sus herramientas.
   */
  function createProgressView(card, context = {}) {
    const steps = card?.querySelector?.('.subagent-steps');
    if (!steps) return null;
    let stepBlock = null;
    return {
      steps,
      setStep(step) {
        const label = card.querySelector('.tool-card-badge.status-loading span');
        if (label) label.textContent = translate('tool_delegate_step', { step });
        const doc = steps.ownerDocument;
        if (!doc) return;
        stepBlock = doc.createElement('div');
        stepBlock.className = 'subagent-step-text';
        steps.appendChild(stepBlock);
      },
      /** El título ya dice «Subagente»: la etiqueta muestra el modelo y el perfil queda en su ayuda. */
      setProfile(name, model) {
        const label = card.querySelector('.subagent-model');
        if (!label || !name) return;
        label.textContent = model || name;
        label.title = translate('tool_delegate_profile_title', { name });
        label.hidden = false;
      },
      setText(text) {
        const block = stepBlock;
        stepBlock = null;
        if (!block) return;
        if (!text) {
          block.remove();
          return;
        }
        block.innerHTML = renderMarkdown(text);
        context.attachListeners?.(block);
      }
    };
  }

  /**
   * Conexión del subagente: la del agente principal o, si existe, la del perfil «Subagente».
   * Un perfil existente que no se puede cargar es un error: no se sustituye en silencio por el principal.
   */
  async function resolveConnection(context = {}) {
    const inherited = {
      apiUrl: context.apiUrl,
      apiType: context.apiType,
      apiKey: context.apiKey,
      model: context.model,
      temperature: context.temperature,
      reasoningEffort: context.reasoningEffort,
      reasoningTransport: context.reasoningTransport,
      contextOptions: context.contextOptions || {},
      summarizeHistory: context.summarizeHistory || null
    };
    let match;
    try {
      match = (context.services?.profiles?.list?.() || [])
        .find(profile => SUBAGENT_PROFILE_NAMES.has(String(profile?.name || '').trim().toLowerCase()));
    } catch (error) {
      return { error: `The connection profiles could not be read: ${error?.message || String(error)}` };
    }
    if (!match) return inherited;

    let settings;
    try {
      const profile = await context.services.profilesUI.loadProfileUnlocked(match.id);
      if (!profile) throw new Error('the profile no longer exists.');
      settings = profile.settings || {};
    } catch (error) {
      return { error: `The "${match.name}" connection profile could not be loaded: ${error?.message || String(error)}` };
    }
    const missing = ['apiUrl', 'apiType', 'model'].filter(key => !settings[key]);
    if (missing.length > 0) return { error: `The "${match.name}" connection profile is incomplete: missing ${missing.join(', ')}.` };

    const connection = {
      profileName: match.name,
      apiUrl: settings.apiUrl,
      apiType: settings.apiType,
      apiKey: settings.apiKey || '',
      model: settings.model,
      temperature: settings.temperature,
      reasoningEffort: settings.reasoningEffort || 'medium',
      reasoningTransport: settings.reasoningTransport || 'auto',
      // Sin capacidad declarada en el perfil, el gestor de contexto asume la de su modelo.
      contextOptions: { ...inherited.contextOptions, totalContextLimit: settings.contextLimitOverride || null },
      summarizeHistory: null
    };
    const Engine = context.services?.engine;
    if (typeof Engine?.createHistorySummarizer === 'function') {
      connection.summarizeHistory = Engine.createHistorySummarizer({
        apiUrl: connection.apiUrl,
        apiType: connection.apiType,
        apiKey: connection.apiKey,
        model: connection.model,
        signal: context.signal || null,
        onBeforeRequest: context.onBeforeRequest || null
      });
    }
    return connection;
  }

  async function runSubagent(args = {}, context = {}) {
    const normalized = normalizeTask(args.task);
    if (normalized.error) return { success: false, error: normalized.error };
    const AgentCore = context.services?.agent;
    if (!AgentCore?.runtime || !AgentCore?.registry) return { success: false, error: 'Agent runtime not available.' };
    const registry = AgentCore.registry;

    const activeDefinitions = typeof context.resolveToolDefinitions === 'function'
      ? await context.resolveToolDefinitions({ stepIndex: 0, workingMessages: [] })
      : registry.getActiveDefinitions(context.config || {});
    const allowed = new Set();
    const tools = (Array.isArray(activeDefinitions) ? activeDefinitions : []).filter(toolDefinition => {
      const tool = registry.getTool(toolDefinition?.function?.name);
      if (!isReadOnlyTool(tool)) return false;
      allowed.add(tool.name);
      return true;
    });
    if (tools.length === 0) return { success: false, error: 'No read-only tools are enabled, so a subagent cannot investigate anything.' };

    const connection = await resolveConnection(context);
    if (connection.error) return { success: false, error: connection.error };

    const progress = createProgressView(findLiveCard(context), context);
    progress?.setProfile(connection.profileName, connection.model);
    // El modelo puede pedir una herramienta que no se le ofreció: se rechaza sin ejecutarla.
    const dispatch = async (toolCall, toolContext) => {
      const name = toolCall?.function?.name || '';
      const tool = registry.getTool(name);
      if (!tool || !allowed.has(tool.name)) {
        return { success: false, toolName: name, error: `Tool '${name}' is not available to the subagent: it can only use the read-only tools it was given.` };
      }
      if (typeof context.dispatchToolCall === 'function') {
        return context.dispatchToolCall(toolCall, { ...toolContext, container: progress?.steps || null });
      }
      return AgentCore.executor.executeToolCall(toolCall, toolContext);
    };

    const result = await AgentCore.runtime.execute({
      apiUrl: connection.apiUrl,
      apiType: connection.apiType,
      apiKey: connection.apiKey,
      model: connection.model,
      temperature: connection.temperature,
      reasoningEffort: connection.reasoningEffort,
      reasoningTransport: connection.reasoningTransport,
      api: context.api || null,
      messages: [{ role: 'user', content: buildSubagentPrompt(normalized.task) }],
      signal: context.signal || null,
      // Mismo prompt de sistema y proyecto que el agente principal; la compactación usa su propia conexión.
      prepareMessages: context.prepareMessages || null,
      contextOptions: connection.contextOptions,
      summarizeHistory: connection.summarizeHistory,
      onBeforeRequest: context.onBeforeRequest || null,
      resolveToolDefinitions: () => tools,
      dispatchToolCall: dispatch,
      callbacks: {
        onStepStart: stepIndex => progress?.setStep(stepIndex + 1),
        onStepDone: (_stepIndex, step) => {
          progress?.setText(step?.type === 'tool_execution' ? step.assistantMsg?.content || '' : '');
        }
      }
    });

    if (result.status === 'cancelled') return { success: false, error: 'Subagent cancelled.' };
    if (result.error) return { success: false, error: result.error.message || String(result.error) };
    const steps = result.stepsCount + 1;
    let report = String(result.finalText || '').trim();
    if (!report) return { success: false, steps, error: 'The subagent finished without a report.' };
    if (report.length > MAX_REPORT_LENGTH) {
      report = `${report.slice(0, MAX_REPORT_LENGTH)}\n\n[Report truncated at ${MAX_REPORT_LENGTH} characters.]`;
    }
    return { success: true, report, steps, toolCalls: result.toolExecutions.length, loopDetected: result.loopDetected === true };
  }

  function clip(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function createLiveCard(args, ui) {
    const card = getCards().createCardWrapper(ui);
    if (!card) return null;
    const t = ui.t;
    const escapeHtml = ui.markdown.escapeHtml;
    const task = clip(typeof args?.task === 'string' ? args.task.trim() : '', TASK_PREVIEW_LENGTH);
    card.innerHTML = getCards().renderCardHtml({
      className: 'subagent-card',
      titleHtml: `<span>${BOT_ICON_SVG}</span><span>${escapeHtml(t('tool_delegate_title'))}</span>`,
      titleSuffixHtml: '<span class="tool-card-tag subagent-model" hidden></span>',
      badgeHtml: `<span class="tool-card-badge status-loading">${ui.SPINNER_SVG} <span>${escapeHtml(t('tool_delegate_step', { step: 1 }))}</span></span>`,
      bodyHtml: `<div class="tool-card-result subagent-body">
        <div class="tool-result-label">${escapeHtml(t('tool_delegate_task_label'))}</div>
        <div class="subagent-task">${escapeHtml(task)}</div>
        <div class="subagent-steps"></div>
        <div class="subagent-report" hidden></div>
      </div>`
    }, ui);
    return card;
  }

  function updateLiveCard(card, _args, result = {}, elapsedMs = 0, ui) {
    if (!card) return;
    const t = ui.t;
    const escapeHtml = ui.markdown.escapeHtml;
    const success = result?.success !== false && !result?.error;
    const badge = card.querySelector('.tool-card-badge');
    if (badge) {
      const label = !success
        ? t('tool_status_error', { ms: elapsedMs || 0 })
        : (result?.steps
          ? t('tool_delegate_done', { steps: result.steps, seconds: ((elapsedMs || 0) / 1000).toFixed(1) })
          : t('tool_status_success'));
      badge.className = `tool-card-badge ${success ? 'status-success' : 'status-error'}`;
      badge.innerHTML = `${success ? (ui.CHECK_SVG) : (ui.ERROR_SVG)} <span>${escapeHtml(label)}</span>`;
    }
    const report = card.querySelector('.subagent-report');
    if (!report) return;
    const body = success
      ? renderMarkdown(String(result?.report || ''), ui.markdown)
      : `<div class="subagent-error">${escapeHtml(String(result?.error || ''))}</div>`;
    report.innerHTML = `<div class="tool-result-label">${escapeHtml(t('tool_delegate_report_label'))}</div>${body}`;
    report.hidden = false;
  }

  /** El historial solo conserva el informe que recibió el modelo, no los pasos intermedios. */
  function renderHistoricalCard(args, message, ui) {
    const card = createLiveCard(args, ui);
    if (!card) return null;
    const content = typeof message?.content === 'string' ? message.content : '';
    let result = { success: true, report: content };
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.success === false) result = parsed;
    } catch (e) { /* el informe es texto, no JSON */ }
    updateLiveCard(card, args, result, 0, ui);
    return card;
  }

  function createTool(Tool) {
    if (typeof Tool !== 'function') throw new Error('La clase Tool es necesaria para crear delegate_task.');
    return new Tool({
      id: definition.name,
      definition,
      category: 'agent',
      metadata: { label: definition.name },
      settings: { titleKey: 'agent_delegate_task_title', descKey: 'agent_delegate_task_desc', defaultEnabled: true, showInSettings: true },
      promptGuide: () => '- `delegate_task(task="...")`: Delegates a self-contained research task to a read-only subagent with a fresh context and returns only its final report. Use it for broad investigations that need many reads; it cannot see this conversation.',
      execute: runSubagent,
      result: {
        toModel: (_args, result) => (result?.success === false
          ? JSON.stringify({ success: false, error: result.error })
          : String(result?.report || '')),
        toMarkdown: (args, result) => {
          const task = clip(String(args?.task || '').trim().split('\n')[0], 200);
          return result?.success === false
            ? `> **delegate_task** (error: ${result.error})\n\n`
            : `> **delegate_task**: ${task}\n\n`;
        }
      },
      displayMode: 'collapsed',
      view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
    });
  }

  const toolModule = {
    id: definition.name,
    definition,
    displayMode: 'collapsed',
    createTool,
    isReadOnlyTool,
    view: { id: definition.name, displayMode: 'collapsed', createLiveCard, updateLiveCard, renderHistoricalCard }
  };

  const manifestApi = resolveDep('ChatToolManifest', './tools/tool-manifest.js');
  if (manifestApi?.builtin && !manifestApi.builtin.has(toolModule.id)) manifestApi.builtin.register(toolModule);
  return toolModule;
});
