const test = require('node:test');
const assert = require('node:assert');
const ChatToolSecurity = require('../js/tool-security.js');

test('ChatToolSecurity - Inicialización y valores por defecto', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_default' });
  assert.equal(manager.getGlobalMcpPolicy(), 'ask');
  assert.equal(manager.listAuthorizedTools().length, 0);
});

test('ChatToolSecurity - Herramientas integradas (Built-in) se autorizan directamente', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_builtin' });
  
  const evalSearch = manager.evaluateAuthorization('search_web', { query: 'test' });
  assert.equal(evalSearch.requiresApproval, false);
  assert.equal(evalSearch.status, 'allow');
  assert.equal(evalSearch.reason, 'builtin_tool');

  const evalJs = manager.evaluateAuthorization({ name: 'execute_javascript', category: 'sandbox' }, { code: '1+1' });
  assert.equal(evalJs.requiresApproval, false);
  assert.equal(evalJs.status, 'allow');
});

test('ChatToolSecurity - Herramientas MCP requieren confirmación por defecto', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_mcp_default' });

  const evalMcp = manager.evaluateAuthorization({
    id: 'mcp__proxy__execute_command',
    name: 'mcp__proxy__execute_command',
    category: 'mcp',
    metadata: { mcpServerName: 'mcp-proxy', originalName: 'execute_command' }
  }, { command: 'ls -la' });

  assert.equal(evalMcp.requiresApproval, true);
  assert.equal(evalMcp.status, 'ask');
  assert.equal(evalMcp.serverName, 'mcp-proxy');
  assert.equal(evalMcp.originalName, 'execute_command');
});

test('ChatToolSecurity - Modo global allow_all autoriza todas las herramientas MCP', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_allow_all' });
  manager.setGlobalMcpPolicy('allow_all');
  assert.equal(manager.getGlobalMcpPolicy(), 'allow_all');

  const evalMcp = manager.evaluateAuthorization({
    id: 'mcp__proxy__read_file',
    name: 'mcp__proxy__read_file',
    category: 'mcp'
  });

  assert.equal(evalMcp.requiresApproval, false);
  assert.equal(evalMcp.status, 'allow');
  assert.equal(evalMcp.reason, 'mcp_global_allow_all');

  // Rechazo de política global inválida
  assert.throws(() => manager.setGlobalMcpPolicy('invalid_policy'), /Política global no válida/);
});

test('ChatToolSecurity - Autorización granular de grano fino por herramienta', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_granular' });

  const toolA = { id: 'mcp__proxy__read_file', name: 'mcp__proxy__read_file', category: 'mcp' };
  const toolB = { id: 'mcp__proxy__execute_command', name: 'mcp__proxy__execute_command', category: 'mcp' };

  // 1. Ambas requieren confirmación inicialmente
  assert.equal(manager.evaluateAuthorization(toolA).requiresApproval, true);
  assert.equal(manager.evaluateAuthorization(toolB).requiresApproval, true);

  // 2. Autorizar exclusivamente toolA
  manager.setToolPolicy(toolA.id, 'allow', { serverName: 'mcp-proxy', originalName: 'read_file' });

  // 3. toolA queda permitida sin confirmación
  const evalA = manager.evaluateAuthorization(toolA);
  assert.equal(evalA.requiresApproval, false);
  assert.equal(evalA.status, 'allow');
  assert.equal(evalA.reason, 'granular_allow_rule');

  // 4. toolB sigue requiriendo confirmación (aislamiento de grano fino)
  const evalB = manager.evaluateAuthorization(toolB);
  assert.equal(evalB.requiresApproval, true);
  assert.equal(evalB.status, 'ask');

  // 5. Establecer regla deny en toolB
  manager.setToolPolicy(toolB.id, 'deny', { serverName: 'mcp-proxy', originalName: 'execute_command' });
  const evalBDeny = manager.evaluateAuthorization(toolB);
  assert.equal(evalBDeny.requiresApproval, false);
  assert.equal(evalBDeny.status, 'deny');
});

test('ChatToolSecurity - Revocación y reseteo de permisos guardados', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_revoke' });

  manager.setToolPolicy('mcp__proxy__tool1', 'allow');
  manager.setToolPolicy('mcp__proxy__tool2', 'allow');
  assert.equal(manager.listAuthorizedTools().length, 2);

  // Revocar una
  const revoked = manager.revokeToolPolicy('mcp__proxy__tool1');
  assert.equal(revoked, true);
  assert.equal(manager.listAuthorizedTools().length, 1);
  assert.equal(manager.getToolPolicy('mcp__proxy__tool1'), null);

  // Restablecer todas
  manager.clearAllAuthorizations();
  assert.equal(manager.listAuthorizedTools().length, 0);
});

