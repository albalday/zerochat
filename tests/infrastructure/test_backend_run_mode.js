const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { tokenDataDir, freePort } = require('../helpers/backend-env.js');

// Modo ejecución de zerochat.py (--prompt): el arranque normal lanza node; un node falso en el
// PATH hace de interfaz por JSON-RPC y deja en INFO lo que observó. Su configuración va en
// fake-ui.json a su lado y recibe la URL antes de la política de caché.

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

// Token diario del servidor en el directorio de datos de cada ejecución: la ejecución no lo acepta.
const DAILY_TOKEN = 'run-mode-token-0123456789';

const FAKE_BROWSER = `
import json, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
# Los navegadores reciben la URL al final; el runner de Node, la URL y después la política de caché.
url_index = max(i for i, arg in enumerate(sys.argv) if arg.startswith("http"))
url = sys.argv[url_index]
fragment = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).fragment))
config = json.loads(Path(sys.argv[0]).with_name("fake-ui.json").read_text(encoding="utf-8"))
scenario = config["scenario"]
info = {"url": url.split("#", 1)[0], "fragment_keys": sorted(fragment), "launcher": Path(sys.argv[0]).name, "args": sys.argv[1:url_index], "after_url": sys.argv[url_index + 1:]}

# La interfaz de desarrollo la sirve el propio servidor de la ejecución: su origen es el de la petición.
ORIGIN = f"http://{fragment['host']}:{fragment['port']}"

def rpc(method, run_id=fragment["run"], **params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {"run_id": run_id, **params}}).encode()
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=body, headers={
        "Content-Type": "application/json", "Origin": ORIGIN, "X-ZeroChat-Token": fragment["token"]})
    return json.loads(urllib.request.urlopen(request, timeout=5).read())

def post_status(size):
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=b"x" * size, headers={
        "Content-Type": "application/json", "Origin": ORIGIN, "X-ZeroChat-Token": fragment["token"]})
    try:
        return urllib.request.urlopen(request, timeout=30).status
    except urllib.error.HTTPError as err:
        return err.code

def rpc_status(method, size, **params):
    """Estado HTTP de un JSON-RPC válido rellenado hasta medir exactamente size bytes."""
    envelope = {"jsonrpc": "2.0", "id": 1, "method": method, "params": {"run_id": fragment["run"], **params, "pad": ""}}
    envelope["params"]["pad"] = "p" * (size - len(json.dumps(envelope).encode()))
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=json.dumps(envelope).encode(), headers={
        "Content-Type": "application/json", "Origin": ORIGIN, "X-ZeroChat-Token": fragment["token"]})
    try:
        return urllib.request.urlopen(request, timeout=30).status
    except urllib.error.HTTPError as err:
        return err.code

def save():
    Path(config["info"]).write_text(json.dumps(info), encoding="utf-8")

def status_with(token, method):
    """Estado HTTP de un JSON-RPC con otra credencial (o sin ella) que la del runner."""
    headers = {"Content-Type": "application/json", "Origin": ORIGIN, **({"X-ZeroChat-Token": token} if token else {})}
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {}}).encode()
    try:
        return urllib.request.urlopen(urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=body, headers=headers), timeout=5).status
    except urllib.error.HTTPError as err:
        return err.code

# La ejecución solo atiende a su runner: ni el token diario del servidor ni zerochat/login.
info["daily_token_status"] = status_with(config["daily_token"], "zerochat/heartbeat")
info["login_status"] = status_with(None, "zerochat/login")
info["wrong_run_id"] = rpc("zerochat/run/prompt", run_id="x" * 32).get("error", {}).get("message")
delivered = rpc("zerochat/run/prompt")["result"]
prompt = delivered["prompt"]
info["profile"] = delivered["profile"]
info["export"] = delivered["export"]
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
    info["usage_reply"] = rpc("zerochat/run/usage", model_calls=1, prompt_tokens=120, completion_tokens=8, cached_tokens=0,
                              reasoning_tokens=0, estimated=False)
    info["bad_result"] = rpc("zerochat/run/result", text="a", error="b").get("error", {}).get("message")
    save()
    rpc("zerochat/run/result", text=f"Respuesta a: {prompt}")
elif scenario == "error":
    rpc("zerochat/run/result", error="model failed")
elif scenario == "needs_input":
    rpc("zerochat/run/result", needs_input={"kind": "ask_user", "text": "¿A o B?"})
`;

const pythonBin = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
let templateDbPath = null;

