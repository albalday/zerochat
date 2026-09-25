const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISettings = require('../../js/ui-settings.js');

test('UISettings - sitúa los permisos de ejecución MCP en su propia sección sin navegación por pestañas', () => {
  const settingsHtml = UISettings.getSettingsDialogHTML();
  assert.equal(settingsHtml.includes('modal-tabs-nav'), false, 'No debe existir la barra de pestañas modal-tabs-nav');
  assert.equal(settingsHtml.includes('id="tab-general"'), false, 'No debe existir el panel tab-general');
  assert.equal(settingsHtml.includes('id="tab-appearance"'), false, 'No debe existir el panel tab-appearance');
  assert.equal(settingsHtml.includes('id="btn-clear-all-data"'), false, 'No debe existir el botón de borrar todo dentro de settings-dialog');
  assert.equal(settingsHtml.includes('id="btn-reset-settings"'), false, 'No debe existir el botón de restaurar dentro de settings-dialog');
  assert.equal(settingsHtml.includes('id="btn-cancel-settings"'), false, 'No debe existir el botón de cancelar dentro de settings-dialog');
  assert.equal(settingsHtml.includes('class="modal-footer"'), false, 'No debe existir la botonera inferior modal-footer en settings-dialog');
  assert.match(settingsHtml, /id="settings-permissions" class="settings-section-pane"/);
  assert.match(settingsHtml, /id="mcp-policy-ask"/);
  assert.match(settingsHtml, /id="mcp-directory-rules"/);
  assert.equal(settingsHtml.includes('id="btn-mcp-save-directory-rules"'), false, 'Las reglas de directorios se guardan con el formulario general');
  assert.match(settingsHtml, /id="mcp-saved-auths-list"/);
  assert.equal(settingsHtml.includes('id="btn-settings-back"'), false, 'No debe existir el botón de volver dentro de settings-dialog');
  assert.match(settingsHtml, /id="settings-section-title"/);
  assert.match(settingsHtml, /id="btn-save-settings"[^>]*class="btn-primary btn-save-header"/);
  assert.match(settingsHtml, /id="btn-close-settings"/);
});

test('UISettings - exige API key para proveedores remotos y enlaza las guías gratuitas correspondientes', () => {
  const hint = { dataset: {}, textContent: '' };
  const helpLink = { hidden: true, href: '' };
  const apiKeyField = {
    hidden: false,
    querySelector: (selector) => selector === '#api-key-hint-text'
      ? hint
      : (selector === '#api-key-free-help-link' ? helpLink : null)
  };
  const elements = {
    settingApiType: { value: 'openrouter' },
    settingApiKey: { disabled: false, closest: () => apiKeyField }
  };

  UISettings.syncProviderFields(elements);
  assert.equal(hint.dataset.i18n, 'field_api_key_required_hint');
  assert.equal(helpLink.hidden, false);
  assert.equal(helpLink.href, 'help/openrouter-free.html');

  elements.settingApiType.value = 'gemini';
  UISettings.syncProviderFields(elements);
  assert.equal(helpLink.href, 'help/gemini-free.html');

  elements.settingApiType.value = 'ollama';
  UISettings.syncProviderFields(elements);
  assert.equal(hint.dataset.i18n, 'field_api_key_hint');
  assert.equal(helpLink.hidden, true);
});

