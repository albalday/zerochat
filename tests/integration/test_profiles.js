const test = require('node:test');
const assert = require('node:assert/strict');
const Profiles = require('../../js/profile-repository.js');
const Backup = require('../../js/profile-backup.js');
const ProfileExportBundle = require('../../js/profile-export-bundle.js');
const I18n = require('../../js/i18n.js');
const { installDom } = require('../helpers/dom-env.js');

function createStorage(legacyProfiles = {}) {
  const values = new Map();
  return {
    getStorageItem: key => values.has(key) ? values.get(key) : null,
    setStorageItem: (key, value) => values.set(key, String(value)),
    getProfiles: () => JSON.parse(JSON.stringify(legacyProfiles))
  };
}

const sampleProfiles = [{
  id: 'profile:remote',
  name: 'Remote',
  description: 'Remote provider',
  settings: { apiType: 'openai', apiUrl: 'https://example.test/v1', model: 'model-a' }
}];

function passwordRequiredError() {
  return Object.assign(new Error('password required'), { code: 'PASSWORD_REQUIRED' });
}

function generateBundle(t, payload = '{"encrypted":true}', metadata = { profileCount: 2 }) {
  const dom = installDom({ url: 'http://127.0.0.1:6388/app/zerochat.html' });
  t.after(() => dom.restore());
  return ProfileExportBundle.generateExportHTML(payload, metadata);
}

// --- Repositorio y persistencia de perfiles ---

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
  assert.throws(() => repository.save({ id: 'unsafe', name: 'Unsafe', settings: { apiKey: 'sk-plain' } }), /encrypted API key/);
  assert.throws(() => repository.mergeImported([{ id: 'unsafe', name: 'Unsafe', settings: { apiKey: 'sk-plain' } }]), /encrypted API key/);
  await repository.saveEditable({ id: 'safe', name: 'Safe', settings: { apiKey: 'sk-secret' } });
  assert.equal((await repository.load('safe')).settings.apiKey, 'sk-secret');
  assert.equal(typeof repository.get('safe').settings.apiKey, 'object');
  assert.doesNotMatch(storage.getStorageItem(Profiles.STORAGE_KEY), /sk-secret/);
});

test('ProfileRepository - un perfil bloqueado no se modifica pero puede borrarse', async () => {
  const repository = Profiles.createRepository(createStorage());
  const locked = await repository.saveEditable({ id: 'locked', name: 'Locked', settings: { apiKey: 'sk-locked', apiKeyLocked: true } });
  assert.throws(() => repository.save({ ...locked, settings: { ...locked.settings, model: 'changed' } }), /locked/);
  assert.equal(repository.remove('locked'), true);
  assert.equal(await repository.load('locked'), null);
});

test('ProfileRepository - no reinicializa silenciosamente documentos con API keys antiguas', () => {
  const storage = createStorage();
  storage.setStorageItem(Profiles.STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'old', name: 'Old', settings: { apiKey: 'sk-plain' } }] }));
  assert.throws(() => Profiles.createRepository(storage).list(), /encrypted API key/);
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

// --- Cifrado y copia de seguridad de perfiles ---

test('ProfileBackup - cifra y recupera las definiciones sin exponerlas en el archivo', async () => {
  const encrypted = await Backup.encryptProfiles(sampleProfiles);
  assert.doesNotMatch(encrypted, /sk-secret/);
  const envelope = JSON.parse(encrypted);
  assert.equal(envelope.format, Backup.FORMAT);
  assert.equal(envelope.algorithm, 'AES-GCM');
  assert.deepEqual(await Backup.decryptProfiles(encrypted), sampleProfiles);
});

test('ProfileBackup - rechaza una copia manipulada', async () => {
  const envelope = JSON.parse(await Backup.encryptProfiles(sampleProfiles));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
  await assert.rejects(Backup.decryptProfiles(JSON.stringify(envelope)), error => error.code === 'PASSWORD_REQUIRED');
});

test('ProfileBackup - valida la estructura antes de cifrar', async () => {
  await assert.rejects(Backup.encryptProfiles([{ id: 'bad', name: '', settings: {} }]), /invalid profile/);
});

