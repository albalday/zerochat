const test = require('node:test');
const assert = require('node:assert/strict');
const Profiles = require('../../js/profile-repository.js');
const Backup = require('../../js/profile-backup.js');
const ProfileExportBundle = require('../../js/profile-export-bundle.js');
const Storage = require('../../js/storage.js');

// Cada caso parte de un almacenamiento vacío: el repositorio real lee y escribe en él.
test.beforeEach(() => localStorage.clear());

const sampleProfiles = [{
  id: 'profile:remote',
  name: 'Remote',
  description: 'Remote provider',
  settings: { apiType: 'openai', apiUrl: 'https://example.test/v1', model: 'model-a' }
}];

function passwordRequiredError() {
  return Object.assign(new Error('password required'), { code: 'PASSWORD_REQUIRED' });
}

function generateBundle(payload = '{"encrypted":true}', appUrl = 'http://127.0.0.1:6388/app/zerochat.html') {
  return ProfileExportBundle.generateExportHTML(payload, { profileCount: 2, appLocation: new URL(appUrl) });
}

// --- Repositorio y persistencia de perfiles ---

test('ProfileRepository - inicializa Espejo, no mezcla perfiles del backend y los bloqueados solo pueden borrarse', async () => {
  const repository = Profiles;

  const profiles = repository.list();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, Profiles.READONLY_PROFILE_ID);
  assert.equal(profiles[0].name, 'Espejo');
  assert.equal(profiles[0].settings.apiType, 'mirror');
  assert.ok(!profiles.some(p => p.general === true));
  assert.equal(repository.remove(Profiles.READONLY_PROFILE_ID), false);
  assert.throws(() => repository.save({ ...profiles[0], settings: { ...profiles[0].settings, model: 'other' } }));

  const locked = await repository.saveEditable({ id: 'locked', name: 'Locked', settings: { apiKey: 'sk-locked', apiKeyLocked: true } });
  assert.throws(() => repository.save({ ...locked, settings: { ...locked.settings, model: 'changed' } }), /locked/);
  assert.equal(repository.remove('locked'), true);
  assert.equal(await repository.load('locked'), null);
});

test('ProfileRepository - fusiona una importación en una única escritura y protege Espejo', async () => {
  const repository = Profiles;
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

  assert.throws(() => repository.mergeImported([
    { id: Profiles.READONLY_PROFILE_ID, name: 'Espejo', settings: { model: 'changed' } }
  ]), /Espejo/);
  assert.equal(repository.get(Profiles.READONLY_PROFILE_ID).settings.model, 'mirror');
});

test('ProfileRepository - no guarda ni importa API keys en texto plano y no reinicializa documentos antiguos', async () => {
  const repository = Profiles;
  assert.throws(() => repository.save({ id: 'unsafe', name: 'Unsafe', settings: { apiKey: 'sk-plain' } }), /encrypted API key/);
  assert.throws(() => repository.mergeImported([{ id: 'unsafe', name: 'Unsafe', settings: { apiKey: 'sk-plain' } }]), /encrypted API key/);
  await repository.saveEditable({ id: 'safe', name: 'Safe', settings: { apiKey: 'sk-secret' } });
  assert.equal((await repository.load('safe')).settings.apiKey, 'sk-secret');
  assert.equal(typeof repository.get('safe').settings.apiKey, 'object');
  assert.doesNotMatch(Storage.getStorageItem(Profiles.STORAGE_KEY), /sk-secret/);

  Storage.setStorageItem(Profiles.STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'old', name: 'Old', settings: { apiKey: 'sk-plain' } }] }));
  assert.throws(() => Profiles.list(), /encrypted API key/);
  assert.match(Storage.getStorageItem(Profiles.STORAGE_KEY), /sk-plain/);
});

// --- Cifrado y copia de seguridad de perfiles ---

