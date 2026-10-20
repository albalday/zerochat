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
import json, os, sys, time, urllib.error, urllib.parse, urllib.request
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

def post_status(size):
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=b"x" * size, headers={
        "Content-Type": "application/json", "Origin": "http://127.0.0.1", "X-ZeroChat-Token": fragment["token"]})
    try:
        return urllib.request.urlopen(request, timeout=30).status
    except urllib.error.HTTPError as err:
        return err.code

def rpc_status(method, size, **params):
    """Estado HTTP de un JSON-RPC válido rellenado hasta medir exactamente size bytes."""
    envelope = {"jsonrpc": "2.0", "id": 1, "method": method, "params": {"run_id": fragment["run"], **params, "pad": ""}}
    envelope["params"]["pad"] = "p" * (size - len(json.dumps(envelope).encode()))
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=json.dumps(envelope).encode(), headers={
        "Content-Type": "application/json", "Origin": "http://127.0.0.1", "X-ZeroChat-Token": fragment["token"]})
    try:
        return urllib.request.urlopen(request, timeout=30).status
    except urllib.error.HTTPError as err:
        return err.code

def save():
    Path(os.environ["FAKE_UI_INFO"]).write_text(json.dumps(info), encoding="utf-8")

info["wrong_run_id"] = rpc("zerochat/run/prompt", run_id="x" * 32).get("error", {}).get("message")
delivered = rpc("zerochat/run/prompt")["result"]
prompt = delivered["prompt"]
info["profile"] = delivered["profile"]
info["export"] = delivered["export"]
info["keep_page"] = delivered["keep_page"]
info["allow_dangerous_tools"] = delivered["allow_dangerous_tools"]
info["second_prompt"] = rpc("zerochat/run/prompt").get("error", {}).get("message")
save()
if delivered["export"] and scenario == "ok":
    # Mientras se espera la exportación, el tope del cuerpo es el suyo; al recibirla, vuelve el general.
    info["export_limit"] = [post_status(64 * 1024 * 1024), post_status(64 * 1024 * 1024 + 1)]
    # Otro método no aprovecha el tope ampliado: el general se aplica tras analizar el cuerpo.
    info["other_method_limit"] = [rpc_status("zerochat/run/progress", 1024 * 1024, kind="stream"),
                                  rpc_status("zerochat/run/progress", 1024 * 1024 + 1, kind="stream")]
if delivered["export"]:
    # La exportación sí admite un cuerpo por encima del tope general.
    info["export_reply"] = rpc("zerochat/run/export", content=f"{delivered['export']}: {prompt}", pad="p" * (1024 * 1024))
    info["second_export"] = rpc("zerochat/run/export", content="x").get("error", {}).get("message")
    info["limit_after_export"] = post_status(1024 * 1024 + 1)
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

/**
 * Lanza zerochat.py --prompt con el navegador falso; `port: null` no pasa --port y `production`
 * ejecuta una copia fuera del repositorio, que abre la interfaz de GitHub Pages. Sin `port`, el
 * puerto lo elige freePort(), que lo libera antes de que zerochat.py lo ocupe: si entretanto otro
 * proceso de la suite lo toma, el arranque falla con el código 3 y se repite una vez con otro puerto.
 */
async function runZerochat(prompt, options = {}) {
  const run = await launchZerochat(prompt, options);
  const portTaken = options.port === undefined && run.code === 3 && /No se pudo escuchar/.test(run.stderr);
  return portTaken ? launchZerochat(prompt, options) : run;
}

