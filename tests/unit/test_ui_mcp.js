const test = require('node:test');
const assert = require('node:assert/strict');

const ChatUIMcp = require('../../js/ui-mcp.js');
const ChatState = require('../../js/state.js');
const ChatMCP = require('../../js/mcp.js');
const ChatToolSecurity = require('../../js/tool-security.js');
const ChatMcpStatus = require('../../js/mcp-status.js');

/** Estado MCP de la prueba, restaurado al terminar junto con las autorizaciones. */
function setup(t, mcp = {}) {
  const previousState = ChatState.get('mcp');
  ChatState.set('mcp', { ...previousState, tools: [], externalTools: [], externalServers: [], ...mcp });
  t.after(() => {
    ChatState.set('mcp', previousState);
    ChatToolSecurity.manager.applyPolicies({ globalMcpPolicy: 'ask', tools: {}, servers: {}, directoryRules: [] });
  });
}

test('ChatMcpStatus - cada estado de servicio del backend (tests/fixtures/mcp/contract.json) se puede arrancar o está activo, nunca ambos', () => {
  const { serviceStatuses } = require('../fixtures/mcp/contract.json');
  for (const status of serviceStatuses) {
    assert.notEqual(ChatMcpStatus.isActive(status), ChatMcpStatus.canStart(status), status);
  }
  assert.deepEqual(serviceStatuses.filter(ChatMcpStatus.isRunning), ['running']);
});

test('ChatUIMcp - el campo help de service.json solo admite URL HTTP o rutas relativas seguras', () => {
  assert.deepEqual(ChatUIMcp.getServiceHelp({ url: 'https://example.com/help', label: { es: 'Ayuda' } }, 'es'), { url: 'https://example.com/help', label: 'Ayuda' });
  assert.deepEqual(ChatUIMcp.getServiceHelp({ url: 'help/mcp.html', label: { en: 'Help' } }, 'es'), { url: 'help/mcp.html', label: 'Help' });
  assert.equal(ChatUIMcp.getServiceHelp({ url: 'javascript:alert(1)', label: 'Unsafe' }, 'es'), null);
  assert.equal(ChatUIMcp.getServiceHelp({ url: '//example.com', label: 'Unsafe' }, 'es'), null);
});

function useDialogs(t, confirmResult, alerts = []) {
  const previous = globalThis.ChatDialogs;
  const confirms = [];
  globalThis.ChatDialogs = {
    confirm: async (message, options) => { confirms.push({ message, options }); return typeof confirmResult === 'function' ? confirmResult() : confirmResult; },
    alert: async (message, options) => { alerts.push({ message, options }); }
  };
  t.after(() => { globalThis.ChatDialogs = previous; });
  return confirms;
}

test('ChatUIMcp - restaura servicios activos en silencio, omite los ya activos y avisa solo si alguno falla', async t => {
  const servers = [
    { id: 'memory', enabled: true, status: 'stopped', displayName: { es: 'Memoria', en: 'Memory' } },
    { id: 'composio', enabled: true, status: 'stopped', displayName: { es: 'Composio' } },
    { id: 'running', enabled: true, status: 'running' },
    { id: 'disabled', enabled: false, status: 'stopped' }
  ];
  setup(t, { status: 'connected', externalServers: servers });
  const started = [];
  const alerts = [];
  const confirms = useDialogs(t, null, alerts);
  t.mock.method(ChatMCP.manager, 'startExternalServer', async id => {
    started.push(id);
    if (id === 'composio') throw new Error('connection failed');
  });
  t.mock.method(console, 'error', () => {});
  const stop = t.mock.method(ChatMCP.manager, 'stopExternalServer', async () => {});

  assert.deepEqual(await ChatUIMcp.restoreEnabledExternalServices(servers), ['memory']);
  assert.equal(confirms.length, 0);
  assert.equal(stop.mock.callCount(), 0);
  assert.deepEqual(started, ['memory', 'composio']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].options.type, 'error');
  assert.match(alerts[0].message, /Composio/);
  assert.doesNotMatch(alerts[0].message, /Memoria/);

  alerts.length = 0;
  started.length = 0;
  const okServers = [{ id: 'memory', enabled: true, status: 'stopped', displayName: { es: 'Memoria' } }];
  setup(t, { status: 'connected', externalServers: okServers });
  assert.deepEqual(await ChatUIMcp.restoreEnabledExternalServices(okServers), ['memory']);
  assert.equal(alerts.length, 0);
  assert.deepEqual(await ChatUIMcp.restoreEnabledExternalServices([{ id: 'x', enabled: false, status: 'stopped' }]), []);

  // No vuelve a arrancar uno que ya pasó a activo en el estado vivo antes de llegar su turno.
  started.length = 0;
  setup(t, { status: 'connected', externalServers: [{ id: 'memory', enabled: true, status: 'running' }] });
  await ChatUIMcp.restoreEnabledExternalServices([{ id: 'memory', enabled: true, status: 'stopped' }]);
  assert.deepEqual(started, []);
});

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function flushMicrotasks() {
  await new Promise(resolve => setImmediate(resolve));
}