test('UISettings - openSettingsSection activa la sección indicada y actualiza el título', () => {
  const panes = [
    { id: 'settings-model', classList: { add: () => { panes[0].active = true; }, remove: () => { panes[0].active = false; } }, active: false },
    { id: 'settings-mcp', classList: { add: () => { panes[1].active = true; }, remove: () => { panes[1].active = false; } }, active: false }
  ];
  const titleEl = { textContent: '', setAttribute: (k, v) => { titleEl[k] = v; } };
  const fakeDoc = {
    getElementById: (id) => panes.find(p => p.id === id) || (id === 'settings-section-title' ? titleEl : null)
  };
  const fakeDialog = {
    ownerDocument: fakeDoc,
    showModal: () => { fakeDialog.isOpen = true; },
    querySelectorAll: (sel) => sel === '.settings-section-pane' ? panes : []
  };
  const elements = {
    settingsDialog: fakeDialog,
    settingsSectionTitle: titleEl
  };

  UISettings.openSettingsSection(elements, {}, {}, 'mcp');
  assert.equal(panes[0].active, false);
  assert.equal(panes[1].active, true);
  assert.equal(titleEl['data-i18n'], 'settings_mcp');
  assert.equal(fakeDialog.isOpen, true);
});

test('UISettings - confirma antes de cerrar ajustes con cambios sin guardar', async () => {
  const originalDialogs = global.ChatDialogs;
  const dialog = { dataset: {}, close: () => { dialog.closed = true; } };
  const elements = { settingsDialog: dialog };

  try {
    UISettings.setSettingsFormDirty(elements, true);
    global.ChatDialogs = { confirm: async () => false };
    assert.equal(await UISettings.closeSettingsModal(elements), false);
    assert.equal(dialog.closed, undefined);

    global.ChatDialogs = { confirm: async () => true };
    assert.equal(await UISettings.closeSettingsModal(elements), true);
    assert.equal(dialog.closed, true);
    assert.equal(UISettings.isSettingsFormDirty(elements), false);
  } finally {
    if (originalDialogs === undefined) delete global.ChatDialogs;
    else global.ChatDialogs = originalDialogs;
  }
});

test('UISettings - applyTheme actualiza data-theme y botones activos', () => {
  const btnLight = {
    className: '',
    getAttribute: (name) => name === 'data-theme' ? 'light' : null,
    classList: {
      add: (cls) => { btnLight.className = cls; },
      remove: () => { btnLight.className = ''; }
    }
  };
  const btnDark = {
    className: '',
    getAttribute: (name) => name === 'data-theme' ? 'dark' : null,
    classList: {
      add: (cls) => { btnDark.className = cls; },
      remove: () => { btnDark.className = ''; }
    }
  };

  const elements = { themeButtons: [btnLight, btnDark] };
  const appConfig = { theme: 'light' };

  const themeDark = UISettings.applyTheme(elements, appConfig, 'dark');
  assert.equal(themeDark, 'dark');
  assert.equal(appConfig.theme, 'light');
  assert.equal(btnDark.className, 'active');
  assert.equal(btnLight.className, '');

  const themeLight = UISettings.applyTheme(elements, appConfig, 'light');
  assert.equal(themeLight, 'light');
  assert.equal(appConfig.theme, 'light');
  assert.equal(btnLight.className, 'active');
});

test('UISettings - gatherEnabledToolsFromUI extrae mapa booleano de checkboxes', () => {
  const checkboxes = [
    { getAttribute: () => 'search_web', checked: true },
    { getAttribute: () => 'execute_javascript', checked: false }
  ];

  const fakeContainer = {
    querySelectorAll: (sel) => sel === '.agent-tool-checkbox' ? checkboxes : []
  };

  const map = UISettings.gatherEnabledToolsFromUI(fakeContainer);
  assert.deepEqual(map, {
    search_web: true,
    execute_javascript: false
  });
});