function launchZerochat(prompt, { scenario = 'ok', env = {}, port, args = [], production = false } = {}) {
  const work = tempDir('zerochat-run-');
  let script = backendPath;
  if (production) {
    script = path.join(work, 'zerochat.py');
    fs.copyFileSync(backendPath, script);
  }
  const binDir = path.join(work, 'bin');
  fs.mkdirSync(binDir);
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(binDir, 'xdg-open'), `#!${python}\n${FAKE_BROWSER}`, { mode: 0o755 });
  const infoPath = path.join(work, 'info.json');
  return Promise.resolve(port === null ? null : port || freePort()).then(listenPort => new Promise(resolve => {
    const portArgs = listenPort === null ? [] : ['--port', String(listenPort)];
    const proc = spawn('python3', [script, '--no-venv', ...portArgs, '--prompt', prompt, ...args], {
      cwd: production ? work : repoRoot,
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
  const exportDir = tempDir('zerochat-run-export-');
  const exportPath = path.join(exportDir, 'conversacion.md');
  // Un directorio con la extensión válida hace fallar la escritura.
  const unwritable = path.join(exportDir, 'directorio.json');
  fs.mkdirSync(unwritable);
  try {
    const busyPort = String(busy.address().port);
    const [ok, failed, unexported, idle, chatty, browserGone, emptyPrompt, portInUse, devDefaultInUse, productionDefaultInUse] = await Promise.all([
      runZerochat('hola mundo', { args: ['--profile', ' Oficina ', '--log', 'on', '--export', exportPath, '--keep-page', '--allow-dangerous-tools'] }),
      runZerochat('hola', { scenario: 'error' }),
      runZerochat('hola', { args: ['--export', unwritable] }),
      runZerochat('hola', { scenario: 'idle', env: { ZEROCHAT_RUN_IDLE_SECONDS: '1' } }),
      runZerochat('hola', { scenario: 'chatty', env: { ZEROCHAT_RUN_IDLE_SECONDS: '1', ZEROCHAT_RUN_TIMEOUT: '2' } }),
      runZerochat('hola', { scenario: 'exit', env: { ZEROCHAT_HEARTBEAT_TIMEOUT: '1' } }),
      runZerochat('   '),
      runZerochat('hola', { port: busy.address().port }),
      // Sin --port, el puerto por defecto (aquí ZEROCHAT_PORT) ocupado.
      runZerochat('hola', { port: null, env: { ZEROCHAT_PORT: busyPort } }),
      runZerochat('hola', { port: null, env: { ZEROCHAT_PORT: busyPort }, production: true })
    ]);

    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, 'Respuesta a: hola mundo\n');
    // La interfaz es la del arranque normal (la local en desarrollo) con run= en el fragmento.
    assert.equal(ok.info.url, `http://127.0.0.1:${ok.port}/zerochat.html`);
    assert.deepEqual(ok.info.fragment_keys, ['host', 'port', 'run', 'token']);
    assert.equal(ok.info.profile, 'Oficina');
    assert.equal(failed.info.profile, null, 'sin --profile la interfaz usa el perfil activo');
    assert.equal(ok.info.wrong_run_id, 'run_id no válido.');
    assert.equal(ok.info.second_prompt, 'El prompt ya se entregó.');
    assert.equal(ok.info.bad_result, 'El resultado lleva text o error.');
    // La conversación exportada se escribe una sola vez en el fichero, con el formato de su extensión.
    assert.equal(ok.info.export, 'markdown');
    assert.equal(ok.info.keep_page, true);
    assert.equal(ok.info.allow_dangerous_tools, true);
    assert.equal(fs.readFileSync(exportPath, 'utf8'), 'markdown: hola mundo');
    assert.equal(ok.info.second_export, 'La exportación ya se recibió.');
    // El cuerpo en el tope exacto pasa el límite y falla al no ser JSON; un byte más se rechaza.
    assert.deepEqual(ok.info.export_limit, [400, 413]);
    assert.equal(ok.info.limit_after_export, 413);
    // Con la exportación pendiente, otro método válido en el tope general exacto pasa y un byte más es 413;
    // la exportación por encima del tope general se acepta.
    assert.deepEqual(ok.info.other_method_limit, [200, 413]);
    assert.deepEqual(ok.info.export_reply.result, { ok: true });
    assert.deepEqual([failed.info.export, failed.info.keep_page, failed.info.allow_dangerous_tools], [null, false, false]);
    // Una exportación pedida que no se escribe es un error, pero la respuesta sigue en stdout.
    assert.equal(unexported.info.export, 'json');
    assert.match(unexported.info.export_reply.error.message, /No se pudo escribir/);
    assert.equal(unexported.code, 1, unexported.stderr);
    assert.equal(unexported.stdout, 'Respuesta a: hola\n');
    assert.match(unexported.stderr, /\[run\] No se pudo escribir .*directorio\.json/);
    // El progreso se registra en stderr recortado en su tope exacto.
    assert.match(ok.stderr, new RegExp(`\\[run\\] tool: ${'y'.repeat(500)}\\n`));
    assert.match(ok.stderr, new RegExp(`\\[run\\] tool: ${'x'.repeat(500)}…\\n`));
    assert.match(ok.stderr, /ZeroChat Local Server/, 'la cabecera del arranque va a stderr');

    assert.equal(failed.code, 1, failed.stderr);
    // Con --prompt el registro está desactivado por defecto: solo queda el motivo del fallo.
    assert.match(failed.stderr, /^\[\d\d:\d\d:\d\d\] \[run\] Error de generación: model failed\n$/);
    assert.equal(idle.code, 2, idle.stderr);
    assert.match(idle.stderr, /Sin progreso de la interfaz durante 1s/);
    // El progreso continuo reinicia la inactividad, pero no el plazo total.
    assert.equal(chatty.code, 2, chatty.stderr);
    assert.match(chatty.stderr, /Plazo total agotado \(2s\)/);
    assert.equal(browserGone.code, 2, browserGone.stderr);
    assert.match(browserGone.stderr, /sin resultado/);
    for (const run of [failed, idle, chatty, browserGone]) assert.equal(run.stdout, '');

    assert.equal(emptyPrompt.code, 4, emptyPrompt.stderr);
    assert.match(emptyPrompt.stderr, /error: el prompt está vacío/);
    assert.equal(portInUse.code, 3, portInUse.stderr);
    assert.match(portInUse.stderr, /No se pudo escuchar/);
    assert.equal(portInUse.info, null);
    // Sin --port: en desarrollo es un fallo de arranque; en producción la ejecución usa un puerto libre.
    assert.equal(devDefaultInUse.code, 3, devDefaultInUse.stderr);
    assert.match(devDefaultInUse.stderr, /en desarrollo la interfaz local necesita ese puerto/);
    assert.equal(devDefaultInUse.info, null);
    assert.equal(productionDefaultInUse.code, 0, productionDefaultInUse.stderr);
    assert.equal(productionDefaultInUse.stdout, 'Respuesta a: hola\n');
    assert.equal(productionDefaultInUse.info.url, 'https://albalday.github.io/zerochat/zerochat.html');
  } finally {
    busy.close();
  }
});
