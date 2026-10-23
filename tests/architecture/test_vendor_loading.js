const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Carga de las librerías empaquetadas: las de arranque van en la página y en el precache; las
// demás las pide ChatVendorLoader cuando hacen falta.

const ROOT = path.resolve(__dirname, '../..');
const VendorLoader = require(path.join(ROOT, 'js/vendor-loader.js'));

test('solo las librerías de arranque se cargan en zerochat.html y entran en el precache', async () => {
  const { VENDORS } = await import(pathToFileURL(path.join(ROOT, 'scripts/vendor-manifest.mjs')).href);
  const html = fs.readFileSync(path.join(ROOT, 'zerochat.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  for (const vendor of VENDORS) {
    const outfile = VendorLoader.bundleInfo(vendor.id).path;
    assert.equal(html.includes(`src="${outfile}"`), !vendor.onDemand, `${outfile} en zerochat.html`);
    assert.equal(sw.includes(`'./${outfile}'`), !vendor.onDemand, `${outfile} en PRECACHE_ASSETS`);
  }
});
