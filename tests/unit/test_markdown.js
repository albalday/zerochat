const { test } = require('node:test');
const assert = require('node:assert/strict');
const Markdown = require('../../js/markdown.js');
const ChatUtils = require('../../js/utils.js');
const { installDom } = require('../helpers/dom-env.js');

test('Markdown - escapa HTML y renderiza tablas, código, pensamiento y reglas horizontales', () => {
  {
    const safe = Markdown.escapeHtml('<script>alert(1)</script>');
    assert.equal(safe, '&lt;script&gt;alert(1)&lt;/script&gt;');
  }

  {
    const md = '| Col 1 | Col 2 |\n| :--- | :---: |\n| Val A | Val B |';
    const html = Markdown.parseMarkdown(md);
    assert.ok(html.includes('<table class="markdown-table">'), 'Debe generar <table>');
    assert.ok(html.includes('Col 1</th>'), 'Debe contener cabecera');
    assert.ok(html.includes('Val A</td>'), 'Debe contener celda');

    // Un texto alrededor de la tabla queda en sus propios párrafos
    const htmlAlias = Markdown.parseMarkdown('Aquí tienes la tabla:\n| Cab 1 | Cab 2 |\n|---|---|\n| Dato 1 | Dato 2 |\n\nTexto final');
    assert.ok(htmlAlias.includes('<div class="table-container">') && htmlAlias.includes('<table class="markdown-table">'));
    assert.ok(htmlAlias.includes('<p>Aquí tienes la tabla:</p>'), 'El texto antes de la tabla debe estar en su propio párrafo sin romper la tabla');
    assert.ok(htmlAlias.includes('<p>Texto final</p>'));
  }

  {
    const md = '```javascript\nconst x = 10;\n```';
    const html = Markdown.parseMarkdown(md);
    assert.ok(html.includes('code-block-container'), 'Debe contener contenedor de código');
    assert.ok(html.includes('const x = 10;'), 'Debe incluir el código');
  }

  {
    const md = '<thought>Razonando la respuesta</thought>Respuesta final';
    const html = Markdown.parseMarkdown(md);
    assert.ok(html.includes('<details class="thought-block"'), 'Debe generar bloque <details> para pensamiento');
    assert.ok(html.includes('Razonando la respuesta'), 'Debe contener el razonamiento');
    assert.ok(html.includes('Respuesta final'), 'Debe contener la respuesta final');
  }

  {
    const md = `Sección 1\n\n---\n\nSección 2`;
    const html = Markdown.parseMarkdown(md);
    assert.ok(html.includes('<hr>'), 'Debe convertir --- a <hr>');
    assert.ok(html.includes('Sección 1'));
    assert.ok(html.includes('Sección 2'));
  }
});

test('Markdown - imágenes: base64, rag-image y URLs sin doble escape ni inyección de atributos', async () => {
  {
    const sample = `1. Esquema y Distribución
  ![Diagrama Placa Base GA-Z77P-D3](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=)

  Referencia: Manual Gigabyte.`;

    const html = Markdown.parseMarkdown(sample);
    assert.ok(html.includes('<figure class="chat-image-figure">'), 'Debe envolver la imagen en un tag figure');
    assert.ok(html.includes('<img class="chat-embedded-image"'), 'Debe renderizar etiqueta img');
    assert.ok(html.includes('src="data:image/jpeg;base64,/9j/'), 'Debe incluir el src base64 seguro');
    assert.ok(html.includes('<figcaption class="chat-image-caption">Diagrama Placa Base GA-Z77P-D3</figcaption>'), 'Debe generar el pie de foto figcaption');
  }

  {
    const md = `![Revisión Placa](rag-image://doc_test_123:img_1)`;
    const html = Markdown.parseMarkdown(md);
    assert.ok(html.includes('data-rag-src="rag-image://doc_test_123:img_1"'), 'Debe incluir data-rag-src para resolución segura');
    assert.ok(html.includes('src="data:image/svg+xml,'), 'Debe usar placeholder SVG para no romper el render en el navegador');
    assert.ok(html.includes('<figcaption class="chat-image-caption">Revisión Placa</figcaption>'), 'Debe incluir pie de foto');
  }

  {
    const html = Markdown.parseMarkdown('![a](https://example.test/i.png?w=1&h=2)');
    assert.ok(html.includes('src="https://example.test/i.png?w=1&amp;h=2"'));
    const tableHtml = Markdown.parseMarkdown('| c |\n|---|\n| ![a](https://example.test/i.png?w=1&h=2) |');
    assert.ok(tableHtml.includes('src="https://example.test/i.png?w=1&amp;h=2"'));
    assert.ok(!html.includes('&amp;amp;') && !tableHtml.includes('&amp;amp;'));
  }

  {
    const html = Markdown.parseMarkdown('![a](https://example.test/i.png"onerror="alert(1))');
    assert.ok(!html.includes('"onerror') && !html.includes(' onerror='));
  }
});



