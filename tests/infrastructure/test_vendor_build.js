const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const VendorLoader = require(path.join(root, 'js/vendor-loader.js'));
const loadManifest = () => import(pathToFileURL(path.join(root, 'scripts/vendor-manifest.mjs')).href);
const outfileOf = vendor => VendorLoader.bundleInfo(vendor.id).path;
const globalNameOf = vendor => VendorLoader.bundleInfo(vendor.id).globalName;

test('build:vendor reproduce exactamente los bundles, las licencias y los avisos versionados', async () => {
  const { VENDORS } = await loadManifest();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-vendor-'));
  try {
    execFileSync('node', ['scripts/build-vendor.mjs', '--out-dir', outDir], { cwd: root, stdio: 'pipe' });
    const listLicenses = dir => fs.readdirSync(path.join(dir, 'licenses')).sort();
    assert.deepEqual(listLicenses(outDir), listLicenses(root), 'licenses/ debe coincidir con la salida de npm run build:vendor');
    const generated = ['THIRD_PARTY_NOTICES.md', ...VENDORS.map(outfileOf), ...listLicenses(root).map(name => `licenses/${name}`)];
    for (const file of generated) {
      assert.ok(fs.readFileSync(path.join(outDir, file)).equals(fs.readFileSync(path.join(root, file))),
        `${file} no coincide con la salida de npm run build:vendor`);
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('build:vendor incluye el texto de licencia de cada paquete empaquetado', () => {
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const linked = [...notices.matchAll(/\]\((licenses\/[^)]+)\)/g)].map(match => match[1]);
  for (const file of linked) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /ships no separate license file/, `${file} no contiene el texto de la licencia`);
  }
  assert.deepEqual([...new Set(linked)].sort(), fs.readdirSync(path.join(root, 'licenses')).map(name => `licenses/${name}`).sort());
  for (const bundled of ['jszip', 'dingbat-to-unicode', 'lop', 'underscore', 'xmlbuilder']) {
    assert.match(notices, new RegExp(`^- \`${bundled}\``, 'm'), `${bundled} va dentro de un bundle y debe figurar en los avisos`);
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
    vm.runInContext(fs.readFileSync(path.join(root, outfileOf(vendor)), 'utf8'), context);
    assert.equal(typeof context[globalNameOf(vendor)], 'object', `${outfileOf(vendor)} debe definir ${globalNameOf(vendor)}`);
  }
});

test('solo las librerías de arranque se cargan en zerochat.html y entran en el precache', async () => {
  const { VENDORS } = await loadManifest();
  const html = fs.readFileSync(path.join(root, 'zerochat.html'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  for (const vendor of VENDORS) {
    const outfile = outfileOf(vendor);
    assert.equal(html.includes(`src="${outfile}"`), !vendor.onDemand, `${outfile} en zerochat.html`);
    assert.equal(sw.includes(`'./${outfile}'`), !vendor.onDemand, `${outfile} en PRECACHE_ASSETS`);
  }
});

test('VendorLoader.bundleInfo devuelve la ruta y globalName esperados y rechaza IDs no válidos', () => {
  const info = VendorLoader.bundleInfo('office-parser');
  assert.deepEqual(info, {
    id: 'office-parser',
    path: 'js/vendor/office-parser.browser.js',
    globalName: 'ZeroChatOfficeParser'
  });
  assert.throws(() => VendorLoader.bundleInfo('Invalid_Id!'), /Invalid vendor library id/);
  assert.throws(() => VendorLoader.bundleInfo(123), /Invalid vendor library id/);
});
