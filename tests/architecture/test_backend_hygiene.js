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

test('Backend Higiene - zerochat.py coincide con la compilación AST de py/', () => {
  const compiled = execFileSync(PYTHON_BIN, [path.join(ROOT, 'scripts', 'build-backend.py'), '--stdout'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const zerochatContent = fs.readFileSync(ZEROCHAT_PY, 'utf8');
  assert.equal(zerochatContent, compiled, 'zerochat.py debe coincidir exactamente con la salida de npm run build:backend');
});

test('Backend Higiene - ningún archivo en py/ usa capturas genéricas silenciosas (except Exception: pass o except:)', () => {
  const offenders = [];

  for (const file of listPyFiles(PY_DIR)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*except\s*:/.test(line)) {
        offenders.push(`${rel}:${i + 1} except:`);
      }
      // except Exception (con o sin «as e») seguido de pass, en la misma línea o en la siguiente.
      const generic = line.match(/^\s*except\s+(?:Exception|BaseException)(?:\s+as\s+\w+)?\s*:\s*(.*)$/);
      if (generic && (generic[1].trim() || (lines[i + 1] || '').trim()) === 'pass') {
        offenders.push(`${rel}:${i + 1} except Exception: pass`);
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
  // Solo se admite al arrancar: la carpeta inicial del proyecto.
  const allowed = new Set([
    'py/security/context.py:PROJECT_DIR = Path.cwd().resolve()'
  ]);
  const offenders = [];
  for (const file of listPyFiles(PY_DIR)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/os\.chdir\(|Path\.cwd\(\)|os\.getcwd\(\)|from\s+os\s+import\s+[^#\n]*\b(?:chdir|getcwd)\b/.test(line) && !allowed.has(`${rel}:${line.trim()}`)) {
        offenders.push(`${rel}:${i + 1} ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `Usa el SecurityContext del proyecto en lugar del directorio del proceso:\n${offenders.join('\n')}`);
});

test('Backend Higiene - paridad JS-Python de los niveles de razonamiento y del tope de ficheros del contexto de proyecto', () => {
  const Defaults = require('../../js/defaults.js');
  const ProjectContext = require('../../js/project-context.js');
  const runState = fs.readFileSync(path.join(PY_DIR, 'run_mode', 'state.py'), 'utf8');
  const levels = runState.match(/^RUN_REASONING_LEVELS\s*=\s*\(([^)]*)\)/m);
  assert.ok(levels, 'RUN_REASONING_LEVELS debe existir en run_mode/state.py');
  assert.deepEqual(levels[1].split(',').map(level => level.trim().replace(/^"|"$/g, '')).filter(Boolean), Object.keys(Defaults.REASONING_LEVEL_LABEL_KEYS));
  const filesystem = fs.readFileSync(path.join(PY_DIR, 'tools', 'filesystem.py'), 'utf8');
  const cap = filesystem.match(/^PROJECT_CONTEXT_MAX_BYTES\s*=\s*(\d+)\s*$/m);
  assert.ok(cap, 'PROJECT_CONTEXT_MAX_BYTES debe existir en tools/filesystem.py');
  assert.equal(Number(cap[1]), ProjectContext.MAX_FILE_BYTES);
});
