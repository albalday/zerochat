#!/usr/bin/env node
/**
 * Empaqueta las librerías de scripts/vendor-manifest.mjs en IIFE versionados en js/vendor/,
 * escribe en licenses/ la licencia de cada paquete incluido en ellos y regenera THIRD_PARTY_NOTICES.md.
 *
 * Los paquetes incluidos salen del metafile de esbuild y, si un archivo de entrada es una
 * distribución precompilada con source map (ExcelJS), de las rutas `node_modules/` de ese mapa.
 * La licencia se copia del paquete instalado; la de los paquetes que solo existen dentro de una
 * distribución precompilada se lee de scripts/vendor-licenses/, que actualiza `--fetch-licenses`.
 *
 * Uso: node scripts/build-vendor.mjs [--out-dir <dir>] [--fetch-licenses]
 * `--out-dir` escribe los artefactos en otro directorio (por defecto, la raíz del repositorio).
 * `--fetch-licenses` descarga con `npm pack` las licencias que falten en scripts/vendor-licenses/ (requiere red).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { VENDORS } from './vendor-manifest.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(ROOT_DIR, 'node_modules');
const STORED_LICENSES_DIR = path.join(ROOT_DIR, 'scripts/vendor-licenses');
const STORED_LICENSES_INDEX = path.join(STORED_LICENSES_DIR, 'index.json');
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const VALID_ID = /^[a-z][a-z0-9-]*$/;
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/i;
const PACKAGE_IN_PATH = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;

function parseArgs(argv) {
  const index = argv.indexOf('--out-dir');
  if (index !== -1 && !argv[index + 1]) throw new Error('--out-dir requires a directory');
  return {
    outDir: index === -1 ? ROOT_DIR : path.resolve(argv[index + 1]),
    fetchLicenses: argv.includes('--fetch-licenses')
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function licenseSlug(name) {
  return name.replace(/^@/, '').replace(/\//g, '__');
}

/** Directorio instalado de `name` visible desde `fromDir`, siguiendo la resolución de node_modules. */
function findInstalledPackage(name, fromDir = ROOT_DIR) {
  for (let dir = fromDir; dir.startsWith(ROOT_DIR); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === ROOT_DIR) break;
  }
  return null;
}

/** Comprueba que la dependencia está fijada a una versión exacta e instalada en esa versión. */
function resolvePinnedVersion(vendor, dependencies) {
  const pinned = dependencies[vendor.package];
  if (!pinned) throw new Error(`${vendor.package} is not listed in package.json dependencies`);
  if (!EXACT_VERSION.test(pinned)) throw new Error(`${vendor.package} must be pinned to an exact version, found "${pinned}"`);
  const installedDir = findInstalledPackage(vendor.package);
  const installed = installedDir && readJson(path.join(installedDir, 'package.json')).version;
  if (installed !== pinned) throw new Error(`${vendor.package} ${installed || '(missing)'} is installed but package.json pins ${pinned}; run npm ci`);
  return pinned;
}

function entryContents(vendor) {
  if (vendor.exports === '*') return `export * from '${vendor.package}';`;
  return `export { ${vendor.exports.join(', ')} } from '${vendor.package}';`;
}

/** Misma convención que ChatVendorLoader: `js/vendor/<id>.browser.js` define `ZeroChat<Id>`. */
function bundlePaths(vendor) {
  if (!VALID_ID.test(vendor.id)) throw new Error(`Invalid vendor id "${vendor.id}"`);
  const globalName = 'ZeroChat' + vendor.id.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  return { outfile: `js/vendor/${vendor.id}.browser.js`, globalName };
}

function licenseName(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(item => item.type || item).join(' OR ');
  return 'UNKNOWN';
}

