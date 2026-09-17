#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    'tests/integration/test_turn_facades.js',
    'tests/integration/test_chat_engine.js',
    'tests/unit/test_state.js',
    'tests/integration/test_conversation_service.js'
  ],
  composer: [
    'tests/unit/test_ui_composer.js',
    'tests/unit/test_attachments.js',
    'tests/unit/test_file_parser.js',
    'tests/browser/browser_composer.test.js'
  ],
  generation: [
    'tests/unit/test_generation_controller.js',
    'tests/unit/test_ui_generation_status.js',
    'tests/integration/test_chat_engine.js',
    'tests/integration/test_agent_runtime.js',
    'tests/browser/browser_conversation.test.js'
  ],
  profiles: [
    'tests/unit/test_ui_profiles.js',
    'tests/integration/test_profile_repository.js',
    'tests/integration/test_profile_backup.js',
    'tests/browser/browser_profiles_settings.test.js'
  ],
  mcp: [
    'tests/unit/test_ui_mcp.js',
    'tests/integration/test_mcp.js',
    'tests/integration/test_mcp_tools.js',
    'tests/browser/browser_mcp_tools.test.js'
  ],
  rag: [
    'tests/integration/test_rag_index.js',
    'tests/integration/test_rag_service.js',
    'tests/integration/test_rag_storage.js',
    'tests/integration/test_rag_ui.js',
    'tests/integration/test_ingestion_engine.js'
  ],
  providers: [
    'tests/integration/test_completed_model_queries.js',
    'tests/integration/test_providers.js',
    'tests/integration/test_webllm.js',
    'tests/browser/browser_webllm.test.js'
  ],
  bundle: [
    'tests/browser/browser_startup.test.js'
  ]
};

/**
 * Encuentra todos los archivos de test en un directorio de forma recursiva o plana,
 * excluyendo helpers y carpetas auxiliares.
 */
export function getTestsInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'helpers' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getTestsInDir(fullPath));
    } else if (entry.isFile() && (entry.name.startsWith('test_') || entry.name.endsWith('.test.js')) && entry.name.endsWith('.js')) {
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
 * Parsea los argumentos de la línea de comandos.
 */
export function parseArgs(rawArgs) {
  let level = null;
  let group = null;
  let listOnly = false;
  const positionalFiles = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--list') {
      listOnly = true;
    } else if (arg.startsWith('--level=')) {
      level = arg.slice(8).trim();
    } else if (arg === '--level' && i + 1 < rawArgs.length) {
      level = rawArgs[++i].trim();
    } else if (arg.startsWith('--group=')) {
      group = arg.slice(8).trim();
    } else if (arg === '--group' && i + 1 < rawArgs.length) {
      group = rawArgs[++i].trim();
    } else if (arg === '--help' || arg === '-h') {
      return { showHelp: true };
    } else if (!arg.startsWith('-')) {
      positionalFiles.push(arg);
    }
  }

  return { level, group, listOnly, positionalFiles, showHelp: false };
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
  --group=<grupo>    Ejecutar tests por área funcional (${Object.keys(GROUPS).join(', ')})
  --list             Listar archivos seleccionados sin ejecutarlos
  --help, -h         Mostrar esta ayuda

Ejemplos:
  node scripts/test-runner.mjs --level=unit
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

  // Ejecutar node --test pasando los archivos directamente (sin shell interpolation)
  const child = spawn(process.execPath, ['--test', ...filesToRun], {
    cwd: ROOT_DIR,
    stdio: 'inherit'
  });

  child.on('error', (err) => {
    console.error('Error al invocar node --test:', err);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

// Ejecutar si se llama directamente
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
  });
}
