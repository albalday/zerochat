const test = require('node:test');
const assert = require('node:assert/strict');

const ChatUIMcp = require('../../js/ui-mcp.js');
const ChatState = require('../../js/state.js');
const ChatMCP = require('../../js/mcp.js');
const ChatToolSecurity = require('../../js/tool-security.js');

/** Estado MCP de la prueba, restaurado al terminar junto con las autorizaciones. */
function setup(t, mcp = {}) {
  const previousState = ChatState.get('mcp');
  ChatState.set('mcp', { ...previousState, tools: [], externalTools: [], externalServers: [], ...mcp });
  t.after(() => {
    ChatState.set('mcp', previousState);
    ChatToolSecurity.manager.clearAllAuthorizations();
    ChatToolSecurity.manager.setGlobalMcpPolicy('ask');
  });
}

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

test('ChatUIMcp - ofrece iniciar los servicios de la sesión anterior y arranca solo los que se conservan', async t => {
  const servers = [
    { id: 'memory', enabled: true, status: 'stopped', displayName: { es: 'Memoria', en: 'Memory' } },
    { id: 'composio', enabled: true, status: 'stopped', displayName: { es: 'Composio' } },
    { id: 'ejemplo', enabled: true, status: 'stopped' },
    { id: 'running', enabled: true, status: 'running' },
    { id: 'disabled', enabled: false, status: 'stopped' }
  ];
  setup(t, { externalServers: servers });
  const started = [];
  const alerts = [];
  let selection = ['memory', 'composio'];
  const confirms = useDialogs(t, () => selection, alerts);
  t.mock.method(ChatMCP.manager, 'startExternalServer', async id => {
    started.push(id);
    if (id === 'composio') throw new Error('connection failed');
  });
  t.mock.method(console, 'error', () => {});
  const stopped = [];
  t.mock.method(ChatMCP.manager, 'stopExternalServer', async id => { stopped.push(id); });

  assert.deepEqual(await ChatUIMcp.offerStoppedExternalServices(servers), selection);
  assert.deepEqual(confirms[0].options.items, [{ id: 'memory', label: 'Memoria' }, { id: 'composio', label: 'Composio' }, { id: 'ejemplo', label: 'ejemplo' }]);
  assert.equal(confirms[0].options.acceptText, 'Iniciar');
  assert.deepEqual(started, ['memory', 'composio']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].options.type, 'error');
  assert.match(alerts[0].message, /Composio/);
  assert.doesNotMatch(alerts[0].message, /Memoria/);

  // Los que no se inician se guardan como no iniciados y no se vuelven a ofrecer.
  assert.deepEqual(stopped, ['ejemplo']);

  ChatState.set('mcp', { externalServers: servers });
  started.length = 0;
  stopped.length = 0;
  selection = null;
  assert.deepEqual(await ChatUIMcp.offerStoppedExternalServices(servers), []);
  assert.deepEqual(started, []);
  assert.deepEqual(stopped, ['memory', 'composio', 'ejemplo']);

  confirms.length = 0;
  assert.deepEqual(await ChatUIMcp.offerStoppedExternalServices([{ id: 'x', enabled: false, status: 'stopped' }]), []);
  assert.equal(confirms.length, 0);
});

test('ChatUIMcp - no reinicia ni marca como detenido un servicio que se inició mientras el diálogo estaba abierto', async t => {
  const servers = [{ id: 'memory', enabled: true, status: 'stopped' }, { id: 'ejemplo', enabled: true, status: 'stopped' }];
  setup(t, { externalServers: servers });
  const started = [];
  useDialogs(t, () => {
    ChatState.set('mcp', current => ({ ...current, externalServers: servers.map(server => ({ ...server, status: 'running' })) }));
    return ['memory'];
  });
  t.mock.method(ChatMCP.manager, 'startExternalServer', async id => { started.push(id); });
  const stop = t.mock.method(ChatMCP.manager, 'stopExternalServer', async () => {});
  await ChatUIMcp.offerStoppedExternalServices(servers);
  assert.deepEqual(started, []);
  assert.equal(stop.mock.callCount(), 0);
});

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

async function flushMicrotasks() {
  await new Promise(resolve => setImmediate(resolve));
}

test('ChatMCP - start: un timeout inicial o de respuesta SSE consulta el estado y acepta running', async t => {
  const manager = ChatMCP.manager;
  {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
    const read = t.mock.method(manager, 'readLiveState', async () => ({ servers: [{ id: 'ejemplo', status: 'running' }] }));
    const waits = [];
    const result = await manager.startExternalServer('ejemplo', (attempt, total) => waits.push([attempt, total]), { remember: true });
    assert.equal(result.servers[0].status, 'running');
    assert.deepEqual(waits, []);
    assert.equal(read.mock.callCount(), 1);
    t.mock.timers.reset();
    request.mock.restore();
    read.mock.restore();
  }
  {
    t.mock.method(manager, 'requestExternalControl', async () => {
      const error = new Error('SSE response timed out');
      error.code = 'MCP_REQUEST_TIMEOUT';
      throw error;
    });
    const read = t.mock.method(manager, 'readLiveState', async () => ({ servers: [{ id: 'ejemplo', status: 'running' }] }));
    assert.equal((await manager.startExternalServer('ejemplo', null, { remember: true })).servers[0].status, 'running');
    assert.equal(read.mock.callCount(), 1);
  }
});