function ensureTemplateDb() {
  if (templateDbPath) return templateDbPath;
  const dir = tempDir('zerochat-run-template-db-');
  execFileSync('python3', ['-c', `
import os, sys, importlib.util
os.environ["ZEROCHAT_DATA_DIR"] = sys.argv[1]
spec = importlib.util.spec_from_file_location("zerochat", sys.argv[2])
mod = importlib.util.module_from_spec(spec)
sys.modules["zerochat"] = mod
spec.loader.exec_module(mod)
mod.save_general_profile({"name": "local", "settings": {"apiType": "openai", "model": "local-default"}})
`, dir, backendPath]);
  templateDbPath = path.join(dir, 'storage', 'zerochat.db');
  return templateDbPath;
}

/**
 * Lanza zerochat.py --prompt con el navegador falso. Sin `port` no pasa --port: la ejecución escucha en un puerto
 * libre que elige el sistema, sin carrera con otros procesos de la suite. `production` ejecuta una copia fuera del
 * repositorio, que abre la interfaz de GitHub Pages.
 */
function runZerochat(prompt, { scenario = 'ok', env = {}, port, args = [], production = false, seedDefaultProfile = true, withNode = true } = {}) {
  const work = tempDir('zerochat-run-');
  let script = backendPath;
  if (production) {
    script = path.join(work, 'zerochat.py');
    fs.copyFileSync(backendPath, script);
  }
  const dataDir = tokenDataDir(DAILY_TOKEN);
  if (seedDefaultProfile) {
    const storageDir = path.join(dataDir, 'storage');
    fs.mkdirSync(storageDir, { mode: 0o700 });
    fs.copyFileSync(ensureTemplateDb(), path.join(storageDir, 'zerochat.db'));
    fs.chmodSync(path.join(storageDir, 'zerochat.db'), 0o600);
  }
  const binDir = path.join(work, 'bin');
  fs.mkdirSync(binDir);

  if (withNode) {
    fs.writeFileSync(path.join(binDir, 'node'), `#!${pythonBin}
import os, sys
if "--version" in sys.argv:
    print("v22.13.0")
    sys.exit(0)
${FAKE_BROWSER}
`, { mode: 0o755 });
  } else {
    fs.writeFileSync(path.join(binDir, 'node'), `#!${pythonBin}
import sys
if "--version" in sys.argv:
    print("v16.0.0")
sys.exit(0)
`, { mode: 0o755 });
  }

  const infoPath = path.join(work, 'info.json');
  fs.writeFileSync(path.join(binDir, 'fake-ui.json'), JSON.stringify({ scenario, info: infoPath, daily_token: DAILY_TOKEN }));
  return new Promise(resolve => {
    const portArgs = port === undefined ? [] : ['--port', String(port)];
    const proc = spawn('python3', [script, '--no-venv', ...portArgs, '--prompt', prompt, ...args], {
      cwd: production ? work : repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ZEROCHAT_DATA_DIR: dataDir,
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
      resolve({ code, stdout, stderr, info });
    });
  });
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
    const mainPort = String(await freePort());
    const [
      ok, failed, unexported, runnerGone, paused,
      emptyPrompt, missingDefaultProfile, noNode, portInUse, devDefaultInUse, productionDefaultInUse, explicitHost
    ] = await Promise.all([
      runZerochat('hola mundo', { args: ['--profile', ' Oficina ', '--log', 'on', '--export', exportPath] }),
      runZerochat('hola', { scenario: 'error' }),
      runZerochat('hola', { args: ['--export', unwritable] }),
      runZerochat('hola', { scenario: 'exit' }),
      runZerochat('hola', { scenario: 'needs_input' }),
      runZerochat('   '),
      runZerochat('hola', { seedDefaultProfile: false }),
      runZerochat('hola', { withNode: false }),
      runZerochat('hola', { port: busy.address().port }),
      // Sin --port, nunca el del servidor principal (aquí ZEROCHAT_PORT, libre) ni ZEROCHAT_HOST: uno libre en 127.0.0.1.
      runZerochat('hola', { env: { ZEROCHAT_PORT: mainPort, ZEROCHAT_HOST: '0.0.0.0' } }),
      runZerochat('hola', { env: { ZEROCHAT_PORT: busyPort }, production: true }),
      runZerochat('hola', { args: ['--host', '127.0.0.1'] })
    ]);

    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, 'Respuesta a: hola mundo\n');
    // Usa el runner de Node.js con --permission y, en desarrollo, descarga siempre la interfaz.
    assert.equal(ok.info.launcher, 'node');
    assert.equal(ok.info.args[0], '--permission');
    assert.match(ok.info.args.at(-1), /cache[\\/]runner[\\/]modules\.json$/);
    assert.deepEqual(ok.info.after_url, ['always'], 'en desarrollo el runner descarga siempre la interfaz');
    // La interfaz es la del arranque normal (la local en desarrollo) con run= en el fragmento.
    assert.match(ok.info.url, /^http:\/\/127\.0\.0\.1:\d+\/zerochat\.html$/);
    assert.deepEqual(ok.info.fragment_keys, ['host', 'port', 'run', 'token']);
    assert.equal(ok.info.profile, 'Oficina');
    assert.equal(failed.info.profile, 'local', 'sin --profile usa el perfil por defecto local del servidor');
    assert.equal(ok.info.wrong_run_id, 'run_id no válido.');
    assert.deepEqual([ok.info.daily_token_status, ok.info.login_status], [401, 401]);
    assert.equal(ok.info.second_prompt, 'El prompt ya se entregó.');
    assert.equal(ok.info.bad_result, 'El resultado lleva text, error, needs_input con kind y text, o limit.');
    // El token del runner admite el consumo acumulado.
    assert.deepEqual(ok.info.usage_reply.result, { ok: true });
    // La conversación exportada se escribe una sola vez en el fichero, con el formato de su extensión.
    assert.equal(ok.info.export, 'markdown');
    assert.equal(fs.readFileSync(exportPath, 'utf8'), 'markdown: hola mundo');
    assert.equal(ok.info.second_export, 'La exportación ya se recibió.');
    // El cuerpo en el tope exacto pasa el límite y falla al no ser JSON; un byte más se rechaza.
    assert.deepEqual(ok.info.export_limit, [400, 413]);
    assert.equal(ok.info.limit_after_export, 413);
    // Con la exportación pendiente, otro método válido en el tope general exacto pasa y un byte más es 413;
    // la exportación por encima del tope general se acepta.
    assert.deepEqual(ok.info.other_method_limit, [200, 413]);
    assert.deepEqual(ok.info.export_reply.result, { ok: true });
    assert.equal(failed.info.export, null);
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
    assert.equal(runnerGone.code, 2, runnerGone.stderr);
    assert.match(runnerGone.stderr, /sin resultado/);
    for (const run of [failed, runnerGone]) assert.equal(run.stdout, '');
    // La pausa sale con su código y, en stdout, la pregunta en texto; el aviso, para una persona, en stderr.
    assert.equal(paused.code, 5, paused.stderr);
    assert.equal(paused.stdout, '¿A o B?\n');
    assert.match(paused.stderr, /\[run\] Ejecución pausada a la espera del usuario\./);

    assert.equal(emptyPrompt.code, 4, emptyPrompt.stderr);
    assert.match(emptyPrompt.stderr, /error: el prompt está vacío/);
    assert.equal(missingDefaultProfile.code, 4, missingDefaultProfile.stderr);
    assert.match(missingDefaultProfile.stderr, /no existe el perfil por defecto 'local'/);
    assert.equal(noNode.code, 3, noNode.stderr);
    assert.match(noNode.stderr, /Se necesita Node\.js 22\.13 o superior/);
    assert.equal(portInUse.code, 3, portInUse.stderr);
    assert.match(portInUse.stderr, /No se pudo escuchar/);
    assert.equal(portInUse.info, null);
    // Sin --port: un puerto libre del sistema en 127.0.0.1, también en desarrollo.
    assert.equal(devDefaultInUse.code, 0, devDefaultInUse.stderr);
    assert.equal(devDefaultInUse.stdout, 'Respuesta a: hola\n');
    assert.match(devDefaultInUse.info.url, /^http:\/\/127\.0\.0\.1:\d+\/zerochat\.html$/);
    assert.notEqual(devDefaultInUse.info.url, `http://127.0.0.1:${mainPort}/zerochat.html`);
    assert.equal(explicitHost.code, 4, explicitHost.stderr);
    assert.match(explicitHost.stderr, /no se combina con --host/);
    assert.equal(productionDefaultInUse.code, 0, productionDefaultInUse.stderr);
    assert.equal(productionDefaultInUse.stdout, 'Respuesta a: hola\n');
    assert.equal(productionDefaultInUse.info.url, 'https://albalday.github.io/zerochat/zerochat.html');
    assert.equal(productionDefaultInUse.info.launcher, 'node');
    assert.equal(productionDefaultInUse.info.args[0], '--permission');
    assert.match(productionDefaultInUse.info.args.at(-1), /cache[\\/]runner[\\/]modules\.json$/);
    assert.deepEqual(productionDefaultInUse.info.after_url, ['version'], 'instalado ejecuta la caché de la versión publicada');
  } finally {
    busy.close();
  }
});
