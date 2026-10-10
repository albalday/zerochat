const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const pkg = require('../../package.json');
const { tokenDataDir, waitForServer, freePort } = require('../helpers/backend-env.js');

test('Servidor local zerochat.py: token de sesión, herramientas core y aislamiento', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-secret-12345';
  const nativeFetch = global.fetch;
  let toolAuthorization = null;
  const signedFetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' ? options.body : '';
    let request;
    try { request = JSON.parse(body); } catch (_) {}
    if (toolAuthorization && request?.method === 'tools/call' && String(url).startsWith(baseUrl)) {
      const expiresAt = Date.now() + toolAuthorization.ttlMs;
      const nonce = crypto.randomBytes(16).toString('base64url');
      const pathName = new URL(url).pathname.replace(/\/$/, '') || '/';
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      const signatureBase = JSON.stringify(['zerochat-tool-auth-v1', toolAuthorization.sessionId, 'POST', pathName, expiresAt, nonce, bodyHash]);
      const signature = crypto.createHmac('sha256', Buffer.from(toolAuthorization.key, 'base64url')).update(signatureBase).digest('base64url');
      options = { ...options, headers: { ...(options.headers || {}),
        'X-ZeroChat-Tool-Session': toolAuthorization.sessionId,
        'X-ZeroChat-Tool-Expires': String(expiresAt),
        'X-ZeroChat-Tool-Nonce': nonce,
        'X-ZeroChat-Tool-Signature': signature } };
    }
    return nativeFetch(url, options);
  };
  global.fetch = signedFetch;

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], { env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) }, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverError = '';
  let serverOutput = '';
  serverProc.stderr.on('data', chunk => { serverError += chunk; });
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Comprobar rechazo sin token (HTTP 401)
    const unauthGet = await fetch(`${baseUrl}/`);
    assert.equal(unauthGet.status, 401, 'Petición GET sin token debe ser rechazada con 401');

    const unauthPost = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(unauthPost.status, 401, 'Petición POST sin token debe ser rechazada con 401');

    const favicon = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(favicon.status, 204);
    assert.equal(await favicon.text(), '');
    const forbiddenFavicon = await fetch(`${baseUrl}/favicon.ico`, {
      headers: { Origin: 'https://untrusted.example' }
    });
    assert.equal(forbiddenFavicon.status, 403);

    const querySse = await fetch(`${baseUrl}/sse?token=${testToken}`);
    assert.equal(querySse.status, 401);
    const { McpClient } = require('../../js/mcp.js');
    const client = new McpClient({ url: `${baseUrl}/sse`, token: testToken });
    try {
      assert.equal(await client.connectSseStream({ timeoutMs: 2000 }), `${baseUrl}/`);
      assert.equal(client.isSseActive, true);
      const tools = await client.request('tools/list');
      assert.ok(Array.isArray(tools.tools));
    } finally {
      client.disconnect();
    }

    // 3. Comprobar rechazo con token inválido
    const invalidPost = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': 'Bearer wrong-token'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    });
    assert.equal(invalidPost.status, 401, 'Petición con token erróneo debe ser 401');

    // El token en la URL ya no autoriza peticiones.
    const queryTokenGet = await fetch(`${baseUrl}/?token=${testToken}`);
    assert.equal(queryTokenGet.status, 401, 'El token en query string debe ser rechazado');

    const invalidShapeRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify([])
    });
    assert.equal(invalidShapeRes.status, 400, 'Una petición JSON que no sea un objeto debe rechazarse');

    try {
      const oversizedRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://albalday.github.io',
          'Authorization': `Bearer ${testToken}`
        },
        body: 'x'.repeat(1024 * 1024 + 1)
      });
      assert.equal(oversizedRes.status, 413, 'Un cuerpo superior al límite debe rechazarse');
    } catch (err) {
      if (err?.cause?.code !== 'EPIPE' && err?.cause?.code !== 'ECONNRESET') {
        throw err;
      }
    }

    // 4. Comprobar autorización con cabecera Authorization: Bearer <token>
    const initRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    });
    assert.equal(initRes.status, 200);
    const initJson = await initRes.json();
    assert.equal(initJson.result?.serverInfo?.name, 'ZeroChat Local Server');
    assert.equal(initJson.result?.serverInfo?.version, pkg.version.split('.').slice(0, 2).join('.'));
    toolAuthorization = initJson.result?.toolAuthorization;
    assert.equal(toolAuthorization?.version, 'zerochat-tool-auth-v1');
    const unsignedToolRes = await nativeFetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'list_directory', arguments: { path: '.' } } })
    });
    assert.equal(unsignedToolRes.status, 403, 'Una llamada tools/call sin sello debe rechazarse');
    const { McpClient: SignedMcpClient } = require('../../js/mcp.js');
    global.fetch = nativeFetch;
    const signedClient = new SignedMcpClient({ id: 'mcp_proxy', url: baseUrl, token: testToken });
    try {
      assert.equal((await signedClient.initialize()).success, true);
      assert.equal((await signedClient.callTool('list_directory', { path: '.' }, { toolAuthorization: true })).success, true);
    } finally {
      signedClient.disconnect();
      global.fetch = signedFetch;
    }

    // 5. Comprobar tools/list
    const toolsRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
    });
    assert.equal(toolsRes.status, 200);
    const toolsJson = await toolsRes.json();
    const tools = toolsJson.result?.tools || [];
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('list_directory'));
    assert.ok(toolNames.includes('read_file'));
    assert.ok(toolNames.includes('write_file'));
    assert.ok(toolNames.includes('edit_file'));
    assert.ok(toolNames.includes('run_command'));
    assert.ok(toolNames.includes('check_command'));
    assert.ok(toolNames.includes('search_files'));
    assert.ok(!toolNames.includes('bash') && !toolNames.includes('execute_command'), 'Una sola herramienta para ejecutar comandos');
    assert.ok(typeof initJson.result?.serverInfo?.os === 'string', 'serverInfo debe publicar el SO detectado');
    const runTool = tools.find(t => t.name === 'run_command');
    assert.ok(runTool?.description?.includes('Host OS:'), 'run_command debe declarar el SO anfitrión');
    assert.match(runTool.description, /fresh/, 'run_command debe advertir de que cada llamada empieza de cero');
    assert.equal(runTool.inputSchema.properties.cwd, undefined, 'run_command no admite cwd');
    assert.deepEqual(Object.keys(runTool.inputSchema.properties).sort(), ['background', 'command', 'timeout_seconds']);
    assert.ok(!toolNames.includes('set_project_directory'), 'El cambio de proyecto no es una herramienta del modelo');
    assert.ok(toolNames.includes('get_diagnostics'));
    assert.ok(toolNames.includes('browser_action'));
    const browserAction = tools.find(t => t.name === 'browser_action');
    assert.equal(typeof browserAction?.availability?.available, 'boolean',
      'browser_action debe publicar su disponibilidad antes de poder activarse');
    const listDirectory = tools.find(t => t.name === 'list_directory');
    assert.equal(listDirectory?.inputSchema?.properties?.max_depth, undefined,
      'list_directory no debe publicar una profundidad recursiva inexistente');

    const availabilityRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/availability', params: { name: 'browser_action' } })
    });
    assert.equal(availabilityRes.status, 200);
    const availabilityJson = await availabilityRes.json();
    assert.equal(typeof availabilityJson.result?.available, 'boolean');

    // El cambio de directorio del proyecto es un método de control de la interfaz.
    const projectRpc = async (id, params) => (await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'X-ZeroChat-Token': testToken },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'zerochat/project/set_directory', params })
    })).json();
    const startCwd = initJson.result.serverInfo.cwd;
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-project-')));
    try {
      const moved = await projectRpc(42, { path: projectDir });
      assert.equal(moved.result?.cwd, projectDir);
      assert.equal(moved.result?.previous_cwd, startCwd);
      const movedHb = await (await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } })).json();
      assert.equal(movedHb.cwd, projectDir, 'El heartbeat publica el nuevo directorio');
      assert.equal((await projectRpc(43, { path: path.join(projectDir, 'missing') })).error?.code, -32602);
      assert.equal((await projectRpc(44, { path: 7 })).error?.code, -32602);
      assert.equal((await projectRpc(45, {})).error?.code, -32602);
    } finally {
      assert.equal((await projectRpc(46, { path: startCwd })).result?.cwd, startCwd);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }

    // El contrato estricto rechaza parámetros que ya no existen.
    const obsoleteArgumentRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'list_directory',
          arguments: { path: '.', max_depth: 2 }
        }
      })
    });
    assert.equal(obsoleteArgumentRes.status, 400);
    const obsoleteArgumentJson = await obsoleteArgumentRes.json();
    assert.match(obsoleteArgumentJson.error || '', /max_depth/);

    // 6. Comprobar ejecución de herramienta read_file
    const callRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: 'package.json', max_lines: 10 }
        }
      })
    });
    assert.equal(callRes.status, 200);
    const callJson = await callRes.json();
    assert.equal(callJson.result?.isError, false);
    const parsedContent = JSON.parse(callJson.result?.content?.[0]?.text);
    assert.equal(parsedContent.success, true);
    assert.match(parsedContent.content, new RegExp(`"version": "${pkg.version}"`));

    // 6.1. Comprobar read_file con rangos start_line y end_line
    const rangeRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: 'package.json', start_line: 1, end_line: 3 }
        }
      })
    });
    assert.equal(rangeRes.status, 200);
    const rangeJson = await rangeRes.json();
    const parsedRange = JSON.parse(rangeJson.result?.content?.[0]?.text);
    assert.equal(parsedRange.success, true);
    assert.equal(parsedRange.lines_returned, 3);
    assert.equal(parsedRange.start_line, 1);
    assert.equal(parsedRange.end_line, 3);

    // 6.2. Comprobar list_directory recursivo acotado
    const listRecRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'list_directory',
          arguments: { path: 'tests/helpers', recursive: true }
        }
      })
    });
    assert.equal(listRecRes.status, 200);
    const listRecJson = await listRecRes.json();
    const parsedListRec = JSON.parse(listRecJson.result?.content?.[0]?.text);
    assert.equal(parsedListRec.success, true);
    assert.equal(parsedListRec.recursive, true);

    // 6.3. Comprobar write_file y edit_file quirúrgico (old_str -> new_str)
    const testFilePath = path.join(os.tmpdir(), `zerochat_test_p1_${Date.now()}.txt`);
    const writeRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 53,
        method: 'tools/call',
        params: {
          name: 'write_file',
          arguments: { path: testFilePath, content: 'primera linea\nsegunda linea objetivo\ntercera linea\n' }
        }
      })
    });
    assert.equal(writeRes.status, 200);
    const writeJson = await writeRes.json();
    const parsedWrite = JSON.parse(writeJson.result?.content?.[0]?.text);
    assert.equal(parsedWrite.success, true);

    const editSurgicalRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 54,
        method: 'tools/call',
        params: {
          name: 'edit_file',
          arguments: { path: testFilePath, old_str: 'segunda linea objetivo', new_str: 'segunda linea modificada' }
        }
      })
    });
    assert.equal(editSurgicalRes.status, 200);
    const editSurgicalJson = await editSurgicalRes.json();
    const parsedEditSurgical = JSON.parse(editSurgicalJson.result?.content?.[0]?.text);
    assert.equal(parsedEditSurgical.success, true);
    assert.equal(parsedEditSurgical.replacements, 1);

    // Error con 0 coincidencias
    const edit0Res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://albalday.github.io',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 55,
        method: 'tools/call',
        params: {
          name: 'edit_file',
          arguments: { path: testFilePath, old_str: 'linea inexistente', new_str: 'foo' }
        }
      })
    });
    assert.equal(edit0Res.status, 200);
    const edit0Json = await edit0Res.json();
    assert.equal(edit0Json.result?.isError, true);
    assert.match(edit0Json.result?.content?.[0]?.text || '', /Target text was not found|No se encontró el texto/);

    try { fs.unlinkSync(testFilePath); } catch (_) {}

    // 6.4. run_command: cada llamada empieza en el proyecto, sin heredar cd ni variables.
    const callTool = async (id, name, args, meta) => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      return { json, parsed: JSON.parse(json.result?.content?.[0]?.text) };
    };
    const jobsRpc = async (id, method, params = {}) => (await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'X-ZeroChat-Token': testToken },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })).json();

    const run1 = await callTool(56, 'run_command', { command: 'export ZEROCHAT_PERSIST_VAR=1 && cd tests/helpers && pwd' });
    assert.equal(run1.parsed.success, true);
    assert.match(run1.parsed.output, /tests\/helpers/);
    const run2 = await callTool(57, 'run_command', { command: 'echo "CHECK_VAR=$ZEROCHAT_PERSIST_VAR" && pwd' });
    assert.equal(run2.parsed.output, `CHECK_VAR=\n${fs.realpathSync(repoRoot)}\n`);
    const failing = await callTool(58, 'run_command', { command: 'echo uno; echo dos >&2; exit 2' });
    assert.equal(failing.json.result.isError, true);
    assert.equal(failing.parsed.exit_code, 2);
    assert.equal(failing.parsed.output, 'uno\ndos\n');
    const cwdRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 59, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'pwd', cwd: '/tmp' } } })
    });
    assert.equal(cwdRes.status, 400, 'run_command rechaza el argumento cwd');
    assert.match((await cwdRes.json()).error || '', /cwd/);

    // 6.5. Truncado defensivo de la salida (>8.000 caracteres) con el log completo disponible.
    const trunc = await callTool(60, 'run_command', { command: 'python3 -c "for i in range(120): print(f\'line {i:03d} \' + \'x\'*80)"' });
    assert.equal(trunc.parsed.success, true);
    assert.equal(trunc.parsed.truncated, true);
    assert.match(trunc.parsed.output, /Output truncated/);
    assert.match(trunc.parsed.output, /line 000/);
    assert.match(trunc.parsed.output, /line 119/);
    assert.ok(fs.readFileSync(trunc.parsed.log_file, 'utf8').includes('line 060'));

    // 6.5b. Segundo plano: la tarjeta lo sigue con zerochat/jobs/* y el cliente lo detiene con su clave.
    const bg = await callTool(61, 'run_command', { command: 'echo listo; exec sleep 100', background: true }, { zerochatJobKey: 'tarjeta-prueba-1' });
    assert.equal(bg.parsed.status, 'running');
    assert.equal(bg.parsed.output, 'listo\n');
    const runningHb = await (await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } })).json();
    assert.ok(runningHb.jobs.some(job => job.id === bg.parsed.job_id && job.status === 'running'), 'El heartbeat publica los comandos en marcha');
    const details = await jobsRpc(62, 'zerochat/jobs/get', { key: 'tarjeta-prueba-1' });
    assert.equal(details.result.id, bg.parsed.job_id);
    assert.equal(details.result.tail, 'listo\n');
    assert.equal(details.result.background, true);
    const page = await jobsRpc(63, 'zerochat/jobs/log', { id: bg.parsed.job_id, offset: 2, limit: 3 });
    assert.deepEqual([page.result.text, page.result.next, page.result.done], ['sto', 5, false]);
    assert.equal((await jobsRpc(64, 'zerochat/jobs/log', { id: bg.parsed.job_id, offset: -1 })).error?.code, -32602);
    assert.ok((await jobsRpc(65, 'zerochat/jobs/list')).result.jobs.some(job => job.key === 'tarjeta-prueba-1'));
    const stoppedByUser = await jobsRpc(66, 'zerochat/jobs/stop', { key: 'tarjeta-prueba-1' });
    assert.equal(stoppedByUser.result.status, 'stopped');
    assert.equal(stoppedByUser.result.stop_reason, 'user');
    assert.equal((await jobsRpc(67, 'zerochat/jobs/get', { id: 99999 })).error?.code, -32602);
    const seen = await callTool(68, 'check_command', { job_id: bg.parsed.job_id });
    assert.equal(seen.parsed.status, 'stopped');
    assert.equal(seen.parsed.stopped_by, 'user');

    // 6.6. Comprobar search_files con regex y filtro glob
    const searchRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 60,
        method: 'tools/call',
        params: {
          name: 'search_files',
          arguments: { query: 'def set_project_directory', path: '.', file_pattern: '*.py' }
        }
      })
    });
    assert.equal(searchRes.status, 200);
    const searchJson = await searchRes.json();
    const parsedSearch = JSON.parse(searchJson.result?.content?.[0]?.text);
    assert.equal(parsedSearch.success, true);
    assert.ok(parsedSearch.total_matches > 0);
    assert.ok(parsedSearch.matches.some(m => m.relative_path.includes('dd-tools.py') || m.relative_path.includes('zerochat.py')));

    // 6.7. Comprobar get_diagnostics en archivo específico
    const diagRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: {
          name: 'get_diagnostics',
          arguments: { path: 'package.json' }
        }
      })
    });
    assert.equal(diagRes.status, 200);
    const diagJson = await diagRes.json();
    const parsedDiag = JSON.parse(diagJson.result?.content?.[0]?.text);
    assert.equal(parsedDiag.success, true);
    assert.equal(parsedDiag.error_count, 0);

    // 6.8. Comprobar browser_action (navigate y screenshot)
    const navRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 62,
        method: 'tools/call',
        params: {
          name: 'browser_action',
          arguments: { action: 'navigate', url: 'about:blank' }
        }
      })
    });
    assert.equal(navRes.status, 200);
    const navJson = await navRes.json();
    const parsedNav = JSON.parse(navJson.result?.content?.[0]?.text);
    assert.equal(parsedNav.success, true);
    assert.equal(parsedNav.action, 'navigate');

    const screenshotRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 63,
        method: 'tools/call',
        params: {
          name: 'browser_action',
          arguments: { action: 'screenshot' }
        }
      })
    });
    assert.equal(screenshotRes.status, 200);
    const screenshotJson = await screenshotRes.json();
    const parsedScreenshot = JSON.parse(screenshotJson.result?.content?.[0]?.text);
    assert.equal(parsedScreenshot.success, true);
    assert.equal(parsedScreenshot.action, 'screenshot');
    assert.ok(typeof parsedScreenshot.image_base64 === 'string' && parsedScreenshot.image_base64.length > 50);

    // 7. Comprobar flujo SSE con token en cabecera
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { 'Accept': 'text/event-stream', 'X-ZeroChat-Token': testToken }
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');
    assert.equal(sseRes.headers.get('cache-control'), 'no-store');

    // 8. Comprobar servicios MCP externos arrancables individualmente
    const statusRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'zerochat/external/status', params: {} })
    });
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.result?.host, 'running');
    const serverIds = (statusJson.result?.servers || []).map(s => s.id);
    assert.ok(serverIds.includes('ejemplo'), 'ejemplo debe estar provisto');
    assert.ok(serverIds.includes('composio'), 'composio debe estar provisto');
    assert.ok(serverIds.includes('playwright'), 'playwright debe estar provisto');
    assert.ok(serverIds.includes('memory'), 'memory debe estar provisto');
    assert.equal(serverIds.includes('lsp'), false, 'lsp no debe ofrecerse como servicio integrado');
    const exampleServer = (statusJson.result?.servers || []).find(s => s.id === 'ejemplo');
    assert.equal(exampleServer?.status, 'stopped');
    assert.equal(exampleServer?.help?.url, 'help/mcp.html#crear-mcp-con-agente');
    const composioServer = (statusJson.result?.servers || []).find(s => s.id === 'composio');
    assert.deepEqual(composioServer?.remote, {
      type: 'mcp-remote',
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      authentication: 'composio-connect'
    });

    // Iniciar individualmente el ejemplo
    const startRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'zerochat/external/servers/start', params: { serverId: 'ejemplo' } })
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    const runningExample = (startJson.result?.servers || []).find(s => s.id === 'ejemplo');
    assert.equal(runningExample?.status, 'running');
    assert.equal(runningExample?.toolCount, 1);

    // tools/list en /mcp/external
    const extToolsRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} })
    });
    assert.equal(extToolsRes.status, 200);
    const extToolsJson = await extToolsRes.json();
    const extToolNames = (extToolsJson.result?.tools || []).map(t => t.name);
    assert.ok(extToolNames.includes('ejemplo_echo'));

    // tools/call ejecutando el echo del ejemplo
    const extCallRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'ejemplo_echo', arguments: { message: 'probando mcp' } }
      })
    });
    assert.equal(extCallRes.status, 200);
    const extCallJson = await extCallRes.json();
    assert.equal(extCallJson.result?.isError, false);
    assert.equal(extCallJson.result?.content?.[0]?.text, 'echo: probando mcp');

    // Detener individualmente el ejemplo
    const stopRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'zerochat/external/servers/stop', params: { serverId: 'ejemplo' } })
    });
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    const stoppedExample = (stopJson.result?.servers || []).find(s => s.id === 'ejemplo');
    assert.equal(stoppedExample?.status, 'stopped');
    assert.equal(stoppedExample?.toolCount, 0);

  } finally {
    global.fetch = nativeFetch;
    serverProc.kill('SIGTERM');
  }
});