test('ProfileBackup - cifra perfiles y API keys, valida estructura, detecta manipulación y deriva contraseña', async () => {
  await assert.rejects(Backup.encryptProfiles([{ id: 'bad', name: '', settings: {} }]), /invalid profile/);

  const encrypted = await Backup.encryptProfiles(sampleProfiles);
  assert.doesNotMatch(encrypted, /sk-secret/);
  const envelope = JSON.parse(encrypted);
  assert.equal(envelope.format, Backup.FORMAT);
  assert.equal(envelope.algorithm, 'AES-GCM');
  assert.deepEqual(await Backup.decryptProfiles(encrypted), sampleProfiles);

  const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` };
  await assert.rejects(Backup.decryptProfiles(JSON.stringify(tampered)), error => error.code === 'PASSWORD_REQUIRED');

  const secret = await Backup.encryptApiKey('sk-secret');
  assert.doesNotMatch(JSON.stringify(secret), /sk-secret/);
  assert.equal(await Backup.decryptApiKey(secret), 'sk-secret');
  assert.throws(() => Backup.validateApiKeySecret('sk-secret'), /encrypted API key/);
  await assert.rejects(Backup.decryptApiKey({ ...secret, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' }));
  const exported = await Backup.encryptProfiles([{ ...sampleProfiles[0], settings: { ...sampleProfiles[0].settings, apiKey: secret } }]);
  assert.deepEqual((await Backup.decryptProfiles(exported))[0].settings.apiKey, secret);

  const originalStorage = global.localStorage;
  const values = new Map();
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
  try {
    const keyMaterial = await Backup.keyMaterialFromPassword('correct horse battery staple');
    const customSecret = await Backup.encryptApiKey('sk-custom', keyMaterial);
    const encryptedProfiles = await Backup.encryptProfiles(sampleProfiles, keyMaterial);
    await assert.rejects(Backup.decryptApiKey(customSecret, null), error => error.code === 'PASSWORD_REQUIRED');
    await assert.rejects(Backup.decryptProfiles(encryptedProfiles, null), error => error.code === 'PASSWORD_REQUIRED');
    Backup.cacheKeyMaterial(keyMaterial);
    assert.equal(await Backup.decryptApiKey(customSecret), 'sk-custom');
    assert.deepEqual(await Backup.decryptProfiles(encryptedProfiles), sampleProfiles);
    Backup.clearCachedKeyMaterial();
    assert.equal(Backup.getCachedKeyMaterial(), null);
  } finally {
    if (originalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalStorage;
  }
});

test('ProfileBackup.withPassword - usa la clave por defecto, reintenta con contraseña y distingue cancelación de fallo real', async () => {
  let prompts = 0;
  const direct = await Backup.withPassword(keyMaterial => ({ keyMaterial }), () => { prompts++; return 'x'; });
  assert.deepEqual(direct, { keyMaterial: undefined });
  assert.equal(prompts, 0);

  const expected = await Backup.keyMaterialFromPassword('secret');
  const calls = [];
  const retried = await Backup.withPassword(async keyMaterial => {
    calls.push(keyMaterial);
    if (!keyMaterial) throw passwordRequiredError();
    return 'ok';
  }, async () => 'secret');
  assert.equal(retried, 'ok');
  assert.deepEqual(calls, [undefined, expected]);

  await assert.rejects(
    Backup.withPassword(async () => { throw passwordRequiredError(); }, async () => null),
    error => error.code === 'PASSWORD_REQUIRED' && error.cancelled === true
  );
  await assert.rejects(
    Backup.withPassword(async () => { throw new Error('disk failure'); }, () => { prompts++; return 'x'; }),
    /disk failure/
  );
  assert.equal(prompts, 0);
});

// --- Paquete exportable independiente (bundle HTML) ---

test('ProfileExportBundle - aísla cada intento con identificador efímero y adapta file://', () => {
  const html = generateBundle();
  assert.match(html, /function createTransferId\(\)/);
  assert.match(html, /const targetName = 'zerochat_import_' \+ activeTransferId/);
  assert.match(html, /#mode=import&transferId=/);
  assert.match(html, /event\.source !== targetWindow/);
  assert.match(html, /event\.data\.transferId !== activeTransferId/);
  assert.match(html, /const TARGET_URL = "http:\/\/127\.0\.0\.1:6388\/app\/zerochat\.html"/);
  assert.match(generateBundle(undefined, 'file:///home/user/zerochat/zerochat.html'), /const TARGET_URL = "zerochat\.html"/);
});

// --- Perfiles de sesión e importación a local ---

test('ProfileRepository - los perfiles volátiles de sesión funcionan con clave directa o cargador diferido', async () => {
  const repository = Profiles;
  const initialCount = repository.list().length;
  const registered = repository.registerSessionProfile({
    id: 'profile:server-run-test',
    name: 'local',
    description: 'Perfil de ejecución en servidor',
    settings: { apiType: 'openai', model: 'gpt-4o', apiKey: 'sk-direct-server-secret' }
  });
  assert.equal(registered.general, true);
  assert.equal(repository.list().length, initialCount);
  assert.equal(repository.findByName('local').id, 'profile:server-run-test');
  assert.equal((await repository.loadUnlocked('profile:server-run-test')).settings.apiKey, 'sk-direct-server-secret');

  repository.clearSessionProfile();
  assert.equal(repository.get('profile:server-run-test'), null);
  assert.equal(repository.registerSessionProfile(null), null);
  assert.throws(() => repository.registerSessionProfile({ name: '' }), /The profile name cannot be empty/);

  const requested = [];
  repository.setSessionKeyLoader(async id => {
    requested.push(id);
    return { id, name: 'Otro', settings: { apiType: 'openai', model: 'm', apiKey: 'sk-otro' } };
  });
  repository.registerSessionProfile({ id: 'profile:otro', name: 'Otro', settings: { apiType: 'openai', model: 'm' } }, { keyless: true });
  assert.ok(!repository.get('profile:otro').settings.apiKey);
  assert.equal((await repository.loadUnlocked('profile:otro')).settings.apiKey, 'sk-otro');
  assert.equal((await repository.loadUnlocked('profile:otro')).settings.apiKey, 'sk-otro');
  assert.deepEqual(requested, ['profile:otro']);

  repository.registerSessionProfile({ id: 'profile:raro', name: 'Raro', settings: {} }, { keyless: true });
  repository.setSessionKeyLoader(async () => ({ id: 'profile:otro', name: 'Otro', settings: { apiKey: 'sk-otro' } }));
  await assert.rejects(repository.loadUnlocked('profile:raro'), /did not return the profile Raro/);
  repository.setSessionKeyLoader(null);
  repository.clearSessionProfile();
});

test('ProfileRepository - syncWithBackend consolida por updatedAt, conserva updatedAt de origen y replica API keys cifradas con revealRemote', async () => {
  const repository = Profiles;
  const serverProfiles = new Map([
    ['profile:remoto-nuevo', {
      id: 'profile:remoto-nuevo',
      name: 'Remoto Nuevo',
      description: 'Desde servidor',
      hasApiKey: true,
      updatedAt: 2000,
      settings: { apiType: 'openai', apiUrl: 'https://api.example/v1', model: 'gpt-4o' }
    }],
    ['profile:compartido', {
      id: 'profile:compartido',
      name: 'Compartido',
      description: 'Versión servidor vieja',
      hasApiKey: false,
      updatedAt: 1000,
      settings: { apiType: 'openai', apiUrl: 'https://api.example/v1', model: 'old' }
    }]
  ]);
  const serverKeys = new Map([['profile:remoto-nuevo', 'sk-remota']]);

  // En el navegador: 'compartido' es más reciente (3000 > 1000) y 'local-offline' es nuevo (synced: false).
  await repository.saveEditable(
    { id: 'profile:compartido', name: 'Compartido', settings: { apiType: 'openai', model: 'new-local', apiKey: 'sk-local-new' } },
    { synced: true }
  );
  // Ajustamos el updatedAt explícito simulando una edición posterior a 1000.
  const localShared = repository.get('profile:compartido');
  repository.save({ ...localShared, updatedAt: 3000 }, { synced: true, preserveUpdatedAt: true });
  await repository.saveEditable(
    { id: 'profile:local-offline', name: 'Offline', settings: { apiType: 'ollama', model: 'llama3', apiKey: '' } },
    { synced: false }
  );

  const savedRemote = [];
  const revealCalls = [];
  const syncParams = {
    serverId: 'srv-A',
    listRemote: async () => [...serverProfiles.values()],
    saveRemote: async payload => {
      savedRemote.push(payload);
      serverProfiles.set(payload.id, { ...payload, hasApiKey: Boolean(payload.settings?.apiKey) });
      return { ...payload, hasApiKey: Boolean(payload.settings?.apiKey) };
    },
    revealRemote: async id => {
      revealCalls.push(id);
      return { ...serverProfiles.get(id), settings: { ...serverProfiles.get(id).settings, apiKey: serverKeys.get(id) } };
    }
  };
  const summary = await repository.syncWithBackend(syncParams);

  assert.equal(summary.uploaded, 2);
  assert.equal(summary.downloaded, 1);
  assert.equal(repository.initialize().serverId, 'srv-A');

  // El servidor recibió el updatedAt original de 'compartido' (3000), no el reloj actual.
  const pushedShared = savedRemote.find(p => p.id === 'profile:compartido');
  assert.equal(pushedShared.updatedAt, 3000);
  assert.equal(pushedShared.settings.apiKey, 'sk-local-new');
  assert.equal(repository.get('profile:compartido').updatedAt, 3000);
  assert.equal(repository.get('profile:compartido').synced, true);

  // El perfil descargado conserva updatedAt=2000 y ya tiene su clave cifrada en localStorage (funciona offline).
  const remoteOnly = repository.get('profile:remoto-nuevo');
  assert.equal(remoteOnly.updatedAt, 2000);
  assert.equal(remoteOnly.hasApiKey, true);
  assert.ok(remoteOnly.settings.apiKey, 'la clave cifrada debe replicarse en localStorage durante syncWithBackend');
  assert.deepEqual(revealCalls, ['profile:remoto-nuevo']);
  assert.equal((await repository.loadUnlocked('profile:remoto-nuevo')).settings.apiKey, 'sk-remota');

  // Resincronizar sin cambios no vuelve a pedir revealRemote.
  await repository.syncWithBackend(syncParams);
  assert.deepEqual(revealCalls, ['profile:remoto-nuevo']);

  // Si otro navegador actualiza el perfil en el servidor, revealRemote actualiza la clave en localStorage sin borrarla.
  serverProfiles.set('profile:remoto-nuevo', {
    ...serverProfiles.get('profile:remoto-nuevo'),
    updatedAt: 2500
  });
  serverKeys.set('profile:remoto-nuevo', 'sk-remota-v2');
  await repository.syncWithBackend(syncParams);
  assert.deepEqual(revealCalls, ['profile:remoto-nuevo', 'profile:remoto-nuevo']);
  assert.equal(repository.get('profile:remoto-nuevo').updatedAt, 2500);
  assert.equal((await repository.loadUnlocked('profile:remoto-nuevo')).settings.apiKey, 'sk-remota-v2');
});

test('ProfileRepository - borrados con synced y protección al cancelar cambio de serverId', async () => {
  const repository = Profiles;
  const serverA = new Map([
    ['profile:a1', { id: 'profile:a1', name: 'A1', hasApiKey: false, updatedAt: 1000, settings: { apiType: 'openai', model: 'm1' } }],
    ['profile:a2', { id: 'profile:a2', name: 'A2', hasApiKey: false, updatedAt: 1000, settings: { apiType: 'openai', model: 'm2' } }]
  ]);

  await repository.syncWithBackend({
    serverId: 'srv-A',
    listRemote: async () => [...serverA.values()],
    saveRemote: async p => p
  });

  // 1. Borrado en servidor (a1 desaparece en srv-A): se elimina la copia local marcada synced.
  serverA.delete('profile:a1');

  const resSame = await repository.syncWithBackend({
    serverId: 'srv-A',
    listRemote: async () => [...serverA.values()],
    saveRemote: async p => p
  });
  assert.equal(resSame.deletedLocal, 1, 'a1 tenía synced:true y faltaba en servidor');
  assert.equal(repository.get('profile:a1'), null);

  // 2. Cambio de serverId con elección 'cancel': conserva todos los perfiles locales y no sube nada a srv-B.
  await repository.saveEditable({ id: 'profile:privado-a', name: 'Privado A', settings: { apiType: 'openai', model: 'm', apiKey: 'sk-privado-a' } });
  const serverB = new Map([
    ['profile:b1', { id: 'profile:b1', name: 'B1', hasApiKey: false, updatedAt: 5000, settings: { apiType: 'ollama', model: 'llama' } }]
  ]);
  const uploadedToB = [];
  let changeArgs = null;
  const resCancel = await repository.syncWithBackend({
    serverId: 'srv-B',
    listRemote: async () => [...serverB.values()],
    saveRemote: async p => { uploadedToB.push(p); return p; },
    onServerChange: async info => { changeArgs = info; return 'cancel'; }
  });
  assert.equal(changeArgs.previousServerId, 'srv-A');
  assert.equal(changeArgs.nextServerId, 'srv-B');
  assert.equal(resCancel.cancelled, true);
  assert.deepEqual(uploadedToB, [], 'cancel no debe subir perfiles de A hacia B');
  assert.ok(repository.get('profile:privado-a'), 'cancel debe conservar el perfil local');
  assert.ok(repository.get('profile:a2'), 'cancel debe conservar los perfiles sincronizados previos');
  assert.equal(repository.get('profile:b1'), null);
  assert.equal(repository.initialize().serverId, 'srv-A');

  // 3. Cambio de serverId con elección 'merge': conserva y sube los perfiles locales sin descartarlos como borrados.
  const serverC = [];
  const resMerge = await repository.syncWithBackend({
    serverId: 'srv-C',
    listRemote: async () => serverC,
    saveRemote: async p => { serverC.push(p); return p; },
    onServerChange: async () => 'merge'
  });
  assert.equal(resMerge.cancelled, false);
  assert.equal(resMerge.uploaded, 2, 'a2 y Privado A pasan al nuevo servidor al elegir merge');
  assert.ok(serverC.some(p => p.id === 'profile:a2'));
  assert.ok(serverC.some(p => p.id === 'profile:privado-a'));
});

