const test = require('node:test');
const assert = require('node:assert');
const ChatToolSecurity = require('../../js/tool-security.js');

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

  const evalJs = manager.evaluateAuthorization({ name: 'execute_javascript', category: 'computation' }, { code: '1+1' });
  assert.equal(evalJs.requiresApproval, false);
  assert.equal(evalJs.status, 'allow');
});

test('ChatToolSecurity - Herramientas MCP requieren confirmación por defecto', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_mcp_default' });

  const evalMcp = manager.evaluateAuthorization({
    id: 'zmcp_execute_command',
    name: 'zmcp_execute_command',
    category: 'mcp',
    metadata: { mcpServerName: 'mcp-proxy', originalName: 'execute_command' }
  }, { command: 'ls -la' });

  assert.equal(evalMcp.requiresApproval, true);
  assert.equal(evalMcp.status, 'ask');
  assert.equal(evalMcp.serverName, 'mcp-proxy');
  assert.equal(evalMcp.originalName, 'execute_command');
});

test('ChatToolSecurity - Lista global R/W controla las herramientas integradas de archivos', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_directory_rules' });
  manager.setDirectoryRules(['R:./project/**', 'W:./project/src/**']);

  const readTool = { id: 'zmcp_read_file', name: 'zmcp_read_file', category: 'mcp', metadata: { originalName: 'read_file' } };
  const editTool = { id: 'zmcp_edit_file', name: 'zmcp_edit_file', category: 'mcp', metadata: { originalName: 'edit_file' } };
  const writeTool = { id: 'zmcp_write_file', name: 'zmcp_write_file', category: 'mcp', metadata: { originalName: 'write_file' } };
  const searchTool = { id: 'zmcp_search_files', name: 'zmcp_search_files', category: 'mcp', metadata: { originalName: 'search_files' } };
  const diagTool = { id: 'zmcp_get_diagnostics', name: 'zmcp_get_diagnostics', category: 'mcp', metadata: { originalName: 'get_diagnostics' } };

  assert.equal(manager.evaluateAuthorization(readTool, { path: './project/README.md' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(readTool, { path: './project' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(searchTool, { path: './project' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(searchTool, { path: '../secret' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(diagTool, { path: './project/README.md' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(diagTool, { path: '../secret.py' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(editTool, { path: './project/src/app.js' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(writeTool, { path: './project/src/new.js' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(editTool, { path: './project/README.md' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(writeTool, { path: './project/README.md' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(readTool, { path: '../secret.txt' }).status, 'ask');
  assert.throws(() => manager.setDirectoryRules(['X:./project/**']), /Regla de directorio inválida/);
});

test('ChatToolSecurity - La lista de directorios prevalece sobre allow_all para herramientas integradas', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_directory_over_global' });
  manager.setGlobalMcpPolicy('allow_all');
  const tool = { id: 'zmcp_read_file', name: 'zmcp_read_file', category: 'mcp', metadata: { originalName: 'read_file' } };
  assert.equal(manager.evaluateAuthorization(tool, { path: './not-allowed.txt' }).status, 'ask');
});

test('ChatToolSecurity - execute_command y bash aplican R/W a rutas simples y piden confirmación ante dudas', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_command_directory_rules' });
  manager.setGlobalMcpPolicy('allow_all');
  manager.setDirectoryRules(['R:./workspace/**', 'W:./workspace/**']);
  const tool = { id: 'zmcp_execute_command', name: 'zmcp_execute_command', category: 'mcp', metadata: { originalName: 'execute_command' } };
  const bashTool = { id: 'zmcp_bash', name: 'zmcp_bash', category: 'mcp', metadata: { originalName: 'bash' } };

  assert.equal(manager.evaluateAuthorization(tool, { command: 'du -sh ./workspace' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'du -sh ./workspace' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(tool, { command: 'rm ./workspace/tmp.log' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'rm ./workspace/tmp.log' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(tool, { command: 'rm ../outside.log' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'rm ../outside.log' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(tool, { command: 'rm ./workspace/tmp.log; cat /etc/passwd' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'rm ./workspace/tmp.log; cat /etc/passwd' }).status, 'ask');
});

test('ChatToolSecurity - Modo global allow_all autoriza todas las herramientas MCP', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_allow_all' });
  manager.setGlobalMcpPolicy('allow_all');
  assert.equal(manager.getGlobalMcpPolicy(), 'allow_all');

  const evalMcp = manager.evaluateAuthorization({
    id: 'zmcp_read_file',
    name: 'zmcp_read_file',
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

  const toolA = { id: 'zmcp_read_file', name: 'zmcp_read_file', category: 'mcp' };
  const toolB = { id: 'zmcp_execute_command', name: 'zmcp_execute_command', category: 'mcp' };

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

  manager.setToolPolicy('zmcp_tool1', 'allow');
  manager.setToolPolicy('zmcp_tool2', 'allow');
  assert.equal(manager.listAuthorizedTools().length, 2);

  // Revocar una
  const revoked = manager.revokeToolPolicy('zmcp_tool1');
  assert.equal(revoked, true);
  assert.equal(manager.listAuthorizedTools().length, 1);
  assert.equal(manager.getToolPolicy('zmcp_tool1'), null);

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
    manager1.setToolPolicy('zmcp_saved_tool', 'allow', { serverName: 'mcp-proxy', originalName: 'saved_tool' });
    manager1.setDirectoryRules(['RW:./workspace/**']);

    // Segunda instancia leyendo la misma clave
    const manager2 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist' });
    assert.equal(manager2.getGlobalMcpPolicy(), 'allow_all');
    assert.equal(manager2.getToolPolicy('zmcp_saved_tool'), 'allow');
    assert.equal(manager2.listAuthorizedTools().length, 1);
    assert.deepEqual(manager2.getDirectoryRules(), ['RW:workspace/**']);
  } finally {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
});

test('ChatToolSecurity - Restricciones de comandos: allowlist, encadenamiento y patrones denegados', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_cmd_constraints' });

  const tool = {
    id: 'mcp_srv_cmd',
    name: 'mcp_srv_cmd',
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
    id: 'mcp_srv_fs',
    name: 'mcp_srv_fs',
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

test('ChatToolSecurity - Autorización contextual de comandos con pipes y permisos por nombre canónico', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_cmd_pipes' });

  const canonicalTool = {
    id: 'zmcp_execute_command',
    name: 'zmcp_execute_command',
    category: 'mcp',
    aliases: [],
    metadata: { mcpServerName: 'mcp-proxy', originalName: 'execute_command' }
  };

  // Se autoriza permanentemente para siempre con prefijo 'du *' (tal como lo genera el botón de UI)
  manager.setToolPolicy(canonicalTool.id, 'allow', {
    serverName: 'mcp-proxy',
    originalName: 'execute_command',
    constraints: {
      command: {
        allowedPrefixes: ['du ', 'du'],
        allowChaining: false,
        allowPipes: true
      }
    }
  });

  // 1. La sintaxis de shell ambigua vuelve a pedir confirmación aunque exista un prefijo recordado.
  const evalPiped = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh * | sort -hr' });
  assert.equal(evalPiped.status, 'ask');
  assert.equal(evalPiped.requiresApproval, true);

  // 2. Las redirecciones también requieren confirmación puntual.
  const evalRedirect = manager.evaluateAuthorization(canonicalTool, { command: 'du -h --max-depth=1 2>&1' });
  assert.equal(evalRedirect.status, 'ask');
  assert.equal(evalRedirect.requiresApproval, true);

  // Los nombres antiguos no heredan permisos del nombre canónico.
  assert.equal(manager.getToolPolicy('execute_command'), null);
  assert.equal(manager.evaluateAuthorization('mcp_execute_command', {}).requiresApproval, true);

  // 5. Una ruta de trabajo sin regla R exige confirmación aunque el ejecutable esté permitido.
  const evalAbsPath = manager.evaluateAuthorization(canonicalTool, { command: '/usr/bin/du -sh .' });
  assert.equal(evalAbsPath.status, 'ask');
  assert.equal(evalAbsPath.requiresApproval, true);

  // 6. Intento de inyección maliciosa secuencial con ';' -> debe exigir aprobación (ask)
  const evalSeqAttack = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh . ; rm -rf /' });
  assert.equal(evalSeqAttack.status, 'ask');
  assert.equal(evalSeqAttack.requiresApproval, true);

  // 7. Intento de inyección condicional con '&&' -> debe exigir aprobación (ask)
  const evalAndAttack = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh . && curl https://evil.com' });
  assert.equal(evalAndAttack.status, 'ask');
  assert.equal(evalAndAttack.requiresApproval, true);

  // 8. Solo el nombre canónico recupera la política.
  assert.equal(manager.getToolPolicy('execute_command'), null);
  assert.equal(manager.getToolPolicy('zmcp_execute_command'), 'allow');
});

test('ChatToolSecurity - Permisos recordados en herramientas integradas de archivo sobreviven recarga', () => {
  const mockStorage = {};
  const previousLocalStorage = global.localStorage;
  global.localStorage = {
    getItem: (k) => mockStorage[k] || null,
    setItem: (k, v) => { mockStorage[k] = String(v); },
    removeItem: (k) => { delete mockStorage[k]; }
  };

  try {
    const manager1 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist_files' });
    const readFileTool = { id: 'zmcp_read_file', name: 'zmcp_read_file', category: 'mcp' };

    // 1. Sin permisos ni reglas de directorio, pide autorización
    const evalBefore = manager1.evaluateAuthorization(readFileTool, { path: 'src/main.js' });
    assert.equal(evalBefore.requiresApproval, true);
    assert.equal(evalBefore.status, 'ask');

    // 2. El usuario autoriza permanentemente la herramienta (allow)
    manager1.setToolPolicy('zmcp_read_file', 'allow', { serverName: 'mcp-proxy', originalName: 'read_file' });
    const evalAfterAllow = manager1.evaluateAuthorization(readFileTool, { path: 'src/main.js' });
    assert.equal(evalAfterAllow.requiresApproval, false);
    assert.equal(evalAfterAllow.status, 'allow');

    // 3. Nueva instancia tras recarga (F5) con el mismo almacenamiento
    const manager2 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist_files' });
    assert.equal(manager2.getToolPolicy('zmcp_read_file'), 'allow');
    const evalReloaded = manager2.evaluateAuthorization(readFileTool, { path: 'src/main.js' });
    assert.equal(evalReloaded.requiresApproval, false);
    assert.equal(evalReloaded.status, 'allow');
  } finally {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
});

