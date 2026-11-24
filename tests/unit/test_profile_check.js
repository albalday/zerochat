const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../../js/state.js');
const ChatConfig = require('../../js/config-store.js');
const Profiles = require('../../js/profile-repository.js');
const API = require('../../js/api.js');
const ProfileCheck = require('../../js/profile-check.js');

// La comprobación usa ChatState, ChatConfig, el repositorio de perfiles y ChatAPI reales; solo se simula la respuesta
// del servidor (fetchServerModels) y, en su caso, la clave sin desbloquear.
const OPENAI = { apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: 'gemma' };
const checkState = () => State.get('ui').profileCheck;
const limit = () => ChatConfig.getActive().modelContextLimit;

async function checkWith(t, connection, listing) {
  const calls = [];
  t.mock.method(API, 'fetchServerModels', async (...args) => {
    calls.push(args);
    return typeof listing === 'function' ? listing(calls.length) : listing;
  });
  ChatConfig.updateRuntime({ ...connection, model: '' });
  ProfileCheck.start();
  ChatConfig.updateRuntime(connection);
  await ProfileCheck.settled();
  return calls;
}

test.beforeEach(() => localStorage.clear());

test('ProfileCheck - modelo listo con el límite que publica el servidor o, si no lo publica, el calculado', async t => {
  await checkWith(t, OPENAI, { success: true, models: [{ id: 'gemma', details: { loaded_context_length: 90112 } }] });
  assert.deepEqual(checkState(), { status: 'ready', reason: '', message: '' });
  assert.equal(limit(), 90112);

  await checkWith(t, OPENAI, { success: true, models: [{ id: 'gemma' }] });
  assert.equal(checkState().status, 'ready');
  assert.equal(limit(), null);
});

test('ProfileCheck - servidor caído, clave rechazada, error del servidor o modelo inexistente: no listo y límite calculado', async t => {
  for (const [listing, reason, message] of [
    [{ success: false, error: 'fetch failed' }, 'unreachable', 'fetch failed'],
    [{ success: false, error: 'HTTP 401: Unauthorized' }, 'auth', 'HTTP 401: Unauthorized'],
    [{ success: false, error: 'HTTP 500: Internal Server Error' }, 'server', 'HTTP 500: Internal Server Error'],
    [{ success: true, models: [{ id: 'otro', details: { loaded_context_length: 4096 } }] }, 'model_not_found', 'gemma']
  ]) {
    await checkWith(t, OPENAI, listing);
    assert.deepEqual(checkState(), { status: 'error', reason, message }, reason);
    assert.equal(limit(), null, reason);
  }
});

test('ProfileCheck - la respuesta de una comprobación relevada por otra posterior se descarta', async t => {
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  await checkWith(t, OPENAI, call => (call === 1 ? first : { success: true, models: [{ id: 'llama', details: { loaded_context_length: 8192 } }] }));
  ChatConfig.updateRuntime({ model: 'llama' });
  await ProfileCheck.settled();
  releaseFirst({ success: true, models: [{ id: 'gemma', details: { loaded_context_length: 90112 } }] });
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checkState().status, 'ready');
  assert.equal(limit(), 8192);
});

test('ProfileCheck - WebLLM usa su ventana de contexto, Espejo y una clave bloqueada quedan sin comprobar y sin consulta', async t => {
  const webllm = await checkWith(t, { apiType: 'webllm', apiUrl: 'webllm://local', model: 'Qwen-MLC', webllmConfig: { context_window_size: '8192', prefill_chunk_size: 'default' } }, null);
  assert.deepEqual([checkState().status, limit(), webllm.length], ['unchecked', 8192, 0]);

  const mirror = await checkWith(t, { apiType: 'mirror', apiUrl: 'mirror://local', model: 'mirror' }, null);
  assert.deepEqual([checkState().status, limit(), mirror.length], ['unchecked', null, 0]);

  t.mock.method(Profiles, 'loadUnlocked', async () => { throw Object.assign(new Error('cancelled'), { code: 'PASSWORD_REQUIRED' }); });
  const locked = await checkWith(t, OPENAI, null);
  assert.deepEqual([checkState(), locked.length], [{ status: 'unchecked', reason: 'locked', message: '' }, 0]);
});

test('ProfileCheck - recheck vuelve a consultar el perfil activo sin que cambie y publica el nuevo resultado', async t => {
  let serverUp = false;
  const calls = await checkWith(t, OPENAI, () => (serverUp
    ? { success: true, models: [{ id: 'gemma', details: { loaded_context_length: 32768 } }] }
    : { success: false, error: 'fetch failed' }));
  assert.equal(checkState().status, 'error');
  const before = calls.length;
  serverUp = true;
  await ProfileCheck.recheck();
  assert.equal(calls.length, before + 1);
  assert.deepEqual(checkState(), { status: 'ready', reason: '', message: '' });
  assert.equal(limit(), 32768);
});
