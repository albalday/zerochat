#!/usr/bin/env node
/**
 * Empaqueta el runner standalone de Node.js para distribución web en GitHub Pages y ejecución local.
 *
 * Uso: node scripts/build-runner.mjs [--outfile <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const index = argv.indexOf('--outfile');
  if (index !== -1 && !argv[index + 1]) throw new Error('--outfile requires a file path');
  return { outfile: index === -1 ? path.join(ROOT_DIR, 'runner.js') : path.resolve(argv[index + 1]) };
}

async function main() {
  const { outfile } = parseArgs(process.argv.slice(2));
  const entryPoint = path.join(ROOT_DIR, 'js', 'run-node.js');

  const stubIconsPlugin = {
    name: 'stub-icons',
    setup(buildContext) {
      buildContext.onResolve({ filter: /icons\.js$/ }, args => ({
        path: args.path,
        namespace: 'stub-icons'
      }));
      buildContext.onLoad({ filter: /.*/, namespace: 'stub-icons' }, () => ({
        contents: 'module.exports = { get: () => "" };',
        loader: 'js'
      }));
    }
  };

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    plugins: [stubIconsPlugin],
    banner: {
      js: '#!/usr/bin/env node\n'
    },
    minify: true,
    legalComments: 'none'
  });

  if (fs.existsSync(outfile)) {
    fs.chmodSync(outfile, 0o755);
    const stat = fs.statSync(outfile);
    console.log(`✔ Runner standalone generado en ${path.relative(ROOT_DIR, outfile)} (${stat.size} bytes)`);
  }
}

main().catch((err) => {
  console.error('Error packaging runner:', err);
  process.exit(1);
});
