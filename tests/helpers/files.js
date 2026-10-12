// Archivos reales (File) para las pruebas de ingesta: la aplicación solo recibe File del navegador.

/** Crea un File con su contenido; `webkitRelativePath` imita la selección de una carpeta. */
function toFile({ name, content = '', type = '', webkitRelativePath }) {
  const file = new File([content], name, { type });
  if (webkitRelativePath) Object.defineProperty(file, 'webkitRelativePath', { value: webkitRelativePath });
  return file;
}

module.exports = { toFile };