test('ChatToolSecurity - Persistencia y recarga entre instancias', () => {
  const mockStorage = {};
  const previousLocalStorage = global.localStorage;
  global.localStorage = {
    getItem: (k) => mockStorage[k] || null,
    setItem: (k, v) => { mockStorage[k] = String(v); },
    removeItem: (k) => { delete mockStorage[k]; }
  };

  try {
    const manager1 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist' });
    manager1.setGlobalMcpPolicy('allow_all');
    manager1.setToolPolicy('mcp__proxy__saved_tool', 'allow', { serverName: 'mcp-proxy', originalName: 'saved_tool' });

    // Segunda instancia leyendo la misma clave
    const manager2 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist' });
    assert.equal(manager2.getGlobalMcpPolicy(), 'allow_all');
    assert.equal(manager2.getToolPolicy('mcp__proxy__saved_tool'), 'allow');
    assert.equal(manager2.listAuthorizedTools().length, 1);
  } finally {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
});

test('ChatToolSecurity - Restricciones de comandos: allowlist, encadenamiento y patrones denegados', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_cmd_constraints' });

  const tool = {
    id: 'mcp__srv__cmd',
    name: 'mcp__srv__cmd',
    category: 'mcp'
  };

  // Autorizar con restricciones de comandos
  manager.setToolPolicy(tool.id, 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['git ', 'npm test'],
        deniedPatterns: ['sudo'],
        allowChaining: false
      }
    }
  });

  assert.deepEqual(manager.getToolConstraints(tool.id).command.allowedPrefixes, ['git ', 'npm test']);

  // 1. Comando dentro de la lista permitida sin encadenamiento -> allow
  const evalGit = manager.evaluateAuthorization(tool, { command: 'git status' });
  assert.equal(evalGit.status, 'allow');
  assert.equal(evalGit.requiresApproval, false);

  const evalNpm = manager.evaluateAuthorization(tool, { command: 'npm test -- --bail' });
  assert.equal(evalNpm.status, 'allow');
  assert.equal(evalNpm.requiresApproval, false);

  // 2. Comando fuera de la lista permitida -> ask (fallback seguro)
  const evalCurl = manager.evaluateAuthorization(tool, { command: 'curl https://example.com' });
  assert.equal(evalCurl.status, 'ask');
  assert.equal(evalCurl.requiresApproval, true);

  // 3. Intento de encadenamiento no autorizado en shell (; o &&) -> ask
  const evalChained = manager.evaluateAuthorization(tool, { command: 'git status; rm -rf /' });
  assert.equal(evalChained.status, 'ask');
  assert.equal(evalChained.requiresApproval, true);

  // 4. Patrón expresamente denegado (sudo) -> deny
  const evalSudo = manager.evaluateAuthorization(tool, { command: 'sudo git status' });
  assert.equal(evalSudo.status, 'deny');
  assert.equal(evalSudo.requiresApproval, false);
});

test('ChatToolSecurity - Restricciones de rutas: anti-traversal, listas negras y carpetas permitidas', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_path_constraints' });

  const tool = {
    id: 'mcp__srv__fs',
    name: 'mcp__srv__fs',
    category: 'mcp'
  };

  manager.setToolPolicy(tool.id, 'allow', {
    constraints: {
      path: {
        allowedDirectories: ['./'],
        deniedDirectories: ['/etc', '~/.ssh'],
        preventTraversal: true
      }
    }
  });

  // 1. Ruta relativa válida dentro del proyecto -> allow
  const evalRel = manager.evaluateAuthorization(tool, { path: 'src/index.js' });
  assert.equal(evalRel.status, 'allow');
  assert.equal(evalRel.requiresApproval, false);

  // 2. Intento de directory traversal que escapa -> deny
  const evalTraversal = manager.evaluateAuthorization(tool, { path: '../../etc/shadow' });
  assert.equal(evalTraversal.status, 'deny');
  assert.equal(evalTraversal.requiresApproval, false);

  // 3. Ruta en lista negra expresa (/etc) -> deny
  const evalEtc = manager.evaluateAuthorization(tool, { path: '/etc/hosts' });
  assert.equal(evalEtc.status, 'deny');
  assert.equal(evalEtc.requiresApproval, false);

  // 4. Ruta absoluta fuera de allowedDirectories -> ask
  const evalOutside = manager.evaluateAuthorization(tool, { path: '/var/log/syslog' });
  assert.equal(evalOutside.status, 'ask');
  assert.equal(evalOutside.requiresApproval, true);

  // 5. Actualizar restricciones mediante setToolConstraints
  manager.setToolConstraints(tool.id, null);
  assert.equal(manager.getToolConstraints(tool.id), null);
  const evalNowAllowed = manager.evaluateAuthorization(tool, { path: '/var/log/syslog' });
  assert.equal(evalNowAllowed.status, 'allow');
});