test('UISettings - applyProfileToForm rellena los inputs de configuración', () => {
  const elements = {
    settingApiType: { value: '' },
    settingApiUrl: { value: '' },
    settingApiKey: { value: '' },
    settingModel: { value: '' },
    modelSelectHelper: { value: '' },
    settingSystemPrompt: { value: '' },
    settingSystemDataPrompt: { value: '' },
    settingTemperature: { value: '' },
    temperatureVal: { textContent: '' },
    settingMaxAgentTurns: { value: '' },
    maxAgentTurnsVal: { textContent: '' },
    settingEnableRawLogs: { checked: false }
  };

  const profileData = {
    apiType: 'anthropic',
    apiUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-7-sonnet',
    systemPrompt: 'Eres un asistente experto.',
    systemDataPrompt: 'Formato ZeroChat.',
    temperature: '0.2',
    maxAgentTurns: 22,
    enableRawLogs: true
  };

  UISettings.applyProfileToForm(elements, profileData);

  assert.equal(elements.settingApiType.value, 'anthropic');
  assert.equal(elements.settingApiUrl.value, 'https://api.anthropic.com/v1');
  assert.equal(elements.settingApiKey.value, '', 'La clave solo se carga desde el repositorio cifrado');
  assert.equal(elements.settingModel.value, 'claude-3-7-sonnet');
  assert.equal(elements.settingSystemPrompt.value, 'Eres un asistente experto.');
  assert.equal(elements.settingSystemDataPrompt.value, 'Formato ZeroChat.');
  assert.equal(elements.settingTemperature.value, '0.2');
  assert.equal(elements.temperatureVal.textContent, '0.2');
  assert.equal(elements.settingMaxAgentTurns.value, 22);
  assert.equal(elements.maxAgentTurnsVal.textContent, 22);
  assert.equal(elements.settingEnableRawLogs.checked, true);
});

test('UISettings - applyProfileToForm asigna endpoint por defecto y placeholder si apiUrl está vacío', () => {
  const elements = {
    settingApiType: { value: '' },
    settingApiUrl: { value: '', placeholder: '' },
    settingApiKey: { value: '' },
    settingModel: { value: '' },
    modelSelectHelper: { value: '' },
    settingSystemPrompt: { value: '' },
    settingTemperature: { value: '' },
    settingMaxAgentTurns: { value: '' }
  };

  const profileData = {
    apiType: 'openai',
    apiUrl: '',
    model: ''
  };

  UISettings.applyProfileToForm(elements, profileData);

  assert.equal(elements.settingApiUrl.value, 'http://localhost:1234/v1');
  assert.equal(elements.settingApiUrl.placeholder, 'http://localhost:1234/v1');
});

test('UISettings - gatherCurrentFormConfig extrae maxAgentTurns correctamente', () => {
  const elements = {
    settingModel: { value: 'gpt-4o' },
    settingMaxAgentTurns: { value: '25' }
  };
  const appConfig = { maxAgentTurns: 15 };
  const config = UISettings.gatherCurrentFormConfig(elements, appConfig);
  assert.equal(config.maxAgentTurns, 25);
});

test('UISettings - no coordina el borrado de perfiles, que corresponde a app.js', () => {
  assert.equal(UISettings.handleDeleteProfile, undefined);
});

test('UISettings - gatherCurrentFormConfig extrae webllmConfig y asigna default si está vacío', () => {
  const elements = {
    settingModel: { value: 'Llama-3.2-1B' },
    settingWebllmContextWindow: { value: '8192' },
    settingWebllmPrefillChunk: { value: '2048' }
  };
  const config = UISettings.gatherCurrentFormConfig(elements, {});
  assert.deepEqual(config.webllmConfig, {
    context_window_size: '8192',
    prefill_chunk_size: '2048'
  });
});

test('UISettings - applyProfileToForm mapea webllmConfig a selects asignando default si es necesario', () => {
  const elements = {
    settingApiType: { value: 'webllm' },
    settingWebllmContextWindow: { value: '' },
    settingWebllmPrefillChunk: { value: '' },
    webllmParamsPanel: { hidden: false },
    btnWebllmParams: { classList: { remove: () => {} } }
  };
  const profileData = {
    webllmConfig: {
      context_window_size: '16384',
      prefill_chunk_size: 'default'
    }
  };
  UISettings.applyProfileToForm(elements, profileData);
  assert.equal(elements.settingWebllmContextWindow.value, '16384');
  assert.equal(elements.settingWebllmPrefillChunk.value, 'default');
  assert.equal(elements.webllmParamsPanel.hidden, true);
});
