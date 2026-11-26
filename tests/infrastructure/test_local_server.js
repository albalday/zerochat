const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const pkg = require('../../package.json');
const { McpClient } = require('../../js/mcp.js');
const { tokenDataDir, startServer } = require('../helpers/backend-env.js');

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

  /** POST JSON-RPC con el token de sesión. */
  function post(method, params = {}, { endpoint = '', headers = {} } = {}) {
    const url = `${baseUrl}/${endpoint}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${testToken}`, ...headers },
      body
    });
  }
  const rpc = async (method, params, options) => (await post(method, params, options)).json();
  async function callTool(name, args, meta, headers = {}) {
    const res = await post('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, { headers });
    assert.equal(res.status, 200);
    let json = await res.json();
    if (json.result?.requiresAuthorization) {
      const auth = await rpc('zerochat/security/authorize', {
        challengeId: json.result.challengeId,
        decision: 'allow_once',
        directoryRule: `RW:${os.tmpdir()}/**`
      }, { headers });
      json = { jsonrpc: '2.0', id: json.id, result: auth.result?.result };
    }
    return { json, parsed: JSON.parse(json.result?.content?.[0]?.text) };
  }
  const heartbeat = async () => (await rpc('zerochat/heartbeat')).result;

  before(async () => {
    // browser_action usa solo el Playwright del servicio: se enlaza el de las pruebas en su lugar.
    const servicePlaywright = path.join(dataDir, 'services', 'playwright', 'node_modules', 'playwright');
    fs.mkdirSync(path.dirname(servicePlaywright), { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'node_modules', 'playwright'), servicePlaywright, 'junction');
    ({ baseUrl, serverProc } = await startServer(port => {
      const proc = spawn('python3', [path.resolve(repoRoot, 'zerochat.py'), '--port', String(port), '--no-browser', '--no-venv'], {
        cwd: repoRoot,
        // Sin la configuración de Git del usuario: el visor de diffs solo ve la del repositorio de prueba.
        env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      serverOutput = '';
      proc.stdout.on('data', chunk => { serverOutput += chunk; });
      return proc;
    }, testToken));
    initResult = (await rpc('initialize')).result;
  });

  after(() => serverProc?.kill('SIGTERM'));

  test('initialize publica el servidor, su versión, el SO, la carpeta general y el estado vivo del latido', async () => {
    assert.match(serverOutput, /Desarrollo local/, 'Debe detectar el entorno de desarrollo');
    assert.match(serverOutput, new RegExp(baseUrl.replace(/\./g, '\\.')), 'Debe mostrar la URL destino en el arranque');
    assert.equal(initResult.serverInfo?.name, 'ZeroChat Local Server');
    const noProjectDir = path.join(fs.realpathSync(dataDir), 'general');
    assert.equal(initResult.serverInfo?.noProjectDir, noProjectDir);
    assert.ok(fs.statSync(noProjectDir).isDirectory(), 'initialize crea la carpeta general');
    assert.equal(initResult.serverInfo?.version, pkg.version.split('.').slice(0, 2).join('.'));
    assert.ok(typeof initResult.serverInfo?.os === 'string', 'serverInfo debe publicar el SO detectado');
    assert.deepEqual(Object.keys(initResult.liveState).sort(), Object.keys(await heartbeat()).sort());
    assert.equal(initResult.liveState.exit_on_close, true);
  });

  test('solo el token en cabecera autoriza, zerochat/login admite hasta 4096 bytes sin token y la API va por POST con CORS', async () => {
    assert.equal((await post('initialize', {}, { headers: { Authorization: '' } })).status, 401);
    assert.equal((await post('initialize', {}, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
    assert.equal((await post('initialize', {}, { endpoint: `?token=${testToken}`, headers: { Authorization: '' } })).status, 401);
    const byHeader = await post('tools/list', {}, { headers: { Authorization: '', 'X-ZeroChat-Token': testToken } });
    assert.equal(byHeader.status, 200);
    await byHeader.text();

    const loginBody = size => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'zerochat/login', params: { user: '', password: '' } });
      return body.slice(0, -1) + ' '.repeat(size - body.length) + '}';
    };
    const sendNoToken = (body, origin = { Origin: ORIGIN }) => fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...origin }, body });
    const atLimit = await sendNoToken(loginBody(4096));
    assert.equal(atLimit.status, 200);
    assert.equal((await atLimit.json()).error?.code, -32602);
    assert.equal((await sendNoToken(loginBody(4097))).status, 401);
    // Un iframe sandbox de cualquier web llega con Origin: null; la CLI y el runner, sin Origin.
    assert.equal((await sendNoToken(loginBody(4096), { Origin: 'null' })).status, 403);
    assert.equal((await (await sendNoToken(loginBody(4096), {})).json()).error?.code, -32602);
    // Un origen local solo vale si es el de la petición (la interfaz que sirve este servidor); otra web local, no.
    const own = new URL(baseUrl);
    assert.equal((await (await sendNoToken(loginBody(4096), { Origin: own.origin })).json()).error?.code, -32602);
    for (const other of [`http://${own.hostname}:${Number(own.port) + 1}`, `http://localhost:${own.port}`, `http://${own.hostname}`]) {
      assert.equal((await sendNoToken(loginBody(4096), { Origin: other })).status, 403, other);
    }
    assert.equal((await post('zerochat/heartbeat', {}, { headers: { Authorization: '' } })).status, 401);

    const api = await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(api.status, 404);
    await api.text();
    const preflight = await fetch(baseUrl, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-zerochat-proxy, x-zerochat-blob, x-zerochat-project' }
    });
    assert.equal(preflight.status, 204);
    assert.deepEqual(preflight.headers.get('access-control-allow-headers').split(', '), [
      'Content-Type', 'Accept', 'Authorization', 'X-ZeroChat-Token', 'X-ZeroChat-Client', 'X-ZeroChat-Proxy', 'X-ZeroChat-Blob', 'X-ZeroChat-Project'
    ]);
    const client = new McpClient({ url: baseUrl, token: testToken });
    assert.ok(Array.isArray((await client.request('tools/list')).tools));
  });

  test('el cuerpo es un objeto JSON de hasta 1 MiB, salvo zerochat/blobs/put con X-ZeroChat-Blob', async () => {
    const send = body => fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${testToken}` },
      body
    });
    assert.equal((await send(JSON.stringify([]))).status, 400);
    try {
      assert.equal((await send('x'.repeat(1024 * 1024 + 1))).status, 413);
    } catch (err) {
      if (err?.cause?.code !== 'EPIPE' && err?.cause?.code !== 'ECONNRESET') throw err;
    }

    const rawData = 'B'.repeat(1024 * 1024 + 100);
    const b64Data = Buffer.from(rawData).toString('base64');
    const client = new McpClient({ url: baseUrl, token: testToken });
    const res = await client.request('zerochat/blobs/put', {
      mimeType: 'text/plain',
      data: `data:text/plain;base64,${b64Data}`
    }, { headers: { 'X-ZeroChat-Blob': '1' } });
    assert.ok(res?.id);
    assert.equal(res.size, rawData.length);

    try {
      const rejected = await send(JSON.stringify({
        jsonrpc: '2.0',
        id: 998,
        method: 'zerochat/blobs/put',
        params: { mimeType: 'text/plain', data: `data:text/plain;base64,${b64Data}` }
      }));
      assert.equal(rejected.status, 413);
    } catch (err) {
      if (err?.cause?.code !== 'EPIPE' && err?.cause?.code !== 'ECONNRESET') throw err;
    }
  });

  test('tools/list publica las herramientas core con sus esquemas estrictos y tools/call valida argumentos y control de acceso', async () => {
    const tools = (await rpc('tools/list')).result?.tools || [];
    const toolNames = tools.map(tool => tool.name);
    for (const name of ['list_directory', 'read_file', 'write_file', 'edit_file', 'run_command', 'check_command', 'search_files', 'get_diagnostics', 'browser_action']) {
      assert.ok(toolNames.includes(name), name);
    }
    const runTool = tools.find(tool => tool.name === 'run_command');
    assert.ok(runTool?.description?.includes('Host OS:'), 'run_command debe declarar el SO anfitrión');
    assert.match(runTool.description, /fresh/, 'run_command debe advertir de que cada llamada empieza de cero');
    assert.deepEqual(Object.keys(runTool.inputSchema.properties).sort(), ['background', 'command', 'timeout_seconds'], 'run_command no admite cwd');
    const editFile = tools.find(tool => tool.name === 'edit_file');
    assert.deepEqual(Object.keys(editFile.inputSchema.properties).sort(), ['new_str', 'old_str', 'path', 'replace_all']);
    assert.match(editFile.description, /several edit_file calls in the same response/);
    assert.deepEqual(editFile.inputSchema.required.sort(), ['new_str', 'old_str', 'path']);

    const badArgs = await post('tools/call', { name: 'run_command', arguments: { command: 'pwd', cwd: '/tmp' } });
    assert.equal(badArgs.status, 400);
    assert.match((await badArgs.json()).error || '', /Argumento no permitido: cwd/);

    const client = new McpClient({ id: 'mcp_proxy', url: baseUrl, token: testToken });
    assert.equal((await client.initialize()).success, true);
    assert.equal((await client.callTool('list_directory', { path: '.' })).success, true);

    const cmdRes = await client.request('tools/call', { name: 'run_command', arguments: { command: 'echo test $X' } });
    assert.equal(cmdRes.requiresAuthorization, true);
    assert.ok(cmdRes.challengeId);
    const authRes = await client.request('zerochat/security/authorize', { challengeId: cmdRes.challengeId, decision: 'allow_once' });
    assert.equal(authRes.authorized, true);
    assert.ok(authRes.result?.content?.[0]?.text?.includes('test'));
  });

  test('herramientas de archivos y run_command responden por tools/call y sus errores llegan con isError', async t => {
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

    const failing = await callTool('run_command', { command: 'pwd; echo dos >&2; exit 2' });
    assert.equal(failing.json.result.isError, true);
    assert.equal(failing.parsed.exit_code, 2);
    assert.equal(failing.parsed.output, `${fs.realpathSync(repoRoot)}\ndos\n`);
  });

  test('cada pestaña trabaja en el proyecto de su cabecera, set_directory/browse/create_directory validan rutas y el latido publica Playwright', async () => {
    const projects = ['a', 'b'].map(name => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `zc-proyecto-${name}-`))));
    const header = dir => ({ 'X-ZeroChat-Project': encodeURIComponent(dir) });
    try {
      for (const params of [{ path: path.join(projects[0], 'missing') }, { path: 7 }, {}]) {
        assert.equal((await rpc('zerochat/project/set_directory', params)).error?.code, -32602, JSON.stringify(params));
      }
      fs.mkdirSync(path.join(projects[0], 'sub'));
      assert.deepEqual((await rpc('zerochat/project/browse', { path: projects[0] })).result?.directories, ['sub']);
      assert.equal((await rpc('zerochat/project/create_directory', { parent: projects[0], name: '../x' })).error?.code, -32602);
      assert.deepEqual((await heartbeat()).playwright, { installed: true, browserAction: { available: true } });

      for (const dir of projects) {
        assert.equal((await callTool('run_command', { command: 'pwd' }, null, header(dir))).parsed.output, `${dir}\n`);
        assert.equal((await rpc('zerochat/heartbeat', {}, { headers: header(dir) })).result.cwd, dir);
      }
      // Elegir carpeta solo la valida para la pestaña y devuelve sus políticas y entorno: sin cabecera sigue el proyecto por defecto
      const setEnv = await rpc('zerochat/project/environment/set', { systemDataPrompt: 'Regla B', browser: 'playwright', mcpServers: ['memory'] }, { headers: header(projects[1]) });
      assert.equal(setEnv.result.projectEnvironment.browser, 'playwright');
      assert.deepEqual(setEnv.result.projectEnvironment.mcpServers, ['memory']);
      const chosen = await rpc('zerochat/project/set_directory', { path: projects[1] }, { headers: header(projects[0]) });
      assert.equal(chosen.result.cwd, projects[1]);
      assert.equal(chosen.result.policies.directoryRules[0], `RWX:${projects[1]}/**`);
      assert.equal(chosen.result.projectEnvironment.browser, 'playwright');
      assert.equal(chosen.result.projectEnvironment.systemDataPrompt, 'Regla B');
      assert.equal((await rpc('zerochat/heartbeat')).result.cwd, fs.realpathSync(repoRoot));

      fs.rmSync(projects[1], { recursive: true });
      const gone = await post('tools/call', { name: 'run_command', arguments: { command: 'pwd' } }, { headers: header(projects[1]) });
      assert.equal((await gone.json()).error.code, -32003, 'Nunca se ejecuta en otra carpeta');
      // initialize sí responde, con el proyecto por defecto y su entorno, para que la pestaña sepa dónde está
      const fallbackInit = await rpc('initialize', {}, { headers: header(projects[1]) });
      assert.equal(fallbackInit.result.serverInfo.cwd, fs.realpathSync(repoRoot));
      assert.equal(fallbackInit.result.projectEnvironment.saved, false);
    } finally {
      projects.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
    }
  });

  test('un comando en marcha se publica en el latido y se sigue y se detiene con zerochat/jobs/*', async () => {
    // En primer plano y con la clave de su tarjeta, el comando figura en marcha mientras se espera su respuesta.
    const pending = callTool('run_command', { command: 'echo listo; exec sleep 100' }, { zerochatJobKey: 'tarjeta-prueba-1' });
    // Como la tarjeta: por la clave, el log espera a que se lance el comando y a su primera salida.
    const first = (await rpc('zerochat/jobs/log', { key: 'tarjeta-prueba-1', offset: 0, wait_ms: 5000 })).result;
    assert.equal(first?.text, 'listo\n');
    const details = first.details;
    assert.ok((await heartbeat()).jobs.some(job => job.id === details.id && job.status === 'running'), 'El latido publica los comandos en marcha');
    const page = await rpc('zerochat/jobs/log', { id: details.id, offset: 2, limit: 3 });
    assert.deepEqual([page.result.text, page.result.offset, page.result.next, page.result.done, page.result.details.id], ['sto', 2, 5, false, details.id]);
    const tailPage = await rpc('zerochat/jobs/log', { id: details.id, tail: 3 });
    assert.deepEqual([tailPage.result.text, tailPage.result.offset, tailPage.result.next], ['to\n', 3, 6]);
    assert.ok((await rpc('zerochat/jobs/list')).result.jobs.some(job => job.key === 'tarjeta-prueba-1'));
    const stopped = await rpc('zerochat/jobs/stop', { key: 'tarjeta-prueba-1' });
    assert.deepEqual([stopped.result.status, stopped.result.stop_reason, Array.isArray(stopped.result.jobs)], ['stopped', 'user', true]);
    assert.equal((await pending).parsed.status, 'stopped');
    assert.equal((await callTool('check_command', { job_id: details.id })).parsed.status, 'stopped');
    assert.ok(Array.isArray((await rpc('zerochat/jobs/report', { ids: [details.id] })).result.reports));
    for (const [method, params] of [['zerochat/jobs/log', { id: details.id, offset: -1 }], ['zerochat/jobs/log', { id: details.id, tail: -1 }], ['zerochat/jobs/get', { id: 99999 }],
      ['zerochat/jobs/report', { ids: 'x' }], ['zerochat/jobs/report', { ids: [true] }]]) {
      assert.equal((await rpc(method, params)).error?.code, -32602, `${method} ${JSON.stringify(params)}`);
    }
  });

  test('browser_action navega y hace una captura', async () => {
    // localhost se admite (webs en desarrollo); otros esquemas no llegan al navegador.
    const navigated = (await callTool('browser_action', { action: 'navigate', url: `${baseUrl}/` })).parsed;
    assert.equal(navigated.success, true);
    assert.ok((await callTool('browser_action', { action: 'navigate', url: 'file:///etc/passwd' })).parsed.error);
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
    const started = (await start({})).result;
    const runningExample = (started?.servers || []).find(server => server.id === 'ejemplo');
    assert.equal(runningExample?.status, 'running');
    assert.equal(runningExample?.toolCount, 1);

    const extToolNames = (started?.externalTools || []).map(tool => tool.name);
    assert.ok(extToolNames.includes('ejemplo_echo'));
    const extCallRes = await rpc('tools/call', { name: 'ejemplo_echo', arguments: { message: 'probando mcp' } });
    let extCall = extCallRes;
    if (extCallRes.result?.requiresAuthorization) {
      const auth = await rpc('zerochat/security/authorize', {
        challengeId: extCallRes.result.challengeId,
        decision: 'allow_once'
      });
      extCall = { result: auth.result?.result };
    }
    assert.equal(extCall.result?.isError, false);
    assert.equal(extCall.result?.content?.[0]?.text, 'echo: probando mcp');

    const stoppedExample = ((await rpc('zerochat/external/servers/stop', { serverId: 'ejemplo' })).result?.servers || []).find(server => server.id === 'ejemplo');
    assert.equal(stoppedExample?.status, 'stopped');
    assert.equal(stoppedExample?.toolCount, 0);

    for (const action of ['start', 'stop', 'configure']) {
      const method = `zerochat/external/servers/${action}`;
      const unknown = await rpc(method, { serverId: 'no-existe', options: {} });
      assert.equal(unknown.error?.code, -32602, `${method} con servidor desconocido`);
      assert.match(unknown.error?.message, /no-existe/);
      const invalidId = await rpc(method, { serverId: 42 });
      assert.equal(invalidId.error?.code, -32602, `${method} con serverId no textual`);
    }
    assert.equal((await rpc('zerochat/external/servers/configure', { serverId: 'ejemplo', options: 'x' })).error?.code, -32602);
  });

  test('en desarrollo local sirve zerochat.html y sus estáticos sin token y rechaza segmentos .. en cualquier método', async () => {
    const htmlRes = await fetch(`${baseUrl}/zerochat.html`);
    assert.equal(htmlRes.status, 200, 'Debe servir zerochat.html con 200 OK');
    assert.match(htmlRes.headers.get('content-type') || '', /text\/html/);
    assert.ok((await htmlRes.text()).includes('ZeroChat'), 'El contenido debe ser el HTML de ZeroChat');
    for (const [file, type] of [['files.html', /text\/html/], ['js/app.js', /javascript/], ['css/tokens.css', /text\/css/], ['manifest.webmanifest', /manifest/]]) {
      const res = await fetch(`${baseUrl}/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('content-type') || '', type, file);
      await res.text();
    }
    // Sin lista de ficheros: se sirve lo que hay bajo la raíz, salvo lo oculto.
    for (const [file, status] of [['package.json', 200], ['.zerochat/plan.md', 404], ['.git/HEAD', 404]]) {
      const res = await fetch(`${baseUrl}/${file}`);
      assert.equal(res.status, status, file);
      await res.text();
    }

    // fetch normaliza la ruta antes de enviarla: estas peticiones van tal cual por http.request.
    const raw = (method, rawPath, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: Number(new URL(baseUrl).port), method, path: rawPath, headers }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{"jsonrpc":"2.0","id":1,"method":"zerochat/heartbeat"}' : undefined);
    });
    for (const [method, rawPath] of [['GET', '/js/../package.json'], ['GET', '/js/%2e%2e/package.json'], ['GET', '/js\\..\\package.json'],
      ['POST', '/mcp/../mcp/external'], ['OPTIONS', '/js/../x']]) {
      const res = await raw(method, rawPath, { Origin: 'http://evil.example', 'Content-Type': 'application/json', 'X-ZeroChat-Token': testToken });
      assert.deepEqual([res.status, res.body], [400, '{"error": "Invalid path"}'], `${method} ${rawPath}`);
    }
    // Un .. en la consulta no es una ruta.
    assert.equal((await raw('GET', '/files.html?path=../x')).status, 200);
  });

  test('guarda por HTTP real conversaciones de más de 1 MiB en tramos sin recibir 413', async () => {
    const Storage = require('../../js/storage.js');
    const client = new McpClient({ url: baseUrl, token: testToken, headers: { Origin: ORIGIN } });
    const messages = [
      { id: 'big_1', role: 'user', content: 'A'.repeat(450 * 1024) },
      { id: 'big_2', role: 'assistant', content: 'B'.repeat(450 * 1024) },
      { id: 'big_3', role: 'tool', content: `${'C'.repeat(400 * 1024)}🚀`, tool_call_id: 'call_big' },
    ];
    const saved = await Storage.saveRemoteConversation(
      (method, params) => client.request(method, params),
      { id: 'conv_http_chunked', title: 'Conversación > 1 MiB' },
      messages
    );
    assert.equal(saved.conversation.messageCount, 3);
    const loaded = await client.request('zerochat/conversations/get', { id: 'conv_http_chunked' });
    assert.equal(loaded.conversation.history.length, 3);
    assert.equal(loaded.conversation.history[2].content, messages[2].content);
    await client.request('zerochat/conversations/delete', { id: 'conv_http_chunked' });
  });
});


test('zerochat.py: logging de peticiones y respuestas con HH:MM:SS, sin datos comprometidos y --keep-server desactiva el watchdog', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const testToken = 'super-secret-token-xyz-987';
  const dataDir = tokenDataDir(testToken);

  let serverOutput = '';
  const { baseUrl, serverProc } = await startServer(port => {
    const proc = spawn('python3', [
      serverPath, '--port', String(port), '--no-browser', '--keep-server', '--no-venv'
    ], { env: { ...process.env, ZEROCHAT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    serverOutput = '';
    proc.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
    return proc;
  }, testToken);

  try {
    // 1. Petición POST sin token (401 Unauthorized) y GET fuera de la interfaz (404)
    await fetch(baseUrl, { method: 'POST', body: '{}' });
    await fetch(`${baseUrl}/`, { headers: { 'X-ZeroChat-Token': testToken } });

    // 2. Petición POST con initialize
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} })
    });

    // 3. Petición POST con tools/call fallida con argumento no permitido y sensible
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'read_file',
          arguments: { path: 'archivo_que_no_existe_12345.txt', secret_payload: 'super_secret_payload_content_12345' }
        }
      })
    });

    // 4. Petición POST con JSON malformado (400 Bad Request) y herramienta no existente (-32601)
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: '{ json_invalido: true '
    });
    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'herramienta_fantasma', arguments: { secret_api_key: 'confidential_key_abc_999' } }
      })
    });

    // 5. Las consultas periódicas de la interfaz no se registran; detener un comando, sí.
    const controlRpc = async (id, method, params) => (await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ZeroChat-Token': testToken },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })).json();
    await controlRpc(13, 'zerochat/jobs/list', {});
    await controlRpc(14, 'zerochat/jobs/get', { key: 'clave-inexistente' });
    await controlRpc(15, 'zerochat/jobs/log', { id: 999, offset: 0 });
    await controlRpc(16, 'zerochat/jobs/stop', { id: 999 });
    const hb = await controlRpc(17, 'zerochat/heartbeat', {});
    assert.equal(hb.result.exit_on_close, false, 'Con --keep-server cerrar la pestaña no detendrá el servidor');

    // Cada respuesta se registra después de enviarla: se espera a la línea de la última que se registra.
    await new Promise((resolve, reject) => {
      const lastLogged = /<--\s+200 OK\s+\S*\s*\[rpc: zerochat\/jobs\/stop\]/;
      const timer = setTimeout(() => reject(new Error(`Sin registro de zerochat/jobs/stop: ${serverOutput}`)), 5000);
      const check = () => {
        if (!lastLogged.test(serverOutput)) return;
        clearTimeout(timer);
        serverProc.stdout.off('data', check);
        resolve();
      };
      serverProc.stdout.on('data', check);
      check();
    });

    assert.match(serverOutput, /Auto-cierre\s*:\s*Desactivado/);
    assert.ok(!/zerochat\/(heartbeat|jobs\/(list|get|log))/.test(serverOutput), 'Las consultas periódicas de la interfaz no deben llenar la consola');
    assert.match(serverOutput, /\[rpc: zerochat\/jobs\/stop\]/, 'Las acciones sobre comandos sí se registran');
    assert.match(serverOutput, /\[\d{2}:\d{2}:\d{2}\]\s+-->\s+GET\s+\//);
    assert.match(serverOutput, /\[\d{2}:\d{2}:\d{2}\]\s+<--\s+401 Unauthorized/);

    const logsWithoutBanner = serverOutput.split('='.repeat(30)).pop() || '';
    assert.ok(!logsWithoutBanner.includes(testToken), 'El token de sesión no debe fugarse en los logs de peticiones');
    assert.ok(!serverOutput.includes('super_secret_payload_content_12345'));
    assert.ok(!serverOutput.includes('confidential_key_abc_999'));
    assert.match(serverOutput, /Argumento no permitido: secret_payload/);
    assert.match(serverOutput, /ERROR:/);
    assert.match(serverOutput, /<--\s+400 Bad Request/);
    assert.match(serverOutput, /\[-32601\]\s*Herramienta local 'herramienta_fantasma' no encontrada/);
  } finally {
    serverProc.kill('SIGTERM');
  }
});
