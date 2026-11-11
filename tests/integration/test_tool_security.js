const test = require('node:test');
const assert = require('node:assert');
const ChatToolSecurity = require('../../js/tool-security.js');

// Cada caso parte de un almacenamiento vacío; el gestor real persiste en él.
test.beforeEach(() => localStorage.clear());

function createManager({ sessionToken, startupDirectory } = {}) {
  const manager = new ChatToolSecurity.ToolSecurityManager();
  if (sessionToken) manager.setSessionToken(sessionToken);
  if (startupDirectory) manager.setStartupDirectory(startupDirectory);
  return manager;
}

test('ChatToolSecurity - Revocación y reseteo de permisos guardados', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();

  manager.setToolPolicy('tool1', 'allow');
  manager.setToolPolicy('tool2', 'allow');
  assert.equal(manager.listAuthorizedTools().length, 2);

  // Revocar una
  const revoked = manager.revokeToolPolicy('tool1');
  assert.equal(revoked, true);
  assert.equal(manager.listAuthorizedTools().length, 1);
  assert.equal(manager.getToolPolicy('tool1'), null);

  // Restablecer todas
  manager.clearAllAuthorizations();
  assert.equal(manager.listAuthorizedTools().length, 0);
});

test('ChatToolSecurity - Persistencia y recarga entre instancias', () => {
  const manager1 = new ChatToolSecurity.ToolSecurityManager();
  manager1.setGlobalMcpPolicy('allow_all');
  manager1.setToolPolicy('saved_tool', 'allow', { serverName: 'mcp-proxy', originalName: 'saved_tool' });
  manager1.setDirectoryRules(['RW:./workspace/**']);

  // Segunda instancia leyendo la misma clave
  const manager2 = new ChatToolSecurity.ToolSecurityManager();
  assert.equal(manager2.getGlobalMcpPolicy(), 'allow_all');
  assert.equal(manager2.getToolPolicy('saved_tool'), 'allow');
  assert.equal(manager2.listAuthorizedTools().length, 1);
  assert.deepEqual(manager2.getDirectoryRules(), ['RW:workspace/**']);
});

test('ChatToolSecurity - Sesión acotada por token y preservación de autorizaciones permanentes', () => {
  const manager = createManager({ sessionToken: 'token_active_123' });

  // 1. Guardar una regla permanente y otra de sesión
  manager.setToolPolicy('perm_tool', 'allow', { scope: 'permanent' });
  manager.setToolPolicy('session_tool', 'allow', { scope: 'session' });
  manager.setServerPolicy('server_session', 'allow', { scope: 'session' });
  manager.setServerPolicy('server_perm', 'allow', { scope: 'permanent' });

  assert.equal(manager.getToolPolicy('perm_tool'), 'allow');
  assert.equal(manager.getToolPolicy('session_tool'), 'allow');
  assert.equal(manager.getServerPolicy('server_session'), 'allow');
  assert.equal(manager.getServerPolicy('server_perm'), 'allow');

  // 2. Si cambia el token de sesión, expiran las de sesión pero se preservan las permanentes
  manager.setSessionToken('token_new_456');

  assert.equal(manager.getToolPolicy('session_tool'), null, 'La autorización de sesión expira');
  assert.equal(manager.getServerPolicy('server_session'), null, 'El servidor de sesión expira');
  assert.equal(manager.getToolPolicy('perm_tool'), 'allow', 'La autorización permanente se conserva');
  assert.equal(manager.getServerPolicy('server_perm'), 'allow', 'El servidor permanente se conserva');

  // 3. Crear una nueva instancia con el mismo storageKey: carga las permanentes del almacenamiento
  const manager2 = createManager({ sessionToken: 'token_fresh_789' });
  assert.equal(manager2.getToolPolicy('perm_tool'), 'allow');
  assert.equal(manager2.getServerPolicy('server_perm'), 'allow');
  assert.equal(manager2.getToolPolicy('session_tool'), null);
});

