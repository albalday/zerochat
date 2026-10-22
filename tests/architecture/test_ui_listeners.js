const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// js/README.md §2: los módulos de interfaz enlazan sus eventos una sola vez en mount(), con listeners
// delegados; repintar una lista no vuelve a enlazar eventos. En js/ui-*.js, addEventListener solo
// aparece en código que se ejecuta una vez: mount*/initMcpUI, las funciones que solo se llaman desde
// ellas o al cargar el módulo, y elementos que la propia función crea (mueren con el repintado).

const ROOT = path.resolve(__dirname, '../..');
const MOUNT = /^(?:mount\w*|initMcpUI)$/;
// Excepciones revisadas: enlazan una sola vez por otra vía.
const EXCEPTIONS = {
  'ui-conversation.js': {
    getScrollState: 'enlaza una vez por contenedor y lo recuerda en scrollStates',
    insertMessage: 'el mensaje es un nodo nuevo y el listener es { once: true }'
  },
  'ui-profiles.js': {
    startImportMode: 'app.js lo llama una vez al arrancar la ventana de importación'
  }
};

/** Funciones de primer nivel de la fábrica UMD (dos espacios de sangría) con sus líneas. */
function topLevelFunctions(lines) {
  const ranges = [];
  let current = null;
  lines.forEach((line, index) => {
    const match = line.match(/^ {2}(?:async )?function (\w+)\(/);
    if (match) current = { name: match[1], start: index };
    else if (current && line === '  }') {
      ranges.push({ ...current, end: index });
      current = null;
    }
  });
  return ranges;
}

test('Interfaz - addEventListener solo en código que se ejecuta una vez por montaje', () => {
  const offenders = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'js')).filter(name => /^ui-.*\.js$/.test(name))) {
    const lines = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8').split('\n');
    const ranges = topLevelFunctions(lines);
    const enclosing = index => ranges.find(range => index > range.start && index < range.end);
    const callSites = name => lines.flatMap((line, index) => (
      new RegExp(`(?<![\\w.])${name}\\(`).test(line) && !/^\s*(?:async )?function /.test(line) ? [index] : []));

    // Una función se ejecuta una vez si es de montaje o si todas sus llamadas están en código que
    // se ejecuta una vez (o al cargar el módulo).
    const once = new Set(ranges.filter(range => MOUNT.test(range.name)).map(range => range.name));
    let changed = true;
    while (changed) {
      changed = false;
      for (const range of ranges) {
        if (once.has(range.name)) continue;
        const calls = callSites(range.name);
        if (calls.length && calls.every(index => !enclosing(index) || once.has(enclosing(index).name))) {
          once.add(range.name);
          changed = true;
        }
      }
    }

    lines.forEach((line, index) => {
      const match = line.match(/([\w.]+)\.addEventListener\(/);
      if (!match) return;
      const range = enclosing(index);
      if (!range || once.has(range.name) || EXCEPTIONS[file]?.[range.name]) return;
      const body = lines.slice(range.start, range.end).join('\n');
      const target = match[1].replace(/\./g, '\\.');
      if (new RegExp(`(?:const|let)\\s+${target}\\s*=\\s*[\\w.]*(?:createElement|createCardWrapper)\\(`).test(body)) return;
      offenders.push(`js/${file}:${index + 1} ${range.name}() enlaza ${match[1]}`);
    });
  }
  assert.deepEqual(offenders, [], `Enlaza el evento en mount() con un listener delegado:\n${offenders.join('\n')}`);
});
