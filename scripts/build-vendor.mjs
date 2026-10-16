#!/usr/bin/env node
/**
 * Empaqueta las librerías de scripts/vendor-manifest.mjs en IIFE versionados en js/vendor/,
 * escribe en licenses/ la licencia de cada paquete incluido en ellos y regenera THIRD_PARTY_NOTICES.md.
 *
 * Los paquetes incluidos salen del metafile de esbuild y su licencia se copia del paquete instalado.
 *
 * Uso: node scripts/build-vendor.mjs [--out-dir <dir>]
 * `--out-dir` escribe los artefactos en otro directorio (por defecto, la raíz del repositorio).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { VENDORS } from './vendor-manifest.mjs';
import VendorLoader from '../js/vendor-loader.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_MODULES = path.join(ROOT_DIR, 'node_modules');
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/i;
const PACKAGE_IN_PATH = /node_modules\/((?:@[^/]+\/)?[^/]+)/g;

function parseArgs(argv) {
  const index = argv.indexOf('--out-dir');
  if (index !== -1 && !argv[index + 1]) throw new Error('--out-dir requires a directory');
  return { outDir: index === -1 ? ROOT_DIR : path.resolve(argv[index + 1]) };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function licenseSlug(name) {
  return name.replace(/^@/, '').replace(/\//g, '__');
}

/** Comprueba que la dependencia está fijada a una versión exacta e instalada en esa versión. */
function resolvePinnedVersion(vendor, dependencies) {
  const pinned = dependencies[vendor.package];
  if (!pinned) throw new Error(`${vendor.package} is not listed in package.json dependencies`);
  if (!EXACT_VERSION.test(pinned)) throw new Error(`${vendor.package} must be pinned to an exact version, found "${pinned}"`);
  const manifest = path.join(NODE_MODULES, vendor.package, 'package.json');
  const installed = fs.existsSync(manifest) && readJson(manifest).version;
  if (installed !== pinned) throw new Error(`${vendor.package} ${installed || '(missing)'} is installed but package.json pins ${pinned}; run npm ci`);
  return pinned;
}

function entryContents(vendor) {
  return `export { ${vendor.exports.join(', ')} } from '${vendor.package}';`;
}

/** Misma convención que ChatVendorLoader: `js/vendor/<id>.browser.js` define `ZeroChat<Id>`. */
function bundlePaths(vendor) {
  const info = VendorLoader.bundleInfo(vendor.id);
  return { outfile: info.path, globalName: info.globalName };
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

/** Licencia de un paquete instalado: la que trae o, en último caso, lo que declara. */
function licenseText(dir, pkg) {
  const packaged = packagedLicenseText(dir, pkg);
  if (packaged) return packaged;
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
  return `${pkg.name} ${pkg.version} declares the ${licenseName(pkg)} license in its package.json${author ? ` (author: ${author})` : ''} and ships no separate license file.\n`;
}

/** Directorio de cada paquete instalado que acaba dentro de un bundle: dir -> nombre. */
function bundledPackages(metafile) {
  const installed = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const matches = [...input.matchAll(PACKAGE_IN_PATH)];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    installed.set(path.join(ROOT_DIR, input.slice(0, last.index + last[0].length)), last[1]);
  }
  return installed;
}

/** Describe cada paquete incluido y deja su licencia en `licenses`. */
function collectLicenses(vendor, packages, licenses) {
  const entries = new Map();
  for (const [dir, name] of packages) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!entries.has(name)) entries.set(name, { name, version: pkg.version, license: licenseName(pkg) });
    const slug = licenseSlug(name);
    if (!licenses.has(slug)) licenses.set(slug, licenseText(dir, pkg));
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
      lines.push(`- \`${entry.name}\` ${entry.version} — ${entry.license} — [${link}](${link})`);
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
  const { outDir } = parseArgs(process.argv.slice(2));
  const { dependencies = {} } = readJson(path.join(ROOT_DIR, 'package.json'));
  const pinned = VENDORS.map(vendor => ({ vendor, version: resolvePinnedVersion(vendor, dependencies) }));
  const built = [];
  for (const { vendor, version } of pinned) {
    const { size, packages } = await buildVendor(vendor, outDir);
    built.push({ vendor, version, packages });
    console.log(`${vendor.package}@${version} -> ${bundlePaths(vendor).outfile} (${Math.round(size / 1024)} KiB)`);
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
