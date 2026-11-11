const test = require('node:test');
const assert = require('node:assert/strict');
const ChatToolSecurity = require('../../js/tool-security.js');

function createMockClient(initialState = {}) {
  const calls = [];
  const state = {
    version: 5,
    globalMcpPolicy: 'ask',
    defaultDirectoryRule: 'RW:/workspace/**',
    directoryRules: [],
    tools: {},
    servers: {},
    ...initialState
  };

  const client = {
    calls,
    state,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'zerochat/security/get') {
        return { policies: { ...state } };
      }
      if (method === 'zerochat/security/update') {
        if (params.globalMcpPolicy !== undefined) state.globalMcpPolicy = params.globalMcpPolicy;
        if (params.directoryRules !== undefined) state.directoryRules = [...params.directoryRules];
        if (params.tools !== undefined) {
          state.tools = { ...state.tools };
          for (const [id, entry] of Object.entries(params.tools)) {
            if (entry === null) delete state.tools[id];
            else state.tools[id] = { ...entry, scope: 'permanent' };
          }
        }
        if (params.servers !== undefined) {
          state.servers = { ...state.servers };
          for (const [id, entry] of Object.entries(params.servers)) {
            if (entry === null) delete state.servers[id];
            else state.servers[id] = { ...entry, scope: 'permanent' };
          }
        }
        return { policies: { ...state } };
      }
      if (method === 'zerochat/security/authorize') {
        return { authorized: true, challengeId: params.challengeId };
      }
      return {};
    }
  };
  return client;
}

test('ChatToolSecurity - sin servidor conectado los setters y retos lanzan error explícito', async () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();

  await assert.rejects(async () => manager.setToolPolicy('tool1', 'allow'), /Local server connection is required/);
  await assert.rejects(async () => manager.revokeToolPolicy('tool1'), /Local server connection is required/);
  await assert.rejects(async () => manager.setServerPolicy('srv1', 'allow'), /Local server connection is required/);
  await assert.rejects(async () => manager.revokeServerPolicy('srv1'), /Local server connection is required/);
  await assert.rejects(async () => manager.setGlobalMcpPolicy('allow_all'), /Local server connection is required/);
  await assert.rejects(async () => manager.setDirectoryRules(['R:/workspace/**']), /Local server connection is required/);
  await assert.rejects(async () => manager.addDirectoryRule('R:/workspace/**'), /Local server connection is required/);
  await assert.rejects(async () => manager.clearAllAuthorizations(), /Local server connection is required/);
  await assert.rejects(async () => manager.authorizeChallenge('ch-1', 'allow_once'), /Local server connection is required/);
});

test('ChatToolSecurity - mutaciones envían parches parciales y adoptan la respuesta del backend', async () => {
  const mockClient = createMockClient();
  const manager = new ChatToolSecurity.ToolSecurityManager();
  manager.setMcpClient(mockClient);

  // 1. setToolPolicy envía parche de herramienta
  await manager.setToolPolicy('tool1', 'allow', { serverName: 'srv1', originalName: 'tool1' });
  assert.equal(mockClient.calls.length, 1);
  assert.equal(mockClient.calls[0].method, 'zerochat/security/update');
  assert.deepEqual(mockClient.calls[0].params, {
    tools: {
      tool1: {
        policy: 'allow',
        constraints: null,
        serverName: 'srv1',
        originalName: 'tool1'
      }
    }
  });
  assert.equal(manager.getToolPolicy('tool1'), 'allow');

  // 2. Añadir tool2 no borra tool1 (parche parcial)
  await manager.setToolPolicy('tool2', 'deny');
  assert.equal(manager.getToolPolicy('tool1'), 'allow');
  assert.equal(manager.getToolPolicy('tool2'), 'deny');

  // 3. revokeToolPolicy envía null para la herramienta
  await manager.revokeToolPolicy('tool1');
  const revokeCall = mockClient.calls[mockClient.calls.length - 1];
  assert.deepEqual(revokeCall.params, { tools: { tool1: null } });
  assert.equal(manager.getToolPolicy('tool1'), null);
  assert.equal(manager.getToolPolicy('tool2'), 'deny');

  // 4. Servidores: setServerPolicy y revokeServerPolicy con null
  await manager.setServerPolicy('srv1', 'allow', { serverName: 'srv1' });
  assert.equal(manager.getServerPolicy('srv1'), 'allow');

  await manager.revokeServerPolicy('srv1');
  const revokeSrvCall = mockClient.calls[mockClient.calls.length - 1];
  assert.deepEqual(revokeSrvCall.params, { servers: { srv1: null } });
  assert.equal(manager.getServerPolicy('srv1'), null);

  // 5. Global policy y directoryRules
  await manager.setGlobalMcpPolicy('workspace_trust');
  assert.equal(manager.getGlobalMcpPolicy(), 'workspace_trust');

  await manager.setDirectoryRules(['R:/proj/**']);
  assert.deepEqual(manager.getDirectoryRules(), ['R:/proj/**']);

  await manager.addDirectoryRule('W:/out/**');
  assert.deepEqual(manager.getDirectoryRules(), ['R:/proj/**', 'W:/out/**']);

  // 6. clearAllAuthorizations envía parches con null
  await manager.clearAllAuthorizations();
  const clearCall = mockClient.calls[mockClient.calls.length - 1];
  assert.equal(clearCall.params.tools.tool2, null);
  assert.equal(manager.listAuthorizedTools().length, 0);
  assert.equal(manager.listAuthorizedServers().length, 0);
});

