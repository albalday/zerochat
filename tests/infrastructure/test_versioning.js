const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('bump-version: los parches web no cambian PyPI y minor actualiza ambos', () => {
  const root = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-version-'));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    for (const file of ['package.json', 'package-lock.json', 'pyproject.toml', 'zerochat.py', 'zerochat.html', 'sw.js']) {
      fs.copyFileSync(path.join(root, file), path.join(fixture, file));
    }
    fs.copyFileSync(path.join(root, 'scripts/bump-version.mjs'), path.join(fixture, 'scripts/bump-version.mjs'));

    const initialPyproject = fs.readFileSync(path.join(fixture, 'pyproject.toml'), 'utf8');
    const [major, minor, patch] = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version.split('.').map(Number);
    execFileSync('node', ['scripts/bump-version.mjs', 'patch'], { cwd: fixture });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version, `${major}.${minor}.${patch + 1}`);
    assert.equal(fs.readFileSync(path.join(fixture, 'pyproject.toml'), 'utf8'), initialPyproject);

    execFileSync('node', ['scripts/bump-version.mjs', 'minor'], { cwd: fixture });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version, `${major}.${minor + 1}.0`);
    assert.match(fs.readFileSync(path.join(fixture, 'pyproject.toml'), 'utf8'), new RegExp(`^version = "${major}\\.${minor + 1}\\.0"$`, 'm'));
    assert.match(fs.readFileSync(path.join(fixture, 'zerochat.py'), 'utf8'), new RegExp(`^SOURCE_BACKEND_VERSION = "${major}\\.${minor + 1}\\.0"$`, 'm'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