test('ChatMCP - start: resuelve timeouts a estado vivo, propaga errores inmediatos y rechaza estados terminales', async t => {
  const manager = ChatMCP.manager;

  for (const errFactory of [() => makeAbortError(), () => Object.assign(new Error('SSE response timed out'), { code: 'MCP_REQUEST_TIMEOUT' })]) {
    const req = t.mock.method(manager, 'requestExternalControl', async () => { throw errFactory(); });
    const read = t.mock.method(manager, 'readLiveState', async () => ({ servers: [{ id: 'ejemplo', status: 'running' }] }));
    const waits = [];
    const res = await manager.startExternalServer('ejemplo', (a, tot) => waits.push([a, tot]), { remember: true });
    assert.equal(res.servers[0].status, 'running');
    assert.deepEqual(waits, []);
    assert.equal(read.mock.callCount(), 1);
    req.mock.restore();
    read.mock.restore();
  }

  // Estados terminales o fallo al consultar estado rechazan sin esperar.
  const reqAbort = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let waits = 0;
  for (const status of ['error', 'available', 'stopped', undefined]) {
    const fetch = t.mock.method(manager, 'readLiveState', async () => ({ servers: status ? [{ id: 'ejemplo', status }] : [] }));
    await assert.rejects(manager.startExternalServer('ejemplo', () => { waits += 1; }, { remember: true }), error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE');
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
  assert.equal(waits, 0);

  const fetchFail = t.mock.method(manager, 'readLiveState', async () => { throw new Error('Status unavailable'); });
  await assert.rejects(manager.startExternalServer('ejemplo', null, { remember: true }),
    error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE' && error.cause.message === 'Status unavailable');
  reqAbort.mock.restore();
  fetchFail.mock.restore();

  // Error distinto de timeout se propaga sin consultar estado.
  t.mock.method(manager, 'requestExternalControl', async () => { throw new Error('Sin conexión'); });
  const fetchSpy = t.mock.method(manager, 'readLiveState', async () => ({ servers: [] }));
  await assert.rejects(() => manager.startExternalServer('ejemplo', null, { remember: true }), /Sin conexión/);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('ChatMCP - start: espera en installing/starting con oauthUrl hasta 10 intentos antes de rendirse', async t => {
  const manager = ChatMCP.manager;

  // 1. Límite de 10 comprobaciones cuando permanece en starting
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req1 = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let fetchCalls = 0;
  const read1 = t.mock.method(manager, 'readLiveState', async () => {
    fetchCalls += 1;
    return { servers: [{ id: 'ejemplo', status: 'starting' }] };
  });
  const waits1 = [];
  const pending1 = assert.rejects(
    manager.startExternalServer('ejemplo', (attempt, total) => waits1.push([attempt, total]), { remember: true }),
    error => error.code === 'EXTERNAL_START_WAIT_TIMEOUT' && error.externalServer.status === 'starting'
  );
  for (let i = 0; i < 10; i += 1) {
    await flushMicrotasks();
    t.mock.timers.tick(15000);
    await flushMicrotasks();
  }
  await pending1;
  assert.equal(fetchCalls, 11);
  assert.deepEqual([waits1[0], waits1[9]], [[1, 10], [10, 10]]);
  t.mock.timers.reset();
  req1.mock.restore();
  read1.mock.restore();

  // 2. OAuth termina durante la espera sin reenviar arranque y propaga oauthUrl
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req2 = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let checks = 0;
  t.mock.method(manager, 'readLiveState', async () => ({
    servers: [{
      id: 'composio',
      status: ++checks === 3 ? 'running' : checks === 1 ? 'installing' : 'starting',
      oauthUrl: checks === 2 ? 'https://example.com/oauth' : null
    }]
  }));
  const waits2 = [];
  const receivedServers = [];
  const pending2 = manager.startExternalServer('composio', (a, tot, st, srv) => {
    waits2.push([a, tot, st]);
    receivedServers.push(srv);
  }, { remember: true });
  await flushMicrotasks();
  assert.deepEqual(waits2, [[1, 80, 'installing']]);
  t.mock.timers.tick(15000);
  await flushMicrotasks();
  assert.deepEqual(waits2, [[1, 80, 'installing'], [1, 80, 'starting']]);
  assert.equal(receivedServers[1].oauthUrl, 'https://example.com/oauth');
  t.mock.timers.tick(15000);
  assert.equal((await pending2).servers[0].status, 'running');
  assert.equal(req2.mock.callCount(), 1);
});


test('ChatMCP - runExternalServerAction: el plazo de espera agotado deja el servicio en starting con el aviso de OAuth', async t => {
  setup(t, { externalServers: [{ id: 'ejemplo', status: 'stopped' }] });
  const manager = ChatMCP.manager;
  t.mock.method(manager, 'startExternalServer', async (id, onWait) => {
    onWait(3, 10);
    assert.deepEqual(ChatState.get('mcp').externalServers[0].startWait, { attempt: 3, total: 10 });
    throw Object.assign(new Error('Wait expired'), { code: 'EXTERNAL_START_WAIT_TIMEOUT', externalServer: { id: 'ejemplo', status: 'starting' } });
  });
  assert.equal(await manager.runExternalServerAction('ejemplo', 'start'), false);
  const [server] = ChatState.get('mcp').externalServers;
  assert.deepEqual({ status: server.status, startWait: server.startWait }, { status: 'starting', startWait: null });
  assert.match(server.error, /OAuth/);
});
