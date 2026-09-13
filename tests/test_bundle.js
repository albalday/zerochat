const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_PROD_PATH = path.join(__dirname, 'tmp_test_prod.html');
const TEST_FALLBACK_PATH = path.join(__dirname, 'tmp_test_fallback.html');
const TEST_DEV_PATH = path.join(__dirname, 'tmp_test_dev.html');
const TEST_GENERIC_DIR = path.join(__dirname, 'tmp_bundle_generic');
const TEST_PROFILE_DIR = path.join(__dirname, 'tmp_bundle_profiles');

test('Bundler - usa únicamente el esbuild instalado', () => {
  const source = fs.readFileSync(path.join(ROOT_DIR, 'bundle.py'), 'utf-8');
  assert.match(source, /\['npx', '--no-install', 'esbuild'/);
  assert.doesNotMatch(source, /\['npx', '--yes', 'esbuild'/);
});

function getIndexScriptPaths() {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf-8');
  return Array.from(html.matchAll(/<script[^>]+src=["'](js\/[^"']+)["']/gi), match => match[1]);
}

function getUmdGlobalNames(scriptPath) {
  const source = fs.readFileSync(path.join(ROOT_DIR, scriptPath), 'utf-8');
  return Array.from(source.matchAll(/root\.([A-Za-z_$][\w$]*)\s*=\s*factory/g), match => match[1]);
}

test('Bundler - Generación en modo Producción (Gzip Base64 Level 9)', () => {
  try {
    const stdout = execSync(`python3 bundle.py index.html "${TEST_PROD_PATH}" --mode=prod`, { cwd: ROOT_DIR, encoding: 'utf-8' });
    assert.ok(stdout.includes("generado con éxito"));
    assert.ok(fs.existsSync(TEST_PROD_PATH));

    const content = fs.readFileSync(TEST_PROD_PATH, 'utf-8');
    const stats = fs.statSync(TEST_PROD_PATH);
    assert.ok(content.includes('<!DOCTYPE html>'));
    assert.ok(content.includes('<html lang="es">'));
    assert.ok(content.includes('<style>'));
    assert.ok(content.includes('id="compressed-js"'));
    assert.ok(content.includes('DecompressionStream'));

    // Verificar que el tamaño de producción es ultra-compacto (< 400 KB)
    assert.ok(stats.size < 400000, `El bundle comprimido debe ser ultra-compacto (actual: ${stats.size} bytes)`);

    // Verificar ausencia de enlaces locales externos
    assert.equal(/<script[^>]*src=["']js\//i.test(content), false, 'No deben quedar etiquetas <script src="js/...">');
    assert.equal(/<link[^>]*href=["']css\//i.test(content), false, 'No deben quedar etiquetas <link href="css/...">');

    // Extraer y descomprimir el CSS embebido
    const cssMatch = content.match(/<script[^>]*id=["']compressed-css["'][^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(cssMatch, 'Debe contener la etiqueta <script id="compressed-css">');
    const decompressedCss = zlib.gunzipSync(Buffer.from(cssMatch[1].trim(), 'base64')).toString('utf-8');
    assert.ok(decompressedCss.length > 10000, 'El CSS descomprimido debe contener los estilos completos');

    // Extraer y descomprimir el JavaScript embebido
    const match = content.match(/<script[^>]*id=["']compressed-js["'][^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(match, 'Debe contener la etiqueta <script id="compressed-js">');

    const b64Payload = match[1].trim();
    const decompressedJs = zlib.gunzipSync(Buffer.from(b64Payload, 'base64')).toString('utf-8');
    assert.ok(decompressedJs.length > 500000, 'El JavaScript descomprimido debe contener el código completo');

    // Las etiquetas script del HTML son la fuente de verdad del bundle. Cada
    // módulo UMD cargado allí debe conservar su global público tras empaquetar.
    const expectedModules = getIndexScriptPaths().flatMap(getUmdGlobalNames);
    assert.ok(expectedModules.length > 0, 'index.html debe declarar módulos UMD para el runtime');
    for (const mod of expectedModules) {
      assert.ok(decompressedJs.includes(mod), `El módulo ${mod} debe estar presente en el código descomprimido`);
    }

    // Verificar validez sintáctica en Node.js
    assert.doesNotThrow(() => {
      execSync('node -c', { input: decompressedJs, encoding: 'utf-8' });
    }, 'El JavaScript descomprimido debe ser 100% válido sintácticamente');
  } finally {
    if (fs.existsSync(TEST_PROD_PATH)) fs.unlinkSync(TEST_PROD_PATH);
  }
});

test('Bundler - Generación en modo Fallback Puro (Python Fallback CSS)', () => {
  try {
    const stdout = execSync(`python3 bundle.py index.html "${TEST_FALLBACK_PATH}" --fallback-only`, { cwd: ROOT_DIR, encoding: 'utf-8' });
    assert.ok(stdout.includes('Python Fallback'));
    assert.ok(fs.existsSync(TEST_FALLBACK_PATH));

    const content = fs.readFileSync(TEST_FALLBACK_PATH, 'utf-8');
    assert.ok(content.includes('<!DOCTYPE html>'));

    // Extraer el JS embebido y comprobar descompresión y sintaxis
    const match = content.match(/<script[^>]*id=["']compressed-js["'][^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(match, 'Debe contener un bloque <script id="compressed-js">');

    const b64Payload = match[1].trim();
    const decompressedJs = zlib.gunzipSync(Buffer.from(b64Payload, 'base64')).toString('utf-8');
    assert.doesNotThrow(() => {
      execSync('node -c', { input: decompressedJs, encoding: 'utf-8' });
    }, 'El JavaScript descomprimido del fallback debe ser 100% válido sintácticamente');
  } finally {
    if (fs.existsSync(TEST_FALLBACK_PATH)) fs.unlinkSync(TEST_FALLBACK_PATH);
  }
});

test('Bundler - Generación en modo Desarrollo (--mode=dev)', () => {
  try {
    const stdout = execSync(`python3 bundle.py index.html "${TEST_DEV_PATH}" --mode=dev`, { cwd: ROOT_DIR, encoding: 'utf-8' });
    assert.ok(stdout.includes('Modo: DEV'));
    assert.ok(fs.existsSync(TEST_DEV_PATH));

    const content = fs.readFileSync(TEST_DEV_PATH, 'utf-8');
    assert.ok(content.includes('<!DOCTYPE html>'));
    assert.ok(content.includes('id="compressed-js"'));
  } finally {
    if (fs.existsSync(TEST_DEV_PATH)) fs.unlinkSync(TEST_DEV_PATH);
  }
});

test('Bundler - incorpora una copia .zcp opcional y retrasa el arranque para restaurarla', () => {
  const sourcePath = path.join(TEST_PROFILE_DIR, 'app.html');
  const outputPath = path.join(TEST_PROFILE_DIR, 'portable.html');
  try {
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'js'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'css'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'profile-backup.js'), 'globalThis.ChatProfileBackup = {};');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'profile-repository.js'), 'globalThis.ChatProfileRepository = {};');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'app.js'), 'const Config = { initialize() {} }; if (Config.initialize) Config.initialize();');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'css', 'app.css'), 'body { color: black; }');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles', 'test-demo.zcp'), JSON.stringify({ marker: 'demo-profile-backup' }));
    fs.writeFileSync(sourcePath, '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/app.css"></head><body><script src="js/profile-backup.js"></script><script src="js/profile-repository.js"></script><script src="js/app.js"></script></body></html>');
    execSync(`python3 bundle.py "${sourcePath}" "${outputPath}" --mode=dev`, { cwd: ROOT_DIR, encoding: 'utf-8' });
    const content = fs.readFileSync(outputPath, 'utf-8');
    const match = content.match(/<script[^>]*id=["']compressed-js["'][^>]*>([\s\S]*?)<\/script>/i);
    const js = zlib.gunzipSync(Buffer.from(match[1].trim(), 'base64')).toString('utf-8');
    assert.ok(js.includes('demo-profile-backup'), 'Debe incluir el contenido de la copia .zcp');
    assert.ok(js.includes('__ZEROCHAT_BUNDLE_PROFILE_RESTORE__'));
    assert.ok(js.includes('storage.getStorageItem(repository.STORAGE_KEY)'), 'Solo debe restaurar si el almacenamiento de perfiles no existe');
    assert.ok(js.includes('repository.mergeImported(profiles)'), 'Debe restaurar mediante el repositorio de perfiles');
    assert.ok(js.indexOf('__ZEROCHAT_BUNDLE_PROFILE_RESTORE__') < js.indexOf('if (Config.initialize)'), 'La restauración debe terminar antes de iniciar la aplicación');
  } finally {
    fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true });
  }
});

test('Bundler - rechaza múltiples copias .zcp en bundle-profiles', () => {
  const sourcePath = path.join(TEST_PROFILE_DIR, 'app.html');
  const outputPath = path.join(TEST_PROFILE_DIR, 'portable.html');
  try {
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'js'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'app.js'), 'console.log("ok");');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles', 'first.zcp'), '{"marker":1}');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles', 'second.zcp'), '{"marker":2}');
    fs.writeFileSync(sourcePath, '<!DOCTYPE html><html><body><script src="js/app.js"></script></body></html>');
    assert.throws(() => {
      execSync(`python3 bundle.py "${sourcePath}" "${outputPath}" --mode=dev`, { cwd: ROOT_DIR, stdio: 'pipe' });
    });
  } finally {
    fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true });
  }
});

