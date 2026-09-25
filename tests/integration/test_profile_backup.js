const test = require('node:test');
const assert = require('node:assert/strict');
const Backup = require('../../js/profile-backup.js');

const profiles = [{
  id: 'profile:remote',
  name: 'Remote',
  description: 'Remote provider',
  settings: { apiType: 'openai', apiUrl: 'https://example.test/v1', model: 'model-a' }
}];

test('ProfileBackup - cifra y recupera las definiciones sin exponerlas en el archivo', async () => {
  const encrypted = await Backup.encryptProfiles(profiles);
  assert.doesNotMatch(encrypted, /sk-secret/);
  const envelope = JSON.parse(encrypted);
  assert.equal(envelope.format, Backup.FORMAT);
  assert.equal(envelope.algorithm, 'AES-GCM');
  assert.deepEqual(await Backup.decryptProfiles(encrypted), profiles);
});

test('ProfileBackup - rechaza una copia manipulada', async () => {
  const envelope = JSON.parse(await Backup.encryptProfiles(profiles));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`;
  await assert.rejects(Backup.decryptProfiles(JSON.stringify(envelope)), error => error.code === 'PASSWORD_REQUIRED');
});

test('ProfileBackup - valida la estructura antes de cifrar', async () => {
  await assert.rejects(Backup.encryptProfiles([{ id: 'bad', name: '', settings: {} }]), /perfil no válido/i);
});

test('ProfileBackup - cifra cada API key y detecta manipulación', async () => {
  const secret = await Backup.encryptApiKey('sk-secret');
  assert.doesNotMatch(JSON.stringify(secret), /sk-secret/);
  assert.equal(await Backup.decryptApiKey(secret), 'sk-secret');
  assert.throws(() => Backup.validateApiKeySecret('sk-secret'), /API key cifrada/);
  await assert.rejects(Backup.decryptApiKey({ ...secret, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' }));
  const exported = await Backup.encryptProfiles([{ ...profiles[0], settings: { ...profiles[0].settings, apiKey: secret } }]);
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
    const encryptedProfiles = await Backup.encryptProfiles(profiles, keyMaterial);
    await assert.rejects(Backup.decryptApiKey(secret, null), error => error.code === 'PASSWORD_REQUIRED');
    await assert.rejects(Backup.decryptProfiles(encryptedProfiles, null), error => error.code === 'PASSWORD_REQUIRED');
    Backup.cacheKeyMaterial(keyMaterial);
    assert.equal(await Backup.decryptApiKey(secret), 'sk-custom');
    assert.deepEqual(await Backup.decryptProfiles(encryptedProfiles), profiles);
    Backup.clearCachedKeyMaterial();
    assert.equal(Backup.getCachedKeyMaterial(), null);
  } finally {
    if (originalStorage === undefined) delete global.localStorage;
    else global.localStorage = originalStorage;
  }
});
