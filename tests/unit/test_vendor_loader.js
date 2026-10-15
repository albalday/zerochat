const test = require('node:test');
const assert = require('node:assert/strict');

const VendorLoader = require('../../js/vendor-loader.js');

test('ChatVendorLoader carga el bundle versionado una sola vez y expone su global', async () => {
  globalThis.ZeroChatOrama = undefined;
  try {
    const [first, second] = await Promise.all([VendorLoader.load('orama'), VendorLoader.load('orama')]);
    assert.equal(first, second);
    assert.equal(first, globalThis.ZeroChatOrama);
    assert.equal(typeof first.create, 'function');
    assert.equal(await VendorLoader.load('orama'), first);
  } finally {
    globalThis.ZeroChatOrama = undefined;
  }
});

test('ChatVendorLoader informa de una librería no disponible y permite reintentar', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(VendorLoader.load('missing-library'), error => {
      assert.equal(error.code, 'VENDOR_UNAVAILABLE');
      assert.match(error.message, /missing-library library could not be loaded.*first use/);
      return true;
    });
  }
});

test('ChatVendorLoader rechaza identificadores que no son nombres de librería', async () => {
  for (const id of ['../utils', 'Orama', '', null, 'a/b']) {
    await assert.rejects(VendorLoader.load(id), /Invalid vendor library id/);
  }
});
