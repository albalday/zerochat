const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tokenDataDir } = require('../helpers/backend-env.js');

// Modo ejecución de zerochat.py (--prompt): copia del perfil de Firefox y ciclo completo con un
// «firefox» falso en el PATH que hace de interfaz por JSON-RPC.

const repoRoot = path.resolve(__dirname, '../..');
const backendPath = path.join(repoRoot, 'zerochat.py');
const UI_ORIGIN = 'https://albalday.github.io';
const ORIGIN_DIR = 'https+++albalday.github.io';

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const pidAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
};

test('zerochat.py: localiza el perfil de Firefox con datos de la interfaz y copia solo ese origen', { skip: process.platform === 'win32' }, () => {
  const script = `
import importlib.util, os, sqlite3, stat, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('zerochat', Path(${JSON.stringify(backendPath)}))
zerochat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zerochat)

origin = zerochat.ui_origin()
assert origin == ${JSON.stringify(UI_ORIGIN)}, origin
assert zerochat.firefox_origin_dir_name(origin) == ${JSON.stringify(ORIGIN_DIR)}
assert zerochat.firefox_origin_dir_name("http://localhost:8080") == "http+++localhost+8080"

def expect_setup_error(fn, fragment):
    try:
        fn()
    except zerochat.RunSetupError as exc:
        assert fragment in str(exc), str(exc)
    else:
        raise AssertionError("RunSetupError esperado: " + fragment)

def profile(root, name, with_origin=True):
    path = root / name
    (path / "storage" / "default").mkdir(parents=True)
    if with_origin:
        (path / "storage" / "default" / ${JSON.stringify(ORIGIN_DIR)}).mkdir()
    return path

with tempfile.TemporaryDirectory() as home:
    os.environ["HOME"] = home
    expect_setup_error(lambda: zerochat.locate_firefox_profile(origin), "No se encontró ningún perfil")

    # Prioridad: installs.ini, después [Install*] de profiles.ini, después Default=1 y el resto;
    # se salta el candidato que no tiene datos de la interfaz.
    root = Path(home) / ".mozilla" / "firefox"
    root.mkdir(parents=True)
    profile(root, "inst", with_origin=False)
    a = profile(root, "a")
    b = profile(root, "b")
    (root / "installs.ini").write_text("[ABC]\\nDefault=inst\\n", encoding="utf-8")
    (root / "profiles.ini").write_text(
        "[Profile1]\\nName=b\\nIsRelative=1\\nPath=b\\n\\n"
        "[Profile0]\\nName=a\\nIsRelative=1\\nPath=a\\nDefault=1\\n\\n"
        "[InstallABC]\\nDefault=b\\n", encoding="utf-8")
    assert zerochat.locate_firefox_profile(origin) == b
    (root / "profiles.ini").write_text(
        "[Profile1]\\nName=b\\nIsRelative=1\\nPath=b\\n\\n"
        "[Profile0]\\nName=a\\nIsRelative=1\\nPath=a\\nDefault=1\\n", encoding="utf-8")
    assert zerochat.locate_firefox_profile(origin) == a
    (a / "storage" / "default" / ${JSON.stringify(ORIGIN_DIR)}).rmdir()
    assert zerochat.locate_firefox_profile(origin) == b
    (b / "storage" / "default" / ${JSON.stringify(ORIGIN_DIR)}).rmdir()
    expect_setup_error(lambda: zerochat.locate_firefox_profile(origin), "abre ZeroChat una vez en Firefox")

    # La ruta XDG con un perfil de ruta absoluta.
    (root / "profiles.ini").unlink()
    xdg_root = Path(home) / ".config" / "mozilla" / "firefox"
    xdg_root.mkdir(parents=True)
    elsewhere = profile(Path(home) / "otros", "c")
    (xdg_root / "profiles.ini").write_text(f"[Profile0]\\nName=c\\nIsRelative=0\\nPath={elsewhere}\\n", encoding="utf-8")
    assert zerochat.locate_firefox_profile(origin) == elsewhere

    # Perfil con datos de la interfaz, de otro origen y del propio perfil.
    source = profile(Path(home) / "fuente", "p")
    storage = source / "storage" / "default"
    origin_dir = storage / ${JSON.stringify(ORIGIN_DIR)}
    (storage / "https+++github.com").mkdir()
    (storage / "https+++github.com" / "secret").write_text("x", encoding="utf-8")
    (source / "cookies.sqlite").write_bytes(b"cookies")
    (source / "logins.json").write_text("{}", encoding="utf-8")
    (origin_dir / ".metadata-v2").write_bytes(b"meta")
    (origin_dir / "ls").mkdir()
    (origin_dir / "idb" / "db.files").mkdir(parents=True)
    (origin_dir / "idb" / "db.files" / "1").write_bytes(b"blob")

    # localStorage con filas solo en el WAL y una base IndexedDB bloqueada en modo exclusivo,
    # como las mantiene Firefox abierto.
    ls = sqlite3.connect(origin_dir / "ls" / "data.sqlite")
    ls.execute("PRAGMA journal_mode=WAL")
    ls.execute("PRAGMA wal_autocheckpoint=0")
    ls.execute("CREATE TABLE data (key TEXT, value TEXT)")
    ls.execute("INSERT INTO data VALUES ('config', 'production')")
    ls.commit()
    idb = sqlite3.connect(origin_dir / "idb" / "db.sqlite")
    idb.execute("PRAGMA locking_mode=EXCLUSIVE")
    idb.execute("PRAGMA journal_mode=WAL")
    idb.execute("PRAGMA wal_autocheckpoint=0")
    idb.execute("CREATE TABLE object_data (key TEXT)")
    idb.execute("INSERT INTO object_data VALUES ('conversation')")
    idb.commit()
    assert (origin_dir / "idb" / "db.sqlite-wal").stat().st_size > 0

    perms = sqlite3.connect(source / "permissions.sqlite")
    perms.execute("CREATE TABLE moz_perms (id INTEGER PRIMARY KEY, origin TEXT, type TEXT, permission INTEGER)")
    perms.execute("CREATE TABLE moz_hosts (id INTEGER PRIMARY KEY, host TEXT)")
    perms.executemany("INSERT INTO moz_perms (origin, type, permission) VALUES (?, ?, 1)", [
        (origin, "loopback-network"), (origin, "local-network"), ("https://github.com", "cookie"), (origin + "^userContextId=1", "cookie")])
    perms.execute("INSERT INTO moz_hosts (host) VALUES ('legacy')")
    perms.execute("PRAGMA user_version = 12")
    perms.commit()
    perms.close()

    copy = zerochat.create_firefox_run_profile(source, origin)
    try:
        ls.close()
        idb.close()
        assert stat.S_IMODE(copy.stat().st_mode) == 0o700
        assert sorted(p.name for p in copy.iterdir()) == ["permissions.sqlite", "storage", "user.js"]
        copied = copy / "storage" / "default"
        assert [p.name for p in copied.iterdir()] == [${JSON.stringify(ORIGIN_DIR)}]
        target = copied / ${JSON.stringify(ORIGIN_DIR)}
        assert (target / ".metadata-v2").read_bytes() == b"meta"
        assert (target / "idb" / "db.files" / "1").read_bytes() == b"blob"
        assert not list(target.rglob("*-wal")) and not list(target.rglob("*-shm"))
        assert sqlite3.connect(target / "ls" / "data.sqlite").execute("SELECT value FROM data").fetchall() == [("production",)]
        assert sqlite3.connect(target / "idb" / "db.sqlite").execute("SELECT key FROM object_data").fetchall() == [("conversation",)]
        copied_perms = sqlite3.connect(copy / "permissions.sqlite")
        assert sorted(copied_perms.execute("SELECT origin, type FROM moz_perms").fetchall()) == [(origin, "local-network"), (origin, "loopback-network")]
        assert copied_perms.execute("SELECT count(*) FROM moz_hosts").fetchone() == (0,)
        assert copied_perms.execute("PRAGMA user_version").fetchone() == (12,)
        copied_perms.close()
        assert 'user_pref("dom.allow_scripts_to_close_windows", true);' in (copy / "user.js").read_text(encoding="utf-8")
    finally:
        import shutil
        shutil.rmtree(copy)

    # Sin firefox en el PATH no hay ejecución; con él, Firefox propio sobre la copia.
    os.environ["PATH"] = str(Path(home) / "vacio")
    expect_setup_error(lambda: zerochat.firefox_launch_command(Path("/tmp/copia"), "https://ui#x", True), "firefox")
    bin_dir = Path(home) / "bin"
    bin_dir.mkdir()
    (bin_dir / "firefox").write_text("#!/bin/sh\\n", encoding="utf-8")
    (bin_dir / "firefox").chmod(0o755)
    os.environ["PATH"] = str(bin_dir)
    assert zerochat.firefox_launch_command(Path("/tmp/copia"), "https://ui#x", True) == [str(bin_dir / "firefox"), "-no-remote", "-profile", "/tmp/copia", "--headless", "https://ui#x"]
    assert "--headless" not in zerochat.firefox_launch_command(Path("/tmp/copia"), "https://ui#x", False)
`;
  execFileSync('python3', ['-c', script], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' });
});

// «firefox» falso: hace de interfaz con el fragmento de arranque y deja en INFO lo que observó.
const FAKE_FIREFOX = `
import json, os, sys, time, urllib.parse, urllib.request
from pathlib import Path
args = sys.argv[1:]
profile = Path(args[args.index("-profile") + 1])
fragment = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(args[-1]).fragment))
scenario = os.environ["FAKE_UI_SCENARIO"]
info = {"pid": os.getpid(), "args": args, "profile": str(profile), "profile_mode": profile.stat().st_mode & 0o777,
        "has_origin": (profile / "storage" / "default" / ${JSON.stringify(ORIGIN_DIR)} / ".metadata-v2").is_file()}

def rpc(method, run_id=fragment["run"], **params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {"run_id": run_id, **params}}).encode()
    request = urllib.request.Request(f"http://{fragment['host']}:{fragment['port']}/", data=body, headers={
        "Content-Type": "application/json", "Origin": ${JSON.stringify(UI_ORIGIN)}, "X-ZeroChat-Token": fragment["token"]})
    return json.loads(urllib.request.urlopen(request, timeout=5).read())

def save():
    Path(os.environ["FAKE_UI_INFO"]).write_text(json.dumps(info), encoding="utf-8")

save()
if scenario == "exit":
    sys.exit(0)
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
    while True:
        rpc("zerochat/run/progress", kind="stream")
        time.sleep(0.2)
# Firefox sin ventana no termina solo: lo mata el backend.
time.sleep(60)
`;

function sampleHome() {
  const home = tempDir('zerochat-run-home-');
  const profileDir = path.join(home, '.mozilla', 'firefox', 'perfil');
  fs.mkdirSync(path.join(profileDir, 'storage', 'default', ORIGIN_DIR), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'storage', 'default', ORIGIN_DIR, '.metadata-v2'), 'meta');
  fs.writeFileSync(path.join(home, '.mozilla', 'firefox', 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=perfil\nDefault=1\n');
  return home;
}

function runZerochat(args, { scenario = 'ok', home = sampleHome(), idleSeconds = '30' } = {}) {
  const work = tempDir('zerochat-run-');
  const binDir = path.join(work, 'bin');
  fs.mkdirSync(binDir);
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(binDir, 'firefox'), `#!${python}\n${FAKE_FIREFOX}`, { mode: 0o755 });
  const infoPath = path.join(work, 'info.json');
  return new Promise(resolve => {
    const proc = spawn('python3', [backendPath, '--no-venv', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        ZEROCHAT_DATA_DIR: tokenDataDir('run-mode-token-0123456789'),
        ZEROCHAT_RUN_IDLE_SECONDS: idleSeconds,
        FAKE_UI_SCENARIO: scenario,
        FAKE_UI_INFO: infoPath
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

test('zerochat.py --prompt: respuesta solo en stdout, códigos de salida, plazos y limpieza del navegador y la copia', { skip: process.platform === 'win32' }, async () => {
  const [ok, failed, idle, chatty, browserGone, noProfile, emptyPrompt] = await Promise.all([
    runZerochat(['--prompt', 'hola mundo', '--headless']),
    runZerochat(['--prompt', 'hola', '--headless'], { scenario: 'error' }),
    runZerochat(['--prompt', 'hola', '--headless'], { scenario: 'idle', idleSeconds: '1' }),
    runZerochat(['--prompt', 'hola', '--headless', '--timeout', '2'], { scenario: 'chatty', idleSeconds: '1' }),
    runZerochat(['--prompt', 'hola'], { scenario: 'exit' }),
    runZerochat(['--prompt', 'hola'], { home: tempDir('zerochat-run-empty-home-') }),
    runZerochat(['--prompt', '   '])
  ]);

  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, 'Respuesta a: hola mundo\n');
  assert.ok(ok.info.args.includes('--headless') && ok.info.args.includes('-no-remote'));
  assert.equal(ok.info.profile_mode, 0o700);
  assert.equal(ok.info.has_origin, true);
  assert.equal(ok.info.wrong_run_id, 'run_id no válido.');
  assert.equal(ok.info.second_prompt, 'El prompt ya se entregó.');
  assert.equal(ok.info.bad_result, 'El resultado lleva text o error.');
  // El progreso se registra en stderr recortado en su tope exacto.
  assert.match(ok.stderr, new RegExp(`\\[run\\] tool: ${'y'.repeat(500)}\\n`));
  assert.match(ok.stderr, new RegExp(`\\[run\\] tool: ${'x'.repeat(500)}…\\n`));
  assert.match(ok.stderr, /Perfil de Firefox:/);

  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Error de generación: model failed/);

  assert.equal(idle.code, 2);
  assert.match(idle.stderr, /Sin progreso de la interfaz durante 1s/);
  // El progreso continuo reinicia la inactividad, pero no el plazo total.
  assert.equal(chatty.code, 2);
  assert.match(chatty.stderr, /Plazo total agotado \(2s\)/);
  assert.equal(browserGone.code, 2);
  assert.match(browserGone.stderr, /El navegador terminó sin devolver resultado/);
  assert.ok(!browserGone.info.args.includes('--headless'));

  for (const run of [ok, failed, idle, chatty, browserGone]) {
    assert.equal(pidAlive(run.info.pid), false, `el navegador falso (PID ${run.info.pid}) debe terminar`);
    assert.equal(fs.existsSync(run.info.profile), false, `la copia ${run.info.profile} debe borrarse`);
    assert.equal(run.stdout.includes('['), false, 'stdout no lleva registro');
  }

  assert.equal(noProfile.code, 3);
  assert.equal(noProfile.stdout, '');
  assert.match(noProfile.stderr, /No se encontró ningún perfil de Firefox/);
  assert.equal(noProfile.info, null);
  assert.equal(emptyPrompt.code, 3);
  assert.match(emptyPrompt.stderr, /El prompt está vacío/);
});
