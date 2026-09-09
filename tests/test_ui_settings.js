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
    apiKey: 'sk-ant-test',
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
  assert.equal(elements.settingApiKey.value, 'sk-ant-test');
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

test('UISettings - handleSaveProfile delega el guardado al editor sin mutar la configuración activa', () => {
  let profileSaved = null;

  const elements = {
    settingProfileName: { value: 'Perfil Ollama Rápido' },
    settingApiUrl: { value: 'http://localhost:11434' },
    settingApiType: { value: 'ollama' },
    settingApiKey: { value: '' },
    settingModel: { value: 'llama3.2:latest' },
    settingSystemPrompt: { value: 'Instrucciones locales' },
    settingTemperature: { value: '0.5' },
    settingEnableRawLogs: { checked: false },
    profileActionFeedback: { style: { display: 'none' }, className: '', textContent: '' }
  };

  const appConfig = {
    activeProfileName: 'Local chat',
    apiUrl: 'http://localhost:1234/v1',
    theme: 'dark',
    language: 'es'
  };

  const saved = UISettings.handleSaveProfile(elements, appConfig, (name, data) => { profileSaved = { name, data }; });

  assert.ok(saved, 'Debe retornar la configuración guardada');
  assert.equal(saved.activeProfileName, 'Perfil Ollama Rápido');
  assert.equal(saved.apiUrl, 'http://localhost:11434');
  assert.equal(saved.model, 'llama3.2:latest');

  assert.ok(profileSaved, 'Debe delegar el guardado en el repositorio de perfiles');
  assert.equal(profileSaved.name, 'Perfil Ollama Rápido');
  assert.equal(profileSaved.data.apiUrl, 'http://localhost:11434');

  assert.equal(elements.profileActionFeedback.style.display, 'block');
});

test('UISettings - no coordina el borrado de perfiles, que corresponde a app.js', () => {
  assert.equal(UISettings.handleDeleteProfile, undefined);
});
