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
    id: 'execute_command',
    name: 'execute_command',
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

  const readTool = { id: 'read_file', name: 'read_file', category: 'mcp', metadata: { originalName: 'read_file' } };
  const editTool = { id: 'edit_file', name: 'edit_file', category: 'mcp', metadata: { originalName: 'edit_file' } };
  const writeTool = { id: 'write_file', name: 'write_file', category: 'mcp', metadata: { originalName: 'write_file' } };
  const searchTool = { id: 'search_files', name: 'search_files', category: 'mcp', metadata: { originalName: 'search_files' } };
  const diagTool = { id: 'get_diagnostics', name: 'get_diagnostics', category: 'mcp', metadata: { originalName: 'get_diagnostics' } };

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

test('ChatToolSecurity - La lista de directorios restringe herramientas de archivos en ausencia de allow_all', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_directory_over_global' });
  manager.setDirectoryRules(['R:./allowed/**']);
  const tool = { id: 'read_file', name: 'read_file', category: 'mcp', metadata: { originalName: 'read_file' } };
  assert.equal(manager.evaluateAuthorization(tool, { path: './allowed/data.txt' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(tool, { path: './not-allowed.txt' }).status, 'ask');

  // En modo allow_all explícito, no se bloquea por reglas de directorio
  manager.setGlobalMcpPolicy('allow_all');
  assert.equal(manager.evaluateAuthorization(tool, { path: './not-allowed.txt' }).status, 'allow');
});

test('ChatToolSecurity - execute_command y bash aplican constraints y bloquean encadenamiento no autorizado', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_command_directory_rules' });
  manager.setToolPolicy('execute_command', 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['du -sh ./workspace', 'rm ./workspace/'],
        allowChaining: false,
        allowPipes: true,
        deniedPatterns: ['/etc/passwd']
      }
    }
  });
  const tool = { id: 'execute_command', name: 'execute_command', category: 'mcp', metadata: { originalName: 'execute_command' } };
  const bashTool = { id: 'bash', name: 'bash', category: 'mcp', metadata: { originalName: 'bash' } };

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
    id: 'read_file',
    name: 'read_file',
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

  const toolA = { id: 'read_file', name: 'read_file', category: 'mcp' };
  const toolB = { id: 'execute_command', name: 'execute_command', category: 'mcp' };

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
    manager1.setToolPolicy('saved_tool', 'allow', { serverName: 'mcp-proxy', originalName: 'saved_tool' });
    manager1.setDirectoryRules(['RW:./workspace/**']);

    // Segunda instancia leyendo la misma clave
    const manager2 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist' });
    assert.equal(manager2.getGlobalMcpPolicy(), 'allow_all');
    assert.equal(manager2.getToolPolicy('saved_tool'), 'allow');
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
    id: 'execute_command',
    name: 'execute_command',
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

  // 1. Con allowPipes: true, los pipes no vuelven a pedir confirmación innecesaria
  const evalPiped = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh * | sort -hr' });
  assert.equal(evalPiped.status, 'allow');
  assert.equal(evalPiped.requiresApproval, false);

  // 2. Si allowPipes es false, los pipes sí requieren confirmación
  manager.setToolConstraints(canonicalTool.id, {
    command: {
      allowedPrefixes: ['du ', 'du'],
      allowChaining: false,
      allowPipes: false
    }
  });
  const evalPipedBlocked = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh * | sort -hr' });
  assert.equal(evalPipedBlocked.status, 'ask');
  assert.equal(evalPipedBlocked.requiresApproval, true);

  // Restaurar allowPipes: true
  manager.setToolConstraints(canonicalTool.id, {
    command: {
      allowedPrefixes: ['du ', 'du'],
      allowChaining: false,
      allowPipes: true
    }
  });

  // Los nombres no autorizados no heredan permisos del nombre canónico.
  assert.equal(manager.getToolPolicy('other_command'), null);
  assert.equal(manager.evaluateAuthorization('mcp_external_cmd', {}).requiresApproval, true);

  // 5. Un comando completamente fuera de los prefijos autorizados exige confirmación
  const evalUnrelatedCmd = manager.evaluateAuthorization(canonicalTool, { command: 'curl -s https://evil.com' });
  assert.equal(evalUnrelatedCmd.status, 'ask');
  assert.equal(evalUnrelatedCmd.requiresApproval, true);

  // 6. Intento de inyección maliciosa secuencial con ';' -> debe exigir aprobación (ask)
  const evalSeqAttack = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh . ; rm -rf /' });
  assert.equal(evalSeqAttack.status, 'ask');
  assert.equal(evalSeqAttack.requiresApproval, true);

  // 7. Intento de inyección condicional con '&&' -> debe exigir aprobación (ask)
  const evalAndAttack = manager.evaluateAuthorization(canonicalTool, { command: 'du -sh . && curl https://evil.com' });
  assert.equal(evalAndAttack.status, 'ask');
  assert.equal(evalAndAttack.requiresApproval, true);

  // 8. Solo el nombre canónico recupera la política.
  assert.equal(manager.getToolPolicy('other_command'), null);
  assert.equal(manager.getToolPolicy('execute_command'), 'allow');
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
    const readFileTool = { id: 'read_file', name: 'read_file', category: 'mcp' };

    // 1. Sin permisos ni reglas de directorio, pide autorización
    const evalBefore = manager1.evaluateAuthorization(readFileTool, { path: 'src/main.js' });
    assert.equal(evalBefore.requiresApproval, true);
    assert.equal(evalBefore.status, 'ask');

    // 2. El usuario autoriza permanentemente la herramienta (allow)
    manager1.setToolPolicy('read_file', 'allow', { serverName: 'mcp-proxy', originalName: 'read_file' });
    const evalAfterAllow = manager1.evaluateAuthorization(readFileTool, { path: 'src/main.js' });
    assert.equal(evalAfterAllow.requiresApproval, false);
    assert.equal(evalAfterAllow.status, 'allow');

    // 3. Nueva instancia tras recarga (F5) con el mismo almacenamiento
    const manager2 = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_persist_files' });
    assert.equal(manager2.getToolPolicy('read_file'), 'allow');
    const evalReloaded = manager2.evaluateAuthorization(readFileTool, { path: 'src/main.js' });
    assert.equal(evalReloaded.requiresApproval, false);
    assert.equal(evalReloaded.status, 'allow');
  } finally {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
});

