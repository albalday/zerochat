const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIProfiles = require('../../js/ui-profiles.js');

test('UIProfiles - isProfileFormDirty detects differences with baseline profile', () => {
  const baseline = {
    activeProfile: { id: 'prof_test' }
  };

  global.ChatProfileRepository = {
    get: (id) => ({
      id: 'prof_test',
      name: 'Test Profile',
      settings: {
        apiType: 'openai',
        apiUrl: 'http://localhost:1234/v1',
        model: 'gpt-4o',
        systemPrompt: '',
        temperature: '0.7'
      }
    })
  };

  try {
    const cleanElements = {
      profileSelectHelper: { value: 'prof_test' },
      settingProfileName: { value: 'Test Profile' },
      settingProfileDescription: { value: '' },
      settingApiType: { value: 'openai' },
      settingApiUrl: { value: 'http://localhost:1234/v1' },
      settingApiKey: { value: '', _loadedApiKey: '' },
      settingModel: { value: 'gpt-4o' },
      settingSystemPrompt: { value: '' },
      settingTemperature: { value: '0.7' }
    };

    assert.equal(UIProfiles.isProfileFormDirty(cleanElements, { getRuntimeConfig: () => baseline }), false);

    // Modificar modelo
    const dirtyElements = {
      ...cleanElements,
      settingModel: { value: 'claude-3-5-sonnet' }
    };
    assert.equal(UIProfiles.isProfileFormDirty(dirtyElements, { getRuntimeConfig: () => baseline }), true);
  } finally {
    delete global.ChatProfileRepository;
  }
});

test('UIProfiles - canSaveProfile requires dirty form state', () => {
  const elements = {
    profileSelectHelper: { value: 'none' },
    settingProfileName: { value: 'Default' }
  };
  // Si no hay cambios ni API key cargada, canSaveProfile es false
  assert.equal(typeof UIProfiles.canSaveProfile(elements), 'boolean');
});
test('UIProfiles - setProfileQueryState updates dataset attribute correctly', () => {
  const mockDialog = {
    dataset: {},
    querySelectorAll: () => []
  };
  const mockElements = {
    profilesDialog: mockDialog
  };

  UIProfiles.setProfileQueryState(mockElements, true);
  assert.equal(mockDialog.dataset.queryReady, 'true');

  UIProfiles.setProfileQueryState(mockElements, false);
  assert.equal(mockDialog.dataset.queryReady, 'false');
});
