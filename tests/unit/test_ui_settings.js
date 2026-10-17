const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISettings = require('../../js/ui-settings.js');
const Config = require('../../js/config-store.js');
const ToolSecurity = require('../../js/tool-security.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Diálogos de ajustes y de perfil con el marcado real; `confirm` sustituye la confirmación. */
function setup(t, { confirm = async () => true } = {}) {
  const dom = installDom({ app: true });
  UISettings.ensureDialogMarkup();
  const elements = getAppElements(document);
  require('../../js/debug.js').setElements(elements);
  const previousDialogs = globalThis.ChatDialogs;
  globalThis.ChatDialogs = { confirm };
  const calls = { loadCachedModels: 0, saved: [], profileSelector: [] };
  UISettings.mount({
    elements,
    getRuntimeConfig: () => Config.getActive(),
    callbacks: {
      loadCachedModels: () => { calls.loadCachedModels++; },
      onConfigSaved: config => calls.saved.push(config),
      populateProfileSelector: id => calls.profileSelector.push(id)
    }
  });
  t.after(() => {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  });
  return { elements, calls };
}

const submit = elements => elements.settingsForm.dispatchEvent(new Event('submit', { cancelable: true }));
const isActive = id => document.getElementById(id).classList.contains('active');

test('UISettings - abrir una sección la activa, pone su título y abre el diálogo', t => {
  const { elements } = setup(t);
  UISettings.openSettingsSection(elements, Config.getActive(), 'mcp');
  assert.equal(isActive('settings-model'), false);
  assert.equal(isActive('settings-mcp'), true);
  assert.equal(elements.settingsSectionTitle.getAttribute('data-i18n'), 'settings_mcp');
  assert.ok(elements.settingsDialog.open);
  assert.ok(elements.agentToolsContainer.querySelector('.agent-tool-checkbox[data-tool-id="search_web"]'), 'Se listan las herramientas configurables');
  assert.equal(elements.agentToolsContainer.querySelector('[data-tool-id="list_documents"]'), null, 'Las de conocimiento local no tienen interruptor');

  UISettings.openSettingsSection(elements, Config.getActive(), 'unknown');
  assert.equal(isActive('settings-model'), true, 'Una sección desconocida abre la del modelo');
});

test('UISettings - la sección MCP se aplica al momento: sin Guardar ni cambios pendientes', async t => {
  const { elements } = setup(t, { confirm: async () => assert.fail('No debe pedir confirmación') });
  UISettings.openSettingsSection(elements, Config.getActive(), 'mcp');
  assert.equal(elements.btnSaveSettings.hidden, true);
  const serverSwitch = document.createElement('input');
  serverSwitch.type = 'checkbox';
  elements.mcpServersList.append(serverSwitch);
  serverSwitch.dispatchEvent(new Event('change', { bubbles: true }));
  const clearAuthsBtn = document.createElement('button');
  clearAuthsBtn.id = 'btn-mcp-clear-auths';
  elements.mcpServersList.append(clearAuthsBtn);
  clearAuthsBtn.dispatchEvent(new Event('click', { bubbles: true }));
  assert.equal(elements.settingsDialog.dataset.settingsDirty, 'false');
  assert.equal(await UISettings.closeSettingsModal(elements), true);

  UISettings.openSettingsSection(elements, Config.getActive(), 'model');
  assert.equal(elements.btnSaveSettings.hidden, false);
  elements.settingSystemDataPrompt.dispatchEvent(new Event('input', { bubbles: true }));
  UISettings.openSettingsSection(elements, Config.getActive(), 'mcp');
  assert.equal(elements.btnSaveSettings.hidden, false, 'Con cambios de otra sección se puede guardar desde MCP');
});

test('UISettings - el tema y el idioma marcan su botón activo', t => {
  const { elements } = setup(t);
  assert.equal(UISettings.applyTheme(elements, 'dark'), 'dark');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.deepEqual([...elements.themeButtons].filter(button => button.classList.contains('active')).map(button => button.dataset.theme), ['dark']);
  assert.equal(UISettings.applyTheme(elements, 'other'), 'light');
  assert.equal(document.documentElement.hasAttribute('data-theme'), false);

  assert.equal(UISettings.applyLanguage(elements, 'en'), 'en');
  assert.deepEqual([...elements.langButtons].filter(button => button.classList.contains('active')).map(button => button.dataset.lang), ['en']);
  assert.equal(elements.settingsSectionTitle.textContent, 'Model', 'ChatI18n traduce el marcado');
  UISettings.applyLanguage(elements, 'es');
});

test('UISettings - el editor exige API key a los proveedores remotos y enlaza sus guías gratuitas', t => {
  const { elements } = setup(t);
  for (const [apiType, hintKey, help] of [['openrouter', 'field_api_key_required_hint', 'help/openrouter-free.html'], ['gemini', 'field_api_key_required_hint', 'help/gemini-free.html'], ['ollama', 'field_api_key_hint', null]]) {
    elements.settingApiType.value = apiType;
    UISettings.syncProviderFields(elements);
    assert.equal(elements.apiKeyHintText.dataset.i18n, hintKey, apiType);
    assert.equal(elements.apiKeyFreeHelpLink.hidden, !help, apiType);
    if (help) assert.equal(elements.apiKeyFreeHelpLink.getAttribute('href'), help);
  }
});

test('UISettings - la temperatura se desactiva si el proveedor no la admite o el perfil está bloqueado', t => {
  const { elements } = setup(t);
  elements.settingApiType.value = 'gemini';
  UISettings.syncProviderFields(elements);
  assert.equal(elements.settingTemperature.disabled, true);
  assert.equal(elements.temperatureHint.dataset.i18n, 'field_temperature_unsupported_hint');

  elements.settingApiType.value = 'openai';
  UISettings.syncProviderFields(elements);
  assert.equal(elements.settingTemperature.disabled, false);
  assert.equal(elements.temperatureHint.dataset.i18n, 'field_temperature_hint');

  elements.profilesDialog.dataset.profileLocked = 'true';
  UISettings.syncProviderFields(elements);
  assert.equal(elements.settingTemperature.disabled, true);
});

test('UISettings - cargar un perfil rellena el editor, usa el endpoint por defecto y muestra WebLLM', t => {
  const { elements } = setup(t);
  UISettings.applyProfileToForm(elements, { apiType: 'claude', apiUrl: 'https://api.anthropic.com/v1', model: 'claude-3-7-sonnet', systemPrompt: 'Eres un asistente experto.', temperature: '0.2', apiKeyLocked: true });
  assert.equal(elements.settingApiType.value, 'claude');
  assert.equal(elements.settingApiUrl.value, 'https://api.anthropic.com/v1');
  assert.equal(elements.settingModel.value, 'claude-3-7-sonnet');
  assert.equal(elements.settingSystemPrompt.value, 'Eres un asistente experto.');
  assert.equal(elements.temperatureVal.textContent, '0.2');
  assert.equal(elements.settingApiKey.value, '', 'La clave solo se carga desde el repositorio cifrado');
  assert.equal(elements.profilesDialog.dataset.profileLocked, 'true');
  assert.equal(elements.settingModel.disabled, true, 'Un perfil bloqueado no se edita');
  assert.equal(elements.apiKeyLockedStatus.hidden, false);

  UISettings.applyProfileToForm(elements, { apiType: 'openai', apiUrl: '', model: '' });
  assert.equal(elements.settingApiUrl.value, 'http://localhost:1234/v1');
  assert.equal(elements.settingApiUrl.placeholder, 'http://localhost:1234/v1');
  assert.equal(elements.webllmParamsPanel.hidden, true);

  UISettings.applyProfileToForm(elements, { apiType: 'webllm', webllmConfig: { context_window_size: '16384', prefill_chunk_size: 'default' } });
  assert.equal(elements.settingWebllmContextWindow.value, '16384');
  assert.equal(elements.settingWebllmPrefillChunk.value, 'default');
  assert.equal(elements.webllmParamsPanel.hidden, false);
  assert.equal(elements.webllmHelpLink.hidden, false);
  assert.deepEqual(UISettings.gatherCurrentFormConfig(elements, Config.getActive()).webllmConfig, { context_window_size: '16384', prefill_chunk_size: 'default' });
});

test('UISettings - guardar aplica reglas, política MCP y herramientas y vuelve a la lista de secciones', async t => {
  const { elements, calls } = setup(t);
  const previousRules = ToolSecurity.manager.getDirectoryRules();
  t.after(() => ToolSecurity.manager.setDirectoryRules(previousRules));
  UISettings.openSettingsSection(elements, Config.getActive(), 'agent');

  const search = elements.agentToolsContainer.querySelector('[data-tool-id="search_web"]');
  search.checked = false;
  search.dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(Config.getActive().enabledTools.search_web, false, 'El interruptor se aplica al momento');
  elements.mcpDirectoryRules.value = 'R:/home/user\nW:/tmp\n\n';
  elements.mcpPolicyWorkspaceTrust.checked = true;
  elements.settingSystemDataPrompt.value = 'Datos propios';

  submit(elements);
  await settle();
  assert.deepEqual(ToolSecurity.manager.getDirectoryRules(), ['R:/home/user', 'W:/tmp']);
  assert.equal(elements.mcpDirectoryRules.value, 'R:/home/user\nW:/tmp', 'El campo muestra las reglas guardadas');
  assert.equal(ToolSecurity.manager.getGlobalMcpPolicy(), 'workspace_trust');
  assert.equal(Config.getActive().systemDataPrompt, 'Datos propios');
  assert.equal(calls.loadCachedModels, 1);
  assert.equal(calls.saved.length, 1);
  assert.equal(elements.settingsDialog.open, false);

  UISettings.openSettingsSection(elements, Config.getActive(), 'permissions');
  elements.mcpDirectoryRules.value = 'X:/invalid';
  submit(elements);
  await settle();
  assert.notEqual(elements.mcpDirectoryRulesError.textContent, '', 'Una regla inválida muestra el error');
  assert.ok(elements.settingsDialog.open, 'y no cierra los ajustes');
  ToolSecurity.manager.setGlobalMcpPolicy('ask');
});
