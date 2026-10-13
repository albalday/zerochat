// Fuentes de la aplicación para las pruebas de arquitectura: las bibliotecas de terceros no cuentan.

const fs = require('node:fs');
const path = require('node:path');

/** Rutas de los archivos con la extensión indicada bajo `dir`, sin entrar en carpetas vendor. */
function listSourceFiles(dir, extension = '.js') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : listSourceFiles(fullPath, extension);
    return entry.name.endsWith(extension) ? [fullPath] : [];
  });
}

module.exports = { listSourceFiles };
