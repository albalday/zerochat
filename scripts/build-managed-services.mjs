import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servicesRoot = path.join(root, 'services');
const outputPath = path.join(root, 'py', 'dd-managed-services.py');
const managedNames = new Set(['README.md', 'service.json', 'installer.json', 'installer.json.example']);

async function collectManagedFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      Object.assign(files, await collectManagedFiles(absolutePath, relativePath));
    } else if (entry.isFile() && (relativeDirectory === 'scripts' || managedNames.has(entry.name) || entry.name.endsWith('.py'))) {
      files[relativePath] = await readFile(absolutePath, 'utf8');
    }
  }
  return files;
}

const serviceDirectories = (await readdir(servicesRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));
const managedFiles = {};
for (const entry of serviceDirectories) {
  const serviceDirectory = path.join(servicesRoot, entry.name);
  if (entry.name === 'scripts') {
    Object.assign(managedFiles, await collectManagedFiles(serviceDirectory, entry.name));
    continue;
  }
  try {
    await readFile(path.join(serviceDirectory, 'service.json'));
  } catch {
    continue;
  }
  Object.assign(managedFiles, await collectManagedFiles(serviceDirectory, entry.name));
}
const source = `# ==============================================================================\n# Generated from services/ by scripts/build-managed-services.mjs. Do not edit.\n# ==============================================================================\n\nimport json\n\nMANAGED_SERVICE_FILES: dict[str, str] = json.loads(${JSON.stringify(JSON.stringify(managedFiles, null, 2))})\n\n\ndef materialize_managed_services(services_root: Path | None = None) -> None:\n    \"\"\"Installs the managed service files without deleting user data or services.\"\"\"\n    root = Path(services_root) if services_root else get_data_dir() / \"services\"\n    for relative_path, content in MANAGED_SERVICE_FILES.items():\n        destination = root / relative_path\n        destination.parent.mkdir(parents=True, exist_ok=True)\n        destination.write_text(content, encoding=\"utf-8\")\n        if relative_path.startswith(\"scripts/\"):\n            destination.chmod(0o755)\n`;

await writeFile(outputPath, source, 'utf8');
