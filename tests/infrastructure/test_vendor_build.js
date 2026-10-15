const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const loadManifest = () => import(pathToFileURL(path.join(root, 'scripts/vendor-manifest.mjs')).href);

test('build:vendor reproduce exactamente los bundles, licencias y avisos versionados', async () => {
  const { VENDORS } = await loadManifest();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-vendor-'));
  try {
    execFileSync('node', ['scripts/build-vendor.mjs', '--out-dir', outDir], { cwd: root, stdio: 'pipe' });
    const generated = ['THIRD_PARTY_NOTICES.md'];
    for (const vendor of VENDORS) generated.push(vendor.outfile, `licenses/${vendor.id.toUpperCase()}-LICENSE.md`);
    for (const file of generated) {
      assert.ok(fs.readFileSync(path.join(outDir, file)).equals(fs.readFileSync(path.join(root, file))),
        `${file} no coincide con la salida de npm run build:vendor`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('build:vendor exige versiones exactas para las librerías empaquetadas', async () => {
  const { VENDORS } = await loadManifest();
  const { dependencies } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const vendor of VENDORS) {
    assert.match(dependencies[vendor.package] || '', /^\d+\.\d+\.\d+$/, `${vendor.package} debe fijarse a una versión exacta`);
  }
});

test('build:vendor expone cada librería como global clásico ejecutable en Node', async () => {
  const { VENDORS } = await loadManifest();
  const vm = require('node:vm');
  for (const vendor of VENDORS) {
    const context = vm.createContext({ console, TextEncoder, TextDecoder, setTimeout, clearTimeout });
    vm.runInContext(`${fs.readFileSync(path.join(root, vendor.outfile), 'utf8')}\nthis.${vendor.globalName} = ${vendor.globalName};`, context);
    assert.equal(typeof context[vendor.globalName], 'object', `${vendor.outfile} debe definir ${vendor.globalName}`);
  }
});

test('solo las librerías de arranque se cargan en zerochat.html y entran en el precache', async () => {
  const { VENDORS } = await loadManifest();
  const html = fs.readFileSync(path.join(root, 'zerochat.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  for (const vendor of VENDORS) {
    assert.equal(html.includes(`src="${vendor.outfile}"`), !vendor.onDemand, `${vendor.outfile} en zerochat.html`);
    assert.equal(sw.includes(`'./${vendor.outfile}'`), !vendor.onDemand, `${vendor.outfile} en PRECACHE_ASSETS`);
  }
});
