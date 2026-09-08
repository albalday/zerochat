const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../js/state.js');
const ChatConfig = require('../js/config-store.js');

function createFixture() {
  let persisted = null;
  const profile = {
    id: 'office', name: 'Servidor Oficina', version: 3,
    settings: {
      apiUrl: 'http://office.test/v1', apiType: 'openai', apiKey: 'secret',
      model: 'qwen-office', systemPrompt: 'Oficina', temperature: '0.2',
      reasoningEffort: 'high', enabledTools: { search_web: false },
      enableRawLogs: true
    }
  };
  const storage = {
    loadRuntimeConfigV2: () => persisted,
    saveRuntimeConfigV2: value => { persisted = JSON.parse(JSON.stringify(value)); },
  };
  const profiles = {
    PROFILE_FIELDS: require('../js/profile-repository.js').PROFILE_FIELDS,
    initialize: () => {},
    findByName: name => name === profile.name ? profile : null,
    list: () => [profile],
    get: id => id === profile.id ? profile : null
  };
  return { store: ChatConfig.createConfigStore({ state: State.createStore(), storage, profiles }), getPersisted: () => persisted };
}

test('ChatConfig - migra la configuración efectiva y registra el perfil aplicado', () => {
  const { store, getPersisted } = createFixture();
  const config = store.initialize();

  assert.equal(config.schemaVersion, 2);
  assert.equal(config.theme, 'light');
  assert.equal(config.language, 'es');
  assert.equal(config.activeProfile.name, 'Servidor Oficina');
  assert.ok(config.systemDataPrompt.includes('Format:'), 'Debe conservar las instrucciones de datos de ZeroChat');
  assert.deepEqual(config.activeRagBranchIds, []);
  assert.equal(getPersisted().activeProfileName, undefined);
});

test('ChatConfig - activar perfil reemplaza campos de perfil y conserva preferencias generales', () => {
  const { store } = createFixture();
  store.initialize();
  store.updateGeneral({ theme: 'dark', activeRagBranchIds: ['rag-a', 'rag-b'] });
  const config = store.activateProfile('office');

  assert.equal(config.apiUrl, 'http://office.test/v1');
  assert.equal(config.model, 'qwen-office');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.enableRawLogs, true);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.activeRagBranchIds, ['rag-a', 'rag-b']);
  assert.equal(config.activeProfile.version, 3);
  assert.ok(config.systemDataPrompt.includes('Format:'), 'Cambiar de perfil no debe perder las instrucciones de datos');
});

test('ChatConfig - snapshots no permiten mutar el estado interno', () => {
  const { store } = createFixture();
  store.initialize();
  store.activateProfile('office');
  const snapshot = store.getActive();
  snapshot.enabledTools.search_web = true;
  assert.equal(store.getActive().enabledTools.search_web, false);
});
