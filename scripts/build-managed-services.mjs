// Genera services/manifest.json, el catálogo de los servicios MCP incluidos que zerochat descarga de la carpeta
// de la interfaz (py/mcp/catalog.py): por servicio, su versión (la de su service.json) y la huella sha256 de cada
// fichero. Un servicio cambiado sin subir su versión no se actualiza en las instalaciones existentes.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servicesRoot = path.join(root, 'services');
const outputPath = path.join(servicesRoot, 'manifest.json');
const catalogNames = new Set(['README.md', 'service.json', 'installer.json', 'installer.json.example']);

async function collectFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(absolutePath, relativePath));
    } else if (entry.isFile() && (catalogNames.has(entry.name) || entry.name.endsWith('.py'))) {
      files[relativePath] = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
    }
  }
  return files;
}

const services = {};
const directories = (await readdir(servicesRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));
for (const entry of directories) {
  const serviceDirectory = path.join(servicesRoot, entry.name);
  let definition;
  try {
    definition = JSON.parse(await readFile(path.join(serviceDirectory, 'service.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw new Error(`services/${entry.name}/service.json: ${error.message}`);
  }
  if (definition.id !== entry.name) throw new Error(`services/${entry.name}/service.json: id must be "${entry.name}"`);
  if (typeof definition.version !== 'string' || !definition.version) {
    throw new Error(`services/${entry.name}/service.json: version is required`);
  }
  services[entry.name] = { version: definition.version, files: await collectFiles(serviceDirectory) };
}

await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, services }, null, 2)}\n`, 'utf8');