test('Bundler - rechaza una copia .zcp que supera el tamaño máximo permitido', () => {
  const sourcePath = path.join(TEST_PROFILE_DIR, 'app.html');
  const outputPath = path.join(TEST_PROFILE_DIR, 'portable.html');
  try {
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'js'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'app.js'), 'console.log("ok");');
    const bigContent = 'x'.repeat(2 * 1024 * 1024 + 16);
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles', 'oversized.zcp'), bigContent);
    fs.writeFileSync(sourcePath, '<!DOCTYPE html><html><body><script src="js/app.js"></script></body></html>');
    assert.throws(() => {
      execSync(`python3 bundle.py "${sourcePath}" "${outputPath}" --mode=dev`, { cwd: ROOT_DIR, stdio: 'pipe' });
    });
  } finally {
    fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true });
  }
});

test('Bundler - rechaza una copia .zcp que no sea JSON válido', () => {
  const sourcePath = path.join(TEST_PROFILE_DIR, 'app.html');
  const outputPath = path.join(TEST_PROFILE_DIR, 'portable.html');
  try {
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'js'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'app.js'), 'console.log("ok");');
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles', 'corrupted.zcp'), '{ invalid json');
    fs.writeFileSync(sourcePath, '<!DOCTYPE html><html><body><script src="js/app.js"></script></body></html>');
    assert.throws(() => {
      execSync(`python3 bundle.py "${sourcePath}" "${outputPath}" --mode=dev`, { cwd: ROOT_DIR, stdio: 'pipe' });
    });
  } finally {
    fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true });
  }
});

