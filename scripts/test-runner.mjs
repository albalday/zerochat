#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TESTS_DIR = path.resolve(ROOT_DIR, 'tests');

export const VALID_LEVELS = [
  'unit',
  'integration',
  'browser',
  'architecture',
  'infrastructure'
];

export const GROUPS = {
  turns: [
    'tests/unit/test_message_turns.js',
    'tests/integration/test_chat_engine.js',
    'tests/unit/test_state.js',
    'tests/integration/test_conversation_service.js'
  ],
  composer: [
    'tests/unit/test_attachments.js',
    'tests/unit/test_file_parser.js',
    'tests/unit/test_office_parser.js',
    'tests/integration/test_office_documents.js',
    'tests/browser/browser_documents.test.js',
    'tests/browser/browser_composer.test.js'
  ],
  generation: [
    'tests/integration/test_chat_engine.js',
    'tests/integration/test_agent_runtime.js',
    'tests/integration/test_delegate_task.js',
    'tests/browser/browser_conversation.test.js',
    'tests/browser/browser_tool_cards.test.js',
    'tests/browser/browser_generation.test.js'
  ],
  profiles: [
    'tests/unit/test_ui_profiles.js',
    'tests/integration/test_profiles.js',
    'tests/browser/browser_profiles_settings.test.js',
    'tests/browser/browser_inspector.test.js'
  ],
  mcp: [
    'tests/unit/test_ui_mcp.js',
    'tests/integration/test_mcp.js',
    'tests/integration/test_mcp_tools.js',
    'tests/browser/browser_mcp_tools.test.js',
    'tests/browser/browser_mcp_panel.test.js'
  ],
  rag: [
    'tests/integration/test_rag_index.js',
    'tests/integration/test_rag_service.js',
    'tests/integration/test_rag_storage.js',
    'tests/integration/test_ingestion_engine.js',
    'tests/integration/test_office_documents.js',
    'tests/browser/browser_documents.test.js'
  ],
  providers: [
    'tests/unit/test_api_utils.js',
    'tests/unit/test_text_tool_calls.js',
    'tests/integration/test_providers.js',
    'tests/integration/test_webllm.js',
    'tests/browser/browser_webllm.test.js'
  ],
  project: [
    'tests/unit/test_project_context.js',
    'tests/integration/test_project_context.js'
  ],
  bundle: [
    'tests/browser/browser_startup.test.js',
    'tests/infrastructure/test_vendor_build.js',
    'tests/architecture/test_vendor_loading.js'
  ]
};

/**
 * Encuentra todos los archivos de test en un directorio de forma recursiva o plana,
 * excluyendo helpers y carpetas auxiliares. Los test_*.py se ejecutan con unittest.
 */
function isTestFile(name) {
  return (name.startsWith('test_') && (name.endsWith('.js') || name.endsWith('.py'))) || name.endsWith('.test.js');
}

export function getTestsInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'helpers' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getTestsInDir(fullPath));
    } else if (entry.isFile() && isTestFile(entry.name)) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

/**
 * Resuelve la lista de archivos para un nivel específico.
 */
export function resolveLevelFiles(level, baseDir = TESTS_DIR) {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`Nivel desconocido: '${level}'. Niveles válidos: ${VALID_LEVELS.join(', ')}`);
  }
  const levelDir = path.join(baseDir, level);
  const files = getTestsInDir(levelDir);
  return files.map(f => path.relative(ROOT_DIR, f));
}

/**
 * Resuelve la lista de archivos para todos los niveles combinados sin duplicados.
 */
export function resolveAllFiles(baseDir = TESTS_DIR) {
  const allFiles = new Set();
  for (const level of VALID_LEVELS) {
    const levelFiles = resolveLevelFiles(level, baseDir);
    for (const f of levelFiles) {
      allFiles.add(f);
    }
  }
  // Durante la migración, incluir también cualquier archivo test_*.js en la raíz de tests/
  if (fs.existsSync(baseDir)) {
    const rootEntries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.startsWith('test_') && entry.name.endsWith('.js')) {
        allFiles.add(path.relative(ROOT_DIR, path.join(baseDir, entry.name)));
      }
    }
  }
  return Array.from(allFiles).sort();
}

/**
 * Resuelve la lista de archivos para un grupo específico.
 */
export function resolveGroupFiles(groupName) {
  const normName = String(groupName || '').trim().toLowerCase();
  if (!GROUPS[normName]) {
    throw new Error(`Grupo desconocido: '${groupName}'. Grupos válidos: ${Object.keys(GROUPS).join(', ')}`);
  }
  const expectedList = GROUPS[normName];
  // Filtramos a archivos que existan en el sistema de archivos
  const existingFiles = expectedList.filter(relPath => {
    return fs.existsSync(path.resolve(ROOT_DIR, relPath));
  });
  return existingFiles.sort();
}

