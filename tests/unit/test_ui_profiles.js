const test = require('node:test');
const assert = require('node:assert/strict');
const UIProfiles = require('../../js/ui-profiles.js');
const ProfileRepository = require('../../js/profile-repository.js');

const editorWith = changes => ({ ...UIProfiles.initialEditorState(), loadedApiKey: '', ...changes });
const MIRROR = { id: ProfileRepository.READONLY_PROFILE_ID, name: 'Espejo' };
const LOCAL = { id: 'profile:local', name: 'Local chat' };

test('UIProfiles - el aviso de guardado distingue solo lectura, falta de nombre, nada pendiente y modelo de WebLLM listo', () => {
  const form = { name: 'Local chat', readOnly: false, webllmModelReady: false };
  const cases = [
    [editorWith({ dirty: true }), { readOnly: true }, 'El perfil Espejo no se puede modificar ni eliminar.'],
    [editorWith({ dirty: true }), { name: '' }, 'Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)'],
    [editorWith(), {}, 'No hay cambios pendientes: Guardar cierra el panel.'],
    [editorWith({ dirty: true }), {}, 'Hay cambios pendientes. Guarda el perfil para conservarlos.'],
    // Una consulta al servidor lista también queda pendiente de guardar.
    [editorWith({ queryReady: true }), {}, 'Hay cambios pendientes. Guarda el perfil para conservarlos.'],
    [editorWith({ queryReady: true }), { webllmModelReady: true }, 'Modelo descargado listo. La consulta al servidor es opcional.']
  ];
  for (const [editor, changes, expected] of cases) {
    assert.equal(UIProfiles.getSaveHint(editor, { ...form, ...changes }), expected, JSON.stringify({ editor, changes }));
  }
});

test('UIProfiles - Guardar espera a la API key y al desbloqueo, cierra sin nada pendiente y valida el nombre', () => {
  const save = (editor, name, selected, sameName) => UIProfiles.getSaveDecision(editor, { name, selected, sameName });
  const pending = editorWith({ dirty: true });
  assert.deepEqual(save(UIProfiles.initialEditorState(), 'Local chat', LOCAL, LOCAL), { action: 'none' }, 'API key aún descifrándose');
  assert.deepEqual(save(editorWith(), '', LOCAL, null), { action: 'close' }, 'Nada pendiente cierra aunque falte el nombre');
  assert.deepEqual(save(editorWith({ dirty: true, locked: true }), 'Local chat', LOCAL, LOCAL), { action: 'none' });
  assert.deepEqual(save(pending, '', LOCAL, null), { action: 'error', message: 'Nombre del perfil (ej: LM Studio, Ollama, OpenRouter...)' });
  assert.deepEqual(save(pending, 'Espejo', MIRROR, MIRROR), { action: 'error', message: 'El perfil Espejo no se puede modificar ni eliminar.' });
  assert.deepEqual(save(pending, 'Espejo', LOCAL, MIRROR), { action: 'error', message: 'El perfil Espejo no se puede modificar ni eliminar.' }, 'Renombrar a Espejo');
  assert.deepEqual(save(pending, 'Local chat', undefined, LOCAL), { action: 'error', message: 'Ya existe un perfil llamado "Local chat".' });
  assert.deepEqual(save(pending, 'Local chat', LOCAL, LOCAL), { action: 'save' });
  assert.deepEqual(save(editorWith({ queryReady: true }), 'Nuevo', undefined, null), { action: 'save' });
});

test('UIProfiles - cerrar el editor pregunta por la consulta sin guardar antes que por los cambios', () => {
  assert.equal(UIProfiles.getCloseConfirmation(editorWith()), null);
  assert.match(UIProfiles.getCloseConfirmation(editorWith({ dirty: true })), /^Hay cambios sin guardar en el perfil/);
  for (const editor of [editorWith({ queryReady: true }), editorWith({ queryReady: true, dirty: true })]) {
    assert.match(UIProfiles.getCloseConfirmation(editor), /no se ha guardado/);
  }
});

test('UIProfiles - los ajustes guardados parten del perfil editado y completan lo vacío con lo guardado o lo del proveedor', () => {
  const base = { ...ProfileRepository.NEW_PROFILE_SETTINGS, apiUrl: 'http://gpu.lan:1234/v1', contextLimitOverride: 32768, webllmConfig: { context_window_size: '8192' } };
  const form = {
    apiType: 'openai', apiUrl: '  ', apiKey: ' sk-nueva ', apiKeyLocked: true, model: ' gemma ', systemPrompt: ' Sé breve. ',
    temperature: '', webllmContextWindow: '', webllmPrefillChunk: '', mcpServers: ['memory'], playwrightBrowser: { mode: 'own', engine: 'chromium' }
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
    webllmConfig: { context_window_size: '8192', prefill_chunk_size: 'default' },
    mcpServers: ['memory'],
    playwrightBrowser: { mode: 'own', engine: 'chromium' }
  });
  // Sin URL guardada se usa la del proveedor elegido, y el formulario manda sobre lo guardado.
  const ollama = UIProfiles.buildProfileSettings({ ...base, apiUrl: '' }, { ...form, apiType: 'ollama', temperature: '1.2', webllmPrefillChunk: '1024' });
  assert.deepEqual({ apiType: ollama.apiType, apiUrl: ollama.apiUrl, temperature: ollama.temperature, prefill: ollama.webllmConfig.prefill_chunk_size },
    { apiType: 'ollama', apiUrl: 'http://localhost:11434', temperature: '1.2', prefill: '1024' });
});
