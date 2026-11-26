const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plantilla agents/template.sh que el modo agentes pide crear (templates/project/mode-agent-templates.txt): se
// ejecuta tal cual con un zerochat falso en el PATH que sale con el código de FAKE_RC, y un comando de aviso que
// deja sus argumentos en un fichero.

const repoRoot = path.resolve(__dirname, '../..');
const templateText = fs.readFileSync(path.join(repoRoot, 'templates/project/mode-agent-templates.txt'), 'utf8');
const launcher = templateText.match(/agents\/template\.sh[^\n]*\n```bash\n([\s\S]*?)```/)[1]
  .replaceAll('<set>.<role>', 'informes.diario')
  .replaceAll('<role>', 'diario');

const skip = process.platform === 'win32' || spawnSync('bash', ['--version']).status !== 0;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-agent-template-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const bin = path.join(root, 'bin');
const project = path.join(root, 'project');
const notified = path.join(root, 'notified.txt');
fs.mkdirSync(bin);
fs.mkdirSync(path.join(project, 'agents'), { recursive: true });
fs.writeFileSync(path.join(bin, 'zerochat'), [
  '#!/usr/bin/env bash',
  '[ "$1 $2" = "--run-file agents/diario.md" ] || exit 99',
  'echo "salida del agente"',
  'echo "[run] conversation_id=conv_9 new=true" >&2',
  'exit "$FAKE_RC"',
  ''
].join('\n'), { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'avisar'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(notified)}\n`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'avisar-falla'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
const script = path.join(project, 'agents', 'diario.sh');
fs.writeFileSync(script, launcher, { mode: 0o755 });

function launch(rc, notify) {
  fs.rmSync(notified, { force: true });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_RC: String(rc) };
  if (notify === undefined) delete env.ZEROCHAT_NOTIFY;
  else env.ZEROCHAT_NOTIFY = notify;
  // Desde otra carpeta: la plantilla se sitúa en la del proyecto.
  const result = spawnSync('bash', [script], { cwd: root, env, encoding: 'utf8' });
  return { ...result, notified: fs.existsSync(notified) ? fs.readFileSync(notified, 'utf8') : null };
}

test('template.sh avisa con el comando configurado solo si la ejecución se pausa, llega al límite o falla, y conserva su código', { skip }, () => {
  for (const [rc, expected] of [[0, null], [5, 'needs_input'], [6, 'limit'], [7, null], [1, 'error'], [3, 'error']]) {
    const result = launch(rc, 'avisar --zerochat');
    assert.equal(result.status, rc, `código ${rc}: ${result.stderr}`);
    assert.equal(result.stdout, 'salida del agente\n');
    // stderr llega entero a quien lanza la plantilla (cron lo guarda o lo envía).
    assert.match(result.stderr, /^\[run\] conversation_id=conv_9 new=true$/m);
    assert.equal(result.notified, expected && `--zerochat informes.diario ${expected} ${rc} conv_9\n`, `código ${rc}`);
  }
});

test('template.sh sin ZEROCHAT_NOTIFY no avisa, y un aviso que falla no cambia el código de la ejecución', { skip }, () => {
  const silent = launch(5);
  assert.equal(silent.status, 5);
  assert.equal(silent.notified, null);
  const failing = launch(6, 'avisar-falla');
  assert.equal(failing.status, 6);
  assert.match(failing.stderr, /\[notify\] the alert command failed/);
});