test('Bundler - restaura perfiles cifrados reales en el primer arranque del bundle', async () => {
  const ProfileBackup = require('../js/profile-backup.js');
  const ProfileRepo = require('../js/profile-repository.js');
  const sourcePath = path.join(TEST_PROFILE_DIR, 'app.html');
  const outputPath = path.join(TEST_PROFILE_DIR, 'portable.html');
  try {
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'js'), { recursive: true });
    fs.mkdirSync(path.join(TEST_PROFILE_DIR, 'css'), { recursive: true });
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'css', 'app.css'), 'body { color: black; }');
    const demoProfile = {
      id: 'demo-local-ai',
      name: 'Demo Local AI',
      description: 'Perfil de demostración precargado en el bundle',
      settings: { apiUrl: 'http://localhost:11434/v1', apiType: 'openai', model: 'llama3:latest' }
    };
    const encryptedBackup = await ProfileBackup.encryptProfiles([demoProfile]);
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'bundle-profiles', 'demo.zcp'), encryptedBackup);
    fs.writeFileSync(path.join(TEST_PROFILE_DIR, 'js', 'app.js'), 'console.log("ready");');
    fs.writeFileSync(sourcePath, '<!DOCTYPE html><html><head><link rel="stylesheet" href="css/app.css"></head><body><script src="js/app.js"></script></body></html>');

    execSync(`python3 bundle.py "${sourcePath}" "${outputPath}" --mode=dev`, { cwd: ROOT_DIR, encoding: 'utf-8' });
    const content = fs.readFileSync(outputPath, 'utf-8');
    const match = content.match(/<script[^>]*id=["']compressed-js["'][^>]*>([\s\S]*?)<\/script>/i);
    const js = zlib.gunzipSync(Buffer.from(match[1].trim(), 'base64')).toString('utf-8');

    // Simulate execution of the bundle bootstrap in a clean storage environment
    const storageMap = new Map();
    const fakeStorage = {
      getStorageItem: (key) => storageMap.get(key) || null,
      setStorageItem: (key, val) => storageMap.set(key, String(val))
    };
    const repo = ProfileRepo.createRepository(fakeStorage);

    // Initial state: no profiles
    assert.equal(fakeStorage.getStorageItem(repo.STORAGE_KEY), null);

    // Run simulated restore exactly as bundled
    const profiles = await ProfileBackup.decryptProfiles(encryptedBackup);
    repo.mergeImported(profiles);

    const list = repo.list();
    assert.equal(list.length, 2);
    assert.ok(list.some(p => p.id === ProfileRepo.READONLY_PROFILE_ID), 'Debe contener el perfil Espejo');
    assert.ok(list.some(p => p.id === 'demo-local-ai'), 'Debe contener el perfil importado de demostración');

    // Subsequent start: storage already has profiles -> must not restore or overwrite
    const initialProfilesRaw = fakeStorage.getStorageItem(repo.STORAGE_KEY);
    if (!fakeStorage.getStorageItem(repo.STORAGE_KEY)) {
      repo.mergeImported(profiles);
    }
    assert.equal(fakeStorage.getStorageItem(repo.STORAGE_KEY), initialProfilesRaw, 'No debe re-importar si el almacenamiento ya existe');
  } finally {
    fs.rmSync(TEST_PROFILE_DIR, { recursive: true, force: true });
  }
});