test('ChatToolSecurity - F1: Una regla de directorio no omite restricciones de prefijo en comandos', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_f1_prefix_bypass' });
  manager.setDirectoryRules(['R:/tmp/zc-audit/**', 'W:/tmp/zc-audit/**']);

  const cmdTool = {
    id: 'execute_command',
    name: 'execute_command',
    category: 'mcp'
  };

  // Autorizar exclusivamente prefijo 'ls'
  manager.setToolPolicy(cmdTool.id, 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['ls'],
        allowChaining: false
      }
    }
  });

  // 1. Comando 'cat' dentro de la ruta permitida por regla de directorio DEBE requerir aprobación (F1)
  const evalCat = manager.evaluateAuthorization(cmdTool, { command: 'cat /tmp/zc-audit/demo.txt' });
  assert.equal(evalCat.requiresApproval, true, 'cat no debe permitirse solo por coincidencia de directorio');
  assert.equal(evalCat.status, 'ask');
  assert.equal(evalCat.reason, 'command_outside_allowed_prefixes');

  // 2. Comando 'ls' dentro de la ruta permitida se autoriza correctamente
  const evalLs = manager.evaluateAuthorization(cmdTool, { command: 'ls /tmp/zc-audit/demo.txt' });
  assert.equal(evalLs.requiresApproval, false);
  assert.equal(evalLs.status, 'allow');
});

test('ChatToolSecurity - list_directory sin path normaliza a "." y aplica reglas de directorio', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_list_dir_norm' });
  const listTool = {
    id: 'list_directory',
    name: 'list_directory',
    category: 'mcp'
  };

  // 1. Sin reglas ni autorización, pide aprobación
  const evalNoRules = manager.evaluateAuthorization(listTool, {});
  assert.equal(evalNoRules.requiresApproval, true);
  assert.equal(evalNoRules.status, 'ask');
  assert.equal(evalNoRules.directoryAccess, 'R');
  assert.equal(evalNoRules.directoryPath, '.');

  // 2. Con regla para la carpeta '.', se autoriza sin pedir confirmación
  manager.setDirectoryRules(['R:.']);
  const evalWithRule = manager.evaluateAuthorization(listTool, {});
  assert.equal(evalWithRule.requiresApproval, false);
  assert.equal(evalWithRule.status, 'allow');
});