test('ProfileBackup - cifra cada API key y detecta manipulación', async () => {
  const secret = await Backup.encryptApiKey('sk-secret');
  assert.doesNotMatch(JSON.stringify(secret), /sk-secret/);
  assert.equal(await Backup.decryptApiKey(secret), 'sk-secret');
  assert.throws(() => Backup.validateApiKeySecret('sk-secret'), /encrypted API key/);
  await assert.rejects(Backup.decryptApiKey({ ...secret, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' }));
  const exported = await Backup.encryptProfiles([{ ...sampleProfiles[0], settings: { ...sampleProfiles[0].settings, apiKey: secret } }]);
  assert.deepEqual((await Backup.decryptProfiles(exported))[0].settings.apiKey, secret);
});

test('ProfileBackup - usa temporalmente el hash de contraseña y conserva el formato existente', async () => {
  const originalStorage = global.localStorage;
  const values = new Map();
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  try {
    const keyMaterial = await Backup.keyMaterialFromPassword('correct horse battery staple');
    const secret = await Backup.encryptApiKey('sk-custom', keyMaterial);
    const encryptedProfiles = await Backup.encryptProfiles(sampleProfiles, keyMaterial);
    await assert.rejects(Backup.decryptApiKey(secret, null), error => error.code === 'PASSWORD_REQUIRED');
    await assert.rejects(Backup.decryptProfiles(encryptedProfiles, null), error => error.code === 'PASSWORD_REQUIRED');
    Backup.cacheKeyMaterial(keyMaterial);
    assert.equal(await Backup.decryptApiKey(secret), 'sk-custom');
    assert.deepEqual(await Backup.decryptProfiles(encryptedProfiles), sampleProfiles);
    Backup.clearCachedKeyMaterial();
    assert.equal(Backup.getCachedKeyMaterial(), null);
  } finally {
    if (originalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalStorage;
  }
});

test('ProfileBackup.withPassword - no pide contraseña si la operación funciona con la clave por defecto', async () => {
  let prompts = 0;
  const result = await Backup.withPassword(keyMaterial => ({ keyMaterial }), () => { prompts++; return 'x'; });
  assert.deepEqual(result, { keyMaterial: undefined });
  assert.equal(prompts, 0);
});

test('ProfileBackup.withPassword - reintenta con la clave derivada de la contraseña', async () => {
  const expected = await Backup.keyMaterialFromPassword('secret');
  const calls = [];
  const result = await Backup.withPassword(async keyMaterial => {
    calls.push(keyMaterial);
    if (!keyMaterial) throw passwordRequiredError();
    return 'ok';
  }, async () => 'secret');
  assert.equal(result, 'ok');
  assert.deepEqual(calls, [undefined, expected]);
});

test('ProfileBackup.withPassword - la cancelación relanza PASSWORD_REQUIRED marcado como cancelado', async () => {
  await assert.rejects(
    Backup.withPassword(async () => { throw passwordRequiredError(); }, async () => null),
    error => error.code === 'PASSWORD_REQUIRED' && error.cancelled === true
  );
});

test('ProfileBackup.withPassword - propaga otros errores sin pedir contraseña', async () => {
  let prompts = 0;
  await assert.rejects(
    Backup.withPassword(async () => { throw new Error('disk failure'); }, () => { prompts++; return 'x'; }),
    /disk failure/
  );
  assert.equal(prompts, 0);
});

// --- Paquete exportable independiente (bundle HTML) ---

test('ProfileExportBundle - aísla cada intento con un identificador de transferencia efímero', t => {
  const html = generateBundle(t);
  assert.match(html, /function createTransferId\(\)/);
  assert.match(html, /const targetName = 'zerochat_import_' \+ activeTransferId/);
  assert.match(html, /#mode=import&transferId=/);
  assert.match(html, /event\.source !== targetWindow/);
  assert.match(html, /event\.data\.transferId !== activeTransferId/);
  assert.match(html, /const TARGET_URL = "http:\/\/127\.0\.0\.1:6388\/app\/zerochat\.html"/);
});

test('ProfileExportBundle - los textos salen en el idioma activo y los estados se muestran como texto', t => {
  I18n.setLanguage('en');
  t.after(() => I18n.setLanguage('es'));
  const html = generateBundle(t, '</script><script>alert(1)</script>');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /2 encrypted connection profile\(s\)/);
  assert.match(html, /"importFailed":"The profiles could not be imported: \{error\}"/);
  assert.doesNotMatch(html, /innerHTML/, 'Los mensajes de la otra pestaña no se insertan como HTML');
  assert.equal(html.includes('</script><script>alert(1)'), false, 'Los datos embebidos no pueden cerrar el script');
});

