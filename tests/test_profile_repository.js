const test = require('node:test');
const assert = require('node:assert/strict');
const Profiles = require('../js/profile-repository.js');

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