test('ChatToolSecurity - Sesión acotada por token y preservación de autorizaciones permanentes', () => {
  const mockStorage = {};
  const previousLocalStorage = global.localStorage;
  global.localStorage = {
    getItem: (k) => mockStorage[k] || null,
    setItem: (k, v) => { mockStorage[k] = String(v); },
    removeItem: (k) => { delete mockStorage[k]; },
    get length() { return Object.keys(mockStorage).length; },
    key: (i) => Object.keys(mockStorage)[i] || null
  };

  try {
    const manager = new ChatToolSecurity.ToolSecurityManager({
      storageKey: 'test_sec_v3_session_test',
      sessionToken: 'token_active_123'
    });

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
    const manager2 = new ChatToolSecurity.ToolSecurityManager({
      storageKey: 'test_sec_v3_session_test',
      sessionToken: 'token_fresh_789'
    });
    assert.equal(manager2.getToolPolicy('perm_tool'), 'allow');
    assert.equal(manager2.getServerPolicy('server_perm'), 'allow');
    assert.equal(manager2.getToolPolicy('session_tool'), null);
  } finally {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
});

test('ChatToolSecurity - Sincronización automática de comandos entre execute_command y bash', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_sync_cmd' });
  const execTool = { id: 'execute_command', name: 'execute_command', category: 'mcp' };
  const bashTool = { id: 'bash', name: 'bash', category: 'mcp' };

  // 1. Autorizar python3 en execute_command
  manager.setToolPolicy('execute_command', 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['python3'],
        allowChaining: false,
        allowPipes: true
      }
    }
  });

  // Ambos deben quedar autorizados con el mismo prefijo
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'python3 script.py' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'python3 script.py' }).status, 'allow');

  // Comandos fuera del prefijo deben seguir pidiendo confirmación
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'curl https://evil.com' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'curl https://evil.com' }).status, 'ask');

  // Revocar execute_command revoca ambas
  manager.revokeToolPolicy('execute_command');
  assert.equal(manager.getToolPolicy('execute_command'), null);
  assert.equal(manager.getToolPolicy('bash'), null);
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'python3 script.py' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(bashTool, { command: 'python3 script.py' }).status, 'ask');
});

test('ChatToolSecurity - Comandos autorizados soportan rutas relativas y argumentos entrecomillados', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_cmd_paths_quotes' });
  const execTool = { id: 'execute_command', name: 'execute_command', category: 'mcp' };

  manager.setToolPolicy('execute_command', 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['python3'],
        allowChaining: false,
        allowPipes: true
      }
    }
  });

  // Rutas relativas como ./script.py o comillas en argumentos no deben forzar 'ask'
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'python3 ./take_screenshot.py' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'python3 "take_screenshot.py"' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(execTool, { command: "python3 'take_screenshot.py'" }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'python3 scripts/take_screenshot.py' }).status, 'allow');
});

test('ChatToolSecurity - Política a nivel de servidor MCP autoriza todas sus herramientas', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_server_policy' });
  const tool1 = { id: 'mcp_playwright_navigate', name: 'navigate', metadata: { mcpServerId: 'playwright', mcpServerName: 'Playwright' } };
  const tool2 = { id: 'mcp_playwright_click', name: 'click', metadata: { mcpServerId: 'playwright', mcpServerName: 'Playwright' } };
  const otherTool = { id: 'mcp_github_issue', name: 'issue', metadata: { mcpServerId: 'github', mcpServerName: 'GitHub' } };

  // Inicialmente piden confirmación
  assert.equal(manager.evaluateAuthorization(tool1, {}).status, 'ask');
  assert.equal(manager.evaluateAuthorization(tool2, {}).status, 'ask');

  // Autorizar el servidor completo
  manager.setServerPolicy('playwright', 'allow', { serverName: 'Playwright' });
  assert.equal(manager.getServerPolicy('playwright'), 'allow');

  // Todas las herramientas del servidor quedan autorizadas sin preguntar
  assert.equal(manager.evaluateAuthorization(tool1, {}).status, 'allow');
  assert.equal(manager.evaluateAuthorization(tool2, {}).status, 'allow');

  // Herramientas de otro servidor siguen pidiendo confirmación
  assert.equal(manager.evaluateAuthorization(otherTool, {}).status, 'ask');

  // Lista de servidores autorizados
  const servers = manager.listAuthorizedServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].serverId, 'playwright');

  // Revocar el servidor
  manager.revokeServerPolicy('playwright');
  assert.equal(manager.getServerPolicy('playwright'), null);
  assert.equal(manager.evaluateAuthorization(tool1, {}).status, 'ask');
});