test('Detección de entorno de desarrollo y servicio de zerochat.html y estáticos en zerochat.py', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-dev-auto';

  // Iniciar sin --ui-url para verificar auto-detección
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], { cwd: repoRoot, env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) }, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Verificar detección en stdout del banner
    assert.match(serverOutput, /Modo de ejecución\s*:\s*Desarrollo local/);
    assert.match(serverOutput, new RegExp(`Destino Web\\s*:\\s*http://127\\.0\\.0\\.1:${port}/zerochat\\.html`));

    // 3. Verificar servicio de zerochat.html sin necesidad de token en headers
    const htmlRes = await fetch(`${baseUrl}/zerochat.html`);
    assert.equal(htmlRes.status, 200, 'Debe servir zerochat.html con 200 OK');
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('ZeroChat'), 'El contenido debe ser el HTML de ZeroChat');

    // 4. Verificar servicio de assets estáticos (js, css, manifest)
    const jsRes = await fetch(`${baseUrl}/js/app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type') || '', /javascript/);
    await jsRes.text();

    const cssRes = await fetch(`${baseUrl}/css/tokens.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type') || '', /text\/css/);
    await cssRes.text();

    const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get('content-type') || '', /manifest/);
    await manifestRes.text();

    // 5. Verificar protección anti-path-traversal
    const traversalRes = await fetch(`${baseUrl}/../package.json`);
    assert.notEqual(traversalRes.status, 200, 'No debe permitir acceso fuera de la raíz');
    await traversalRes.text();
  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('zerochat.py: logging de peticiones y respuestas con HH:MM:SS, sin datos comprometidos y con detalle de errores', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'super-secret-token-xyz-987';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], { env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) }, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk.toString(); });

  try {
    // Esperar arranque comprobando probe con token
    await waitForServer(baseUrl, testToken, serverProc);

    // 1. Petición GET sin token (401 Unauthorized)
    await fetch(`${baseUrl}/`);

    // 2. Petición GET autenticada por cabecera
    await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });

    // 3. Petición POST con initialize
    const loggingInitRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} })
    });
    const loggingAuth = (await loggingInitRes.json()).result?.toolAuthorization;

    // 4. Petición POST con tools/call fallida (archivo no existente) con argumento sensible
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: {
            path: 'archivo_que_no_existe_12345.txt',
            secret_payload: 'super_secret_payload_content_12345'
          }
        }
      })
    });

    // 5. Petición POST con JSON malformado (400 Bad Request)
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: '{ json_invalido: true '
    });

    // 6. Petición POST con herramienta no existente (-32601)
    const unknownBody = JSON.stringify({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'herramienta_fantasma', arguments: { secret_api_key: 'confidential_key_abc_999' } }
    });
    const unknownExpires = Date.now() + loggingAuth.ttlMs;
    const unknownNonce = crypto.randomBytes(16).toString('base64url');
    const unknownHash = crypto.createHash('sha256').update(unknownBody).digest('hex');
    const unknownBase = JSON.stringify(['zerochat-tool-auth-v1', loggingAuth.sessionId, 'POST', '/', unknownExpires, unknownNonce, unknownHash]);
    const unknownSignature = crypto.createHmac('sha256', Buffer.from(loggingAuth.key, 'base64url')).update(unknownBase).digest('base64url');
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`,
        'X-ZeroChat-Tool-Session': loggingAuth.sessionId,
        'X-ZeroChat-Tool-Expires': String(unknownExpires),
        'X-ZeroChat-Tool-Nonce': unknownNonce,
        'X-ZeroChat-Tool-Signature': unknownSignature
      },
      body: unknownBody
    });

    // Dar margen para vaciar buffers de stdout
    await new Promise(resolve => setTimeout(resolve, 150));

    // Validar líneas con formato [HH:MM:SS]
    const timestampRegex = /\[\d{2}:\d{2}:\d{2}\]/;
    assert.match(serverOutput, timestampRegex, 'Los logs deben incluir marca temporal [HH:MM:SS]');

    // Validar líneas de petición (-->) y respuesta (<--)
    assert.match(serverOutput, /\[\d{2}:\d{2}:\d{2}\]\s+-->\s+GET\s+\//, 'Debe registrarse línea de petición GET');
    assert.match(serverOutput, /\[\d{2}:\d{2}:\d{2}\]\s+<--\s+401 Unauthorized/, 'Debe registrarse error 401');

    // Validar que el token NUNCA se filtre en texto plano en stdout de las peticiones
    const logsWithoutBanner = serverOutput.split('=' .repeat(30)).pop() || '';
    assert.ok(!logsWithoutBanner.includes(testToken), 'El token de sesión no debe fugarse en los logs de peticiones');

    // Validar que NO se filtran los argumentos/payloads de las herramientas
    assert.ok(!serverOutput.includes('super_secret_payload_content_12345'), 'Los payloads confidenciales no deben imprimirse');
    assert.ok(!serverOutput.includes('confidential_key_abc_999'), 'Las claves en argumentos no deben imprimirse');

    // Validar que el tag de la herramienta y el error se registran
    assert.match(serverOutput, /Argumento no permitido: secret_payload/, 'Debe registrarse el rechazo del argumento no permitido');
    assert.match(serverOutput, /ERROR:/, 'Debe registrarse la etiqueta ERROR en fallos de herramientas');
    assert.match(serverOutput, /<--\s+400 Bad Request/, 'Debe registrarse error 400 en JSON malformado');
    assert.match(serverOutput, /\[-32601\]\s*Herramienta local 'herramienta_fantasma' no encontrada/, 'Debe registrarse error descriptivo de herramienta no encontrada');
  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('Servidor local zerochat.py: heartbeat y apagado automático por inactividad', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'heartbeat-test-token-67890';

  // Iniciar servidor con timeout de heartbeat de 0.2 segundos para prueba ágil
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken), ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Rechazo de /zerochat/heartbeat sin token o con token inválido (401)
    const unauthHb = await fetch(`${baseUrl}/zerochat/heartbeat`);
    assert.equal(unauthHb.status, 401, 'Heartbeat sin token debe ser 401');

    const invalidHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': 'token-invalido-xyz' } });
    assert.equal(invalidHb.status, 401, 'Heartbeat con token inválido debe ser 401');

    // 3. Aceptación de /zerochat/heartbeat con token válido (200 {"ok": true})
    const authHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(authHb.status, 200, 'Heartbeat con token válido debe ser 200');
    const hbData = await authHb.json();
    assert.equal(hbData.ok, true, 'Heartbeat debe responder {"ok": true}');
    assert.equal(typeof hbData.cwd, 'string', 'Heartbeat debe publicar el directorio del proyecto');
    assert.equal(hbData.exit_on_close, true, 'Heartbeat avisa de que cerrar el navegador detiene el servidor');
    assert.deepEqual(hbData.jobs, []);

    // 4. Latido sucesivo antes de que expire el timeout (a los 100ms) mantiene vivo el servidor
    await new Promise(resolve => setTimeout(resolve, 100));
    const keepAliveHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(keepAliveHb.status, 200, 'Heartbeat periódico debe mantener vivo el servidor');

    // 5. Intento con token inválido a los 50ms no debe renovar el watchdog
    await new Promise(resolve => setTimeout(resolve, 50));
    const badTokenHb = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': 'fake-token' } });
    assert.equal(badTokenHb.status, 401, 'Token inválido debe seguir siendo rechazado');

    // 6. Esperar a que el watchdog detecte la inactividad (>0.2s desde el último válido) y apague el servidor automáticamente
    const exitPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El servidor no se apagó por inactividad de heartbeat')), 3000);
      serverProc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    await exitPromise;
    assert.match(serverOutput, /Navegador desconectado \(cierre detectado\)/, 'El log debe indicar la detección de cierre');
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
  }
});

test('Servidor local zerochat.py: --no-exit-on-close desactiva el watchdog', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'no-exit-token-99999';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-exit-on-close', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken), ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    await waitForServer(baseUrl, testToken, serverProc);

    // Enviar un heartbeat
    const hbRes = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(hbRes.status, 200);
    assert.equal((await hbRes.json()).exit_on_close, false, 'Cerrar la pestaña no detendrá los comandos');

    // Esperar 400ms (> ZEROCHAT_HEARTBEAT_TIMEOUT=0.2)
    await new Promise(resolve => setTimeout(resolve, 400));

    // El servidor debe seguir activo porque --no-exit-on-close desactivó el watchdog
    const checkRes = await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(checkRes.status, 200, 'El servidor debe seguir respondiendo con --no-exit-on-close');
    assert.match(serverOutput, /Auto-cierre\s*:\s*Desactivado/, 'El banner debe indicar auto-cierre desactivado');
  } finally {
    serverProc.kill('SIGTERM');
  }
});

test('Servidor local zerochat.py: peticiones RPC autenticadas (/mcp/external) inicializan y renuevan el watchdog sin /zerochat/heartbeat', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'rpc-watchdog-token-12345';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken), ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    // 1. Esperar arranque
    await waitForServer(baseUrl, testToken, serverProc);

    // 2. Enviar petición RPC a /mcp/external con token (tools/list)
    const rpcRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZeroChat-Token': testToken
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(rpcRes.status, 200, 'Llamada RPC debe devolver 200');

    // 3. Esperar a que el watchdog detecte la inactividad tras la llamada RPC (>0.2s)
    const exitPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El servidor no se apagó por inactividad tras RPC')), 3000);
      serverProc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    await exitPromise;
    assert.match(serverOutput, /Navegador desconectado \(cierre detectado\)/, 'El watchdog debe registrar desconexión tras actividad RPC');
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
  }
});

test('Servidor local zerochat.py: los métodos de control MCP responden con error JSON-RPC ante entradas inválidas', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const testToken = 'control-errors-token-12345';
  const dataDir = tokenDataDir(testToken);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--no-browser', '--no-venv', '--no-exit-on-close'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const rpc = async (method, params) => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    assert.equal(res.status, 200, method);
    return res.json();
  };

  try {
    await waitForServer(baseUrl, testToken, serverProc);
    for (const action of ['start', 'stop', 'configure']) {
      const method = `zerochat/external/servers/${action}`;
      const unknown = await rpc(method, { serverId: 'no-existe', options: {} });
      assert.equal(unknown.error?.code, -32602, `${method} con servidor desconocido`);
      assert.match(unknown.error?.message, /no-existe/);
      const invalidId = await rpc(method, { serverId: 42 });
      assert.equal(invalidId.error?.code, -32602, `${method} con serverId no textual`);
    }
    const invalidOptions = await rpc('zerochat/external/servers/configure', { serverId: 'ejemplo', options: 'x' });
    assert.equal(invalidOptions.error?.code, -32602);
    const status = await rpc('zerochat/external/status', {});
    assert.equal(status.result.servers.some(server => server.id === 'no-existe'), false);
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
