const test = require('node:test');
const assert = require('node:assert/strict');
const ChatToolSecurity = require('../../js/tool-security.js');

function createMockClient(initialState = {}) {
  const calls = [];
  const state = {
    version: 8,
    allowAll: false,
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
      if (method === 'zerochat/security/update') {
        if (params.allowAll !== undefined) state.allowAll = Boolean(params.allowAll);
        if (params.directoryRules !== undefined) state.directoryRules = [...params.directoryRules];
        if (params.addDirectoryRules !== undefined) state.directoryRules = [...new Set([...state.directoryRules, ...params.addDirectoryRules])];
        if (params.tools !== undefined) {
          state.tools = { ...state.tools };
          for (const [id, entry] of Object.entries(params.tools)) {
            if (entry === null) delete state.tools[id];
            else state.tools[id] = { ...entry, scope: 'permanent' };
          }
        }
        if (params.commandPatterns !== undefined) state.commandPatterns = { global: [], project: [], ...params.commandPatterns, session: state.commandPatterns?.session || [] };
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
        return { authorized: true, challengeId: params.challengeId, policies: { ...state } };
      }
      return {};
    }
  };
  return client;
}

test('ChatToolSecurity - sin servidor conectado los setters y retos lanzan error explícito', async () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();

  const calls = [
    () => manager.setToolPolicy('tool1', 'allow'),
    () => manager.revokeToolPolicy('tool1'),
    () => manager.setServerPolicy('srv1', 'allow'),
    () => manager.revokeServerPolicy('srv1'),
    () => manager.setAllowAll(true),
    () => manager.setDirectoryRules(['R:/workspace/**']),
    () => manager.addDirectoryRule('R:/workspace/**'),
    () => manager.setCommandPatterns({ global: ['git *'] }),
    () => manager.clearAllAuthorizations(),
    () => manager.authorizeChallenge('ch-1', 'allow_once')
  ];
  for (const call of calls) await assert.rejects(call, /Local server connection is required/);
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

  // 5. allowAll del proyecto y directoryRules
  await manager.setAllowAll(true);
  assert.equal(manager.getAllowAll(), true);
  await manager.setAllowAll(false);
  assert.equal(manager.getAllowAll(), false);

  await manager.setDirectoryRules(['R:/proj/**']);
  assert.deepEqual(manager.getDirectoryRules(), ['R:/proj/**']);

  await manager.addDirectoryRule('W:/out/**');
  assert.deepEqual(mockClient.calls[mockClient.calls.length - 1].params, { addDirectoryRules: ['W:/out/**'] });
  assert.deepEqual(manager.getDirectoryRules(), ['R:/proj/**', 'W:/out/**']);

  // 6. clearAllAuthorizations envía parches con null y limpia patrones globales y del proyecto actual
  await manager.clearAllAuthorizations();
  const clearCall = mockClient.calls[mockClient.calls.length - 1];
  assert.equal(clearCall.params.tools.tool2, null);
  assert.deepEqual(clearCall.params.commandPatterns, { global: [], project: [] });
  assert.equal(manager.listAuthorizedTools().length, 0);
  assert.equal(manager.listAuthorizedServers().length, 0);
});

test('ChatToolSecurity - busca por id exacto/propio y aísla listeners que fallan', (t) => {
  t.mock.method(console, 'warn', () => {});
  const manager = new ChatToolSecurity.ToolSecurityManager();
  let notified = false;
  manager.subscribe(() => { throw new Error('broken listener'); });
  manager.subscribe(() => { notified = true; });

  manager.applyPolicies({ tools: { MyTool: { policy: 'allow' } }, servers: { PlayWright: { policy: 'allow' } } });
  assert.equal(notified, true);
  assert.equal(console.warn.mock.callCount(), 1);
  assert.equal(manager.getToolPolicy('MyTool'), 'allow');
  assert.equal(manager.getToolPolicy('mytool'), null);
  assert.equal(manager.getToolPolicy('__proto__'), null);
  assert.equal(manager.getServerPolicy('playwright'), null);
});

test('ChatToolSecurity - authorizeChallenge y setCommandPatterns adoptan políticas sin peticiones extra ni patrones de sesión', async () => {
  const authClient = createMockClient({ tools: { initial_tool: { policy: 'allow' } } });
  const authManager = new ChatToolSecurity.ToolSecurityManager();
  authManager.setMcpClient(authClient);
  authClient.calls.length = 0;
  const res = await authManager.authorizeChallenge('ch-123', 'allow_once');
  assert.equal(res.authorized, true);
  assert.equal(authManager.getToolPolicy('initial_tool'), 'allow');
  assert.deepEqual(authClient.calls.map(c => c.method), ['zerochat/security/authorize']);
  assert.equal(authClient.calls[0].params.challengeId, 'ch-123');

  const patClient = createMockClient({ commandPatterns: { global: ['git *'], project: [], session: ['make *'] } });
  const patManager = new ChatToolSecurity.ToolSecurityManager();
  patManager.setMcpClient(patClient);
  patManager.applyPolicies(patClient.state);
  assert.deepEqual(patManager.getCommandPatterns().session, ['make *']);

  await patManager.setCommandPatterns({ global: ['git status *'], project: ['npm test *'] });
  assert.deepEqual(patClient.calls.at(-1).params, { commandPatterns: { global: ['git status *'], project: ['npm test *'] } });
  assert.deepEqual(patManager.getCommandPatterns(), { global: ['git status *'], project: ['npm test *'], session: ['make *'] });
});
