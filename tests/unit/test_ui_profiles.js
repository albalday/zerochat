const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIProfiles = require('../../js/ui-profiles.js');
const UISettings = require('../../js/ui-settings.js');
const Profiles = require('../../js/profile-repository.js');
const Config = require('../../js/config-store.js');
const Storage = require('../../js/storage.js');
const I18n = require('../../js/i18n.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Espera a que se cumpla la condición: guardar cifra la clave y tarda más que un ciclo. */
async function until(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await settle();
  }
}

/**
 * Monta el menú y el editor de perfiles sobre el marcado de la aplicación. Los diálogos de
 * ChatDialogs se sustituyen por `dialogs`; el resto de módulos son los reales.
 */
function setup(t, dialogs = {}) {
  const dom = installDom({ app: true });
  // Cada prueba empieza solo con el perfil Espejo.
  Storage.deleteStorageItem(Profiles.STORAGE_KEY);
  UISettings.ensureDialogMarkup();
  const elements = getAppElements(document);
  const calls = { updateUIFromConfig: 0, inspectProfile: [] };
  const previousDialogs = globalThis.ChatDialogs;
  const prompts = [];
  globalThis.ChatDialogs = {
    confirm: async () => true,
    alert: async () => {},
    prompt: async message => { prompts.push(message); return null; },
    ...dialogs
  };
  UIProfiles.mount({
    elements,
    getRuntimeConfig: () => Config.getActive(),
    updateUIFromConfig: () => { calls.updateUIFromConfig++; },
    loadCachedModels: () => {},
    resetTelemetryDisplay: () => {},
    closeSettingsModal: () => {},
    inspectProfile: async profile => { calls.inspectProfile.push(profile.id); }
  });
  t.after(() => {
    if (previousDialogs === undefined) delete globalThis.ChatDialogs;
    else globalThis.ChatDialogs = previousDialogs;
    dom.restore();
  });
  return { elements, calls, prompts };
}

function saveProfile(name, settings = {}) {
  return Profiles.save({ id: `profile:${name}`, name, description: `${name} local`, settings: { ...Profiles.NEW_PROFILE_SETTINGS, ...settings } });
}

const openMenu = elements => elements.activeProfileTrigger.click();
const menuItem = (elements, profileId) => elements.activeProfileList.querySelector(`[data-profile-id="${profileId}"]`).closest('.header-profile-item');

test('UIProfiles - el menú lista los perfiles con inspeccionar, editar y, salvo Espejo, borrar', async t => {
  const { elements, calls } = setup(t);
  const custom = saveProfile('Mi Perfil Ollama');
  Config.activateProfile(Profiles.READONLY_PROFILE_ID);

  openMenu(elements);
  assert.equal(elements.activeProfilePopover.hidden, false);
  const mirror = menuItem(elements, Profiles.READONLY_PROFILE_ID);
  assert.ok(mirror.classList.contains('active'));
  assert.equal(mirror.querySelector('[role="menuitemradio"]').getAttribute('aria-checked'), 'true');
  assert.ok(mirror.querySelector('[data-profile-action="inspect"]'));
  assert.ok(mirror.querySelector('[data-profile-action="edit"]'));
  assert.equal(mirror.querySelector('[data-profile-action="delete"]'), null, 'Espejo es de solo lectura');
  const item = menuItem(elements, custom.id);
  assert.deepEqual([...item.querySelectorAll('[data-profile-action]')].map(button => button.dataset.profileAction), ['inspect', 'edit', 'delete']);

  item.querySelector('[data-profile-action="inspect"]').click();
  await settle();
  assert.deepEqual(calls.inspectProfile, [custom.id]);

  openMenu(elements);
  menuItem(elements, custom.id).querySelector('[data-profile-id]').click();
  assert.equal(Config.getActive().activeProfile.id, custom.id, 'Elegir un perfil lo activa');
  assert.equal(elements.activeProfilePopover.hidden, true);
  assert.ok(calls.updateUIFromConfig > 0);
});

