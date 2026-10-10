const test = require('node:test');
const assert = require('node:assert/strict');
const Profiles = require('../../js/profile-repository.js');
const Backup = require('../../js/profile-backup.js');

function createStorage(legacyProfiles = {}) {
  const values = new Map();
  return {
    getStorageItem: key => values.has(key) ? values.get(key) : null,
    setStorageItem: (key, value) => values.set(key, String(value)),
    getProfiles: () => JSON.parse(JSON.stringify(legacyProfiles))
  };
}

test('ProfileRepository - inicializa únicamente el perfil Espejo de solo lectura', () => {
  const storage = createStorage();
  const repository = Profiles.createRepository(storage);

  const profiles = repository.list();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, Profiles.READONLY_PROFILE_ID);
  assert.equal(profiles[0].name, 'Espejo');
  assert.equal(profiles[0].settings.apiType, 'mirror');
  assert.equal(repository.remove(Profiles.READONLY_PROFILE_ID), false);
  assert.throws(() => repository.save({ ...profiles[0], settings: { ...profiles[0].settings, model: 'other' } }));
});

test('ProfileRepository - guarda versiones sin exponer referencias mutables', () => {
  const repository = Profiles.createRepository(createStorage());
  const first = repository.save({ id: 'lab', name: 'Laboratorio', settings: { model: 'model-a' } });
  const second = repository.save({ id: 'lab', name: 'Laboratorio', settings: { model: 'model-b' } });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  const loaded = repository.get('lab');
  loaded.settings.model = 'mutado';
  assert.equal(repository.get('lab').settings.model, 'model-b');
});

test('ProfileRepository - conserva la descripción del perfil', () => {
  const repository = Profiles.createRepository(createStorage());
  repository.save({ id: 'lab', name: 'Laboratorio', description: 'Servidor de pruebas', settings: {} });

  assert.equal(repository.get('lab').description, 'Servidor de pruebas');
});

test('ProfileRepository - conserva y normaliza webllmConfig en settings', () => {
  const repository = Profiles.createRepository(createStorage());
  const webllmConfig = {
    context_window_size: '16384',
    prefill_chunk_size: '2048'
  };
  repository.save({ id: 'webllm-profile', name: 'WebLLM High-End', settings: { apiType: 'webllm', webllmConfig } });

  const retrieved = repository.get('webllm-profile');
  assert.deepEqual(retrieved.settings.webllmConfig, webllmConfig);
});

test('ProfileRepository - fusiona una importación en una única escritura y conserva Espejo', async () => {
  const repository = Profiles.createRepository(createStorage());
  repository.save({ id: 'local', name: 'Local', settings: { model: 'before' } });
  const encryptedApiKey = await Backup.encryptApiKey('sk-imported');
  const result = repository.mergeImported([
    { id: 'local', name: 'Local', settings: { model: 'after', apiKey: encryptedApiKey } },
    { id: 'remote', name: 'Remote', settings: { model: 'remote-model' } }
  ]);

  assert.deepEqual(result, { added: 1, replaced: 1, total: 2 });
  assert.equal(repository.get('local').settings.model, 'after');
  assert.equal((await repository.load('local')).settings.apiKey, 'sk-imported');
  assert.equal(repository.get('remote').settings.model, 'remote-model');
  assert.equal(repository.get(Profiles.READONLY_PROFILE_ID).name, 'Espejo');
});

test('ProfileRepository - no guarda ni importa API keys en texto plano', async () => {
  const storage = createStorage();
  const repository = Profiles.createRepository(storage);
  assert.throws(() => repository.save({ id: 'unsafe', name: 'Unsafe', settings: { apiKey: 'sk-plain' } }), /API key cifrada/);
  assert.throws(() => repository.mergeImported([{ id: 'unsafe', name: 'Unsafe', settings: { apiKey: 'sk-plain' } }]), /API key cifrada/);
  await repository.saveEditable({ id: 'safe', name: 'Safe', settings: { apiKey: 'sk-secret' } });
  assert.equal((await repository.load('safe')).settings.apiKey, 'sk-secret');
  assert.equal(typeof repository.get('safe').settings.apiKey, 'object');
  assert.doesNotMatch(storage.getStorageItem(Profiles.STORAGE_KEY), /sk-secret/);
});

test('ProfileRepository - un perfil bloqueado no se modifica pero puede borrarse', async () => {
  const repository = Profiles.createRepository(createStorage());
  const locked = await repository.saveEditable({ id: 'locked', name: 'Locked', settings: { apiKey: 'sk-locked', apiKeyLocked: true } });
  assert.throws(() => repository.save({ ...locked, settings: { ...locked.settings, model: 'changed' } }), /bloqueados/);
  assert.equal(repository.remove('locked'), true);
  assert.equal(await repository.load('locked'), null);
});

test('ProfileRepository - no reinicializa silenciosamente documentos con API keys antiguas', () => {
  const storage = createStorage();
  storage.setStorageItem(Profiles.STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'old', name: 'Old', settings: { apiKey: 'sk-plain' } }] }));
  assert.throws(() => Profiles.createRepository(storage).list(), /API key cifrada/);
  assert.match(storage.getStorageItem(Profiles.STORAGE_KEY), /sk-plain/);
});

test('ProfileRepository - rechaza una importación que intenta modificar Espejo', () => {
  const repository = Profiles.createRepository(createStorage());
  assert.throws(() => repository.mergeImported([
    { id: Profiles.READONLY_PROFILE_ID, name: 'Espejo', settings: { model: 'changed' } }
  ]), /Espejo/);
  assert.equal(repository.get(Profiles.READONLY_PROFILE_ID).settings.model, 'mirror');
});

test('ProfileRepository - carga sin error perfiles heredados con apiKey vacía o nula', async () => {
  const storage = createStorage();
  storage.setStorageItem(Profiles.STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    profiles: [
      { id: 'profile:mirror', name: 'Espejo', settings: { apiUrl: 'mirror://local', apiType: 'mirror', apiKey: '', model: 'mirror' } },
      { id: 'profile:legacy-null', name: 'Legacy Null', settings: { apiUrl: 'http://localhost:1234', apiKey: null } }
    ]
  }));
  const repository = Profiles.createRepository(storage);
  const list = repository.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'profile:mirror');
  assert.equal(list[1].id, 'profile:legacy-null');
  assert.equal((await repository.load('profile:mirror')).settings.apiKey, '');
  assert.equal((await repository.load('profile:legacy-null')).settings.apiKey, '');
});

test('ProfileRepository - informa cuántas API keys ha recifrado', async () => {
  const repository = Profiles.createRepository(createStorage());
  assert.equal(await repository.recipherApiKeys(null, null), 0);

  await repository.saveEditable({ id: 'safe', name: 'Safe', settings: { apiKey: 'sk-secret' } });
  assert.equal(await repository.recipherApiKeys(null, null), 1);
  assert.equal((await repository.load('safe')).settings.apiKey, 'sk-secret');
});