/**
 * Obtiene los archivos modificados en el árbol de trabajo mediante git.
 */
export function getChangedFiles() {
  try {
    const statusOutput = execSync('git status --porcelain', { cwd: ROOT_DIR, encoding: 'utf8' });
    const diffOutput = execSync('git diff --name-only HEAD', { cwd: ROOT_DIR, encoding: 'utf8' });
    const set = new Set();
    for (const line of (statusOutput + '\n' + diffOutput).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cleanPath = trimmed.replace(/^[MADRCU?!]{1,2}\s+/, '').split(' -> ').pop().trim();
      if (cleanPath) set.add(cleanPath);
    }
    return Array.from(set);
  } catch (_) {
    return [];
  }
}

/**
 * Resuelve los archivos de prueba impactados por los cambios detectados en git.
 */
export function resolveChangedFiles() {
  const changed = getChangedFiles();
  if (changed.length === 0) return [];

  // Excepción AGENTS.md: cambios exclusivos de documentación/ayuda no disparan tests
  const isDocOnly = changed.every(f => f.startsWith('help/') || f.startsWith('docs/') || f.endsWith('.md') || f === 'LICENSE');
  if (isDocOnly) return [];

  const levelsToRun = new Set();
  const directTestFiles = new Set();

  for (const f of changed) {
    if (f.startsWith('tests/')) {
      if (isTestFile(path.basename(f))) {
        directTestFiles.add(f);
      }
      for (const lvl of VALID_LEVELS) {
        if (f.startsWith(`tests/${lvl}/`)) {
          levelsToRun.add(lvl);
        }
      }
      continue;
    }

    if (f === 'zerochat.py' || f.startsWith('py/')) {
      levelsToRun.add('infrastructure');
    }
    if (f.startsWith('css/') || f === 'zerochat.html' || f === 'manifest.webmanifest' || f.startsWith('js/ui-') || f === 'js/icons.js' || f === 'sw.js') {
      levelsToRun.add('browser');
      levelsToRun.add('architecture');
    }
    if (f.startsWith('js/engine/') || f.startsWith('js/providers') || f.startsWith('js/tools/') || f.startsWith('js/mcp')) {
      levelsToRun.add('integration');
      levelsToRun.add('unit');
    }
    if (f.startsWith('js/')) {
      levelsToRun.add('unit');
    }
    if (f === 'package.json' || f === 'package-lock.json' || f.startsWith('scripts/')) {
      levelsToRun.add('unit');
      levelsToRun.add('architecture');
      levelsToRun.add('infrastructure');
    }
  }

  const resultFiles = new Set(directTestFiles);
  for (const lvl of levelsToRun) {
    for (const file of resolveLevelFiles(lvl)) {
      resultFiles.add(file);
    }
  }

  return Array.from(resultFiles).sort();
}

/**
 * Parsea los argumentos de la línea de comandos.
 */
export function parseArgs(rawArgs) {
  let level = null;
  let group = null;
  let listOnly = false;
  let changedOnly = false;
  let concurrency = null;
  let retryOnFailure = false;
  const positionalFiles = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--list') {
      listOnly = true;
    } else if (arg === '--changed') {
      changedOnly = true;
    } else if (arg === '--all') {
      level = 'all';
    } else if (arg.startsWith('--level=')) {
      level = arg.slice(8).trim();
    } else if (arg === '--level' && i + 1 < rawArgs.length) {
      level = rawArgs[++i].trim();
    } else if (arg.startsWith('--group=')) {
      group = arg.slice(8).trim();
    } else if (arg === '--group' && i + 1 < rawArgs.length) {
      group = rawArgs[++i].trim();
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = parseInt(arg.slice(14).trim(), 10);
    } else if (arg === '--concurrency' && i + 1 < rawArgs.length) {
      concurrency = parseInt(rawArgs[++i].trim(), 10);
    } else if (arg === '--retry') {
      retryOnFailure = true;
    } else if (arg === '--help' || arg === '-h') {
      return { showHelp: true };
    } else if (!arg.startsWith('-')) {
      positionalFiles.push(arg);
    }
  }

  return { level, group, listOnly, changedOnly, concurrency, retryOnFailure, positionalFiles, showHelp: false };
}

/**
 * Muestra la ayuda de uso.
 */
export function printUsage() {
  console.log(`
ZeroChat Test Runner
--------------------
Uso:
  node scripts/test-runner.mjs [opciones] [archivos...]

Opciones:
  --level=<nivel>    Ejecutar suite por nivel (${VALID_LEVELS.join(', ')}, all)
  --all              Alias para ejecutar todas las suites en una sola invocación
  --changed          Ejecutar únicamente los tests impactados por cambios en git
  --group=<grupo>    Ejecutar tests por área funcional (${Object.keys(GROUPS).join(', ')})
  --list             Listar archivos seleccionados sin ejecutarlos
  --retry            Al fallar, reintenta la ejecución una única vez (solo CI)
  --help, -h         Mostrar esta ayuda

Ejemplos:
  node scripts/test-runner.mjs --level=unit
  node scripts/test-runner.mjs --all
  node scripts/test-runner.mjs --changed
  node scripts/test-runner.mjs --level=browser
  node scripts/test-runner.mjs --group=composer --list
  node scripts/test-runner.mjs --group=turns
`);
}

