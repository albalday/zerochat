const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../../js/state.js');
const Storage = require('../../js/storage.js');
const Profiles = require('../../js/profile-repository.js');
const ChatConfig = require('../../js/config-store.js');

// ChatConfig trabaja con ChatState, ChatStorage y el repositorio de perfiles reales sobre el
// localStorage en memoria de storage-env.js; cada caso parte de un almacenamiento vacío.
test.beforeEach(() => localStorage.clear());

const OFFICE = {
  id: 'office', name: 'Servidor Oficina',
  settings: {
    apiUrl: 'http://office.test/v1', apiType: 'openai',
    model: 'qwen-office', systemPrompt: 'Oficina', temperature: '0.2',
    reasoningEffort: 'high',
    enableRawLogs: true
  }
};

function initializeWithOffice() {
  ChatConfig.initialize();
  Profiles.save(OFFICE);
}

test('ChatConfig - arranca con Espejo, conserva las instrucciones de datos y no persiste el perfil por nombre', () => {
  const config = ChatConfig.initialize();
  assert.equal(config.activeProfile.id, Profiles.READONLY_PROFILE_ID);
  assert.equal(config.apiType, 'mirror');
  assert.ok(config.systemDataPrompt.includes('Format:'), 'Debe conservar las instrucciones de datos de ZeroChat');
  assert.equal(Storage.loadRuntimeConfigV2().activeProfileName, undefined);
});

test('ChatConfig - activar perfil reemplaza campos de perfil y conserva preferencias generales', () => {
  initializeWithOffice();
  ChatConfig.updateRuntime({ theme: 'dark', activeRagBranchIds: ['rag-a', 'rag-b'], enabledTools: { search_web: false } });
  const config = ChatConfig.activateProfile('office');

  assert.equal(config.apiUrl, 'http://office.test/v1');
  assert.equal(config.model, 'qwen-office');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.enableRawLogs, true);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.activeRagBranchIds, ['rag-a', 'rag-b']);
  assert.deepEqual(config.enabledTools, { search_web: false }, 'Las herramientas nativas son una preferencia general');
  assert.equal(config.activeProfile.version, Profiles.get('office').version);
  assert.ok(config.systemDataPrompt.includes('Format:'), 'Cambiar de perfil no debe perder las instrucciones de datos');
});

test('ChatConfig - un perfil activado solo para la sesión no cambia la configuración guardada', () => {
  initializeWithOffice();
  const stored = Storage.loadRuntimeConfigV2();
  try {
    const config = ChatConfig.activateProfile('office', { sessionOnly: true });
    assert.equal(config.model, 'qwen-office');
    ChatConfig.updateRuntime({ theme: 'dark' });
    assert.equal(ChatConfig.getActive().theme, 'dark');
    assert.deepEqual(Storage.loadRuntimeConfigV2(), stored);
    assert.equal(stored.activeProfile.id, Profiles.READONLY_PROFILE_ID);
  } finally {
    // La marca vive en la configuración en memoria: los demás casos parten de una página nueva.
    State.set('config', ChatConfig.normalize({}));
  }
});

test('ChatConfig - el límite detectado es volátil y se descarta al activar perfil o cambiar de conexión', () => {
  initializeWithOffice();
  ChatConfig.updateRuntime({ modelContextLimit: 90112, contextLimitOverride: 1000000 });
  assert.equal(ChatConfig.getActive().modelContextLimit, 90112);
  assert.equal(Storage.loadRuntimeConfigV2().modelContextLimit, null);

  const activated = ChatConfig.activateProfile('office');
  assert.equal(activated.modelContextLimit, null);
  assert.equal(activated.contextLimitOverride, null);

  ChatConfig.updateRuntime({ modelContextLimit: 90112 });
  assert.equal(ChatConfig.updateRuntime({ apiUrl: 'https://api.example.test/v1' }).modelContextLimit, null);
});

test('ChatConfig - migración y borrado vuelven a Espejo sin conservar credenciales del perfil anterior', () => {
  Storage.saveRuntimeConfigV2({ activeProfile: { id: 'deleted', name: 'Old' }, model: 'old', apiKey: 'test-only', theme: 'dark', language: 'en' });
  let updates = 0;
  const unsubscribe = State.subscribe('config', () => updates++);
  try {
    const config = ChatConfig.initialize();
    assert.equal(updates, 1);
    assert.equal(config.apiType, 'mirror');
    assert.equal(config.apiKey, undefined);
    assert.equal(config.theme, 'dark');
  } finally {
    unsubscribe();
  }
  Profiles.save({ id: 'test', name: 'Test', settings: { model: 'test' } });
  ChatConfig.activateProfile('test');
  Profiles.remove('test');
  const fallback = ChatConfig.activateFallbackProfile();
  assert.equal(fallback.activeProfile.id, Profiles.READONLY_PROFILE_ID);
  assert.equal(fallback.apiKey, undefined);
  assert.equal(fallback.language, 'en');
});

test('ChatConfig - el modo proyecto es global: se normaliza y no cambia al activar un perfil', () => {
  assert.equal(ChatConfig.normalize({}).projectMode, true, 'Activo por defecto: .zerochat/state.md ya es una decisión explícita');
  assert.deepEqual(ChatConfig.normalize({}).projectDeclined, []);
  const declined = Array.from({ length: 60 }, (_, index) => `/repo/${index}`);
  const normalized = ChatConfig.normalize({
    projectMode: false,
    projectDeclined: [' /a ', '/a', '', 42, 'x'.repeat(5000), ...declined]
  });
  assert.equal(normalized.projectMode, false, 'Desactivarlo se respeta');
  assert.equal(normalized.projectDeclined.length, 50);
  assert.equal(normalized.projectDeclined[49], '/repo/59');
  assert.ok(!normalized.projectDeclined.includes(''));

  initializeWithOffice();
  ChatConfig.updateRuntime({ projectMode: false, projectDeclined: ['/home/u/repo'] });
  const config = ChatConfig.activateProfile('office');
  assert.equal(config.projectMode, false);
  assert.deepEqual(config.projectDeclined, ['/home/u/repo']);
});

test('ChatDefaults - el contexto WebLLM predeterminado es 4K en móviles y 16K en el resto', () => {
  const Defaults = require('../../js/defaults.js');
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgentData: { mobile: true }, userAgent: 'X11; Linux' }), 4096);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgentData: { mobile: false }, userAgent: 'Android Mobile' }), 16384);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0' }), 4096);
  assert.equal(Defaults.getWebllmDefaultContextWindowSize({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' }), 16384);
  assert.ok(Defaults.WEBLLM_CONTEXT_WINDOW_SIZES.includes(Defaults.WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE));
});
