const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const PY_DIR = path.join(ROOT, 'py');
const ZEROCHAT_PY = path.join(ROOT, 'zerochat.py');
const PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

function listPyFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listPyFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      files.push(full);
    }
  }
  return files.sort();
}

test('Backend Higiene - zerochat.py coincide con la compilación AST de py/ y conserva el inventario de símbolos', () => {
  const compiled = execFileSync(PYTHON_BIN, [path.join(ROOT, 'scripts', 'build-backend.py'), '--stdout'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const zerochatContent = fs.readFileSync(ZEROCHAT_PY, 'utf8');
  assert.equal(zerochatContent, compiled, 'zerochat.py debe coincidir exactamente con la salida de npm run build:backend');

  const expectedSymbols = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'zerochat_symbols.json'), 'utf8'));
  const actualSymbols = JSON.parse(execFileSync(PYTHON_BIN, [path.join(ROOT, 'scripts', 'build-backend.py'), '--symbols'], {
    cwd: ROOT,
    encoding: 'utf8'
  }));
  assert.deepEqual(actualSymbols, expectedSymbols, 'El inventario de símbolos de nivel superior de zerochat.py ha cambiado sin actualizar la fixture');
});

test('Backend Higiene - ningún archivo en py/ usa capturas genéricas silenciosas (except Exception: pass o except:)', () => {
  const offenders = [];

  for (const file of listPyFiles(PY_DIR)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*except\s*:\s*$/.test(line)) {
        offenders.push(`${rel}:${i + 1} except:`);
      }
      if (/^\s*except\s+Exception\s*:\s*$/.test(line)) {
        const nextLine = (lines[i + 1] || '').trim();
        if (nextLine === 'pass') {
          offenders.push(`${rel}:${i + 1} except Exception: pass`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `Usa excepciones específicas o registra/justifica el error:\n${offenders.join('\n')}`);
});

test('Backend Higiene - paridad entre LOCAL_TOOLS_DEFINITIONS y LOCAL_TOOL_HANDLERS', () => {
  const toolsSource = fs.readFileSync(path.join(PY_DIR, 'tools', 'registry.py'), 'utf8');
  const defMatch = toolsSource.match(/LOCAL_TOOLS_DEFINITIONS\s*=\s*\[([\s\S]*?)\n\]/);
  assert.ok(defMatch, 'LOCAL_TOOLS_DEFINITIONS debe existir en tools/registry.py');

  const names = [...defMatch[1].matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
  assert.ok(names.length >= 8, 'Deben existir herramientas locales definidas');

  const handlerMatch = toolsSource.match(/LOCAL_TOOL_HANDLERS\s*=\s*\{([\s\S]*?)\n\}/);
  assert.ok(handlerMatch, 'LOCAL_TOOL_HANDLERS debe existir en tools/registry.py');

  const handlers = [...handlerMatch[1].matchAll(/"([^"]+)":/g)].map(m => m[1]);
  for (const name of names) {
    assert.ok(handlers.includes(name), `La herramienta '${name}' debe tener un manejador en LOCAL_TOOL_HANDLERS`);
  }
});

test('Backend Higiene - el proceso no cambia de directorio ni lee el suyo fuera del arranque', () => {
  // El proyecto viaja en el SecurityContext de cada petición: un Path.cwd() olvidado actuaría en otra carpeta.
  // Solo se admite al arrancar: la carpeta inicial del proyecto y la detección del repositorio de desarrollo.
  const allowed = new Set([
    'py/security/context.py:PROJECT_DIR = Path.cwd().resolve()',
    'py/core/environment.py:cwd = Path.cwd().resolve()'
  ]);
  const offenders = [];
  for (const file of listPyFiles(PY_DIR)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/os\.chdir\(|Path\.cwd\(\)|os\.getcwd\(\)/.test(line) && !allowed.has(`${rel}:${line.trim()}`)) {
        offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `Usa el SecurityContext del proyecto en lugar del directorio del proceso:\n${offenders.join('\n')}`);
});
