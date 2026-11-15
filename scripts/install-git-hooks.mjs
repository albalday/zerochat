// npm install (script prepare) activa los hooks versionados de .githooks/ en esta copia del repositorio.
// Fuera de un repositorio Git (un paquete descargado) no hace nada.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  process.exit(0);
}
execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
