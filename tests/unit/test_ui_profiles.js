const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIProfiles = require('../../js/ui-profiles.js');

test('UIProfiles - isProfileFormDirty y canSaveProfile detectan modificación y la mantienen activa', () => {
  const elements = {
    profilesDialog: { dataset: {} },
    profileSelectHelper: { value: 'prof_test' },
    settingProfileName: { value: 'Test Profile' },
    settingModel: { value: 'gpt-4o' }
  };

  // 1. Estado inicial sin modificar: no está sucio y no se puede guardar
  assert.equal(UIProfiles.isProfileFormDirty(elements), false);
  assert.equal(UIProfiles.canSaveProfile(elements), false);

  // 2. Cualquier modificación activa el estado sucio y permite guardar
  UIProfiles.setProfileDirty(elements, true);
  assert.equal(UIProfiles.isProfileFormDirty(elements), true);
  assert.equal(UIProfiles.canSaveProfile(elements), true);

  // 3. Aunque el valor vuelva al original, cualquier modificación previa lo deja activado
  elements.settingModel.value = 'gpt-4o';
  assert.equal(UIProfiles.isProfileFormDirty(elements), true, 'Debe permanecer activado aunque se revierta el campo');
  assert.equal(UIProfiles.canSaveProfile(elements), true);

  // 4. Al resetear explícitamente (ej: cambio de perfil o tras guardar), vuelve a quedar limpio
  UIProfiles.setProfileDirty(elements, false);
  assert.equal(UIProfiles.isProfileFormDirty(elements), false);
  assert.equal(UIProfiles.canSaveProfile(elements), false);
});

test('UIProfiles - canSaveProfile requiere modificación o consulta lista', () => {
  const elements = {
    profilesDialog: { dataset: {}, querySelectorAll: () => [] },
    profileSelectHelper: { value: 'prof_test' }
  };
  assert.equal(UIProfiles.canSaveProfile(elements), false);

  UIProfiles.setProfileDirty(elements, true);
  assert.equal(UIProfiles.canSaveProfile(elements), true);

  UIProfiles.setProfileDirty(elements, false);
  assert.equal(UIProfiles.canSaveProfile(elements), false);

  UIProfiles.setProfileQueryState(elements, true);
  assert.equal(UIProfiles.canSaveProfile(elements), true);
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