test('ChatMCP - start: si el estado se queda en starting, renuncia tras 10 comprobaciones', async t => {
  const manager = ChatMCP.manager;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let fetchCalls = 0;
  t.mock.method(manager, 'readLiveState', async () => {
    fetchCalls += 1;
    return { servers: [{ id: 'ejemplo', status: 'starting' }] };
  });
  const waits = [];
  const pending = assert.rejects(
    manager.startExternalServer('ejemplo', (attempt, total) => waits.push([attempt, total]), { remember: true }),
    error => error.code === 'EXTERNAL_START_WAIT_TIMEOUT' && error.externalServer.status === 'starting'
  );
  for (let i = 0; i < 10; i += 1) {
    await flushMicrotasks();
    t.mock.timers.tick(15000);
    await flushMicrotasks();
  }
  await pending;
  assert.equal(fetchCalls, 11);
  assert.equal(waits.length, 10);
  assert.deepEqual(waits[0], [1, 10]);
  assert.deepEqual(waits[9], [10, 10]);
});

test('ChatMCP - start: renuncia sin esperar ante estado de error, estados terminales, servicios desconocidos o fallo de consulta', async t => {
  const manager = ChatMCP.manager;
  t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let waits = 0;
  for (const status of ['error', 'available', 'stopped', undefined]) {
    const fetch = t.mock.method(manager, 'readLiveState', async () => ({ servers: status ? [{ id: 'ejemplo', status }] : [] }));
    await assert.rejects(manager.startExternalServer('ejemplo', () => { waits += 1; }, { remember: true }), error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE');
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
  assert.equal(waits, 0);

  t.mock.method(manager, 'readLiveState', async () => { throw new Error('Status unavailable'); });
  await assert.rejects(manager.startExternalServer('ejemplo', null, { remember: true }),
    error => error.code === 'EXTERNAL_START_STATUS_UNAVAILABLE' && error.cause.message === 'Status unavailable');
});

test('ChatMCP - start: un error distinto del timeout se propaga sin comprobar el estado', async t => {
  const manager = ChatMCP.manager;
  t.mock.method(manager, 'requestExternalControl', async () => { throw new Error('Sin conexión'); });
  const fetch = t.mock.method(manager, 'readLiveState', async () => ({ servers: [] }));
  await assert.rejects(() => manager.startExternalServer('ejemplo', null, { remember: true }), /Sin conexión/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('ChatMCP - start: OAuth termina durante una espera sin reenviar el arranque', async t => {
  const manager = ChatMCP.manager;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let checks = 0;
  t.mock.method(manager, 'readLiveState', async () => ({
    servers: [{ id: 'ejemplo', status: ++checks === 3 ? 'running' : checks === 1 ? 'installing' : 'starting' }]
  }));
  const waits = [];
  const pending = manager.startExternalServer('ejemplo', (attempt, total, status) => waits.push([attempt, total, status]), { remember: true });
  await flushMicrotasks();
  assert.deepEqual(waits, [[1, 80, 'installing']]);
  t.mock.timers.tick(14999);
  await flushMicrotasks();
  assert.equal(checks, 1);
  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.deepEqual(waits, [[1, 80, 'installing'], [1, 10, 'starting']]);
  t.mock.timers.tick(15000);
  assert.equal((await pending).servers[0].status, 'running');
  assert.equal(request.mock.callCount(), 1);
});

test('ChatMCP - start: propaga el objeto servidor con oauthUrl durante el arranque', async t => {
  const manager = ChatMCP.manager;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(manager, 'requestExternalControl', async () => { throw makeAbortError(); });
  let checks = 0;
  t.mock.method(manager, 'readLiveState', async () => ({
    servers: [{ id: 'composio', status: ++checks === 2 ? 'running' : 'starting', oauthUrl: checks === 1 ? 'https://example.com/oauth' : null }]
  }));
  const receivedServers = [];
  const pending = manager.startExternalServer('composio', (attempt, total, status, server) => receivedServers.push(server), { remember: true });
  await flushMicrotasks();
  t.mock.timers.tick(15000);
  assert.equal((await pending).servers[0].status, 'running');
  assert.equal(receivedServers.length, 1);
  assert.equal(receivedServers[0].oauthUrl, 'https://example.com/oauth');
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
