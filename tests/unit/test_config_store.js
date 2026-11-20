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

test('ChatConfig - arranca con Espejo, conserva preferencias generales al activar perfil y soporta sessionOnly', () => {
  const initial = ChatConfig.initialize();
  assert.equal(initial.activeProfile.id, Profiles.READONLY_PROFILE_ID);
  assert.equal(initial.apiType, 'mirror');
  assert.ok(initial.systemDataPrompt.includes('Format:'));
  assert.equal(Storage.loadRuntimeConfigV2().activeProfileName, undefined);

  Profiles.save(OFFICE);
  const storedBeforeSession = Storage.loadRuntimeConfigV2();
  try {
    const sessionCfg = ChatConfig.activateProfile('office', { sessionOnly: true });
    assert.equal(sessionCfg.model, 'qwen-office');
    ChatConfig.updateRuntime({ theme: 'dark' });
    assert.equal(ChatConfig.getActive().theme, 'dark');
    assert.deepEqual(Storage.loadRuntimeConfigV2(), storedBeforeSession);
  } finally {
    State.set('config', ChatConfig.normalize({}));
  }

  localStorage.clear();
  initializeWithOffice();
  ChatConfig.updateRuntime({ theme: 'dark', activeRagBranchIds: ['rag-a', 'rag-b'], enabledTools: { search_web: false } });
  const config = ChatConfig.activateProfile('office');
  assert.equal(config.apiUrl, 'http://office.test/v1');
  assert.equal(config.model, 'qwen-office');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.enableRawLogs, true);
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.activeRagBranchIds, ['rag-a', 'rag-b']);
  assert.deepEqual(config.enabledTools, { search_web: false });
  assert.equal(config.activeProfile.version, Profiles.get('office').version);
  assert.ok(config.systemDataPrompt.includes('Format:'));
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

  // Si el perfil activo guardado no existe en el repositorio local, vuelve al perfil de respaldo.
  Storage.saveRuntimeConfigV2({
    activeProfile: { id: 'profile:inexistente', name: 'Perfil Borrado' },
    apiType: 'openai', model: 'gpt-4o', language: 'en'
  });
  const fallbackRestored = ChatConfig.initialize();
  assert.equal(fallbackRestored.activeProfile.id, Profiles.READONLY_PROFILE_ID);
  assert.equal(fallbackRestored.model, 'mirror');
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

test('ChatConfig - el respaldo offline de entornos por proyecto normaliza, separa general y acota a 50 proyectos', () => {
  assert.equal(ChatConfig.getProjectEnvironment(''), null);
  ChatConfig.saveProjectEnvironmentBackup('', {
    systemDataPrompt: '  General prompt  ',
    enabledTools: { search_web: false, bad: 'nope' },
    mcpServers: [' memory ', 'memory', 'brave'],
    browser: 'invalid_browser',
    updatedAt: 100
  });
  assert.deepEqual(ChatConfig.getProjectEnvironment(''), {
    systemDataPrompt: 'General prompt',
    enabledTools: { search_web: false },
    mcpServers: ['memory', 'brave'],
    browser: 'browser_action',
    updatedAt: 100
  });

  for (let i = 1; i <= 50; i++) {
    ChatConfig.saveProjectEnvironmentBackup(`/repo/${i}`, { browser: 'playwright', updatedAt: 1000 + i });
  }
  assert.equal(Object.keys(Storage.loadProjectEnvironments()).length, 50);
  // Al pasar de 50 se expulsa el más antiguo (general con updatedAt 100).
  assert.equal(ChatConfig.getProjectEnvironment(''), null);
  assert.equal(ChatConfig.getProjectEnvironment('/repo/50').browser, 'playwright');
});

test('ChatConfig - applyProjectEnvironment aplica valores del proyecto, preserva cadena vacía y restablece proyectos sin guardar', () => {
  ChatConfig.initialize();
  const appliedA = ChatConfig.applyProjectEnvironment('/repo/alpha', {
    saved: true,
    systemDataPrompt: '',
    enabledTools: { search_web: false },
    mcpServers: ['memory'],
    browser: 'playwright',
    updatedAt: 500
  });
  assert.equal(appliedA.systemDataPrompt, '');
  assert.deepEqual(appliedA.enabledTools, { search_web: false });
  assert.deepEqual(appliedA.mcpServers, ['memory']);
  assert.equal(appliedA.browser, 'playwright');
  assert.equal(ChatConfig.getProjectEnvironment('/repo/alpha').browser, 'playwright');

  // Proyecto nuevo sin entorno guardado en SQLite no hereda ajustes del proyecto anterior.
  const appliedB = ChatConfig.applyProjectEnvironment('/repo/beta', { saved: false });
  assert.equal(appliedB.systemDataPrompt, ChatConfig.DEFAULT_SYSTEM_DATA_PROMPT);
  assert.deepEqual(appliedB.enabledTools, {});
  assert.deepEqual(appliedB.mcpServers, []);
  assert.equal(appliedB.browser, 'browser_action');

  // Sin servidor (offline) recupera el respaldo local guardado previamente.
  const offlineA = ChatConfig.applyProjectEnvironment('/repo/alpha');
  assert.equal(offlineA.browser, 'playwright');
  assert.deepEqual(offlineA.mcpServers, ['memory']);
});