test('ChatToolSecurity - T02: una política guardada con otra versión se descarta entera', () => {
  const Storage = require('../../js/storage.js');
  const storageKey = ChatToolSecurity.STORAGE_KEY;
  Storage.setStorageItem(storageKey, JSON.stringify({
    version: 3,
    globalMcpPolicy: 'ask',
    tools: {
      run_command: {
        policy: 'allow',
        originalName: 'run_command',
        constraints: { command: { allowedPrefixes: ['git', 'cd'], allowChaining: true, allowPipes: true } }
      }
    },
    servers: {},
    directoryRules: ['R:/home/user/proj']
  }));

  try {
    const manager = createManager({ startupDirectory: '/home/user/proj' });
    assert.equal(manager.getToolConstraints('run_command'), null);

    // Una vez guardadas en la versión actual, las opciones explícitas se respetan al recargar
    manager.setToolPolicy('run_command', 'allow', {
      constraints: { command: { allowedPrefixes: ['git'], allowChaining: false, allowPipes: true } }
    });
    assert.equal(JSON.parse(Storage.getStorageItem(storageKey)).version, 4);
    const reloaded = createManager({ startupDirectory: '/home/user/proj' });
    assert.equal(reloaded.getToolConstraints('run_command').command.allowPipes, true);
  } finally {
    localStorage.removeItem(storageKey);
  }
});

test('ToolSecurityManager - un listener que falla no impide notificar al resto y queda registrado', (t) => {
  t.mock.method(console, 'warn', () => {});
  const manager = new ChatToolSecurity.ToolSecurityManager();
  let notified = false;
  manager.subscribe(() => { throw new Error('listener broken'); });
  manager.subscribe(() => { notified = true; });

  manager.notifyListeners();

  assert.strictEqual(notified, true);
  assert.strictEqual(console.warn.mock.callCount(), 1);
});

test('ChatToolSecurity - adaptador cliente: syncFromBackend y syncToBackend sincronizan con el backend', async () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();
  const calls = [];
  const mockClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'zerochat/security/get') {
        return {
          policies: {
            globalMcpPolicy: 'allow_all',
            directoryRules: ['R:/custom/path'],
            tools: {
              read_file: { policy: 'allow', scope: 'permanent' }
            },
            servers: {
              srv1: { policy: 'allow', scope: 'permanent' }
            }
          }
        };
      }
      if (method === 'zerochat/security/update') {
        return { success: true };
      }
      return {};
    }
  };

  manager.setMcpClient(mockClient);
  await manager.syncFromBackend();

  assert.equal(manager.getGlobalMcpPolicy(), 'allow_all');
  assert.equal(manager.getToolPolicy('read_file'), 'allow');
  assert.equal(manager.getServerPolicy('srv1'), 'allow');
  assert.deepEqual(manager.getDirectoryRules(), ['R:/custom/path']);

  // Modificar una política dispara syncToBackend hacia el cliente
  calls.length = 0;
  manager.setToolPolicy('write_file', 'allow');
  await new Promise(r => setTimeout(r, 10));

  const updateCall = calls.find(c => c.method === 'zerochat/security/update');
  assert.ok(updateCall, 'Debe haber enviado zerochat/security/update');
  assert.equal(updateCall.params.tools.write_file.policy, 'allow');
});

test('ChatToolSecurity - adaptador cliente: authorizeChallenge delega en el backend y refresca políticas', async () => {
  const manager = new ChatToolSecurity.ToolSecurityManager();
  const calls = [];
  const mockClient = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'zerochat/security/authorize') {
        return { authorized: true, challengeId: params.challengeId };
      }
      if (method === 'zerochat/security/get') {
        return {
          policies: {
            globalMcpPolicy: 'ask',
            directoryRules: ['R:/workspace', 'RW:/workspace'],
            tools: {},
            servers: {}
          }
        };
      }
      return {};
    }
  };

  // Sin cliente configurado falla explícitamente
  await assert.rejects(
    async () => manager.authorizeChallenge('ch-1', 'allow_once'),
    /Local server connection is required/
  );

  manager.setMcpClient(mockClient);
  const res = await manager.authorizeChallenge('ch-1', 'allow_always', {
    constraints: { command: { allowedPrefixes: ['git'] } },
    directoryRule: 'RW:/workspace'
  });

  assert.equal(res.authorized, true);
  assert.equal(res.challengeId, 'ch-1');
  const authCall = calls.find(c => c.method === 'zerochat/security/authorize');
  assert.ok(authCall);
  assert.equal(authCall.params.decision, 'allow_always');
  assert.equal(authCall.params.directoryRule, 'RW:/workspace');

  // Comprueba que refrescó las políticas tras allow_always
  const getCall = calls.find(c => c.method === 'zerochat/security/get');
  assert.ok(getCall, 'Debe sincronizar desde el backend tras conceder un permiso permanente');
});