test('UIProfiles - el editor solo permite guardar con cambios o una consulta lista', async t => {
  const { elements } = setup(t);
  const profile = saveProfile('Editable', { model: 'gpt-4o' });
  Config.activateProfile(profile.id);

  openMenu(elements);
  menuItem(elements, profile.id).querySelector('[data-profile-action="edit"]').click();
  await settle();
  assert.ok(elements.profilesDialog.open);
  assert.equal(elements.settingProfileName.value, 'Editable');
  assert.equal(elements.settingModel.value, 'gpt-4o');
  assert.equal(elements.btnSaveProfile.disabled, true, 'Sin cambios no se guarda');

  elements.settingModel.value = 'gpt-4.1';
  elements.settingModel.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(elements.btnSaveProfile.disabled, false);
  elements.settingModel.value = 'gpt-4o';
  elements.settingModel.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(elements.btnSaveProfile.disabled, false, 'Volver al valor inicial no deshace la modificación');

  assert.equal(await UIProfiles.closeProfilesModal(true), true);
  openMenu(elements);
  menuItem(elements, profile.id).querySelector('[data-profile-action="edit"]').click();
  await settle();
  assert.equal(elements.btnSaveProfile.disabled, true, 'Al reabrir el editor no quedan cambios pendientes');
  UIProfiles.setProfileQueryState(true);
  assert.equal(elements.btnSaveProfile.disabled, false, 'Una consulta al servidor lista permite guardar');
});

test('UIProfiles - cerrar con cambios pide confirmación y guardar actualiza el perfil', async t => {
  const confirms = [];
  let discard = false;
  const { elements } = setup(t, { confirm: async message => { confirms.push(message); return discard; } });
  const profile = saveProfile('Guardable', { model: 'old-model' });
  Config.activateProfile(profile.id);
  openMenu(elements);
  menuItem(elements, profile.id).querySelector('[data-profile-action="edit"]').click();
  await settle();

  elements.settingModel.value = 'new-model';
  elements.settingModel.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(await UIProfiles.closeProfilesModal(false), false);
  assert.deepEqual(confirms, [I18n.t('confirm_profile_unsaved_changes')]);
  assert.ok(elements.profilesDialog.open);

  elements.btnSaveProfile.click();
  await until(() => !elements.profilesDialog.open);
  assert.equal(Profiles.get(profile.id).settings.model, 'new-model');
});

test('UIProfiles - borrar un perfil pide confirmación, respeta la cancelación y rechaza Espejo', async t => {
  let accept = false;
  const confirms = [];
  const { elements, calls } = setup(t, { confirm: async message => { confirms.push(message); return accept; } });
  const profile = saveProfile('Perfil Borrable');
  Config.activateProfile(profile.id);

  openMenu(elements);
  menuItem(elements, profile.id).querySelector('[data-profile-action="delete"]').click();
  await settle();
  assert.match(confirms[0], /Perfil Borrable/);
  assert.ok(Profiles.get(profile.id), 'Cancelar no borra');

  accept = true;
  openMenu(elements);
  menuItem(elements, profile.id).querySelector('[data-profile-action="delete"]').click();
  await settle();
  assert.equal(Profiles.get(profile.id), null);
  assert.notEqual(Config.getActive().activeProfile?.id, profile.id, 'El perfil activo borrado se sustituye');
  assert.ok(calls.updateUIFromConfig > 0, 'Se refrescan los controles del perfil activo');
  assert.equal(elements.activeProfileList.querySelector(`[data-profile-id="${profile.id}"]`), null);
});

test('UIProfiles - un perfil nuevo abre el editor vacío sin pedir nombre ni heredar la clave', async t => {
  const { elements, prompts } = setup(t);
  const active = saveProfile('Con clave', { apiKeyLocked: true });
  Config.activateProfile(active.id);
  elements.settingProfileName.value = 'Texto anterior';
  elements.settingApiKey.value = 'sk-old';

  openMenu(elements);
  elements.btnMenuNewProfile.click();
  await settle();

  assert.deepEqual(prompts, [], 'No se pide nombre ni contraseña');
  assert.ok(elements.profilesDialog.open);
  assert.equal(elements.settingProfileName.value, '');
  assert.equal(elements.settingProfileDescription.value, '');
  assert.equal(elements.settingApiKey.value, '');
  assert.equal(elements.settingApiKeyLocked.checked, false);
  assert.equal(elements.btnSaveProfile.disabled, true, 'Sin nombre no se guarda');
});

test('UIProfiles - usar la clave predeterminada informa si no hay API keys', async t => {
  const alerts = [];
  setup(t, { alert: async message => { alerts.push(message); } });
  await UIProfiles.handleUseDefaultEncryptionKey();
  assert.deepEqual(alerts, [I18n.t('crypto_default_no_api_keys')]);
});