/**
 * Función principal de orquestación.
 */
export async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.showHelp) {
    printUsage();
    process.exit(0);
  }

  let filesToRun = [];

  if (args.positionalFiles.length > 0) {
    filesToRun = args.positionalFiles.map(f => path.relative(ROOT_DIR, path.resolve(ROOT_DIR, f)));
  } else if (args.changedOnly) {
    filesToRun = resolveChangedFiles();
    if (filesToRun.length === 0) {
      console.log('No se detectaron cambios en el código que requieran ejecutar pruebas.');
      process.exit(0);
    }
  } else if (args.group) {
    filesToRun = resolveGroupFiles(args.group);
  } else if (args.level && args.level !== 'all') {
    filesToRun = resolveLevelFiles(args.level);
    if (filesToRun.length === 0 && args.level === 'browser' && fs.existsSync(path.resolve(ROOT_DIR, 'tests/test_browser_ui.js'))) {
      filesToRun = ['tests/test_browser_ui.js'];
    }
  } else {
    // Por defecto o --level=all
    filesToRun = resolveAllFiles();
    // En caso transitorio si todavía no se han movido a niveles:
    if (filesToRun.length === 0) {
      const rootTestFiles = getTestsInDir(TESTS_DIR);
      filesToRun = rootTestFiles.map(f => path.relative(ROOT_DIR, f));
    }
  }

  if (filesToRun.length === 0) {
    console.error(`Error: No se encontraron archivos de prueba para la selección indicada.`);
    process.exit(1);
  }

  if (args.listOnly) {
    console.log(`Archivos de prueba seleccionados (${filesToRun.length}):`);
    for (const file of filesToRun) {
      console.log(`  - ${file}`);
    }
    process.exit(0);
  }

  const jsFiles = filesToRun.filter(f => !f.endsWith('.py'));
  const pyFiles = filesToRun.filter(f => f.endsWith('.py'));

  // Ejecutar node --test pasando los archivos directamente (sin shell interpolation)
  const testArgs = [...process.execArgv, '--require', './tests/helpers/storage-env.js', '--test'];
  if (args.concurrency) {
    testArgs.push(`--test-concurrency=${args.concurrency}`);
  }
  testArgs.push(...jsFiles);

  // unittest importa cada test_*.py por su nombre de módulo desde su carpeta,
  // donde también están los helpers compartidos; -v informa de cada caso y -b
  // muestra lo que imprime el backend solo en los casos que fallan. Cada fichero
  // corre en su propio proceso para que los lentos no se esperen unos a otros.
  const pyDirs = [...new Set(pyFiles.map(f => path.resolve(ROOT_DIR, path.dirname(f))))];
  const pyArgs = file => ['-m', 'unittest', '-v', '-b', path.basename(file, '.py')];
  const pyEnv = { ...process.env, PYTHONPATH: [...pyDirs, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };

  // Con buffered, la salida se guarda en orden y se devuelve para escribirla
  // después, de modo que dos ejecuciones simultáneas no mezclan sus líneas.
  const spawnTests = (command, commandArgs, env, { buffered = false } = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT_DIR,
      env,
      stdio: buffered ? ['ignore', 'pipe', 'pipe'] : 'inherit'
    });
    const output = [];
    if (buffered) {
      child.stdout.on('data', chunk => output.push([process.stdout, chunk]));
      child.stderr.on('data', chunk => output.push([process.stderr, chunk]));
    }
    child.on('error', (err) => {
      console.error(`Error al invocar ${command}:`, err);
      reject(err);
    });
    child.on('close', code => resolve({ code: code ?? 0, output }));
  });

  // Python corre a la vez que node --test y sus informes se escriben, en el orden
  // de los ficheros, al terminar este.
  const runOnce = async () => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const py = Promise.all(pyFiles.map(file => spawnTests(python, pyArgs(file), pyEnv, { buffered: true })));
    const js = jsFiles.length ? await spawnTests(process.execPath, testArgs, process.env) : { code: 0 };
    let code = js.code;
    for (const result of await py) {
      for (const [stream, chunk] of result.output) stream.write(chunk);
      code ||= result.code;
    }
    return code;
  };

  const exitCode = await runOnce();
  if (args.retryOnFailure && exitCode !== 0) {
    console.log('\nLa ejecución falló; reintento único (solo CI).\n');
    process.exit(await runOnce());
  }
  process.exit(exitCode);
}

// Ejecutar si se llama directamente
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
  });
}
