const test = require('node:test');
const assert = require('node:assert/strict');
const UIProfiles = require('../../js/ui-profiles.js');
const ProfileRepository = require('../../js/profile-repository.js');

const editorWith = changes => ({ ...UIProfiles.initialEditorState(), loadedApiKey: '', ...changes });
const MIRROR = { id: ProfileRepository.READONLY_PROFILE_ID, name: 'Espejo' };
const LOCAL = { id: 'profile:local', name: 'Local chat' };

test('UIProfiles - avisos de estado, cierre y decisión de guardado del editor', () => {
  const form = { name: 'Local chat', readOnly: false, webllmModelReady: false };
  for (const [editor, changes, expected] of [
    [editorWith({ dirty: true }), { readOnly: true }, 'El perfil Espejo no se puede modificar ni eliminar.'],
    [editorWith({ dirty: true }), { name: '' }, 'Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)'],
    [editorWith(), {}, 'No hay cambios pendientes: Guardar cierra el panel.'],
    [editorWith({ dirty: true }), {}, 'Hay cambios pendientes. Guarda el perfil para conservarlos.'],
    [editorWith({ queryReady: true }), {}, 'Hay cambios pendientes. Guarda el perfil para conservarlos.'],
    [editorWith({ queryReady: true }), { webllmModelReady: true }, 'Modelo descargado listo. La consulta al servidor es opcional.']
  ]) {
    assert.equal(UIProfiles.getSaveHint(editor, { ...form, ...changes }), expected, JSON.stringify({ editor, changes }));
  }

  assert.equal(UIProfiles.getCloseConfirmation(editorWith()), null);
  assert.match(UIProfiles.getCloseConfirmation(editorWith({ dirty: true })), /^Hay cambios sin guardar en el perfil/);
  for (const editor of [editorWith({ queryReady: true }), editorWith({ queryReady: true, dirty: true })]) {
    assert.match(UIProfiles.getCloseConfirmation(editor), /no se ha guardado/);
  }

  const save = (editor, name, selected, sameName) => UIProfiles.getSaveDecision(editor, { name, selected, sameName });
  const pending = editorWith({ dirty: true });
  assert.deepEqual(save(UIProfiles.initialEditorState(), 'Local chat', LOCAL, LOCAL), { action: 'none' });
  assert.deepEqual(save(editorWith(), '', LOCAL, null), { action: 'close' });
  assert.deepEqual(save(editorWith({ dirty: true, locked: true }), 'Local chat', LOCAL, LOCAL), { action: 'none' });
  assert.deepEqual(save(pending, '', LOCAL, null), { action: 'error', message: 'Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)' });
  assert.deepEqual(save(pending, 'Espejo', MIRROR, MIRROR), { action: 'error', message: 'El perfil Espejo no se puede modificar ni eliminar.' });
  assert.deepEqual(save(pending, 'Espejo', LOCAL, MIRROR), { action: 'error', message: 'El perfil Espejo no se puede modificar ni eliminar.' });
  assert.deepEqual(save(pending, 'Local chat', undefined, LOCAL), { action: 'error', message: 'Ya existe un perfil llamado "Local chat".' });
  assert.deepEqual(save(pending, 'Local chat', LOCAL, LOCAL), { action: 'save' });
  assert.deepEqual(save(editorWith({ queryReady: true }), 'Nuevo', undefined, null), { action: 'save' });
});

test('UIProfiles - la ejecución en segundo plano requiere conexión y un perfil compatible (ni Espejo ni WebLLM)', () => {
  assert.deepEqual(UIProfiles.getBackgroundEligibility({ activeProfile: { id: ProfileRepository.READONLY_PROFILE_ID }, apiType: 'mirror' }, false),
    { allowed: false, reasonKey: 'profile_background_disconnected' });
  assert.deepEqual(UIProfiles.getBackgroundEligibility({ activeProfile: { id: ProfileRepository.READONLY_PROFILE_ID }, apiType: 'mirror' }, true),
    { allowed: false, reasonKey: 'profile_background_unsupported' });
  assert.deepEqual(UIProfiles.getBackgroundEligibility({ activeProfile: { id: 'profile:web' }, apiType: 'webllm' }, true),
    { allowed: false, reasonKey: 'profile_background_webllm_unsupported' });
  assert.deepEqual(UIProfiles.getBackgroundEligibility({ activeProfile: { id: 'profile:local' }, apiType: 'openai' }, true),
    { allowed: true, reasonKey: '' });
});

test('UIProfiles - los ajustes guardados parten del perfil editado y completan lo vacío con lo guardado o lo del proveedor', () => {
  const base = { ...ProfileRepository.NEW_PROFILE_SETTINGS, apiUrl: 'http://gpu.lan:1234/v1', webllmConfig: { context_window_size: '8192' } };
  const form = {
    apiType: 'openai', apiUrl: '  ', apiKey: ' sk-nueva ', apiKeyLocked: true, model: ' gemma ', systemPrompt: ' Sé breve. ',
    temperature: '', webllmContextWindow: '', webllmPrefillChunk: ''
  };
  const settings = UIProfiles.buildProfileSettings(base, form);
  assert.deepEqual(settings, {
    ...base,
    apiUrl: 'http://gpu.lan:1234/v1',
    apiKey: 'sk-nueva',
    apiKeyLocked: true,
    model: 'gemma',
    systemPrompt: 'Sé breve.',
    temperature: '0.7',
    webllmConfig: { context_window_size: '8192', prefill_chunk_size: 'default' }
  });
  // Sin URL guardada se usa la del proveedor elegido, y el formulario manda sobre lo guardado.
  const ollama = UIProfiles.buildProfileSettings({ ...base, apiUrl: '' }, { ...form, apiType: 'ollama', temperature: '1.2', webllmPrefillChunk: '1024', contextWindow: ' 262144 ' });
  assert.deepEqual({ apiType: ollama.apiType, apiUrl: ollama.apiUrl, temperature: ollama.temperature, prefill: ollama.webllmConfig.prefill_chunk_size, contextWindow: ollama.contextWindow },
    { apiType: 'ollama', apiUrl: 'http://localhost:11434', temperature: '1.2', prefill: '1024', contextWindow: 262144 });
  assert.equal(UIProfiles.buildProfileSettings(ollama, { ...form, contextWindow: '' }).contextWindow, null);
});
