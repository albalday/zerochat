const { test } = require('node:test');
const assert = require('node:assert/strict');
const FileParser = require('../../js/file-parser.js');

test('FileParser - desofusca desplazamiento de glifos/fuente (+3) en tablas PDF', () => {
  // Casos reportados por el usuario
  assert.equal(
    FileParser.decodePdfShiftedText('O L T X L G L W \\'),
    'LIQUIDITY'
  );

  assert.equal(
    FileParser.decodePdfShiftedText('F R D O P L Q H G'),
    'COAL MINED'
  );

  // Fila tabular con cifras numéricas (comas y puntos decimales codificados en +3)
  assert.equal(
    FileParser.decodePdfShiftedText('O L T X L G L W \\   4 / 5 6 7 1 8 3'),
    'LIQUIDITY 1,234.50'
  );

  assert.equal(
    FileParser.decodePdfShiftedText('F R D O P L Q H G   : ; < 1 5'),
    'COAL MINED 789.2'
  );
});

test('FileParser - desofusca tablas multilínea con números y términos financieros', () => {
  const shiftedTable = [
    'O L T X L G L W \\   4 / 5 6 7 1 8 3',
    'F D V K   D Q G   F D V K   H T X L Y D O H Q W V   8 9 1 0',
    '4 / 8 3 3 1 3 3'
  ].join('\n');

  const decoded = FileParser.decodePdfShiftedText(shiftedTable);
  assert.match(decoded, /LIQUIDITY 1,234\.50/);
  assert.match(decoded, /CASH/);
  assert.match(decoded, /1,500\.00/);
});

test('FileParser - no altera texto normal en español o inglés (evita falsos positivos)', () => {
  const spanishText = 'El presente informe anual corresponde al ejercicio 2023. La empresa aumentó sus ventas.';
  assert.equal(FileParser.decodePdfShiftedText(spanishText), spanishText);

  const englishText = 'The quick brown fox jumps over the lazy dog. Revenue was positive in Q3.';
  assert.equal(FileParser.decodePdfShiftedText(englishText), englishText);
});

test('FileParser - compacta glifos espaciados de PDF antes de indexarlos', () => {
  const extracted = 'C a s h F l o w\nC a p i t a l E x p e n d i t u r e s';
  const normalized = FileParser.decodePdfShiftedText(extracted);

  assert.doesNotMatch(normalized, /C a s h/);
  assert.doesNotMatch(normalized, /C a p i t a l/);
  assert.match(normalized, /CASH FLOW/);
  assert.match(normalized, /CAPITAL EXPENDITURES/);
});

test('FileParser - compacta páginas PDF que contienen un glifo por línea', () => {
  const extracted = [
    '--- Página 60 ---',
    'C', 'a', 's', 'h', '',
    'F', 'l', 'o', 'w', 's', '',
    'f', 'r', 'o', 'm', '',
    'I', 'n', 'v', 'e', 's', 't', 'i', 'n', 'g', '',
    'A', 'c', 't', 'i', 'v', 'i', 't', 'i', 'e', 's', '',
    '(', '1', ',', '5', '7', '7', ')'
  ].join('\n');

  const normalized = FileParser.collapseVerticallySplitGlyphs(extracted);
  assert.match(normalized, /Cash Flows from Investing Activities \(1,577\)/);
  assert.doesNotMatch(normalized, /C\na\ns\nh/);
});

test('FileParser - usa el mapa ToUnicode de la fuente PDF activa', () => {
  const aggregate = new Map([['0001', 'X']]);
  aggregate.byFontName = new Map([
    ['F1', new Map([['0001', 'A']])],
    ['F2', new Map([['0001', 'B']])]
  ]);

  const stream = 'BT /F1 12 Tf <0001> Tj /F2 12 Tf <0001> Tj ET';
  assert.equal(FileParser.parsePdfStreamText(stream, aggregate), 'AB');
});

test('FileParser - descifra imágenes en PDFs con seguridad estándar RC4 sin contraseña', async () => {
  const fs = require('fs');
  const path = '/home/alberto/FinanceBench/financebench-main/pdfs/BOEING_2021_10K.pdf';
  if (!fs.existsSync(path)) return;
  const data = fs.readFileSync(path);
  const result = await FileParser.parsePdfDocument(data);
  assert.ok(result.images.length >= 1, 'Debe extraer al menos una imagen');
  const img = result.images[0];
  assert.equal(img.mimeType, 'image/jpeg');
  assert.ok(img.dataUrl.startsWith('data:image/jpeg;base64,/9j/'), 'El dataUrl debe comenzar con la cabecera JPEG válida');
});

test('FileParser - descifra texto y CMaps en PDFs con seguridad estándar RC4 sin contraseña', async () => {
  const fs = require('fs');
  const path = '/home/alberto/FinanceBench/financebench-main/pdfs/WALMART_2020_10K.pdf';
  if (!fs.existsSync(path)) return;
  const data = fs.readFileSync(path);
  const result = await FileParser.parsePdfDocument(data);
  assert.ok(result.text.length > 50000, 'Debe extraer texto completo del PDF');
  assert.match(result.text, /WALMART INC\./);
  assert.match(result.text, /Operating income/);
  assert.match(result.text, /Consolidated Statements of Income/);
});


