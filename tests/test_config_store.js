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

test('ChatConfig - conserva una estrategia de transporte de razonamiento válida', () => {
  const { store } = createFixture();
  store.initialize();
  assert.equal(store.updateRuntime({ reasoningTransport: 'send-none' }).reasoningTransport, 'send-none');
  assert.equal(store.updateRuntime({ reasoningTransport: 'untrusted' }).reasoningTransport, 'auto');
});

test('ChatConfig - snapshots no permiten mutar el estado interno', () => {
  const { store } = createFixture();
  store.initialize();
  store.activateProfile('office');
  const snapshot = store.getActive();
  snapshot.enabledTools.search_web = true;
  assert.equal(store.getActive().enabledTools.search_web, false);
});

test('ChatConfig - el límite detectado es volátil y se descarta al activar perfil', () => {
  const { store, getPersisted } = createFixture();
  store.initialize();
  store.updateRuntime({ modelContextLimit: 90112, contextLimitOverride: 1000000 });

  assert.equal(store.getActive().modelContextLimit, 90112);
  assert.equal(getPersisted().modelContextLimit, null);

  const config = store.activateProfile('office');

  assert.equal(config.modelContextLimit, null);
  assert.equal(config.contextLimitOverride, null);
});

test('ChatConfig - cambiar de conexión descarta el límite detectado anterior', () => {
  const { store } = createFixture();
  store.initialize();
  store.updateRuntime({ modelContextLimit: 90112 });

  const config = store.updateRuntime({ apiUrl: 'https://api.example.test/v1' });

  assert.equal(config.modelContextLimit, null);
});

test('ChatConfig - el perfil de respaldo sustituye una selección ausente', () => {
  const { store } = createFixture();
  store.initialize();
  const config = store.activateFallbackProfile();

  assert.equal(config.activeProfile.name, 'Servidor Oficina');
  assert.equal(config.apiUrl, 'http://office.test/v1');
  assert.equal(config.model, 'qwen-office');
});

test('ChatConfig - migración y borrado vuelven a Espejo sin conservar credenciales del perfil anterior', () => {
  const Profiles = require('../js/profile-repository.js');
  const values = new Map();
  let persisted = { activeProfile: { id: 'deleted', name: 'Old' }, model: 'old', apiKey: 'test-only', theme: 'dark', language: 'en' };
  const storage = {
    getStorageItem: key => values.get(key), setStorageItem: (key, value) => values.set(key, value),
    loadRuntimeConfigV2: () => persisted, saveRuntimeConfigV2: value => { persisted = value; }
  };
  const profiles = Profiles.createRepository(storage);
  const state = State.createStore();
  let updates = 0;
  state.subscribe('config', () => updates++);
  const store = ChatConfig.createConfigStore({ state, storage, profiles: { ...profiles, READONLY_PROFILE_ID: Profiles.READONLY_PROFILE_ID } });
  const config = store.initialize();
  assert.equal(updates, 1);
  assert.equal(config.apiType, 'mirror');
  assert.equal(config.apiKey, '');
  assert.equal(config.theme, 'dark');
  profiles.save({ id: 'test', name: 'Test', settings: { apiKey: 'test-only', model: 'test' } });
  store.activateProfile('test');
  profiles.remove('test');
  const fallback = store.activateFallbackProfile();
  assert.equal(fallback.activeProfile.id, Profiles.READONLY_PROFILE_ID);
  assert.equal(fallback.apiKey, '');
  assert.equal(fallback.language, 'en');
});
