const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const pkg = require('../../package.json');
const { McpClient } = require('../../js/mcp.js');
const { tokenDataDir, waitForServer, freePort } = require('../helpers/backend-env.js');

// Un solo proceso para todos los comportamientos que comparten la misma CLI y el mismo entorno.
describe('Servidor local zerochat.py', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const testToken = 'test-token-secret-12345';
  const ORIGIN = 'https://albalday.github.io';
  const dataDir = tokenDataDir(testToken);
  let baseUrl = '';
  let serverProc = null;
  let serverOutput = '';
  let initResult = null;
  let nextId = 1;

  /** Cabeceras del sello de tools/call, como las calcula el cliente con la autorización de initialize. */
  function toolSeal(url, body) {
    const { sessionId, key, ttlMs } = initResult.toolAuthorization;
    const expiresAt = Date.now() + ttlMs;
    const nonce = crypto.randomBytes(16).toString('base64url');
    const pathName = new URL(url).pathname.replace(/\/$/, '') || '/';
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const signatureBase = JSON.stringify(['zerochat-tool-auth-v1', sessionId, 'POST', pathName, expiresAt, nonce, bodyHash]);
    return {
      'X-ZeroChat-Tool-Session': sessionId,
      'X-ZeroChat-Tool-Expires': String(expiresAt),
      'X-ZeroChat-Tool-Nonce': nonce,
      'X-ZeroChat-Tool-Signature': crypto.createHmac('sha256', Buffer.from(key, 'base64url')).update(signatureBase).digest('base64url')
    };
  }

  /** POST JSON-RPC con el token de sesión; tools/call va sellado salvo `seal: false`. */
  function post(method, params = {}, { endpoint = '', seal = method === 'tools/call', headers = {} } = {}) {
    const url = `${baseUrl}/${endpoint}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${testToken}`, ...(seal ? toolSeal(url, body) : {}), ...headers },
      body
    });
  }
  const rpc = async (method, params, options) => (await post(method, params, options)).json();
  async function callTool(name, args, meta) {
    const res = await post('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    assert.equal(res.status, 200);
    const json = await res.json();
    return { json, parsed: JSON.parse(json.result?.content?.[0]?.text) };
  }
  const heartbeat = async () => (await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } })).json();

  before(async () => {
    // browser_action usa solo el Playwright del servicio: se enlaza el de las pruebas en su lugar.
    const servicePlaywright = path.join(dataDir, 'services', 'playwright', 'node_modules', 'playwright');
    fs.mkdirSync(path.dirname(servicePlaywright), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'node_modules', 'playwright'), servicePlaywright, 'junction');
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProc = spawn('python3', [path.resolve(repoRoot, 'zerochat.py'), '--port', String(port), '--no-browser', '--no-venv'], {
      cwd: repoRoot,
      // Sin la configuración de Git del usuario: el visor de diffs solo ve la del repositorio de prueba.
      env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProc.stdout.on('data', chunk => { serverOutput += chunk; });
    await waitForServer(baseUrl, testToken, serverProc);
    initResult = (await rpc('initialize')).result;
  });

  after(() => serverProc?.kill('SIGTERM'));

  test('el arranque detecta el entorno de desarrollo y muestra la URL', () => {
    assert.match(serverOutput, /Desarrollo local/, 'Debe detectar el entorno de desarrollo');
    assert.match(serverOutput, new RegExp(baseUrl.replace(/\./g, '\\.')), 'Debe mostrar la URL destino en el arranque');
  });

  test('solo el token de sesión en cabecera autoriza, nunca en la URL', async () => {
    assert.equal((await fetch(`${baseUrl}/`)).status, 401, 'Petición GET sin token debe ser rechazada con 401');
    assert.equal((await post('initialize', {}, { headers: { Authorization: '' } })).status, 401, 'Petición POST sin token debe ser rechazada con 401');
    assert.equal((await post('initialize', {}, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401, 'Petición con token erróneo debe ser 401');
    assert.equal((await fetch(`${baseUrl}/?token=${testToken}`)).status, 401, 'El token en query string debe ser rechazado');
    assert.equal((await fetch(`${baseUrl}/sse?token=${testToken}`)).status, 401);
    const byHeader = await post('tools/list', {}, { headers: { Authorization: '', 'X-ZeroChat-Token': testToken } });
    assert.equal(byHeader.status, 200, 'X-ZeroChat-Token también autoriza');
    await byHeader.text();
  });

  test('favicon.ico responde vacío sin token, salvo a un origen ajeno', async () => {
    const favicon = await fetch(`${baseUrl}/favicon.ico`);
    assert.equal(favicon.status, 204);
    assert.equal(await favicon.text(), '');
    assert.equal((await fetch(`${baseUrl}/favicon.ico`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  });

  test('el cuerpo de una petición es un objeto JSON de hasta 1 MiB', async () => {
    const send = body => fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${testToken}` },
      body
    });
    assert.equal((await send(JSON.stringify([]))).status, 400, 'Una petición JSON que no sea un objeto debe rechazarse');
    try {
      assert.equal((await send('x'.repeat(1024 * 1024 + 1))).status, 413, 'Un cuerpo superior al límite debe rechazarse');
    } catch (err) {
      if (err?.cause?.code !== 'EPIPE' && err?.cause?.code !== 'ECONNRESET') throw err;
    }
  });

  test('el flujo SSE abre con el token en cabecera y el cliente MCP lo usa', async () => {
    const sseRes = await fetch(`${baseUrl}/sse`, { headers: { Accept: 'text/event-stream', 'X-ZeroChat-Token': testToken } });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');
    assert.equal(sseRes.headers.get('cache-control'), 'no-store');
    await sseRes.body.cancel();
    const client = new McpClient({ url: `${baseUrl}/sse`, token: testToken });
    try {
      assert.equal(await client.connectSseStream({ timeoutMs: 2000 }), `${baseUrl}/`);
      assert.equal(client.isSseActive, true);
      assert.ok(Array.isArray((await client.request('tools/list')).tools));
    } finally {
      client.disconnect();
    }
  });

  test('initialize publica el servidor, su versión, el SO y la autorización de herramientas', () => {
    assert.equal(initResult.serverInfo?.name, 'ZeroChat Local Server');
    assert.equal(initResult.serverInfo?.version, pkg.version.split('.').slice(0, 2).join('.'));
    assert.ok(typeof initResult.serverInfo?.os === 'string', 'serverInfo debe publicar el SO detectado');
    assert.equal(initResult.toolAuthorization?.version, 'zerochat-tool-auth-v1');
  });

  test('tools/call exige el sello del cliente, que admite un desfase de reloj de 25 s', async t => {
    const unsigned = await post('tools/call', { name: 'list_directory', arguments: { path: '.' } }, { seal: false });
    assert.equal(unsigned.status, 403, 'Una llamada tools/call sin sello debe rechazarse');
    await unsigned.text();
    const client = new McpClient({ id: 'mcp_proxy', url: baseUrl, token: testToken });
    try {
      assert.equal((await client.initialize()).success, true);
      assert.equal((await client.callTool('list_directory', { path: '.' }, { toolAuthorization: true })).success, true);
      // Con el navegador en otro equipo, su reloj puede ir adelantado o atrasado respecto al del servidor.
      const now = Date.now();
      t.mock.timers.enable({ apis: ['Date'], now });
      for (const skewMs of [25_000, -25_000]) {
        t.mock.timers.setTime(now + skewMs);
        assert.equal((await client.callTool('list_directory', { path: '.' }, { toolAuthorization: true })).success, true, `Desfase de reloj ${skewMs} ms`);
      }
    } finally {
      client.disconnect();
    }
  });

  test('tools/list publica las herramientas core con sus esquemas estrictos', async () => {
    const tools = (await rpc('tools/list')).result?.tools || [];
    const toolNames = tools.map(tool => tool.name);
    for (const name of ['list_directory', 'read_file', 'write_file', 'edit_file', 'run_command', 'check_command', 'search_files', 'get_diagnostics', 'browser_action']) {
      assert.ok(toolNames.includes(name), name);
    }
    assert.ok(!toolNames.includes('set_project_directory'), 'El cambio de proyecto no es una herramienta del modelo');
    const runTool = tools.find(tool => tool.name === 'run_command');
    assert.ok(runTool?.description?.includes('Host OS:'), 'run_command debe declarar el SO anfitrión');
    assert.match(runTool.description, /fresh/, 'run_command debe advertir de que cada llamada empieza de cero');
    assert.deepEqual(Object.keys(runTool.inputSchema.properties).sort(), ['background', 'command', 'timeout_seconds'], 'run_command no admite cwd');
    const editFile = tools.find(tool => tool.name === 'edit_file');
    assert.deepEqual(Object.keys(editFile.inputSchema.properties).sort(), ['new_str', 'old_str', 'path', 'replace_all'],
      'edit_file solo publica el reemplazo exacto; write_file cubre la escritura completa');
    assert.match(editFile.description, /several edit_file calls in the same response/,
      'edit_file indica al modelo que varias ediciones van en varias llamadas de la misma respuesta');
    assert.deepEqual(editFile.inputSchema.required.sort(), ['new_str', 'old_str', 'path']);
  });

  test('tools/call rechaza con 400 los argumentos que no cumplen el esquema publicado', async () => {
    const res = await post('tools/call', { name: 'run_command', arguments: { command: 'pwd', cwd: '/tmp' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error || '', /Argumento no permitido: cwd/);
  });

  test('el directorio del proyecto lo cambia la interfaz y lo publica el latido', async () => {
    const startCwd = initResult.serverInfo.cwd;
    const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-project-')));
    const setDirectory = params => rpc('zerochat/project/set_directory', params);
    try {
      const moved = await setDirectory({ path: projectDir });
      assert.equal(moved.result?.cwd, projectDir);
      assert.equal(moved.result?.previous_cwd, startCwd);
      const movedHb = await heartbeat();
      assert.equal(movedHb.cwd, projectDir, 'El heartbeat publica el nuevo directorio');
      assert.deepEqual(movedHb.playwright, { installed: true, browserAction: { available: true } }, 'El heartbeat publica el estado de Playwright');
      for (const params of [{ path: path.join(projectDir, 'missing') }, { path: 7 }, {}]) {
        assert.equal((await setDirectory(params)).error?.code, -32602, JSON.stringify(params));
      }
    } finally {
      assert.equal((await setDirectory({ path: startCwd })).result?.cwd, startCwd);
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('el visor de diffs exige un visor gráfico y abre el del árbol de trabajo o el del último commit', async () => {
    const openDiff = params => rpc('zerochat/diff/open', params);
    const nonGitDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-nongit-')));
    const nonGitFile = path.join(nonGitDir, 'test.txt');
    fs.writeFileSync(nonGitFile, 'hello');
    const gitTestDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-git-')));
    const trackedFile = path.join(gitTestDir, 'tracked.txt');
    const untrackedFile = path.join(gitTestDir, 'untracked.txt');
    fs.writeFileSync(trackedFile, 'initial\n');
    fs.writeFileSync(untrackedFile, 'new\n');
    execSync('git init && git config user.name test && git config user.email test@test.com && git add tracked.txt && git commit -m "init"', { cwd: gitTestDir, stdio: 'ignore' });
    fs.appendFileSync(trackedFile, 'change\n');

    const killPid = pid => {
      if (!pid) return;
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        } else {
          process.kill(-pid, 'SIGKILL');
        }
      } catch (_) {
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
      }
    };

    try {
      for (const params of [{}, { path: 123 }, { path: '' }, { path: 'nonexistent/file.txt' }, { path: gitTestDir }]) {
        assert.equal((await openDiff(params)).error?.code, -32602, JSON.stringify(params));
      }

      // Sin visor gráfico configurado no se lanza nada (git recurriría a uno de terminal invisible): se propone uno.
      const noGuiToolRes = await openDiff({ path: trackedFile });
      assert.equal(noGuiToolRes.result?.success, false);
      assert.ok(noGuiToolRes.result.setup.commands.includes(`git config --global diff.guitool ${noGuiToolRes.result.setup.tool}`));
      assert.equal((await rpc('zerochat/diff/configure', { tool: 'nano' })).error?.code, -32602);
      // Visor gráfico de prueba que termina sin abrir ventana.
      execSync('git config diff.guitool zcfake && git config difftool.zcfake.cmd true', { cwd: gitTestDir, stdio: 'ignore' });

      const nonGitRes = await openDiff({ path: nonGitFile });
      assert.equal(nonGitRes.error?.code, -32602);
      assert.match(nonGitRes.error?.message, /repositorio Git/);

      const trackedRes = await openDiff({ path: trackedFile });
      assert.equal(trackedRes.result?.success, true);
      assert.equal(trackedRes.result?.has_diff, true);
      assert.equal(trackedRes.result?.mode, 'working_tree');
      assert.equal(trackedRes.result?.in_head, true);
      assert.equal(typeof trackedRes.result?.pid, 'number');
      killPid(trackedRes.result?.pid);

      const untrackedRes = await openDiff({ path: untrackedFile });
      assert.equal(untrackedRes.result?.success, true);
      assert.equal(untrackedRes.result?.has_diff, true);
      assert.equal(untrackedRes.result?.in_head, false);
      assert.equal(typeof untrackedRes.result?.pid, 'number');
      killPid(untrackedRes.result?.pid);

      // Tras hacer commit del fichero, no hay diffs en working tree
      execSync('git commit -am "second commit"', { cwd: gitTestDir, stdio: 'ignore' });
      const cleanRes = await openDiff({ path: trackedFile });
      assert.equal(cleanRes.result?.success, true);
      assert.equal(cleanRes.result?.has_diff, false);
      assert.equal(cleanRes.result?.has_commit_history, true);
      assert.equal(cleanRes.result?.pid, undefined);

      // Con commit_fallback: true, lanza el diff del último commit
      const fallbackRes = await openDiff({ path: trackedFile, commit_fallback: true });
      assert.equal(fallbackRes.result?.success, true);
      assert.equal(fallbackRes.result?.has_diff, true);
      assert.equal(fallbackRes.result?.mode, 'commit');
      assert.equal(typeof fallbackRes.result?.pid, 'number');
      killPid(fallbackRes.result?.pid);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
      fs.rmSync(gitTestDir, { recursive: true, force: true });
    }
  });

  test('las herramientas de archivos responden por tools/call y sus errores llegan con isError', async t => {
    const read = await callTool('read_file', { path: 'package.json', max_lines: 10 });
    assert.equal(read.json.result?.isError, false);
    assert.match(read.parsed.content, new RegExp(`"version": "${pkg.version}"`));

    const testFilePath = path.join(os.tmpdir(), `zerochat_test_p1_${Date.now()}.txt`);
    t.after(() => fs.rmSync(testFilePath, { force: true }));
    assert.equal((await callTool('write_file', { path: testFilePath, content: 'primera linea\nsegunda linea\n' })).parsed.success, true);
    assert.equal((await callTool('edit_file', { path: testFilePath, old_str: 'segunda', new_str: 'otra' })).parsed.replacements, 1);
    assert.equal(fs.readFileSync(testFilePath, 'utf8'), 'primera linea\notra linea\n');
    const notFound = await callTool('edit_file', { path: testFilePath, old_str: 'inexistente', new_str: 'x' });
    assert.equal(notFound.json.result.isError, true);
    assert.match(notFound.parsed.error, /Target text was not found/);
  });

  test('run_command empieza en el proyecto y un código de salida distinto de cero llega con isError', async () => {
    const failing = await callTool('run_command', { command: 'pwd; echo dos >&2; exit 2' });
    assert.equal(failing.json.result.isError, true);
    assert.equal(failing.parsed.exit_code, 2);
    assert.equal(failing.parsed.output, `${fs.realpathSync(repoRoot)}\ndos\n`);
  });

  test('un comando en marcha se publica en el latido y se sigue y se detiene con zerochat/jobs/*', async () => {
    // En primer plano y con la clave de su tarjeta, el comando figura en marcha mientras se espera su respuesta.
    const pending = callTool('run_command', { command: 'echo listo; exec sleep 100' }, { zerochatJobKey: 'tarjeta-prueba-1' });
    let details;
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 20))) {
      details = (await rpc('zerochat/jobs/get', { key: 'tarjeta-prueba-1' })).result;
      if (details?.tail === 'listo\n') break;
    }
    assert.equal(details?.tail, 'listo\n');
    assert.ok((await heartbeat()).jobs.some(job => job.id === details.id && job.status === 'running'), 'El latido publica los comandos en marcha');
    const page = await rpc('zerochat/jobs/log', { id: details.id, offset: 2, limit: 3 });
    assert.deepEqual([page.result.text, page.result.next, page.result.done], ['sto', 5, false]);
    assert.ok((await rpc('zerochat/jobs/list')).result.jobs.some(job => job.key === 'tarjeta-prueba-1'));
    const stopped = await rpc('zerochat/jobs/stop', { key: 'tarjeta-prueba-1' });
    assert.deepEqual([stopped.result.status, stopped.result.stop_reason], ['stopped', 'user']);
    assert.equal((await pending).parsed.status, 'stopped');
    assert.equal((await callTool('check_command', { job_id: details.id })).parsed.status, 'stopped');
    assert.ok(Array.isArray((await rpc('zerochat/jobs/report', { ids: [details.id] })).result.reports));
    for (const [method, params] of [['zerochat/jobs/log', { id: details.id, offset: -1 }], ['zerochat/jobs/get', { id: 99999 }],
      ['zerochat/jobs/report', { ids: 'x' }], ['zerochat/jobs/report', { ids: [true] }]]) {
      assert.equal((await rpc(method, params)).error?.code, -32602, `${method} ${JSON.stringify(params)}`);
    }
  });

  test('search_files busca en el proyecto', async () => {
    const found = (await callTool('search_files', { query: 'def set_project_directory', path: '.', file_pattern: '*.py' })).parsed;
    assert.equal(found.success, true);
    assert.ok(found.matches.some(match => match.relative_path.includes('dd-tools.py') || match.relative_path.includes('zerochat.py')));
  });

  test('get_diagnostics revisa un archivo concreto', async () => {
    const diagnostics = (await callTool('get_diagnostics', { path: 'package.json' })).parsed;
    assert.equal(diagnostics.success, true);
    assert.equal(diagnostics.error_count, 0);
  });

  test('browser_action navega y hace una captura', async () => {
    const navigated = (await callTool('browser_action', { action: 'navigate', url: 'about:blank' })).parsed;
    assert.equal(navigated.success, true);
    assert.equal(navigated.action, 'navigate');
    const screenshot = (await callTool('browser_action', { action: 'screenshot' })).parsed;
    assert.equal(screenshot.success, true);
    assert.equal(screenshot.action, 'screenshot');
    assert.ok(typeof screenshot.image_base64 === 'string' && screenshot.image_base64.length > 50);
  });

  test('los servicios MCP integrados se publican en el latido y se arrancan, usan y detienen uno a uno', async () => {
    const listedServers = (await heartbeat()).servers;
    const serverIds = listedServers.map(server => server.id);
    for (const id of ['ejemplo', 'composio', 'playwright', 'memory']) assert.ok(serverIds.includes(id), `${id} debe estar provisto`);
    assert.equal(serverIds.includes('lsp'), false, 'lsp no debe ofrecerse como servicio integrado');
    const exampleServer = listedServers.find(server => server.id === 'ejemplo');
    assert.equal(exampleServer?.status, 'stopped');
    assert.equal(exampleServer?.help?.url, 'help/mcp.html#crear-mcp-con-agente');
    assert.deepEqual(listedServers.find(server => server.id === 'composio')?.remote, {
      type: 'mcp-remote',
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      authentication: 'composio-connect'
    });

    const start = params => rpc('zerochat/external/servers/start', { serverId: 'ejemplo', ...params });
    // Solo Playwright MCP admite el navegador que exige un perfil.
    assert.deepEqual((await start({ remember: false, browser: { mode: 'own', engine: 'chromium' } })).error,
      { code: -32602, message: 'ejemplo no admite elegir navegador.' });
    // Arrancar sin decir si se recuerda es un error del cliente.
    assert.deepEqual((await start({})).error, { code: -32602, message: 'remember es obligatorio al arrancar y debe ser un booleano.' });

    const runningExample = ((await start({ remember: true })).result?.servers || []).find(server => server.id === 'ejemplo');
    assert.equal(runningExample?.status, 'running');
    assert.equal(runningExample?.toolCount, 1);
    assert.equal(runningExample?.browser, null);

    const extToolNames = ((await rpc('tools/list', {}, { endpoint: 'mcp/external' })).result?.tools || []).map(tool => tool.name);
    assert.ok(extToolNames.includes('ejemplo_echo'));
    const extCall = await rpc('tools/call', { name: 'ejemplo_echo', arguments: { message: 'probando mcp' } }, { endpoint: 'mcp/external' });
    assert.equal(extCall.result?.isError, false);
    assert.equal(extCall.result?.content?.[0]?.text, 'echo: probando mcp');

    const stoppedExample = ((await rpc('zerochat/external/servers/stop', { serverId: 'ejemplo' })).result?.servers || []).find(server => server.id === 'ejemplo');
    assert.equal(stoppedExample?.status, 'stopped');
    assert.equal(stoppedExample?.toolCount, 0);
  });

  test('en desarrollo local sirve zerochat.html y sus estáticos sin token, sin salir de la raíz', async () => {
    const htmlRes = await fetch(`${baseUrl}/zerochat.html`);
    assert.equal(htmlRes.status, 200, 'Debe servir zerochat.html con 200 OK');
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);
    assert.ok((await htmlRes.text()).includes('ZeroChat'), 'El contenido debe ser el HTML de ZeroChat');
    for (const [file, type] of [['js/app.js', /javascript/], ['css/tokens.css', /text\/css/], ['manifest.webmanifest', /manifest/]]) {
      const res = await fetch(`${baseUrl}/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type') || '', type, file);
      await res.text();
    }
    const traversalRes = await fetch(`${baseUrl}/../package.json`);
    assert.notEqual(traversalRes.status, 200, 'No debe permitir acceso fuera de la raíz');
    await traversalRes.text();
  });
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

    // 7. Las consultas periódicas de la interfaz no se registran; detener un comando, sí.
    const controlRpc = (id, method, params) => fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ZeroChat-Token': testToken },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    await controlRpc(13, 'zerochat/jobs/list', {});
    await controlRpc(14, 'zerochat/jobs/get', { key: 'clave-inexistente' });
    await controlRpc(15, 'zerochat/jobs/log', { id: 999, offset: 0 });
    await controlRpc(16, 'zerochat/jobs/stop', { id: 999 });

    // Dar margen para vaciar buffers de stdout
    await new Promise(resolve => setTimeout(resolve, 150));

    assert.ok(!/zerochat\/jobs\/(list|get|log)/.test(serverOutput), 'Las consultas periódicas de la interfaz no deben llenar la consola');
    assert.match(serverOutput, /\[rpc: zerochat\/jobs\/stop\]/, 'Las acciones sobre comandos sí se registran');

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

    // 6. Una petición RPC autenticada a /mcp/external renueva el watchdog sin /zerochat/heartbeat
    const rpcRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ZeroChat-Token': testToken },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(rpcRes.status, 200, 'Llamada RPC debe devolver 200');

    // 7. Esperar a que el watchdog detecte la inactividad (>0.2s desde la última actividad válida) y apague el servidor automáticamente
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

test('Servidor local zerochat.py: --keep-server desactiva el watchdog y --print-url muestra la URL', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'no-exit-token-99999';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--print-url', '--keep-server', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_DATA_DIR: tokenDataDir(testToken) },
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

    // El servidor debe seguir activo porque --keep-server desactivó el watchdog
    const checkRes = await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(checkRes.status, 200, 'El servidor debe seguir respondiendo con --keep-server');
    assert.match(serverOutput, /Auto-cierre\s*:\s*Desactivado/, 'El banner debe indicar auto-cierre desactivado');
    // --print-url: la URL con el token, rodeada de cinco líneas en blanco para copiarla.
    assert.match(serverOutput, new RegExp(`={64}\\n{6}https?://\\S+#token=${testToken}&host=127\\.0\\.0\\.1&port=${port}\\n{6}(?!\\n)`));

    // Métodos de control MCP: error JSON-RPC ante entradas inválidas
    const rpc = async (method, params) => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      assert.equal(res.status, 200, method);
      return res.json();
    };
    for (const action of ['start', 'stop', 'configure']) {
      const method = `zerochat/external/servers/${action}`;
      const unknown = await rpc(method, { serverId: 'no-existe', options: {}, remember: false });
      assert.equal(unknown.error?.code, -32602, `${method} con servidor desconocido`);
      assert.match(unknown.error?.message, /no-existe/);
      const invalidId = await rpc(method, { serverId: 42 });
      assert.equal(invalidId.error?.code, -32602, `${method} con serverId no textual`);
    }
    const invalidOptions = await rpc('zerochat/external/servers/configure', { serverId: 'ejemplo', options: 'x' });
    assert.equal(invalidOptions.error?.code, -32602);
    const heartbeat = await (await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } })).json();
    assert.equal(heartbeat.servers.some(server => server.id === 'no-existe'), false);
  } finally {
    serverProc.kill('SIGTERM');
  }
});
