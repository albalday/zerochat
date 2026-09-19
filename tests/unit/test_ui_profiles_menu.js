const { test } = require('node:test');
const assert = require('node:assert/strict');
const UISettings = require('../../js/ui-settings.js');
const UIProfiles = require('../../js/ui-profiles.js');

function createMockElement(tagName) {
  const children = [];
  const attrs = {};
  return {
    tagName,
    className: '',
    children,
    dataset: {},
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => attrs[k],
    appendChild: (c) => children.push(c),
    querySelector: (sel) => {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return children.find(c => c.className && c.className.includes(cls));
      }
      if (sel.includes('data-profile-action=')) {
        const match = sel.match(/data-profile-action="([^"]+)"/);
        const action = match ? match[1] : null;
        return children.find(c => c.dataset && c.dataset.profileAction === action);
      }
      return null;
    }
  };
}

test('UISettings.renderProfileMenu - renderiza lista con acciones de editar y borrar', () => {
  const mockChildren = [];
  const mockDoc = {
    createElement: (tag) => createMockElement(tag)
  };
  const mockList = {
    ownerDocument: mockDoc,
    replaceChildren: () => { mockChildren.length = 0; },
    appendChild: (child) => { mockChildren.push(child); }
  };
  const elements = { activeProfileList: mockList };

  const profiles = [
    { id: 'profile:mirror', name: 'Espejo', description: 'Espejo local' },
    { id: 'profile:custom1', name: 'Mi Perfil Ollama', description: 'Ollama local' }
  ];

  UISettings.renderProfileMenu(elements, profiles, 'profile:mirror');

  assert.equal(mockChildren.length, 2, 'Debe renderizar 2 elementos de perfil');

  // 1. Primer elemento: Espejo (solo lectura)
  const mirrorItem = mockChildren[0];
  assert.match(mirrorItem.className, /header-profile-item/);
  assert.match(mirrorItem.className, /active/);

  const mirrorOption = mirrorItem.children[0];
  assert.equal(mirrorOption.dataset.profileId, 'profile:mirror');
  assert.equal(mirrorOption.getAttribute('role'), 'menuitemradio');
  assert.equal(mirrorOption.getAttribute('aria-checked'), 'true');

  const mirrorActions = mirrorItem.children[1];
  const mirrorEdit = mirrorActions.querySelector('[data-profile-action="edit"]');
  assert.ok(mirrorEdit, 'El perfil Espejo debe tener botón de edición');
  assert.equal(mirrorEdit.dataset.targetId, 'profile:mirror');

  // Espejo NO debe tener botón de borrado
  const mirrorDelete = mirrorActions.querySelector('[data-profile-action="delete"]');
  assert.equal(Boolean(mirrorDelete), false, 'El perfil Espejo de solo lectura no debe tener botón de borrado');

  // 2. Segundo elemento: Mi Perfil Ollama (editable)
  const customItem = mockChildren[1];
  assert.match(customItem.className, /header-profile-item/);
  assert.doesNotMatch(customItem.className, /active/);

  const customActions = customItem.children[1];
  const customEdit = customActions.children[0];
  const customDelete = customActions.children[1];

  assert.ok(customEdit, 'El perfil editable debe tener botón de edición');
  assert.equal(customEdit.dataset.profileAction, 'edit');
  assert.equal(customEdit.dataset.targetId, 'profile:custom1');

  assert.ok(customDelete, 'El perfil editable debe tener botón de borrado');
  assert.equal(customDelete.dataset.profileAction, 'delete');
  assert.equal(customDelete.dataset.targetId, 'profile:custom1');
});

test('UIProfiles - handleDeleteProfileById rechaza borrar perfil de solo lectura', async () => {
  const result = await UIProfiles.handleDeleteProfileById('profile:mirror', {}, {});
  assert.equal(result, false, 'No se debe permitir borrar el perfil Espejo');
});

test('UIProfiles - handleDeleteProfileById pide confirmación y elimina perfil si se acepta', async () => {
  let confirmPromptMessage = '';
  let removedId = null;

  global.ChatDialogs = {
    confirm: async (msg) => {
      confirmPromptMessage = msg;
      return true;
    }
  };

  const mockProfiles = {
    READONLY_PROFILE_ID: 'profile:mirror',
    get: (id) => (id === 'prof_1' ? { id: 'prof_1', name: 'Perfil Borrable' } : null),
    remove: (id) => {
      removedId = id;
      return true;
    },
    list: () => []
  };

  global.ChatProfileRepository = mockProfiles;
  global.ChatConfig = {
    getActive: () => ({ activeProfile: { id: 'prof_1' } }),
    activateFallbackProfile: () => {}
  };

  const elements = {
    profilesDialog: { dataset: {}, querySelectorAll: () => [] },
    profileSelectHelper: { innerHTML: '', appendChild: () => {}, value: 'prof_1' },
    activeProfileList: { replaceChildren: () => {}, appendChild: () => {}, ownerDocument: { createElement: createMockElement } }
  };

  const result = await UIProfiles.handleDeleteProfileById('prof_1', elements, {});
  assert.equal(result, true, 'Debe devolver true al completar el borrado');
  assert.match(confirmPromptMessage, /Perfil Borrable/, 'Debe pedir confirmación incluyendo el nombre');
  assert.equal(removedId, 'prof_1', 'Debe haber llamado a remove con el id del perfil');
});

test('UIProfiles - handleDeleteProfileById no elimina si se cancela la confirmación', async () => {
  let removed = false;

  global.ChatDialogs = {
    confirm: async () => false
  };

  global.ChatProfileRepository = {
    READONLY_PROFILE_ID: 'profile:mirror',
    get: (id) => ({ id, name: 'Perfil Seguro' }),
    remove: () => { removed = true; return true; },
    list: () => []
  };

  const result = await UIProfiles.handleDeleteProfileById('prof_2', {}, {});
  assert.equal(result, false, 'Debe devolver false si la confirmación se cancela');
  assert.equal(removed, false, 'No debe llamar a remove al cancelar');
});

test('UIProfiles - handleMenuNewProfile no pide nombre y abre editor con campos vacíos', async () => {
  let promptCalled = false;
  let modalOpened = false;

  global.ChatDialogs = {
    prompt: async () => {
      promptCalled = true;
      return 'Nombre Inesperado';
    }
  };

  const elements = {
    profilesDialog: {
      dataset: {},
      showModal: () => { modalOpened = true; },
      querySelectorAll: () => []
    },
    activeProfileTrigger: { setAttribute: () => {} },
    activeProfilePopover: { hidden: false },
    settingProfileName: { value: 'Texto anterior', focus: () => {} },
    settingProfileDescription: { value: 'Descripcion anterior' },
    settingApiKey: { value: 'sk-old', _loadedApiKey: 'sk-old' },
    settingApiKeyLocked: { checked: true },
    profileSelectHelper: { value: 'old_id' }
  };

  await UIProfiles.handleMenuNewProfile(elements, {});

  assert.equal(promptCalled, false, 'No debe solicitar confirmación o prompt de nombre al crear nuevo perfil');
  assert.equal(modalOpened, true, 'Debe abrir el modal de perfiles directamente');
  assert.equal(elements.settingProfileName.value, '', 'El campo nombre debe quedar en blanco');
  assert.equal(elements.settingProfileDescription.value, '', 'El campo descripción debe quedar en blanco');
  assert.equal(elements.settingApiKeyLocked.checked, false, 'El bloqueo de cambios debe inicializarse desmarcado');
  assert.equal(elements.profilesDialog.dataset.isNew, 'true', 'Debe marcar dataset.isNew');
});
