const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const PY_DIR = path.join(ROOT, 'py');
const ZEROCHAT_PY = path.join(ROOT, 'zerochat.py');

function listPyFiles(dir) {
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.py'))
    .sort()
    .map(file => path.join(dir, file));
}

test('Backend Higiene - zerochat.py se genera exactamente concatenando py/*.py ordenados', () => {
  const pyFiles = listPyFiles(PY_DIR);
  const concatenated = pyFiles.map(file => fs.readFileSync(file, 'utf8')).join('');
  const zerochatContent = fs.readFileSync(ZEROCHAT_PY, 'utf8');
  assert.equal(zerochatContent, concatenated, 'zerochat.py debe coincidir exactamente con la concatenación de py/*.py');
});

test('Backend Higiene - ningún archivo en py/ usa capturas genéricas silenciosas (except Exception: pass o except:)', () => {
  const offenders = [];

  for (const file of listPyFiles(PY_DIR)) {
    const rel = path.relative(ROOT, file);
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
  const toolsSource = fs.readFileSync(path.join(PY_DIR, 'dd-tools.py'), 'utf8');
  const defMatch = toolsSource.match(/LOCAL_TOOLS_DEFINITIONS\s*=\s*\[([\s\S]*?)\n\]/);
  assert.ok(defMatch, 'LOCAL_TOOLS_DEFINITIONS debe existir en dd-tools.py');

  const names = [...defMatch[1].matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
  assert.ok(names.length >= 8, 'Deben existir herramientas locales definidas');

  const handlerMatch = toolsSource.match(/LOCAL_TOOL_HANDLERS\s*=\s*\{([\s\S]*?)\n\}/);
  assert.ok(handlerMatch, 'LOCAL_TOOL_HANDLERS debe existir en dd-tools.py');

  const handlers = [...handlerMatch[1].matchAll(/"([^"]+)":/g)].map(m => m[1]);
  for (const name of names) {
    assert.ok(handlers.includes(name), `La herramienta '${name}' debe tener un manejador en LOCAL_TOOL_HANDLERS`);
  }
});
