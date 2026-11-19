const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(__dirname, '../../.zerochat/task.py');

function runTaskScript(args, { dir }) {
  return execFileSync('python3', [SCRIPT_PATH, '--dir', dir, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
}

function setupMockZerochatDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-test-'));
  const planContent = `# Plan

## M1 First milestone
Goal: Test goal
Done when: Test done
- [ ] M1-T1 First task
- [ ] M1-T2 Second task

## M2 Second milestone
Goal: Next goal
Done when: Next done
- [ ] M2-T1 Third task
`;

  const stateContent = `# Current state
- Milestone: M1 First milestone
- Next task: M1-T1 First task
- Active decisions: none
- Last updated: 2026-01-01
`;

  const logContent = `# Decision log

- 2026-01-01 M1-D1 Initial decision (M1-T0)
`;

  fs.writeFileSync(path.join(tmpDir, 'plan.md'), planContent, 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'state.md'), stateContent, 'utf-8');
  fs.writeFileSync(path.join(tmpDir, 'log.md'), logContent, 'utf-8');

  return {
    dir: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true })
  };
}

test('task.py - done actualiza plan.md/state.md/log.md, --drop, fin de hito y literales con barras invertidas', () => {
  const env = setupMockZerochatDir();
  try {
    const planWithSlash = fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8')
      .replace('- [ ] M1-T2 Second task', '- [ ] M1-T2 Pintar `\\r` y `\\1` como en una terminal');
    fs.writeFileSync(path.join(env.dir, 'plan.md'), planWithSlash, 'utf-8');

    runTaskScript(['done', 'M1-T1', '-d', 'Nueva arquitectura de pruebas', '--date', '2026-10-15'], { dir: env.dir });
    const plan1 = fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8');
    assert.match(plan1, /- \[x\] M1-T1 First task \(2026-10-15\)/);
    const state1 = fs.readFileSync(path.join(env.dir, 'state.md'), 'utf-8');
    assert.ok(state1.includes('- Next task: M1-T2 Pintar `\\r` y `\\1` como en una terminal\n'), state1);
    assert.ok(!state1.includes('\r'));
    assert.match(state1, /- Last updated: 2026-10-15/);
    const log = fs.readFileSync(path.join(env.dir, 'log.md'), 'utf-8');
    assert.match(log, /- 2026-10-15 M1-D2 Nueva arquitectura de pruebas \(M1-T1\)/);

    runTaskScript(['done', 'M1-T2', '--drop', 'obsoleta por cambios en requisitos'], { dir: env.dir });
    assert.match(fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8'), /- \[x\] M1-T2 .* \(dropped: obsoleta por cambios en requisitos\)/);
    assert.match(fs.readFileSync(path.join(env.dir, 'state.md'), 'utf-8'), /- Next task: none pending/);
  } finally {
    env.cleanup();
  }
});

test('task.py - add-task añade tarea numerada y rechaza IDs de tarea inválidos', () => {
  const env = setupMockZerochatDir();
  try {
    runTaskScript(['add-task', 'M1', 'Tercera tarea agregada'], { dir: env.dir });
    assert.match(fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8'), /- \[ \] M1-T3 Tercera tarea agregada/);
    assert.throws(() => runTaskScript(['done', 'invalid-task-id'], { dir: env.dir }), /Invalid task ID/);
  } finally {
    env.cleanup();
  }
});
