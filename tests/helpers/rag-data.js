const RagStorage = require('../../js/ragStorage.js');

/**
 * Deja la base de conocimiento vacía con la API de la aplicación: borrar una rama elimina en
 * cascada sus documentos, fragmentos e imágenes e invalida su índice.
 */
async function clearRagData() {
  for (const branch of await RagStorage.getBranches()) await RagStorage.deleteBranch(branch.id);
}

module.exports = { clearRagData };
