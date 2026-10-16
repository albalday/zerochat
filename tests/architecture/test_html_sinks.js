const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listSourceFiles } = require('../helpers/source-files');

// Fronteras de arquitectura y seguridad (docs/audits/AuditFull.md): el HTML solo se asigna en los usos
// revisados de esta lista cerrada. Cada uno pinta marcado propio con los datos escapados
// (escapeHtml), Markdown saneado, SVG de ChatIcons o el marcado de un diálogo; vaciar con '' no
// cuenta. Un uso nuevo se revisa y se añade aquí, o se escribe con setText/textContent.
// Las superficies que pintan datos del modelo o de la red tienen además su prueba de inyección.

const ROOT = path.resolve(__dirname, '../..');
const HTML_SINK = /\.(?:innerHTML|outerHTML)\s*=(?!=)(?!\s*''\s*;)|insertAdjacentHTML\s*\(/g;
const REVIEWED_USES = {
  'js/command-card.js': 2,
  'js/debug.js': 5,
  'js/export.js': 1,
  'js/generation-controller.js': 1,
  'js/mcp.js': 3,
  'js/rag-ui.js': 10,
  'js/tool-cards.js': 12,
  'js/tools/builtin/ask-user.tool.js': 2,
  'js/tools/builtin/delegate-task.tool.js': 3,
  'js/tools/builtin/download-image.tool.js': 1,
  'js/tools/builtin/execute-javascript.tool.js': 2,
  'js/tools/builtin/read-knowledge-image.tool.js': 1,
  'js/tools/builtin/render-chart.tool.js': 2,
  'js/tools/builtin/search-web.tool.js': 4,
  'js/ui-command-jobs.js': 1,
  'js/ui-conversation.js': 10,
  'js/ui-dialogs.js': 1,
  'js/ui-inspector.js': 12,
  'js/ui-mcp.js': 6,
  'js/ui-profiles.js': 1,
  'js/ui-reasoning.js': 1,
  'js/ui-settings.js': 5,
  'js/ui-sidebar.js': 2,
  'js/utils.js': 3
};

test('HTML - solo se asigna HTML en los usos revisados de la lista cerrada', () => {
  const found = {};
  for (const file of listSourceFiles(path.join(ROOT, 'js'))) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const count = [...fs.readFileSync(file, 'utf8').matchAll(HTML_SINK)].length;
    if (count) found[relative] = count;
  }
  assert.deepEqual(found, REVIEWED_USES, 'Revisa el uso nuevo o retirado de innerHTML y actualiza la lista; para texto usa ChatUtils.setText');
});
