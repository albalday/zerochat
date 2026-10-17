const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

test('getOfficeDocumentKind devuelve el nombre legible según la tabla unificada (F-03)', () => {
  assert.equal(OfficeParser.getOfficeDocumentKind('docx'), 'Word document');
  assert.equal(OfficeParser.getOfficeDocumentKind('xlsx'), 'Excel spreadsheet');
  assert.equal(OfficeParser.getOfficeDocumentKind('pptx'), 'PowerPoint presentation');
  assert.equal(OfficeParser.getOfficeDocumentKind('odt'), 'OpenDocument text');
  assert.equal(OfficeParser.getOfficeDocumentKind('ods'), 'OpenDocument spreadsheet');
  assert.equal(OfficeParser.getOfficeDocumentKind('odp'), 'OpenDocument presentation');
  assert.equal(OfficeParser.getOfficeDocumentKind('unknown'), 'Office document');
});

// docx se convierte con mammoth y el DOMParser del navegador: lo cubre browser_documents.

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

test('las imágenes EMF quedan como marcadores de texto', async () => {
  const emf = await parseFixture('emf-image.pptx');
  assert.match(emf.text, /\[Image not shown: Image 1 \(slide 2\) \(EMF format is not supported\)\]/);
  assert.deepEqual(emf.images, []);
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

test('odt con saltos de página genera marcadores de página limpios sin saltos redundantes (F-08)', async () => {
  const fflate = require('fflate');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:p>Página uno</text:p>
      <text:soft-page-break/>
      <text:p>Página dos</text:p>
    </office:text>
  </office:body>
</office:document-content>`;
  const zip = fflate.zipSync({ 'content.xml': Buffer.from(xml) });
  const { text } = await OfficeParser.parseOfficeDocument(zip.buffer, 'paginas.odt');
  assert.equal(text, '--- Page 1 ---\nPágina uno\n\n--- Page 2 ---\nPágina dos');
});

const SHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const DRAWING_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const CHARTSHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet';

const relationshipsXml = items => `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, mode]) => (
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`)).join('')}</Relationships>`;

const sheetXml = rows => `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

/** Libro xlsx mínimo: `sheets` = [{ name, state, rel, xml }], `extra` = partes adicionales del paquete. */
function buildXlsx({ sheets, workbookPr = '', extra = {} }) {
  const fflate = require('fflate');
  const files = {
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${workbookPr}<sheets>${sheets.map((sheet, i) => (
  `<sheet name="${sheet.name}" sheetId="${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${i + 1}"/>`)).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationshipsXml(sheets.map((sheet, i) => [`rId${i + 1}`, sheet.rel || SHEET_REL, `worksheets/sheet${i + 1}.xml`])),
    ...Object.fromEntries(sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheet.xml])),
    ...extra
  };
  return fflate.zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, typeof content === 'string' ? Buffer.from(content) : content]))).buffer;
}

const parseXlsx = async options => (await OfficeParser.parseOfficeDocument(buildXlsx(options), 'datos.xlsx')).text;

const columnLetters = index => (index >= 26 ? columnLetters(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26));

const numberRows = (count, columns = 1) => Array.from({ length: count }, (_, r) => (
  `<row r="${r + 1}">${Array.from({ length: columns }, (_, c) => `<c r="${columnLetters(c)}${r + 1}"><v>${r}</v></c>`).join('')}</row>`)).join('');

test('xlsx nativo con celdas booleanas, errores, texto inline, columnas dispersas y hojas ocultas', async () => {
  const text = await parseXlsx({
    sheets: [
      {
        name: 'Resumen',
        state: 'visible',
        xml: sheetXml('<row r="1"><c r="A1" t="b"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Texto directo</t></is></c><c r="D1" t="e"><v>#N/A</v></c></row>')
      },
      { name: 'Oculta', state: 'hidden', xml: sheetXml('<row r="1"><c r="A1" t="str"><v>Dato oculto</v></c></row>') }
    ]
  });
  assert.match(text, /## Sheet: Resumen\n\n\| TRUE \|  \| Texto directo \| #N\/A \|/);
  assert.match(text, /## Sheet: Oculta \(hidden\)\n\n\| Dato oculto \|/);
});

test('xlsx sin xl/workbook.xml se trata como archivo dañado', async () => {
  const fflate = require('fflate');
  const zip = fflate.zipSync({ 'dummy.txt': Buffer.from('nada') });
  await assert.rejects(
    OfficeParser.parseOfficeDocument(zip.buffer, 'incompleto.xlsx'),
    /The Excel spreadsheet could not be read\. It may be damaged or password protected\./
  );
});

test('xlsx con etiquetas con prefijo de espacio de nombres (x:row, x:c) se lee igual', async () => {
  const text = await parseXlsx({
    sheets: [{
      name: 'Prefijo',
      xml: '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>hola</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>'
    }]
  });
  assert.match(text, /## Sheet: Prefijo\n\n\| hola \|/);
});

test('xlsx convierte fechas con formatos integrados y personalizados, y respeta el calendario 1904', async () => {
  const styles = `<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/><numFmt numFmtId="165" formatCode="&quot;Total&quot; 0.00 [Red]"/></numFmts>
<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
  const cells = '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45000.5</v></c><c r="C1" s="3"><v>45000</v></c><c r="D1" s="0"><v>45000</v></c></row>';
  const base = { extra: { 'xl/styles.xml': styles } };
  const text1900 = await parseXlsx({ ...base, sheets: [{ name: 'D', xml: sheetXml(cells) }] });
  assert.match(text1900, /\| 2023-03-15 \| 2023-03-15T12:00:00Z \| 45000 \| 45000 \|/);
  const text1904 = await parseXlsx({ ...base, workbookPr: '<workbookPr date1904="1"/>', sheets: [{ name: 'D', xml: sheetXml(cells) }] });
  assert.match(text1904, /\| 2027-03-16 \| 2027-03-16T12:00:00Z \| 45000 \| 45000 \|/);
});

test('xlsx ignora las lecturas fonéticas de las cadenas compartidas y las hojas de gráfico', async () => {
  const sharedStrings = '<sst><si><r><t>東京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si><si><t>Dos</t></si></sst>';
  const text = await parseXlsx({
    extra: { 'xl/sharedStrings.xml': sharedStrings },
    sheets: [
      { name: 'Datos', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>') },
      { name: 'Grafico', rel: CHARTSHEET_REL, xml: '<chartsheet/>' }
    ]
  });
  assert.match(text, /\| 東京 \| Dos \|/);
  assert.doesNotMatch(text, /トウキョウ|Grafico/);
});

test('xlsx en el borde del tope de filas: 500 filas completas y 501 con aviso de truncado', async () => {
  const at500 = await parseXlsx({ sheets: [{ name: 'H', xml: sheetXml(numberRows(500)) }] });
  assert.equal(at500.match(/^\| \d+ \|$/gm).length, 500);
  assert.doesNotMatch(at500, /Showing the first/);
  const at501 = await parseXlsx({ sheets: [{ name: 'H', xml: sheetXml(numberRows(501)) }] });
  assert.equal(at501.match(/^\| \d+ \|$/gm).length, 500);
  assert.match(at501, /\[Showing the first 500 of 501 rows\]/);
});

test('xlsx en el borde del tope de columnas: 50 se conservan y la 51 se descarta', async () => {
  const at50 = await parseXlsx({ sheets: [{ name: 'C', xml: sheetXml(numberRows(1, 50)) }] });
  assert.equal(at50.split('\n')[2].split('|').length - 2, 50);
  const at51 = await parseXlsx({ sheets: [{ name: 'C', xml: sheetXml(numberRows(1, 51)) }] });
  assert.equal(at51.split('\n')[2].split('|').length - 2, 50);
});

test('xlsx con imágenes de la hoja: incrustada, enlazada fuera del paquete y con relación inexistente', async () => {
  const drawing = `<xdr:wsDr xmlns:xdr="d" xmlns:a="a" xmlns:r="r">${['rId1', 'rId2', 'rId9'].map(id => (
    `<xdr:twoCellAnchor><xdr:pic><xdr:blipFill><a:blip r:embed="${id}"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>`)).join('')}</xdr:wsDr>`;
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAbKgILlaNmJgAAAABJRU5ErkJggg==', 'base64'));
  const text = await parseXlsx({
    sheets: [{ name: 'Fotos', xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>').replace('</worksheet>', '<drawing r:id="rId1" xmlns:r="r"/></worksheet>') }],
    extra: {
      'xl/worksheets/_rels/sheet1.xml.rels': relationshipsXml([['rId1', DRAWING_REL, '../drawings/drawing1.xml']]),
      'xl/drawings/drawing1.xml': drawing,
      'xl/drawings/_rels/drawing1.xml.rels': relationshipsXml([['rId1', IMAGE_REL, '../media/image1.png'], ['rId2', IMAGE_REL, 'https://example.com/logo.png', 'External']]),
      'xl/media/image1.png': png
    }
  });
  assert.match(text, /!\[Image 1 \(sheet "Fotos"\)\]\(rag-image:\/\/__DOC_ID__:img_1\)/);
  assert.match(text, /\[Image not shown: Image 2 \(sheet "Fotos"\) \(linked external image\)\]/);
  assert.match(text, /\[Image omitted: Image 3 \(sheet "Fotos"\)\]/);
  assert.doesNotMatch(text, /example\.com/);
});