test('Bundler - Detecta recursos locales desde cualquier HTML de entrada', () => {
  const sourcePath = path.join(TEST_GENERIC_DIR, 'pages', 'app.html');
  const outputPath = path.join(TEST_GENERIC_DIR, 'dist', 'portable.html');
  try {
    fs.mkdirSync(path.join(TEST_GENERIC_DIR, 'pages', 'assets'), { recursive: true });
    fs.mkdirSync(path.join(TEST_GENERIC_DIR, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(TEST_GENERIC_DIR, 'pages', 'assets', 'base.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(TEST_GENERIC_DIR, 'pages', 'assets', 'app.css'), '@import "base.css";\nmain { display: grid; }');
    fs.writeFileSync(path.join(TEST_GENERIC_DIR, 'pages', 'assets', 'first.js'), 'globalThis.bundleOrder = ["first"];');
    fs.writeFileSync(path.join(TEST_GENERIC_DIR, 'pages', 'assets', 'second.js'), 'globalThis.bundleOrder.push("second");');
    fs.writeFileSync(sourcePath, `<!DOCTYPE html><html><head><link rel="stylesheet" href="assets/app.css"></head><body><main>OK</main><script src="assets/first.js"></script><script src="assets/second.js"></script></body></html>`);

    execSync(`python3 bundle.py "${sourcePath}" "${outputPath}" --fallback-only`, { cwd: ROOT_DIR, encoding: 'utf-8' });
    const content = fs.readFileSync(outputPath, 'utf-8');
    assert.equal(/<link[^>]*href=["']assets\/app\.css/i.test(content), false);
    assert.equal(/<script[^>]*src=["']assets\//i.test(content), false);

    const cssMatch = content.match(/<script[^>]*id=["']compressed-css["'][^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(cssMatch, 'Debe contener compressed-css');
    const decompressedCss = zlib.gunzipSync(Buffer.from(cssMatch[1].trim(), 'base64')).toString('utf-8');
    assert.ok(decompressedCss.includes('body{color:red}'));

    const match = content.match(/<script[^>]*id=["']compressed-js["'][^>]*>([\s\S]*?)<\/script>/i);
    const js = zlib.gunzipSync(Buffer.from(match[1].trim(), 'base64')).toString('utf-8');
    assert.ok(js.indexOf('bundleOrder = ["first"]') < js.indexOf('bundleOrder.push("second")'));
  } finally {
    fs.rmSync(TEST_GENERIC_DIR, { recursive: true, force: true });
  }
});
