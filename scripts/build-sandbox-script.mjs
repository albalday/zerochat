#!/usr/bin/env node
/**
 * Genera, a partir de scripts/sandbox-child.js, el proceso hijo de execute_javascript para sus dos
 * consumidores: py/tools/sandbox_script.py (el servidor) y js/sandbox-node-script.js (el runner de Node
 * sin servidor). Una sola fuente del script y de los indicadores con que se lanza.
 *
 *   node scripts/build-sandbox-script.mjs [--outdir <carpeta>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --permission quita disco y procesos; el otro indicador impide generar código desde cadenas en el proceso.
const NODE_ARGS = ['--permission', '--disallow-code-generation-from-strings'];
// Lo que se lee de stdout y de stderr del hijo. El script ya acota resultado, consola y error a 30 000
// caracteres cada uno; en JSON un carácter ocupa como mucho 6 bytes (\uXXXX): 3 × 30 000 × 6 < 1 MiB.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const NOTICE = 'Generated from scripts/sandbox-child.js by scripts/build-sandbox-script.mjs. Do not edit.';

const outdirFlag = process.argv.indexOf('--outdir');
const outDir = outdirFlag === -1 ? ROOT_DIR : path.resolve(process.argv[outdirFlag + 1]);
const script = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'sandbox-child.js'), 'utf8').trim();

// Un literal JSON de solo ASCII es también un literal de cadena válido en Python y en JavaScript.
const literal = value => JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const python = `"""Proceso hijo de execute_javascript en Node. ${NOTICE}"""

from __future__ import annotations

NODE_SANDBOX_ARGS = ${literal(NODE_ARGS)}
NODE_SANDBOX_MAX_OUTPUT_BYTES = ${MAX_OUTPUT_BYTES}
NODE_SANDBOX_SCRIPT = ${literal(script)}
`;

const javascript = `/** Proceso hijo de execute_javascript en Node. ${NOTICE} */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatSandboxNodeScript = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    NODE_SANDBOX_ARGS: ${literal(NODE_ARGS)},
    NODE_SANDBOX_MAX_OUTPUT_BYTES: ${MAX_OUTPUT_BYTES},
    NODE_SANDBOX_SCRIPT: ${literal(script)}
  };
}));
`;

const outputs = { 'py/tools/sandbox_script.py': python, 'js/sandbox-node-script.js': javascript };
for (const [relative, content] of Object.entries(outputs)) {
  const target = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
