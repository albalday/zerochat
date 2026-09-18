#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const target = process.argv[2];
if (!target || target === '--help' || target === '-h') {
  console.log(`
ZeroChat Version Synchronizer
-----------------------------
Uso:
  node scripts/bump-version.mjs <nueva_version | patch | minor | major>

Ejemplos:
  node scripts/bump-version.mjs 7.0.3
  node scripts/bump-version.mjs patch
  npm run bump patch
`);
  process.exit(target ? 0 : 1);
}

const pkgPath = path.join(ROOT_DIR, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

let newVersion = target.trim();
if (['patch', 'minor', 'major'].includes(newVersion)) {
  const parts = currentVersion.split('.').map(n => parseInt(n, 10));
  if (parts.length < 3 || parts.some(isNaN)) {
    console.error(`Error: La versión actual '${currentVersion}' no tiene formato semver x.y.z`);
    process.exit(1);
  }
  if (newVersion === 'patch') {
    parts[2] += 1;
  } else if (newVersion === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else if (newVersion === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  }
  newVersion = parts.join('.');
}

// Validar formato semver básico x.y.z
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(newVersion)) {
  console.error(`Error: '${newVersion}' no es una versión semver válida (ej. 7.0.3)`);
  process.exit(1);
}

if (newVersion === currentVersion) {
  console.log(`La versión ya es ${newVersion}. No hay cambios.`);
  process.exit(0);
}

console.log(`Actualizando versión: ${currentVersion} -> ${newVersion}`);

// 1. package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`✔ package.json actualizado a ${newVersion}`);

// 2. package-lock.json
const lockPath = path.join(ROOT_DIR, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = newVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = newVersion;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log(`✔ package-lock.json actualizado a ${newVersion}`);
}

// 3. zerochat.py
const pyPath = path.join(ROOT_DIR, 'zerochat.py');
if (fs.existsSync(pyPath)) {
  let pyContent = fs.readFileSync(pyPath, 'utf8');
  pyContent = pyContent.replace(/return\s+"[0-9]+\.[0-9]+\.[0-9]+[^"]*"/, `return "${newVersion}"`);
  fs.writeFileSync(pyPath, pyContent, 'utf8');
  console.log(`✔ zerochat.py actualizado con fallback ${newVersion}`);
}

// 4. zerochat.html
const htmlPath = path.join(ROOT_DIR, 'zerochat.html');
if (fs.existsSync(htmlPath)) {
  let htmlContent = fs.readFileSync(htmlPath, 'utf8');
  htmlContent = htmlContent.replace(/<title>ZeroChat\s+v[0-9]+\.[0-9]+\.[0-9]+[^<]*<\/title>/i, `<title>ZeroChat v${newVersion}</title>`);
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');
  console.log(`✔ zerochat.html actualizado a ZeroChat v${newVersion}`);
}

// 5. sw.js
const swPath = path.join(ROOT_DIR, 'sw.js');
if (fs.existsSync(swPath)) {
  let swContent = fs.readFileSync(swPath, 'utf8');
  swContent = swContent.replace(/const\s+CACHE_NAME\s*=\s*'zerochat-v[^']+';/, `const CACHE_NAME = 'zerochat-v${newVersion}';`);
  fs.writeFileSync(swPath, swContent, 'utf8');
  console.log(`✔ sw.js actualizado a cache zerochat-v${newVersion}`);
}

console.log(`\n¡Sincronización completada con éxito! Versión actual: ${newVersion}`);

