/**
 * Coordinador de la interfaz del modo proyecto: seguimiento de carpeta por conversación,
 * acciones del panel de proyecto (inicializar, actualizar normas, compactar, cambiar o borrar carpeta)
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

  const { resolveDep, projectName } = Utils;
  const { t } = I18n;

  const getState = () => resolveDep('ChatState', './state.js');
  const getConfig = () => resolveDep('ChatConfig', './config-store.js');
  const getDialogs = () => resolveDep('ChatDialogs', './ui-dialogs.js');
  const getMCP = () => resolveDep('ChatMCP', './mcp.js');
  const getProjectContext = () => resolveDep('ChatProjectContext', './project-context.js');
  const getUIReasoning = () => resolveDep('ChatUIReasoning', './ui-reasoning.js');
  const getFolderPicker = () => resolveDep('ChatUIFolderPicker', './ui-folder-picker.js');
  const getFilesPage = () => resolveDep('ChatFilesPage', './files-page.js');

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
   * Abrir una conversación de otro proyecto lleva el servidor a su carpeta, y una sin proyecto a la carpeta general.
   * Si ya no existe, se avisa y la conversación se queda sin herramientas locales (localToolsAvailable),
   * nunca en otra carpeta.
   */
  function followConversationProject(conversation) {
    if (!conversation) return Promise.resolve();
    return openProjectDirectory(getMCP().directoryOfProject(conversation.project));
  }

  /** Muestra en la cabecera el enlace a los ficheros del proyecto activo cuando hay conexión. */
  function syncProjectFilesLink(elements) {
    const link = elements.btnOpenProjectFiles;
    const mcp = getState().get('mcp');
    const cwd = mcp.status === 'connected' ? mcp.serverInfo?.cwd || '' : '';
    link.hidden = !cwd;
    if (!cwd) {
      link.removeAttribute('href');
      return;
    }
    const label = t('btn_project_files_title', { name: projectName(cwd) });
    link.href = `files.html${getFilesPage().pageUrl(cwd, '')}`;
    link.title = label;
    link.setAttribute('aria-label', label);
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
      canDeleteProject: ProjectContext.canDeleteProject(),
      busy: State.isConversationBusy()
    });
  }

  function createPanelHandlers({ elements, createNewSession, removeProjectSessions, getChatHistory, submitComposerText }) {
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

    const runInitialize = async template => {
      try {
        const confirmKey = template === 'agent' ? 'project_initialize_agent_confirm' : 'project_initialize_confirm';
        await ProjectContext.initialize({
          template,
          askConfirmation: ({ cwd, rule }) => Dialogs.confirm(t(confirmKey, { cwd, dir: rule.slice(3) })),
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
    };

    return {
      toggle(enabled) {
        Config.updateRuntime({ projectMode: Boolean(enabled) });
      },
      async changeDirectory() {
        try {
          const result = await ProjectContext.changeDirectory({
            askPath: cwd => {
              // El panel se cierra con cualquier clic fuera de él, también dentro del selector.
              UIReasoning.closeReasoningMenu(elements);
              const MCP = getMCP();
              return getFolderPicker().open({
                current: cwd,
                recent: State.get('sessions').list.map(session => session.project),
                generalDir: MCP.directoryOfProject('')
              });
            },
            isBusy
          });
          if (result?.reason === 'error') {
            await Dialogs.alert(t('project_directory_error', { error: result.error }), { type: 'error' });
          }
          // En la carpeta nueva se empieza siempre un chat nuevo, también desde uno vacío.
          if (result?.ok) await createNewSession();
        } catch (error) {
          console.error('[App] Project directory change failed:', error);
          await Dialogs.alert(error?.message || String(error), { type: 'error' });
        }
      },
      initialize() {
        const mode = elements.projectModePanel?.querySelector('#project-init-template')?.value === 'agent' ? 'agent' : 'default';
        return runInitialize(mode);
      },
      async deleteProject() {
        try {
          const result = await ProjectContext.deleteProject({
            askDeleteOptions: ({ cwd, name }) => Dialogs.confirm(t('project_delete_confirm', { cwd, name }), {
              type: 'warning',
              checkbox: t('project_delete_dir_checkbox'),
              checkboxDefault: false
            }),
            askConfirmPath: ({ cwd }) => Dialogs.prompt(t('project_delete_dir_prompt', { cwd }), '', { type: 'warning' }),
            afterDelete: async deleted => {
              if (typeof removeProjectSessions === 'function') {
                await removeProjectSessions(deleted?.deleted, deleted?.deletedConversationIds || []);
              }
            },
            isBusy
          });
          if (result?.reason === 'path-mismatch') {
            await Dialogs.alert(t('project_delete_dir_mismatch'), { type: 'warning' });
          } else if (result?.reason === 'error') {
            await Dialogs.alert(t('project_delete_error', { error: result.error }), { type: 'error' });
          }
        } catch (error) {
          console.error('[App] Project deletion failed:', error);
          await Dialogs.alert(error?.message || String(error), { type: 'error' });
        }
      },
      async updateRules() {
        try {
          await ProjectContext.updateRules({
            askConfirmation: ({ name }) => Dialogs.confirm(t('project_update_rules_confirm', { name })),
            isBusy,
            startConversation: async () => {
              if (getChatHistory().some(message => message.role !== 'system')) await createNewSession();
            },
            sendPrompt: startPromptTurn
          });
        } catch (error) {
          console.error('[App] Project rules update failed:', error);
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
      () => {
        syncProjectFilesLink(elements);
        refreshProjectContext();
      }
    );
    syncProjectFilesLink(elements);
    State.subscribe('project', render);
    // Al terminar un turno el agente puede haber creado o actualizado los ficheros del proyecto.
    State.subscribe(state => ({ generating: state.streaming.isGenerating }), ({ generating }) => {
      if (!generating && Config.getActive().projectMode === true) refreshProjectContext();
      // «Cambiar…» solo está activo sin generación en curso.
      render();
    });
    Config.subscribe((nextConfig, previousConfig) => {
      if (nextConfig.projectMode !== previousConfig.projectMode) {
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
    syncProjectFilesLink,
    refreshProjectContext,
    renderProjectPanel,
    createPanelHandlers,
    subscribe
  };
});
