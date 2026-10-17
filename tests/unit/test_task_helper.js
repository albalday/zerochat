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

test('task.py - done marca la tarea y detecta automáticamente la siguiente', () => {
  const env = setupMockZerochatDir();
  try {
    runTaskScript(['done', 'M1-T1', '--date', '2026-10-15'], { dir: env.dir });

    const plan = fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8');
    assert.match(plan, /- \[x\] M1-T1 First task \(2026-10-15\)/);
    assert.match(plan, /- \[ \] M1-T2 Second task/);

    const state = fs.readFileSync(path.join(env.dir, 'state.md'), 'utf-8');
    assert.match(state, /- Next task: M1-T2 Second task/);
    assert.match(state, /- Last updated: 2026-10-15/);
  } finally {
    env.cleanup();
  }
});

test('task.py - done con decisión registra el siguiente ID correlativo en log.md', () => {
  const env = setupMockZerochatDir();
  try {
    runTaskScript(['done', 'M1-T1', '-d', 'Nueva arquitectura de pruebas', '--date', '2026-10-15'], { dir: env.dir });

    const log = fs.readFileSync(path.join(env.dir, 'log.md'), 'utf-8');
    assert.match(log, /- 2026-10-15 M1-D2 Nueva arquitectura de pruebas \(M1-T1\)/);
  } finally {
    env.cleanup();
  }
});

test('task.py - done al terminar el hito marca none pending si no quedan tareas', () => {
  const env = setupMockZerochatDir();
  try {
    runTaskScript(['done', 'M1-T1', '--date', '2026-10-15'], { dir: env.dir });
    runTaskScript(['done', 'M1-T2', '--date', '2026-10-15'], { dir: env.dir });

    const state = fs.readFileSync(path.join(env.dir, 'state.md'), 'utf-8');
    assert.match(state, /- Next task: none pending/);
  } finally {
    env.cleanup();
  }
});

test('task.py - done con --drop marca la tarea como descartada con motivo', () => {
  const env = setupMockZerochatDir();
  try {
    runTaskScript(['done', 'M1-T1', '--drop', 'obsoleta por cambios en requisitos'], { dir: env.dir });

    const plan = fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8');
    assert.match(plan, /- \[x\] M1-T1 First task \(dropped: obsoleta por cambios en requisitos\)/);
  } finally {
    env.cleanup();
  }
});

test('task.py - add-task añade una tarea numerada consecutivamente al hito', () => {
  const env = setupMockZerochatDir();
  try {
    runTaskScript(['add-task', 'M1', 'Tercera tarea agregada'], { dir: env.dir });

    const plan = fs.readFileSync(path.join(env.dir, 'plan.md'), 'utf-8');
    assert.match(plan, /- \[ \] M1-T3 Tercera tarea agregada/);
  } finally {
    env.cleanup();
  }
});

test('task.py - rechaza IDs de tarea inválidos', () => {
  const env = setupMockZerochatDir();
  try {
    assert.throws(() => {
      runTaskScript(['done', 'invalid-task-id'], { dir: env.dir });
    }, /Invalid task ID/);
  } finally {
    env.cleanup();
  }
});
