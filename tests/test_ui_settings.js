const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISettings = require('../js/ui-settings.js');

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
