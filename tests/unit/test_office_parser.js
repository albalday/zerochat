const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installDom } = require('../helpers/dom-env.js');

installDom();
const OfficeParser = require('../../js/office-parser.js');

const FIXTURES = path.resolve(__dirname, '../fixtures/office');

function readFixture(name) {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const parseFixture = (name, fileName = name) => OfficeParser.parseOfficeDocument(readFixture(name), fileName);

function assertRedPng(images, page) {
  assert.equal(images.length, 1);
  assert.equal(images[0].id, 'img_1');
  assert.equal(images[0].mimeType, 'image/png');
  assert.equal(images[0].page, page);
  assert.match(images[0].dataUrl, /^data:image\/png;base64,iVBORw0KGgo/);
}

test('getOfficeFormat reconoce formatos actuales, con macros, ODF y antiguos por extensión', () => {
  const cases = {
    'a.docx': 'docx', 'A.DOCM': 'docx', 'b.xlsx': 'xlsx', 'b.xlsm': 'xlsx', 'c.pptx': 'pptx', 'c.pptm': 'pptx',
    'd.odt': 'odt', 'e.ods': 'ods', 'f.odp': 'odp', 'g.doc': 'doc', 'h.xls': 'xls', 'i.ppt': 'ppt',
    'notes.txt': '', 'docx': '', 'informe.pdf': ''
  };
  for (const [name, format] of Object.entries(cases)) assert.equal(OfficeParser.getOfficeFormat(name), format, name);
});

for (const fixture of ['pandoc.docx', 'libreoffice.docx']) {
  test(`docx (${fixture}): títulos, formato, enlaces, listas, tablas e imágenes en Markdown`, async () => {
    const { text, images } = await parseFixture(fixture);
    assert.match(text, /^# Informe trimestral$/m);
    assert.match(text, /^## Anexo$/m);
    assert.match(text, /\*\*negrita\*\*/);
    assert.match(text, /\[enlace\]\(https:\/\/example\.com\/?\)/);
    assert.match(text, /^- Uno\n- Dos\n {2}- Dos punto uno$/m);
    assert.match(text, /^1\. Primero\n2\. Segundo$/m);
    assert.match(text, /^\| Producto \| Ventas \|\n\| --- \| --- \|\n\| Café \| 120 \|\n\| Té \\\| verde \| 80 \|$/m);
    assert.match(text, /!\[[^\]]+\]\(rag-image:\/\/__DOC_ID__:img_1\)/);
    assertRedPng(images, 1);
  });
}

for (const fixture of ['pandoc.odt', 'libreoffice.odt']) {
  test(`odt (${fixture}): títulos, enlaces, listas numeradas, tablas e imágenes`, async () => {
    const { text, images } = await parseFixture(fixture);
    assert.match(text, /^# Informe trimestral$/m);
    assert.match(text, /^## Anexo$/m);
    assert.match(text, /\[enlace\]\(https:\/\/example\.com\)/);
    assert.match(text, /^- Uno\n- Dos\n {2}- Dos punto uno$/m);
    assert.match(text, /^1\. Primero\n2\. Segundo$/m);
    assert.match(text, /\| Té \\\| verde \| 80 \|/);
    assert.match(text, /!\[Image 1 \(page 1\)\]\(rag-image:\/\/__DOC_ID__:img_1\)/);
    assertRedPng(images, 1);
  });
}

for (const fixture of ['pandoc.pptx', 'libreoffice.pptx', 'libreoffice.odp']) {
  test(`presentación (${fixture}): marcadores de diapositiva, títulos, imágenes y notas`, async () => {
    const { text, images } = await parseFixture(fixture);
    assert.match(text, /^--- Slide 1 ---\n## Portada\n\nPresentación de prueba\n\n--- Slide 2 ---\n## Resultados$/m);
    const slides = text.split(/^--- Slide \d+ ---$/m).slice(1).map(slide => slide.trim());
    assert.equal(slides.length, 2);
    assert.match(slides[0], /^## Portada\n\nPresentación de prueba$/);
    assert.match(slides[1], /^## Resultados\n\nVentas al alza\n\nCostes estables/);
    assert.match(slides[1], /!\[Image 1 \(slide 2\)\]\(rag-image:\/\/__DOC_ID__:img_1\)/);
    assert.match(slides[1], /^Notes: Nota del orador para resultados$/m);
    assertRedPng(images, 2);
  });
}

for (const fixture of ['exceljs.xlsx', 'libreoffice.xlsx', 'libreoffice.ods']) {
  test(`hoja de cálculo (${fixture}): una tabla por hoja, valores calculados, imágenes y tope de filas`, async () => {
    const { text, images } = await parseFixture(fixture);
    const [ventas, largo] = text.split(/^## Sheet: /m).slice(1);
    assert.match(ventas, /^Ventas\n\n\| Producto \| Unidades \| Precio \| Total \| Fecha \|\n\| --- \| --- \| --- \| --- \| --- \|\n/);
    assert.match(ventas, /^\| Café \| 120 \| 1[.,]5 \| 180 \| (?:2026-01-15|15\/01\/2026) \|$/m);
    assert.match(ventas, /^\| Té verde \| 80 \| 2 \| 160 \|/m);
    assert.match(ventas, /\n\n!\[Image 1 \(sheet "Ventas"\)\]\(rag-image:\/\/__DOC_ID__:img_1\)/);
    assert.match(largo, /^Largo\n\n\| Fila \| Valor \|/);
    assert.equal(largo.match(/^\| \d+ \| v\d+ \|$/gm).length, 499);
    assert.match(largo, /\[Showing the first 500 of 601 rows\]/);
    assertRedPng(images, 1);
  });
}

test('las imágenes EMF y las enlazadas a URL externas quedan como marcadores de texto', async () => {
  const emf = await parseFixture('emf-image.pptx');
  assert.match(emf.text, /\[Image not shown: Image 1 \(slide 2\) \(EMF format is not supported\)\]/);
  assert.deepEqual(emf.images, []);

  const linked = await parseFixture('linked-image.docx');
  assert.match(linked.text, /\[Image not shown: Logo rojo \(linked external image\)\]/);
  assert.doesNotMatch(linked.text, /example\.com\/logo\.png/);
  assert.deepEqual(linked.images, []);
});

test('un documento con macros se lee como su formato base sin ejecutar nada', async () => {
  const { text } = await parseFixture('pandoc.docx', 'informe.docm');
  assert.match(text, /^# Informe trimestral$/m);
});

test('los formatos binarios antiguos y los archivos dañados se rechazan con un mensaje claro', async () => {
  await assert.rejects(OfficeParser.parseOfficeDocument(new ArrayBuffer(8), 'acta.doc'),
    /Word 97-2003 files \(\.doc\) are not supported\. Save the file as \.docx/);
  await assert.rejects(OfficeParser.parseOfficeDocument(new ArrayBuffer(8), 'datos.xls'), /Save the file as \.xlsx/);
  await assert.rejects(OfficeParser.parseOfficeDocument(new ArrayBuffer(8), 'charla.ppt'), /Save the file as \.pptx/);
  for (const name of ['roto.docx', 'roto.xlsx', 'roto.pptx', 'roto.odt']) {
    await assert.rejects(OfficeParser.parseOfficeDocument(new TextEncoder().encode('not a zip').buffer, name),
      /could not be read\. It may be damaged or password protected\./);
  }
  await assert.rejects(OfficeParser.parseOfficeDocument(new ArrayBuffer(8), 'notas.txt'), /not a supported office document/);
});

test('ODS no pierde filas tras un hueco de más de 500 filas vacías (F-01)', async () => {
  const fflate = require('fflate');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="Sheet1">
        <table:table-row>
          <table:table-cell><text:p>Fila 1</text:p></table:table-cell>
        </table:table-row>
        <table:table-row table:number-rows-repeated="600"/>
        <table:table-row>
          <table:table-cell><text:p>Fila 2</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`;
  const zip = fflate.zipSync({ 'content.xml': Buffer.from(xml) });
  const { text } = await OfficeParser.parseOfficeDocument(zip.buffer, 'hueco.ods');
  assert.match(text, /Fila 1/);
  assert.match(text, /Fila 2/);
});

test('pptx sin presentation.xml se trata como archivo dañado (F-02)', async () => {
  const fflate = require('fflate');
  const zip = fflate.zipSync({ 'dummy.txt': Buffer.from('nada') });
  await assert.rejects(
    OfficeParser.parseOfficeDocument(zip.buffer, 'incompleto.pptx'),
    /The PowerPoint presentation could not be read\. It may be damaged or password protected\./
  );
});

