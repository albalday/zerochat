const { test } = require('node:test');
const assert = require('node:assert/strict');
const Markdown = require('../../js/markdown.js');

test('Markdown - Escape HTML básico', () => {
  const safe = Markdown.escapeHtml('<script>alert(1)</script>');
  assert.equal(safe, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('Markdown - Renderizado de tablas GFM', () => {
  const md = '| Col 1 | Col 2 |\n| :--- | :---: |\n| Val A | Val B |';
  const html = Markdown.parseMarkdown(md);
  assert.ok(html.includes('<table class="markdown-table">'), 'Debe generar <table>');
  assert.ok(html.includes('Col 1</th>'), 'Debe contener cabecera');
  assert.ok(html.includes('Val A</td>'), 'Debe contener celda');

  // Comprobar que renderMarkdown es un alias funcional
  assert.equal(typeof Markdown.renderMarkdown, 'function');
  const htmlAlias = Markdown.renderMarkdown('Aquí tienes la tabla:\n| Cab 1 | Cab 2 |\n|---|---|\n| Dato 1 | Dato 2 |\n\nTexto final');
  assert.ok(htmlAlias.includes('<div class="table-container"><table class="markdown-table">'));
  assert.ok(htmlAlias.includes('<p>Aquí tienes la tabla:</p>'), 'El texto antes de la tabla debe estar en su propio párrafo sin romper la tabla');
  assert.ok(htmlAlias.includes('<p>Texto final</p>'));
});

test('Markdown - Renderizado de bloques de código', () => {
  const md = '```javascript\nconst x = 10;\n```';
  const html = Markdown.parseMarkdown(md);
  assert.ok(html.includes('code-block-container'), 'Debe contener contenedor de código');
  assert.ok(html.includes('const x = 10;'), 'Debe incluir el código');
});

test('Markdown - Renderizado de bloques de pensamiento <think> y <thought>', () => {
  const md = '<thought>Razonando la respuesta</thought>Respuesta final';
  const html = Markdown.parseMarkdown(md);
  assert.ok(html.includes('<details class="thought-block"'), 'Debe generar bloque <details> para pensamiento');
  assert.ok(html.includes('Razonando la respuesta'), 'Debe contener el razonamiento');
  assert.ok(html.includes('Respuesta final'), 'Debe contener la respuesta final');
});

test('Markdown - Renderizado de imágenes Markdown (![alt](url)) e imágenes base64', () => {
  const sample = `1. Esquema y Distribución
![Diagrama Placa Base GA-Z77P-D3](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=)

Referencia: Manual Gigabyte.`;

  const html = Markdown.parseMarkdown(sample);
  assert.ok(html.includes('<figure class="chat-image-figure">'), 'Debe envolver la imagen en un tag figure');
  assert.ok(html.includes('<img class="chat-embedded-image"'), 'Debe renderizar etiqueta img');
  assert.ok(html.includes('src="data:image/jpeg;base64,/9j/'), 'Debe incluir el src base64 seguro');
  assert.ok(html.includes('<figcaption class="chat-image-caption">Diagrama Placa Base GA-Z77P-D3</figcaption>'), 'Debe generar el pie de foto figcaption');
});

test('Markdown - Renderizado de reglas horizontales (---, ***, ___)', () => {
  const md = `Sección 1\n\n---\n\nSección 2`;
  const html = Markdown.parseMarkdown(md);
  assert.ok(html.includes('<hr>'), 'Debe convertir --- a <hr>');
  assert.ok(html.includes('Sección 1'));
  assert.ok(html.includes('Sección 2'));
});

test('Markdown - Renderizado seguro de rag-image con data-rag-src y resolución por listeners', async () => {
  const md = `![Revisión Placa](rag-image://doc_test_123:img_1)`;
  const html = Markdown.parseMarkdown(md);
  assert.ok(html.includes('data-rag-src="rag-image://doc_test_123:img_1"'), 'Debe incluir data-rag-src para resolución segura');
  assert.ok(html.includes('src="data:image/svg+xml,'), 'Debe usar placeholder SVG para no romper el render en el navegador');
  assert.ok(html.includes('<figcaption class="chat-image-caption">Revisión Placa</figcaption>'), 'Debe incluir pie de foto');
});