test('Markdown - el código en línea se muestra literal y no lo alteran otras reglas', () => {
  assert.equal(Markdown.parseMarkdown('- `6*7` = 42\n- `7*6` = 42'), '<ul><li><code>6*7</code> = 42</li><li><code>7*6</code> = 42</li></ul>');
  assert.equal(Markdown.parseMarkdown('usa `a _b_ c` y `**x**` con *cursiva*'), '<p>usa <code>a _b_ c</code> y <code>**x**</code> con <em>cursiva</em></p>');
  assert.equal(Markdown.parseMarkdown('`![x](https://e.test/i.png)` `[l](https://e.test)`'), '<p><code>![x](https://e.test/i.png)</code> <code>[l](https://e.test)</code></p>');
  assert.equal(Markdown.parseMarkdown('`<b>x</b>`'), '<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>');

  const table = Markdown.parseMarkdown('| a | b |\n|---|---|\n| `2*3*4` | `x | y` |');
  assert.ok(table.includes('<td><code>2*3*4</code></td>'), 'El código de una celda tampoco se convierte en cursiva');
  assert.ok(table.includes('<td><code>x | y</code></td>'), 'Una barra dentro del código no parte la celda');

  assert.equal(Markdown.parseMarkdown('texto \u00000\u0000 raro'), '<p>texto 0 raro</p>', 'Un marcador escrito en la entrada no inyecta código');
});

test('Markdown - normaliza notación matemática y LaTeX a Unicode dentro de delimitadores', () => {
  // Flechas y operadores comunes dentro de $...$ o \(...\)
  assert.equal(Markdown.parseMarkdown('A $\\rightarrow$ B'), '<p>A → B</p>');
  assert.equal(Markdown.parseMarkdown('$\\alpha \\le \\beta$'), '<p>α ≤ β</p>');
  assert.equal(Markdown.parseMarkdown('\\(x \\approx y\\)'), '<p>x ≈ y</p>');
  assert.equal(Markdown.parseMarkdown('$x \\approx y$'), '<p>x ≈ y</p>');

  // Bloques display math y fracciones
  assert.equal(Markdown.parseMarkdown('$$\\frac{a + b}{c}$$'), '<p>(a + b)/c</p>');
  assert.equal(Markdown.parseMarkdown('\\[x = \\frac{1}{2}\\]'), '<p>x = 1/2</p>');
  assert.equal(Markdown.parseMarkdown('raíz $\\sqrt{x}$'), '<p>raíz √(x)</p>');

  // Superíndices y subíndices dentro de delimitadores
  assert.equal(Markdown.parseMarkdown('$x^{2} + y^{2} = z^{2}$'), '<p>x² + y² = z²</p>');
  assert.equal(Markdown.parseMarkdown('$x^2 + y^2$'), '<p>x² + y²</p>');
  assert.equal(Markdown.parseMarkdown('$x_{1} + x_{n}$'), '<p>x₁ + xₙ</p>');

  // Variables matemáticas simples con $
  assert.equal(Markdown.parseMarkdown('donde $x$ es la variable'), '<p>donde x es la variable</p>');

  // Conserva precios y rangos monetarios
  assert.equal(Markdown.parseMarkdown('cuesta $50 y la oferta es $40'), '<p>cuesta $50 y la oferta es $40</p>');
  assert.equal(Markdown.parseMarkdown('rango $10-$20'), '<p>rango $10-$20</p>');
  assert.equal(Markdown.parseMarkdown('Precio $5/$10 al mes'), '<p>Precio $5/$10 al mes</p>');

  // F-03: No corrompe rutas Windows, URLs ni variables snake_case
  assert.equal(Markdown.parseMarkdown('Ruta: C:\\data\\in\\times.txt'), '<p>Ruta: C:\\data\\in\\times.txt</p>');
  assert.equal(Markdown.parseMarkdown('Archivo nombre_archivo_con_guiones y metodo_test()'), '<p>Archivo nombre_archivo_con_guiones y metodo_test()</p>');

  // Dentro de código inline y bloques de código se conserva literal
  assert.equal(Markdown.parseMarkdown('usa `$\\rightarrow$` literal'), '<p>usa <code>$\\rightarrow$</code> literal</p>');
  assert.ok(Markdown.parseMarkdown('```latex\n\\rightarrow\n```').includes('\\rightarrow'));

  // Dentro de tablas
  const table = Markdown.parseMarkdown('| Símbolo | Significado |\n|---|---|\n| $\\rightarrow$ | flecha |');
  assert.ok(table.includes('<td>→</td>'));
});

test('Markdown - attachContentListeners activa el click accesible en imágenes para abrir en nueva pestaña', () => {
  const dom = installDom();
  try {
    const container = document.createElement('div');
    container.innerHTML = Markdown.parseMarkdown('![Diagrama](https://example.test/img.png)');
    const img = container.querySelector('img.chat-embedded-image');
    assert.ok(img);
    assert.equal(img.getAttribute('role'), null);

    const opened = [];
    window.open = url => {
      opened.push(url);
      return { document: {} };
    };

    Markdown.attachContentListeners(container);
    assert.equal(img.getAttribute('role'), 'button');
    assert.equal(img.tabIndex, 0);

    img.dispatchEvent(new Event('click'));
    assert.equal(opened.length, 1);
    assert.ok(opened[0].startsWith('blob:'));

    const enterEvent = new Event('keydown');
    enterEvent.key = 'Enter';
    img.dispatchEvent(enterEvent);
    assert.equal(opened.length, 2);
    assert.ok(opened[1].startsWith('blob:'));
  } finally {
    dom.restore();
  }
});