/** Texto de licencia del paquete (archivo o sección del README), o null si no trae ninguno. */
function packagedLicenseText(dir, pkg) {
  const files = fs.readdirSync(dir);
  const file = files.filter(name => LICENSE_FILE.test(name)).sort()[0];
  if (file) return fs.readFileSync(path.join(dir, file), 'utf8');
  // Muchos paquetes pequeños solo incluyen la licencia en la sección «License» del README.
  const readme = files.filter(name => /^readme(?:\.(?:md|markdown|txt))?$/i.test(name)).sort()[0];
  const section = readme && fs.readFileSync(path.join(dir, readme), 'utf8').match(/^(#{1,6})\s*licen[cs]e\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
  return section && section[2].trim() ? `License section of the ${pkg.name} ${pkg.version} README:\n\n${section[2].trim()}\n` : null;
}

/**
 * Licencia de un paquete instalado o descargado: la que trae, la almacenada en scripts/vendor-licenses/
 * (copiada de su repositorio cuando el paquete publicado no la incluye) o, en último caso, lo que declara.
 */
function licenseText(dir, pkg, stored = readStoredLicenses()) {
  const packaged = packagedLicenseText(dir, pkg);
  if (packaged) return packaged;
  if (stored[pkg.name]) return fs.readFileSync(path.join(STORED_LICENSES_DIR, `${licenseSlug(pkg.name)}.txt`), 'utf8');
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return `${pkg.name} ${pkg.version} declares the ${licenseName(pkg)} license in its package.json${author ? ` (author: ${author})` : ''} and ships no separate license file.\n`;
}

/**
 * Paquetes incluidos en un bundle: { name, dir } por cada paquete instalado del metafile, más los
 * nombres de los paquetes que una distribución precompilada declara en su source map.
 */
function bundledPackages(metafile) {
  const installed = new Map();
  const prebuilt = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const matches = [...input.matchAll(PACKAGE_IN_PATH)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const dir = path.join(ROOT_DIR, input.slice(0, last.index + last[0].length));
    installed.set(dir, last[1]);
    const mapFile = path.join(ROOT_DIR, `${input}.map`);
    if (!fs.existsSync(mapFile)) continue;
    for (const source of readJson(mapFile).sources || []) {
      const names = [...source.matchAll(PACKAGE_IN_PATH)];
      if (names.length) prebuilt.set(names[names.length - 1][1], { from: last[1], dir });
    }
  }
  return { installed, prebuilt };
}

function readStoredLicenses() {
  return fs.existsSync(STORED_LICENSES_INDEX) ? readJson(STORED_LICENSES_INDEX) : {};
}

/** Descarga con `npm pack` la licencia de los paquetes precompilados que no están instalados. */
function fetchMissingLicenses(names) {
  const stored = readStoredLicenses();
  const missing = names.filter(name => !stored[name]);
  if (!missing.length) return;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zerochat-licenses-'));
  try {
    for (const name of missing) {
      const [packed] = JSON.parse(execFileSync('npm', ['pack', name, '--json', '--pack-destination', workDir], { cwd: workDir, encoding: 'utf8' }));
      const extractDir = path.join(workDir, licenseSlug(name));
      fs.mkdirSync(extractDir);
      execFileSync('tar', ['-xzf', path.join(workDir, packed.filename), '-C', extractDir], { stdio: 'ignore' });
      const pkgDir = path.join(extractDir, 'package');
      const pkg = readJson(path.join(pkgDir, 'package.json'));
      fs.mkdirSync(STORED_LICENSES_DIR, { recursive: true });
      fs.writeFileSync(path.join(STORED_LICENSES_DIR, `${licenseSlug(name)}.txt`), licenseText(pkgDir, pkg, {}));
      stored[name] = { version: pkg.version, license: licenseName(pkg) };
      console.log(`Fetched license of ${name}@${pkg.version} (${stored[name].license})`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  const sorted = Object.fromEntries(Object.keys(stored).sort().map(name => [name, stored[name]]));
  fs.writeFileSync(STORED_LICENSES_INDEX, `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Describe cada paquete incluido y deja su licencia en `licenses`. */
function collectLicenses(vendor, packages, licenses) {
  const entries = new Map();
  const add = (name, entry, text) => {
    if (!entries.has(name)) entries.set(name, entry);
    const slug = licenseSlug(name);
    if (!licenses.has(slug)) licenses.set(slug, text);
  };
  for (const [dir, name] of packages.installed) {
    const pkg = readJson(path.join(dir, 'package.json'));
    add(name, { name, version: pkg.version, license: licenseName(pkg) }, licenseText(dir, pkg));
  }
  const stored = readStoredLicenses();
  for (const [name, { from, dir }] of packages.prebuilt) {
    if (entries.has(name)) continue;
    const installedDir = findInstalledPackage(name, dir);
    if (installedDir) {
      const pkg = readJson(path.join(installedDir, 'package.json'));
      add(name, { name, license: licenseName(pkg), prebuiltIn: from, textFrom: `${name}@${pkg.version}` }, licenseText(installedDir, pkg));
    } else if (stored[name]) {
      add(name, { name, license: stored[name].license, prebuiltIn: from, textFrom: `${name}@${stored[name].version}` },
        fs.readFileSync(path.join(STORED_LICENSES_DIR, `${licenseSlug(name)}.txt`), 'utf8'));
    } else {
      throw new Error(`No license text for ${name} (inside the prebuilt ${from} of ${vendor.package}); run npm run build:vendor -- --fetch-licenses`);
    }
  }
  const main = entries.get(vendor.package);
  entries.delete(vendor.package);
  return [main, ...[...entries.values()].sort((a, b) => a.name.localeCompare(b.name))];
}

function noticesText(bundles) {
  const lines = [
    '# Third-party notices',
    '',
    'ZeroChat embeds the following open-source packages in its standalone distribution, without modification',
    'beyond minification and module-format conversion. The full text of each license is in `licenses/`.',
    'This file and `licenses/` are generated by `npm run build:vendor` from `scripts/vendor-manifest.mjs`.'
  ];
  for (const { vendor, version, packages } of bundles) {
    const { outfile, globalName } = bundlePaths(vendor);
    lines.push('', `## \`${outfile}\``, '',
      `\`${vendor.package}\` ${version}, exposed as \`${globalName}\`${vendor.onDemand ? ' and loaded on demand' : ''}. Included packages:`, '');
    for (const entry of packages) {
      const link = `licenses/${licenseSlug(entry.name)}.txt`;
      const origin = entry.prebuiltIn
        ? ` — inside the prebuilt \`${entry.prebuiltIn}\` distribution; license text from ${entry.textFrom}`
        : '';
      lines.push(`- \`${entry.name}\`${entry.version ? ` ${entry.version}` : ''} — ${entry.license} — [${link}](${link})${origin}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function buildVendor(vendor, outDir) {
  const { outfile: relativeOutfile, globalName } = bundlePaths(vendor);
  const outfile = path.join(outDir, relativeOutfile);
  const { metafile } = await build({
    stdin: { contents: entryContents(vendor), resolveDir: ROOT_DIR, loader: 'js' },
    outfile,
    bundle: true,
    format: 'iife',
    globalName,
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning'
  });
  return { size: fs.statSync(outfile).size, packages: bundledPackages(metafile) };
}

async function main() {
  const { outDir, fetchLicenses } = parseArgs(process.argv.slice(2));
  const { dependencies = {} } = readJson(path.join(ROOT_DIR, 'package.json'));
  const pinned = VENDORS.map(vendor => ({ vendor, version: resolvePinnedVersion(vendor, dependencies) }));
  const built = [];
  for (const { vendor, version } of pinned) {
    const { size, packages } = await buildVendor(vendor, outDir);
    built.push({ vendor, version, packages });
    console.log(`${vendor.package}@${version} -> ${bundlePaths(vendor).outfile} (${Math.round(size / 1024)} KiB)`);
  }
  if (fetchLicenses) {
    const notInstalled = built.flatMap(({ packages }) => [...packages.prebuilt]
      .filter(([name, { dir }]) => !findInstalledPackage(name, dir))
      .map(([name]) => name));
    fetchMissingLicenses([...new Set(notInstalled)].sort());
  }
  const licenses = new Map();
  const bundles = built.map(({ vendor, version, packages }) => ({ vendor, version, packages: collectLicenses(vendor, packages, licenses) }));
  const licensesDir = path.join(outDir, 'licenses');
  fs.rmSync(licensesDir, { recursive: true, force: true });
  fs.mkdirSync(licensesDir, { recursive: true });
  for (const [slug, text] of licenses) fs.writeFileSync(path.join(licensesDir, `${slug}.txt`), text);
  fs.writeFileSync(path.join(outDir, 'THIRD_PARTY_NOTICES.md'), noticesText(bundles));
  console.log(`${licenses.size} licenses -> licenses/`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
