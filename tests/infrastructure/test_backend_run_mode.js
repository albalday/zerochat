const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { tokenDataDir, freePort } = require('../helpers/backend-env.js');

// Modo ejecución de zerochat.py (--prompt): el arranque normal abre el navegador con xdg-open; un
// xdg-open falso en el PATH hace de interfaz por JSON-RPC y deja en INFO lo que observó.

const repoRoot = path.resolve(__dirname, '../..');
const backendPath = path.join(repoRoot, 'zerochat.py');

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const FAKE_BROWSER = `
import json, os, sys, time, urllib.parse, urllib.request
from pathlib import Path
url = sys.argv[-1]
fragment = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).fragment))
scenario = os.environ["FAKE_UI_SCENARIO"]
info = {"url": url.split("#", 1)[0], "fragment_keys": sorted(fragment)}

def rpc(method, run_id=fragment["run"], **params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {"run_id": run_id, **params}}).encode()
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=body, headers={
        "Content-Type": "application/json", "Origin": "http://127.0.0.1", "X-ZeroChat-Token": fragment["token"]})
    return json.loads(urllib.request.urlopen(request, timeout=5).read())

def save():
    Path(os.environ["FAKE_UI_INFO"]).write_text(json.dumps(info), encoding="utf-8")

info["wrong_run_id"] = rpc("zerochat/run/prompt", run_id="x" * 32).get("error", {}).get("message")
prompt = rpc("zerochat/run/prompt")["result"]["prompt"]
info["second_prompt"] = rpc("zerochat/run/prompt").get("error", {}).get("message")
save()
if scenario == "ok":
    rpc("zerochat/run/progress", kind="tool", text="y" * 500)
    rpc("zerochat/run/progress", kind="tool", text="x" * 501)
    info["bad_result"] = rpc("zerochat/run/result", text="a", error="b").get("error", {}).get("message")
    save()
    rpc("zerochat/run/result", text=f"Respuesta a: {prompt}")
elif scenario == "error":
    rpc("zerochat/run/result", error="model failed")
elif scenario == "chatty":
    for _ in range(50):
        try:
            rpc("zerochat/run/progress", kind="stream")
        except OSError:
            break
        time.sleep(0.2)
elif scenario == "idle":
    time.sleep(5)
`;

function runZerochat(prompt, { scenario = 'ok', env = {}, port } = {}) {
  const work = tempDir('zerochat-run-');
  const binDir = path.join(work, 'bin');
  fs.mkdirSync(binDir);
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(binDir, 'xdg-open'), `#!${python}\n${FAKE_BROWSER}`, { mode: 0o755 });
  const infoPath = path.join(work, 'info.json');
  return Promise.resolve(port || freePort()).then(listenPort => new Promise(resolve => {
    const proc = spawn('python3', [backendPath, '--no-venv', '--port', String(listenPort), '--prompt', prompt], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ZEROCHAT_DATA_DIR: tokenDataDir('run-mode-token-0123456789'),
        FAKE_UI_SCENARIO: scenario,
        FAKE_UI_INFO: infoPath,
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', code => {
      const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : null;
      resolve({ code, stdout, stderr, info, port: listenPort });
    });
  }));
}

test('zerochat.py --prompt: arranque normal, respuesta solo en stdout, códigos de salida y plazos', { skip: process.platform !== 'linux' }, async () => {
  const busy = net.createServer();
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  try {
    const [ok, failed, idle, chatty, browserGone, emptyPrompt, portInUse] = await Promise.all([
      runZerochat('hola mundo'),
      runZerochat('hola', { scenario: 'error' }),
      runZerochat('hola', { scenario: 'idle', env: { ZEROCHAT_RUN_IDLE_SECONDS: '1' } }),
      runZerochat('hola', { scenario: 'chatty', env: { ZEROCHAT_RUN_IDLE_SECONDS: '1', ZEROCHAT_RUN_TIMEOUT: '2' } }),
      runZerochat('hola', { scenario: 'exit', env: { ZEROCHAT_HEARTBEAT_TIMEOUT: '1' } }),
      runZerochat('   '),
      runZerochat('hola', { port: busy.address().port })
    ]);

    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, 'Respuesta a: hola mundo\n');
    // La interfaz es la del arranque normal (la local en desarrollo) con run= en el fragmento.
    assert.equal(ok.info.url, `http://127.0.0.1:${ok.port}/zerochat.html`);
    assert.deepEqual(ok.info.fragment_keys, ['host', 'port', 'run', 'token']);
    assert.equal(ok.info.wrong_run_id, 'run_id no válido.');
    assert.equal(ok.info.second_prompt, 'El prompt ya se entregó.');
    assert.equal(ok.info.bad_result, 'El resultado lleva text o error.');
    // El progreso se registra en stderr recortado en su tope exacto.
    assert.match(ok.stderr, new RegExp(`\\[run\\] tool: ${'y'.repeat(500)}\\n`));
    assert.match(ok.stderr, new RegExp(`\\[run\\] tool: ${'x'.repeat(500)}…\\n`));
    assert.match(ok.stderr, /ZeroChat Local Server/, 'la cabecera del arranque va a stderr');

    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /Error de generación: model failed/);
    assert.equal(idle.code, 2);
    assert.match(idle.stderr, /Sin progreso de la interfaz durante 1s/);
    // El progreso continuo reinicia la inactividad, pero no el plazo total.
    assert.equal(chatty.code, 2);
    assert.match(chatty.stderr, /Plazo total agotado \(2s\)/);
    assert.equal(browserGone.code, 2);
    assert.match(browserGone.stderr, /sin resultado/);
    for (const run of [failed, idle, chatty, browserGone]) assert.equal(run.stdout, '');

    assert.equal(emptyPrompt.code, 3);
    assert.match(emptyPrompt.stderr, /El prompt está vacío/);
    assert.equal(portInUse.code, 3);
    assert.match(portInUse.stderr, /No se pudo escuchar/);
    assert.equal(portInUse.info, null);
  } finally {
    busy.close();
  }
});