test('Markdown - tableToCsv convierte tablas HTML a formato CSV estándar con escape RFC 4180', () => {
  const dom = installDom();
  try {
    const div = document.createElement('div');
    div.innerHTML = `
      <table>
        <thead>
          <tr><th>Producto</th><th>Precio</th><th>Notas</th></tr>
        </thead>
        <tbody>
          <tr><td>Manzana</td><td>1.50</td><td>Fruta fresca</td></tr>
          <tr><td>Pera, conferencia</td><td>2.00</td><td>Con "piel" fina</td></tr>
          <tr><td>Naranja</td><td>1.80</td><td>Línea 1\nLínea 2</td></tr>
        </tbody>
      </table>
    `;
    const table = div.querySelector('table');
    const csv = Markdown.tableToCsv(table);
    const expected = [
      'Producto,Precio,Notas',
      'Manzana,1.50,Fruta fresca',
      '"Pera, conferencia",2.00,"Con ""piel"" fina"',
      'Naranja,1.80,"Línea 1\nLínea 2"'
    ].join('\r\n');
    assert.equal(csv, expected);
    assert.equal(Markdown.tableToCsv(null), '');
  } finally {
    dom.restore();
  }
});

test('Markdown - attachContentListeners conecta copia y descarga CSV en las tablas', () => {
  const dom = installDom();
  try {
    const container = document.createElement('div');
    container.innerHTML = Markdown.parseMarkdown('| Nombre | Edad |\n|---|---|\n| Ana | 30 |\n| Bob | 25 |');

    const copyBtn = container.querySelector('.btn-copy-table-csv');
    const exportBtn = container.querySelector('.btn-export-table-csv');
    assert.ok(copyBtn, 'Debe renderizar botón de copiar CSV');
    assert.ok(exportBtn, 'Debe renderizar botón de exportar CSV');

    let copiedText = null;
    ChatUtils.copyToClipboard = (text) => {
      copiedText = text;
    };

    const downloaded = [];
    const fakeExport = {
      downloadFile: (content, filename, mimeType) => {
        downloaded.push({ content, filename, mimeType });
        return true;
      }
    };
    global.ChatExport = fakeExport;

    Markdown.attachContentListeners(container);

    copyBtn.dispatchEvent(new Event('click'));
    assert.equal(copiedText, 'Nombre,Edad\r\nAna,30\r\nBob,25');

    exportBtn.dispatchEvent(new Event('click'));
    assert.equal(downloaded.length, 1);
    assert.equal(downloaded[0].filename, 'tabla.csv');
    assert.equal(downloaded[0].mimeType, 'text/csv;charset=utf-8');
    assert.equal(downloaded[0].content, 'Nombre,Edad\r\nAna,30\r\nBob,25');
  } finally {
    delete global.ChatExport;
    dom.restore();
  }
});

test('Markdown - bloques de código HTML y SVG incluyen botón de vista previa que abre en pestaña', () => {
  const dom = installDom();
  try {
    const mdHtml = '```html\n<div class="folleto"><h1>Hola</h1></div>\n```';
    const parsedHtml = Markdown.parseMarkdown(mdHtml);
    assert.ok(parsedHtml.includes('btn-preview-code'), 'Bloque HTML debe tener botón de vista previa');

    const mdSvg = '```svg\n<svg><circle r="10"/></svg>\n```';
    const parsedSvg = Markdown.parseMarkdown(mdSvg);
    assert.ok(parsedSvg.includes('btn-preview-code'), 'Bloque SVG debe tener botón de vista previa');

    const mdJs = '```javascript\nconst a = 1;\n```';
    const parsedJs = Markdown.parseMarkdown(mdJs);
    assert.ok(!parsedJs.includes('btn-preview-code'), 'Bloque JS no debe tener botón de vista previa');

    const container = document.createElement('div');
    container.innerHTML = parsedHtml;

    const openedDocs = [];
    ChatUtils.openDocumentInNewTab = (content, mimeType) => {
      openedDocs.push({ content, mimeType });
      return true;
    };

    Markdown.attachContentListeners(container);

    const previewBtn = container.querySelector('.btn-preview-code');
    assert.ok(previewBtn);
    previewBtn.dispatchEvent(new Event('click'));

    assert.equal(openedDocs.length, 1);
    assert.equal(openedDocs[0].content, '<div class="folleto"><h1>Hola</h1></div>');
    assert.equal(openedDocs[0].mimeType, 'text/html;charset=utf-8');
  } finally {
    dom.restore();
  }
});



