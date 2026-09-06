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
