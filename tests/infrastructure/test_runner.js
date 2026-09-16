const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('Test Runner - valida niveles definidos y parseo de argumentos', async () => {
  const runner = await import('../../scripts/test-runner.mjs');

  assert.deepEqual(runner.VALID_LEVELS, ['unit', 'integration', 'browser', 'architecture', 'infrastructure']);

  const parsed1 = runner.parseArgs(['--level=unit', '--list']);
  assert.equal(parsed1.level, 'unit');
  assert.equal(parsed1.listOnly, true);
  assert.equal(parsed1.group, null);

  const parsed2 = runner.parseArgs(['--group', 'composer']);
  assert.equal(parsed2.group, 'composer');
  assert.equal(parsed2.level, null);

  const parsed3 = runner.parseArgs(['tests/unit/foo.js', 'tests/unit/bar.js']);
  assert.deepEqual(parsed3.positionalFiles, ['tests/unit/foo.js', 'tests/unit/bar.js']);
});

test('Test Runner - rechaza niveles o grupos desconocidos con error descriptivo', async () => {
  const runner = await import('../../scripts/test-runner.mjs');

  assert.throws(() => {
    runner.resolveLevelFiles('nivel_invalido');
  }, /Nivel desconocido: 'nivel_invalido'/);

  assert.throws(() => {
    runner.resolveGroupFiles('grupo_invalido');
  }, /Grupo desconocido: 'grupo_invalido'/);
});

test('Test Runner - define grupos funcionales requeridos por tests/README.md', async () => {
  const runner = await import('../../scripts/test-runner.mjs');

  const expectedGroups = ['turns', 'composer', 'generation', 'profiles', 'mcp', 'rag', 'providers', 'bundle'];
  for (const grp of expectedGroups) {
    assert.ok(runner.GROUPS[grp], `El grupo ${grp} debe estar definido`);
    assert.ok(Array.isArray(runner.GROUPS[grp]), `El grupo ${grp} debe ser un array de archivos`);
  }
});
