/**
 * Coordinador de la interfaz del modo proyecto: seguimiento de carpeta por conversación,
 * acciones del panel de proyecto (inicializar, compactar, recargar, declinar, cambiar carpeta)
 * y renderizado bajo demanda sobre UIReasoning.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'), require('./i18n.js'));
  } else {
    root.ChatUIProject = factory(root.ChatUtils, root.ChatI18n);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils, I18n) {
  'use strict';

  const { resolveDep } = Utils;
  const { t } = I18n;

  const getState = () => resolveDep('ChatState', './state.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getProjectContext = () => resolveDep('ChatProjectContext', './project-context.js');
  const getUIReasoning = () => resolveDep('ChatUIReasoning', './ui-reasoning.js');

  const getServerCwd = () => getState().get('mcp').serverInfo?.cwd || '';

  /** Lleva el servidor a la carpeta `project` (si hay servidor y es otra) y avisa si ya no existe. */
  async function openProjectDirectory(project) {
    const cwd = getServerCwd();
    if (!project || !cwd || project === cwd) return;
    try {
      await getMCP().manager.setProjectDirectory(project);
    } catch (error) {
      const reason = String(error?.message || error).replace(/^Error MCP \(-?\d+\): /, '');
      await getDialogs().alert(t('conversation_project_unavailable', { project, error: reason }), { type: 'warning' });
    }
  }

  /**
   * Abrir una conversación de otro proyecto lleva el servidor a su carpeta. Si ya no existe, se avisa y
   * la conversación se queda sin herramientas locales (localToolsAvailable), nunca en otra carpeta.
   */
  function followConversationProject(conversation) {
    return openProjectDirectory(conversation?.project);
  }

  /**
   * Chat nuevo en otro proyecto desde su cabecera del historial: primero el chat vacío (si una generación
   * lo impide, el servidor no cambia de carpeta) y después la carpeta, que el chat toma al guardarse.
   * El perfil activo no cambia.
   */
  async function createProjectSession(project, createNewSession) {
    if (await createNewSession()) await openProjectDirectory(project);
  }

  function refreshProjectContext() {
    getProjectContext().refresh().catch(error => console.warn('[App] Could not refresh project context:', error));
  }

  /** El indicador del botón siempre; el panel solo con el modal abierto (renderizado bajo demanda). */
  function renderProjectPanel(elements) {
    const State = getState();
    const ProjectContext = getProjectContext();
    const UIReasoning = getUIReasoning();
    const config = getConfig().getActive();
    const project = State.get('project');
    UIReasoning.syncProjectIndicator(elements, config, project);
    UIReasoning.syncWelcomeProject(elements, config, project);
    if (!elements.reasoningModal || elements.reasoningModal.hidden) return;
    UIReasoning.renderProjectPanel(elements, {
      config,
      project,
      canInitialize: ProjectContext.canInitialize(),
      canCompact: ProjectContext.canCompact(),
      canChangeDirectory: ProjectContext.canChangeDirectory(),
      busy: State.isConversationBusy()
    });
  }

  function createPanelHandlers({ elements, createNewSession, getChatHistory, submitComposerText }) {
    const State = getState();
    const Config = getConfig();
    const Dialogs = getDialogs();
    const ProjectContext = getProjectContext();
    const UIReasoning = getUIReasoning();
    const isBusy = () => State.isConversationBusy();

    const startPromptTurn = async prompt => {
      UIReasoning.closeReasoningMenu(elements);
      await submitComposerText(prompt);
    };

    return {
      toggle(enabled) {
        Config.updateRuntime({ projectMode: Boolean(enabled) });
      },
      async decline() {
        const cwd = State.get('project').cwd;
        if (!cwd) return;
        const confirmed = await Dialogs.confirm(t('project_decline_confirm', { cwd }));
        // El servidor puede haber cambiado de directorio mientras se esperaba la respuesta.
        if (!confirmed || State.get('project').cwd !== cwd) return;
        Config.updateRuntime({ projectDeclined: [...Config.getActive().projectDeclined, cwd] });
      },
      reactivate() {
        const cwd = State.get('project').cwd;
        Config.updateRuntime({ projectDeclined: Config.getActive().projectDeclined.filter(path => path !== cwd) });
      },
      async reload() {
        try {
          await ProjectContext.refresh();
        } catch (error) {
          console.warn('[App] Could not refresh project context:', error);
        }
        renderProjectPanel(elements);
        const reloadBtn = elements.projectModePanel?.querySelector('[data-project-action="reload"]');
        if (reloadBtn) reloadBtn.textContent = t('project_action_reloaded');
      },
      async changeDirectory() {
        try {
          const result = await ProjectContext.changeDirectory({
            askPath: cwd => Dialogs.prompt(t('project_directory_prompt'), cwd, { title: t('project_directory_title') }),
            isBusy
          });
          if (result?.reason === 'error') {
            await Dialogs.alert(t('project_directory_error', { error: result.error }), { type: 'error' });
          }
          // La conversación abierta es de su proyecto: en la carpeta nueva se empieza otra.
          const { activeId, list } = State.get('sessions');
          const project = list.find(session => session.id === activeId)?.project;
          if (result?.ok && project && project !== result.cwd) await createNewSession();
        } catch (error) {
          console.error('[App] Project directory change failed:', error);
          await Dialogs.alert(error?.message || String(error), { type: 'error' });
        }
      },
      async initialize() {
        try {
          await ProjectContext.initialize({
            askConfirmation: ({ cwd, rule }) => Dialogs.confirm(t('project_initialize_confirm', { cwd, dir: rule.slice(3) })),
            isBusy,
            startConversation: async () => {
              if (getChatHistory().some(message => message.role !== 'system')) await createNewSession();
            },
            sendPrompt: startPromptTurn
          });
        } catch (error) {
          console.error('[App] Project initialization failed:', error);
          await Dialogs.alert(error?.message || String(error), { type: 'error' });
        }
      },
      async compact() {
        try {
          await ProjectContext.compact({
            askConfirmation: ({ name }) => Dialogs.confirm(t('project_compact_confirm', { name })),
            isBusy,
            startConversation: async () => {
              if (getChatHistory().some(message => message.role !== 'system')) await createNewSession();
            },
            sendPrompt: startPromptTurn
          });
        } catch (error) {
          console.error('[App] Project compaction failed:', error);
          await Dialogs.alert(error?.message || String(error), { type: 'error' });
        }
      }
    };
  }

  function subscribe(elements) {
    const State = getState();
    const Config = getConfig();
    const Dialogs = getDialogs();
    const render = () => renderProjectPanel(elements);

    // Si la carpeta del proyecto desaparece, la pestaña vuelve al proyecto por defecto y se avisa una vez.
    getMCP().manager.onProjectLost = async ({ project, fallback }) => {
      await Dialogs.alert(t('project_folder_missing', { project, fallback }), { type: 'warning' });
    };
    // El proyecto depende del servidor local: se recalcula al conectar, cambiar de cwd o de herramientas.
    State.subscribe(
      state => ({ status: state.mcp.status, cwd: state.mcp.serverInfo?.cwd || '', tools: state.mcp.tools.length }),
      refreshProjectContext
    );
    State.subscribe('project', render);
    // Al terminar un turno el agente puede haber creado o actualizado los ficheros del proyecto.
    State.subscribe(state => ({ generating: state.streaming.isGenerating }), ({ generating }) => {
      if (!generating && Config.getActive().projectMode === true) refreshProjectContext();
      // «Cambiar…» solo está activo sin generación en curso.
      render();
    });
    Config.subscribe((nextConfig, previousConfig) => {
      if (nextConfig.projectMode !== previousConfig.projectMode ||
          JSON.stringify(nextConfig.projectDeclined) !== JSON.stringify(previousConfig.projectDeclined)) {
        refreshProjectContext();
      }
      render();
    });
    // Estado inicial coherente con la configuración aunque el servidor no llegue a conectar.
    refreshProjectContext();
  }

  return {
    openProjectDirectory,
    followConversationProject,
    createProjectSession,
    refreshProjectContext,
    renderProjectPanel,
    createPanelHandlers,
    subscribe
  };
});