test('ChatToolSecurity - Política workspace_trust autoriza comandos y archivos locales pero bloquea traversal', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_workspace_trust' });
  manager.setGlobalMcpPolicy('workspace_trust');

  const readFileTool = { id: 'read_file', name: 'read_file', category: 'mcp' };
  const execTool = { id: 'execute_command', name: 'execute_command', category: 'mcp' };

  // Comandos y lecturas locales del workspace están permitidas
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'ls -la' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'git status --short' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'npm test' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(readFileTool, { path: 'src/index.js' }).status, 'allow');
  assert.equal(manager.evaluateAuthorization(readFileTool, { path: './package.json' }).status, 'allow');

  // Intentos de acceso fuera del workspace o comandos globales piden confirmación
  assert.equal(manager.evaluateAuthorization(readFileTool, { path: '../../etc/shadow' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(readFileTool, { path: '/etc/passwd' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'sudo rm -rf /' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'cat /etc/shadow' }).status, 'ask');
  assert.equal(manager.evaluateAuthorization(execTool, { command: 'ls ../../' }).status, 'ask');
});

test('ChatToolSecurity - Permitir prefijo cd * autoriza comandos encadenados y navegación sin re-preguntar', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_cd_chaining' });
  const bashTool = { id: 'bash', name: 'bash', category: 'mcp' };

  // 1. Simular la autorización que genera el botón "Permitir siempre cd *"
  manager.setToolPolicy('bash', 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['cd'],
        allowChaining: true,
        allowPipes: true
      }
    }
  });

  // Comando complejo encadenado con && y bucle for / pipes
  const complexCmd = "cd /home/alberto/vs/zerochat && for c in 4907cc8 fcc2c85 f4a30a8; do echo \"=== $c ===\"; git show --stat $c | head -5; done";
  const evalComplex = manager.evaluateAuthorization(bashTool, { command: complexCmd });
  assert.equal(evalComplex.status, 'allow', 'Debe permitir el comando encadenado que empieza con cd');
  assert.equal(evalComplex.requiresApproval, false);

  // Comando con git status encadenado tras cd
  const evalGitChained = manager.evaluateAuthorization(bashTool, { command: 'cd /home/alberto/vs/zerochat && git status --short && git diff' });
  assert.equal(evalGitChained.status, 'allow');
  assert.equal(evalGitChained.requiresApproval, false);

  // 2. Resiliencia: si un registro previo guardó allowChaining: false pero tiene prefijo cd, cd debe permitir encadenamiento
  manager.setToolPolicy('bash', 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['cd'],
        allowChaining: false, // Forzar false para probar la corrección automática
        allowPipes: true
      }
    }
  });
  const evalAfterFalse = manager.evaluateAuthorization(bashTool, { command: complexCmd });
  assert.equal(evalAfterFalse.status, 'allow', 'Prefijo cd no debe ser bloqueado por allowChaining: false');
  assert.equal(evalAfterFalse.requiresApproval, false);
});

test('ChatToolSecurity - Navegación con cd hereda permisos del comando secundario si está en allowedPrefixes', () => {
  const manager = new ChatToolSecurity.ToolSecurityManager({ storageKey: 'test_sec_cd_subcmd' });
  const bashTool = { id: 'bash', name: 'bash', category: 'mcp' };

  // El usuario autoriza permanentemente "git"
  manager.setToolPolicy('bash', 'allow', {
    constraints: {
      command: {
        allowedPrefixes: ['git'],
        allowChaining: true,
        allowPipes: true
      }
    }
  });

  // Si el agente ejecuta "cd /repo && git status", debe permitirse porque el comando ejecutado tras cd es "git"
  const evalChainedGit = manager.evaluateAuthorization(bashTool, { command: 'cd /home/alberto/vs/zerochat && git status --short' });
  assert.equal(evalChainedGit.status, 'allow');
  assert.equal(evalChainedGit.requiresApproval, false);

  // Pero si el comando tras cd es otro no autorizado (e.g. rm), debe pedir confirmación
  const evalChainedRm = manager.evaluateAuthorization(bashTool, { command: 'cd /home/alberto/vs/zerochat && rm -rf target' });
  assert.equal(evalChainedRm.status, 'ask');
  assert.equal(evalChainedRm.requiresApproval, true);
});