test('ChatToolSecurity - findToolEntry y findServerEntry son búsquedas exactas', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();
  manager.applyPolicies({
    tools: {
      MyTool: { policy: 'allow', originalName: 'MyTool' }
    },
    servers: {
      PlayWright: { policy: 'allow', serverName: 'PlayWright' }
    }
  });

  // Búsqueda exacta
  assert.notEqual(manager.findToolEntry('MyTool'), null);
  assert.equal(manager.findToolEntry('mytool'), null);
  assert.notEqual(manager.findServerEntry('PlayWright'), null);
  assert.equal(manager.findServerEntry('playwright'), null);
});

test('ChatToolSecurity - authorizeChallenge ejecuta y siempre refresca políticas', async () => {
  const mockClient = createMockClient({
    tools: { initial_tool: { policy: 'allow' } }
  });
  const manager = new ChatToolSecurity.ToolSecurityManager();
  manager.setMcpClient(mockClient);

  mockClient.calls.length = 0;
  const res = await manager.authorizeChallenge('ch-123', 'allow_once');
  assert.equal(res.authorized, true);

  const authCall = mockClient.calls.find(c => c.method === 'zerochat/security/authorize');
  assert.ok(authCall, 'Debe haber llamado a security/authorize');
  assert.equal(authCall.params.challengeId, 'ch-123');

  const getCall = mockClient.calls.find(c => c.method === 'zerochat/security/get');
  assert.ok(getCall, 'Debe haber refrescado políticas tras autorizar');
});

test('ChatToolSecurity - cambio de sessionToken limpia autorizaciones de sesión y preserva permanentes', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();
  manager.setSessionToken('token-1');

  manager.applyPolicies({
    tools: {
      perm_tool: { policy: 'allow', scope: 'permanent' },
      sess_tool: { policy: 'allow', scope: 'session' }
    },
    servers: {
      perm_srv: { policy: 'allow', scope: 'permanent' },
      sess_srv: { policy: 'allow', scope: 'session' }
    }
  });

  assert.equal(manager.getToolPolicy('perm_tool'), 'allow');
  assert.equal(manager.getToolPolicy('sess_tool'), 'allow');
  assert.equal(manager.getServerPolicy('perm_srv'), 'allow');
  assert.equal(manager.getServerPolicy('sess_srv'), 'allow');

  // Cambio de token
  manager.setSessionToken('token-2');

  assert.equal(manager.getToolPolicy('perm_tool'), 'allow');
  assert.equal(manager.getToolPolicy('sess_tool'), null);
  assert.equal(manager.getServerPolicy('perm_srv'), 'allow');
  assert.equal(manager.getServerPolicy('sess_srv'), null);
});

test('ChatToolSecurity - un listener que falla no detiene la notificación a los demás', (t) => {
  t.mock.method(console, 'warn', () => {});
  const manager = new ChatToolSecurity.ToolSecurityManager();
  let notified = false;
  manager.subscribe(() => { throw new Error('broken listener'); });
  manager.subscribe(() => { notified = true; });

  manager.notifyListeners();

  assert.equal(notified, true);
  assert.equal(console.warn.mock.callCount(), 1);
});
