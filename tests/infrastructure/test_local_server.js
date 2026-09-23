const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const pkg = require('../../package.json');

test('zerochat.py: la consola interactiva expone estado, ayuda y cierre ordenado', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const script = `
import argparse
import importlib.util
import os
import pty
import sys
import termios
from pathlib import Path
spec = importlib.util.spec_from_file_location('zerochat_console_test', Path(${JSON.stringify(path.resolve(__dirname, '../../zerochat.py'))}))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.format_uptime(0) == '00:00:00'
assert module.format_uptime(3661.8) == '01:01:01'
parser = argparse.ArgumentParser(prog='zerochat.py')
assert 'usage: zerochat.py' in parser.format_help()

class InteractiveOutput:
    def __init__(self, output):
        self.output = output
    def isatty(self):
        return True
    def write(self, value):
        return self.output.write(value)
    def flush(self):
        return self.output.flush()

original_stdin = sys.stdin
original_stdout = sys.stdout
saved_fd = os.dup(0)
master_fd, slave_fd = pty.openpty()
try:
    os.dup2(slave_fd, 0)
    os.close(slave_fd)
    sys.stdin = os.fdopen(0, 'r', closefd=False)
    sys.stdout = InteractiveOutput(original_stdout)
    terminal_before = termios.tcgetattr(0)
    console = module.ConsoleControl(None, parser)
    assert console.enabled is True
    console.start()
    assert not (termios.tcgetattr(0)[3] & termios.ICANON)
    console.close()
    assert termios.tcgetattr(0) == terminal_before
finally:
    sys.stdin = original_stdin
    sys.stdout = original_stdout
    os.dup2(saved_fd, 0)
    os.close(saved_fd)
    os.close(master_fd)
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe' }));
});

async function waitForServer(baseUrl, testToken, serverProc, maxWaitMs = 15000) {
  const start = Date.now();
  let serverError = '';
  if (serverProc && serverProc.stderr) {
    serverProc.stderr.on('data', chunk => { serverError += chunk.toString(); });
  }
  while (Date.now() - start < maxWaitMs) {
    try {
      const probeRes = await fetch(`${baseUrl}/`, {
        headers: testToken ? { 'X-ZeroChat-Token': testToken } : {}
      });
      if (probeRes.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`El servidor zerochat.py no arrancó en ${baseUrl} tras ${maxWaitMs}ms. Error: ${serverError}`);
}

test('Servidor local zerochat.py: token de sesión, herramientas core y aislamiento', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 6400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-secret-12345';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-venv'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

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
    assert.ok(toolNames.includes('edit_file'));
    assert.ok(toolNames.includes('execute_command'));
    const listDirectory = tools.find(t => t.name === 'list_directory');
    assert.equal(listDirectory?.inputSchema?.properties?.max_depth, undefined,
      'list_directory no debe publicar una profundidad recursiva inexistente');

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

    // 7. Comprobar flujo SSE con token en cabecera
    const sseRes = await fetch(`${baseUrl}/sse`, {
      headers: { 'Accept': 'text/event-stream', 'X-ZeroChat-Token': testToken }
    });
    assert.equal(sseRes.status, 200);
    assert.equal(sseRes.headers.get('content-type'), 'text/event-stream');

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
    assert.ok(serverIds.includes('dummy_mcp'), 'dummy_mcp debe estar provisto');
    assert.ok(serverIds.includes('playwright'), 'playwright debe estar provisto');
    assert.ok(serverIds.includes('memory'), 'memory debe estar provisto');
    assert.ok(serverIds.includes('lsp'), 'lsp debe estar provisto');
    const dummyServer = (statusJson.result?.servers || []).find(s => s.id === 'dummy_mcp');
    assert.equal(dummyServer?.status, 'stopped');

    // Iniciar individualmente dummy_mcp
    const startRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'zerochat/external/servers/start', params: { serverId: 'dummy_mcp' } })
    });
    assert.equal(startRes.status, 200);
    const startJson = await startRes.json();
    const runningDummy = (startJson.result?.servers || []).find(s => s.id === 'dummy_mcp');
    assert.equal(runningDummy?.status, 'running');
    assert.equal(runningDummy?.toolCount, 1);

    // tools/list en /mcp/external
    const extToolsRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} })
    });
    assert.equal(extToolsRes.status, 200);
    const extToolsJson = await extToolsRes.json();
    const extToolNames = (extToolsJson.result?.tools || []).map(t => t.name);
    assert.ok(extToolNames.includes('mcp_dummyz5fzmcp_echo'));

    // tools/call ejecutando dummy_mcp echo
    const extCallRes = await fetch(`${baseUrl}/mcp/external`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://albalday.github.io', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'mcp_dummyz5fzmcp_echo', arguments: { message: 'probando mcp' } }
      })
    });
    assert.equal(extCallRes.status, 200);
    const extCallJson = await extCallRes.json();
    assert.equal(extCallJson.result?.isError, false);
    assert.equal(extCallJson.result?.content?.[0]?.text, 'echo: probando mcp');

    // Detener individualmente dummy_mcp
    const stopRes = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'zerochat/external/servers/stop', params: { serverId: 'dummy_mcp' } })
    });
    assert.equal(stopRes.status, 200);
    const stopJson = await stopRes.json();
    const stoppedDummy = (stopJson.result?.servers || []).find(s => s.id === 'dummy_mcp');
    assert.equal(stoppedDummy?.status, 'stopped');
    assert.equal(stoppedDummy?.toolCount, 0);

  } finally {
    serverProc.kill('SIGTERM');
  }
});


test('Generación y persistencia de token diario en zerochat.py', async () => {
  const code = `
import zerochat
token1 = zerochat.get_daily_token()
token2 = zerochat.get_daily_token()
assert token1 == token2, "El token diario debe ser idempotente en el mismo día"
assert len(token1) > 20, "El token debe ser de longitud segura"
print("DAILY_TOKEN_OK")
`;
  const output = execFileSync('python3', ['-c', code], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  });
  assert.ok(output.includes('DAILY_TOKEN_OK'));
});

test('Versionado: el backend usa major.minor y la interfaz conserva el parche', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const output = execFileSync('python3', ['-c', `
import zerochat
assert zerochat.VERSION == '${pkg.version.split('.').slice(0, 2).join('.')}'
assert zerochat.UI_VERSION == '${pkg.version}'
print('VERSION_POLICY_OK')
`], { cwd: repoRoot, encoding: 'utf8' });
  assert.ok(output.includes('VERSION_POLICY_OK'));
});

test('Detección de entorno de desarrollo y servicio de zerochat.html y estáticos en zerochat.py', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 7400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'test-token-dev-auto';

  // Iniciar sin --ui-url para verificar auto-detección
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-venv'
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

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

test('Apertura de navegador en zerochat.py: open_browser prioriza herramientas de sistema y desacopla el proceso', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const testScript = `
import sys
import os
import subprocess
from unittest.mock import patch, MagicMock
import zerochat

# 1. En Termux se prioriza termux-open-url incluso si xdg-open está disponible
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/data/data/com.termux/files/usr/bin/' + cmd if cmd in ('termux-open-url', 'xdg-open') else None), patch.dict(os.environ, {'TERMUX_VERSION': '0.118'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe retornar True con termux-open-url"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['termux-open-url', 'http://127.0.0.1:6388/zerochat.html']
        assert kwargs.get('start_new_session') is True
        assert kwargs.get('stdout') == subprocess.DEVNULL
        assert kwargs.get('stderr') == subprocess.DEVNULL

# 2. En Linux de escritorio con xdg-open disponible
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/usr/bin/' + cmd if cmd == 'xdg-open' else None), patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe retornar True con xdg-open"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['xdg-open', 'http://127.0.0.1:6388/zerochat.html']
        assert kwargs.get('start_new_session') is True
        assert kwargs.get('stdout') == subprocess.DEVNULL
        assert kwargs.get('stderr') == subprocess.DEVNULL

# 3. El prefijo de Termux también se detecta cuando TERMUX_VERSION no está definido
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/data/data/com.termux/files/usr/bin/' + cmd if cmd in ('termux-open-url', 'xdg-open') else None), patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe detectar Termux por PREFIX"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['termux-open-url', 'http://127.0.0.1:6388/zerochat.html']

# 4. Termux usa termux-open-url aunque Python se identifique como Android
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', return_value='/data/data/com.termux/files/usr/bin/termux-open-url'), patch.dict(os.environ, {'TERMUX_VERSION': '0.118'}, clear=True):
    with patch.object(sys, 'platform', 'android'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe priorizar Termux también en Android"
        args, kwargs = mock_popen.call_args
        assert args[0] == ['termux-open-url', 'http://127.0.0.1:6388/zerochat.html']

# 5. Termux recibe un comando manual seguro que conserva el token de sesión
termux_url = 'https://albalday.github.io/zerochat/zerochat.html#token=test-token&host=127.0.0.1&port=6388'
with patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    assert zerochat.get_manual_browser_command(termux_url) == "termux-open-url 'https://albalday.github.io/zerochat/zerochat.html#token=test-token&host=127.0.0.1&port=6388'"

# 6. Termux usa la ruta absoluta de PREFIX si el venv no hereda PATH
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', return_value=None), patch.object(zerochat.Path, 'is_file', return_value=True), patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe usar la ruta absoluta de Termux"
        args, kwargs = mock_popen.call_args
        assert args[0] == ['/data/data/com.termux/files/usr/bin/termux-open-url', 'http://127.0.0.1:6388/zerochat.html']

# 7. Termux informa el fallo de lanzamiento en lugar de ocultarlo y probar otro launcher
with patch('subprocess.Popen', side_effect=PermissionError('permiso denegado')), patch('shutil.which', return_value='/data/data/com.termux/files/usr/bin/termux-open-url'), patch.dict(os.environ, {'PREFIX': '/data/data/com.termux/files/usr'}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        try:
            zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
            raise AssertionError('open_browser debe propagar el error de termux-open-url')
        except RuntimeError as err:
            assert 'permiso denegado' in str(err)
            assert 'termux_detectado=True' in str(err)

# 8. En Linux sin xdg-open pero con gio disponible
with patch('subprocess.Popen') as mock_popen, patch('shutil.which', side_effect=lambda cmd: '/usr/bin/' + cmd if cmd == 'gio' else None), patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True, "open_browser debe retornar True con gio"
        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        assert args[0] == ['gio', 'open', 'http://127.0.0.1:6388/zerochat.html']
        assert kwargs.get('start_new_session') is True

# 9. Fallback a webbrowser cuando no hay herramientas de sistema
with patch('shutil.which', return_value=None), patch('webbrowser.open', return_value=True) as mock_wb, patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        res = zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
        assert res is True
        mock_wb.assert_called_once_with('http://127.0.0.1:6388/zerochat.html')

# 10. Un navegador que rechaza la URL conserva un error diagnosticable
with patch('shutil.which', return_value=None), patch('webbrowser.open', return_value=False), patch.dict(os.environ, {}, clear=True):
    with patch.object(sys, 'platform', 'linux'):
        try:
            zerochat.open_browser('http://127.0.0.1:6388/zerochat.html')
            raise AssertionError('open_browser debe explicar un lanzamiento rechazado')
        except RuntimeError as err:
            assert 'Ningún lanzador de navegador aceptó' in str(err)
            assert 'termux_detectado=False' in str(err)
            assert 'webbrowser: devolvió False' in str(err)

print("OPEN_BROWSER_TEST_OK")
`;

  const output = execFileSync('python3', ['-c', testScript], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.ok(output.includes('OPEN_BROWSER_TEST_OK'), 'La prueba de open_browser debe completarse correctamente');
});

test('zerochat.py: logging de peticiones y respuestas con HH:MM:SS, sin datos comprometidos y con detalle de errores', async () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');
  const port = 6400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'super-secret-token-xyz-987';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-venv'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

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
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} })
    });

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
    await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'herramienta_fantasma',
          arguments: { secret_api_key: 'confidential_key_abc_999' }
        }
      })
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
  const port = 7400 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'heartbeat-test-token-67890';

  // Iniciar servidor con timeout de heartbeat de 0.2 segundos para prueba ágil
  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
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
  const port = 7500 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'no-exit-token-99999';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-exit-on-close', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', chunk => { serverOutput += chunk; });

  try {
    await waitForServer(baseUrl, testToken, serverProc);

    // Enviar un heartbeat
    const hbRes = await fetch(`${baseUrl}/zerochat/heartbeat`, { headers: { 'X-ZeroChat-Token': testToken } });
    assert.equal(hbRes.status, 200);

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
  const port = 7600 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const testToken = 'rpc-watchdog-token-12345';

  const serverProc = spawn('python3', [
    serverPath, '--port', String(port), '--token', testToken, '--no-browser', '--no-venv'
  ], {
    env: { ...process.env, ZEROCHAT_HEARTBEAT_TIMEOUT: '0.2', ZEROCHAT_HEARTBEAT_POLL: '0.05' },
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

test('Servidor local zerochat.py: omite comprobación de versión remota en desarrollo local', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const serverPath = path.resolve(repoRoot, 'zerochat.py');

  const checkPyCode = `
import zerochat
import sys

# 1. En entorno de repo local dev_root debe estar activo
assert zerochat.get_dev_root() is not None, "get_dev_root() debe detectar el repositorio local"

# 2. check_version() no debe imprimir nada en modo dev
import io
out = io.StringIO()
old_stdout = sys.stdout
sys.stdout = out
try:
    zerochat.check_version()
finally:
    sys.stdout = old_stdout

output = out.getvalue()
assert "Nueva versión disponible" not in output, f"No debe comprobar versión en dev: {output}"
assert "_read_package_version" not in output, f"No debe mostrar texto de función interna: {output}"

# 3. parse_version compara semver adecuadamente
assert zerochat.parse_version("7.0.5") == (7, 0, 5)
assert zerochat.parse_version("7.0.10") > zerochat.parse_version("7.0.5")
assert not (zerochat.parse_version("7.0.5") > zerochat.parse_version("7.0.5"))

# 4. Solo major.minor requiere actualizar el ejecutable.
assert not zerochat.has_new_backend_version("7.4.9", "7.4")
assert zerochat.has_new_backend_version("7.5.0", "7.4")
assert zerochat.get_venv_dir() == zerochat.get_data_dir() / ".venv"

# 5. El entorno MCP no cambia el intérprete del servidor.
import os
import tempfile
with tempfile.TemporaryDirectory() as temp_dir:
    old_data_dir = os.environ.get("ZEROCHAT_DATA_DIR")
    os.environ["ZEROCHAT_DATA_DIR"] = temp_dir
    try:
        current_python = sys.executable
        zerochat.ensure_virtual_environment()
        assert sys.executable == current_python
        assert zerochat.get_venv_python(zerochat.get_venv_dir()).is_file()
    finally:
        if old_data_dir is None:
            os.environ.pop("ZEROCHAT_DATA_DIR", None)
        else:
            os.environ["ZEROCHAT_DATA_DIR"] = old_data_dir
`;

  execFileSync('python3', ['-c', checkPyCode], { cwd: repoRoot });
});
