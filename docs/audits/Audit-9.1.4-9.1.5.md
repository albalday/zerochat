# Auditoría de cambios 9.1.4 → 9.1.5

- Fecha: 2026-10-15
- Alcance: `git diff cca1c87..8e449f8` (desde `feat(project): centinela task.py … 9.1.4` hasta `chore: bump version to 9.1.5`), tareas M4-T4 a M4-T13.
- Código auditado: código propio sin pruebas, unas 1.200 líneas añadidas y 79 eliminadas. Quedan fuera `tests/`, `js/vendor/`, `licenses/`, `scripts/vendor-licenses/`, `THIRD_PARTY_NOTICES.md`, `package-lock.json`, `help/`, `.zerochat/` y los `.md`.
- Áreas: fallos, duplicación, código muerto, rendimiento y peso de las librerías de terceros.
- Línea base: todas las suites en verde (unit 280, integration 365, architecture 46, infrastructure 39, browser 103). La suite actual no detecta ningún hallazgo de esta auditoría.

## Volumen del cambio

| Archivo | + | − |
| --- | --- | --- |
| `js/office-parser.js` (nuevo) | 691 | 0 |
| `scripts/build-vendor.mjs` (nuevo) | 268 | 0 |
| `js/vendor-loader.js` (nuevo) | 84 | 0 |
| `js/web-browser.js` | 45 | 30 |
| `scripts/vendor-manifest.mjs` (nuevo) | 35 | 0 |
| `js/file-parser.js` | 23 | 14 |
| `js/utils.js` | 14 | 0 |
| `js/ingestionEngine.js` | 11 | 1 |
| `scripts/test-runner.mjs` | 10 | 2 |
| `js/attachments.js` | 8 | 7 |
| `package.json` | 6 | 3 |
| `zerochat.html` | 5 | 3 |
| `js/tools/builtin/download-pdf.tool.js` | 3 | 3 |
| `sw.js` | 3 | 1 |
| `js/ragStorage.js` | 1 | 1 |
| `scripts/build-orama.mjs`, `scripts/orama-entry.js` (eliminados) | 0 | 14 |
| **Total** | **1.207** | **79** |

Unas 888 líneas añadidas y 60 eliminadas corresponden a la aplicación (`js/`, `zerochat.html`, `sw.js`); unas 313 y 16, a los scripts de build y del ejecutor de pruebas.

## Resumen

| ID | Hallazgo | Tipo | Prioridad | Dificultad | Ahorro |
| --- | --- | --- | --- | --- | --- |
| F-01 | Una hoja ODS puede perder filas sin avisar | Fallo | Alta | 2 | ~3 líneas |
| F-02 | Un pptx sin `presentation.xml` no se trata como dañado | Fallo | Baja | 1 | 0 |
| F-03 | Cuatro tablas de formatos ofimáticos | Duplicación | Media | 2 | ~10 líneas |
| F-04 | Referencia de imagen docx reextraída por regex | Acoplamiento | Media | 1 | ~2 líneas |
| F-05 | Marcadores de imagen no mostrada repetidos | Duplicación | Baja | 1 | ~5 líneas |
| F-06 | Rama redundante en `blockMarkdown` | Código muerto | Baja | 1 | 1 línea |
| F-07 | La ubicación de la imagen ODF se calcula dos veces | Duplicación | Baja | 1 | ~2 líneas |
| F-08 | Marcadores de diapositiva/página resueltos de dos formas | Incoherencia | Media | 2 | ~3 líneas |
| F-09 | Acumulación de tablas duplicada entre pptx y ODF | Duplicación | Baja | 3 | ~8 líneas |
| F-10 | `content.xml` se recorre dos veces | Rendimiento | Media | 2 | 0 |
| F-11 | Lista de tipos de imagen duplicada con `ChatUtils` | Duplicación | Baja | 1 | ~1 línea |
| F-12 | Detección y lectura ofimática repetidas en los consumidores | Duplicación | Baja | 2 | ~4 líneas |
| F-13 | «¿Es PDF?» se decide en tres sitios de `web-browser.js` | Duplicación | Media | 2 | ~4 líneas |
| F-14 | Cabeceras de adjuntos casi idénticas | Duplicación | Baja | 1 | ~3 líneas |
| F-15 | Formatos admitidos copiados a mano en `ragStorage.js` | Duplicación | Baja | 1 | 0 |
| F-16 | Convención de nombres de bundles definida tres veces | Duplicación | Media | 2 | ~8 líneas |
| F-17 | Rama `exports === '*'` sin uso | Código muerto | Baja | 1 | 1 línea |
| F-18 | `index.json` de licencias releído por cada paquete | Rendimiento | Baja | 1 | 0 |
| F-19 | ExcelJS pesa 924 KB e incluye 69 paquetes para solo leer hojas | Arquitectura | Alta | 3 | ~924 KB y 69 avisos |

Dificultad: 1 trivial, 2 fácil, 3 moderada, 4 difícil.

Aplicar F-01 a F-18 ahorra unas **50–70 líneas (~5 %)** sin perder funcionalidad: el código no está inflado. El ahorro relevante es el de F-19, que es de arquitectura.

## Valoración general: librerías frente a parser propio

`js/office-parser.js` ocupa casi lo mismo que un parser propio en buena parte de sus formatos:

| Sección | Líneas | Papel de la librería |
| --- | --- | --- |
| docx | ~96 | mammoth lo lee entero; aquí solo se convierte su HTML a Markdown |
| xlsx | ~43 | ExcelJS lo lee entero; aquí solo se formatean las celdas |
| pptx | ~78 | Propio; fflate solo descomprime el ZIP |
| odt/ods/odp | ~211 | Propio; fflate solo descomprime el ZIP |
| Base común (XML, ZIP, Markdown, imágenes, API, constantes) | ~260 | Propio |

- **pptx y OpenDocument** son en la práctica un parser propio (~290 líneas más la base común).
- **docx**: mammoth tiene unas 4.500 líneas y resuelve listas numeradas (`numbering.xml`), herencia de estilos, tablas con celdas combinadas, notas al pie, cuadros de texto y variantes entre productores. Un parser propio razonable serían 600–1.000 líneas. Está justificado.
- **xlsx**: la lectura de ExcelJS son unas 11.000 líneas. Un lector propio solo de lectura (cadenas compartidas, formatos numéricos para detectar fechas, fórmulas compartidas, texto enriquecido) serían 150–250 líneas sobre fflate. Ver F-19.

Con todo propio, el módulo rondaría las 1.500–2.000 líneas. El código ahorrado con las librerías es menor de lo que parece, y a cambio se pagan unos 1,2 MB en `js/vendor/`, 78 licencias en los avisos y el mantenimiento de las versiones.

## Fallos confirmados

### F-01 Una hoja ODS puede perder filas sin avisar

- Evidencia: [`readOpenDocument`](../../js/office-parser.js) (líneas 616-625) guarda en la hoja también las filas vacías, repetidas hasta el tope de 500. [`sheetSection`](../../js/office-parser.js) (líneas 118-133) recorta después las vacías finales y solo avisa del truncado si quedan 500 filas.
- Reproducción: una hoja con 3 filas de datos, un hueco de 600 filas vacías (`table:number-rows-repeated`) y 5 filas más. El tope se llena con 3 filas de datos y 497 vacías, las 5 últimas no se guardan, el recorte deja 3 filas y no aparece «Showing the first…». Se pierden 5 filas sin aviso.
- Incoherencia: xlsx ya ignora las filas vacías (`eachRow({ includeEmpty: false })`, línea 351).
- Alternativa: ignorar en ODS las filas sin contenido, como en xlsx. Corrige el fallo y simplifica `sheetSection`, que ya no tendría que recortar filas finales.
- Prueba: unitaria con un `.ods` que tenga un hueco de más de 500 filas vacías entre dos bloques de datos.
- Prioridad: alta.

### F-02 Un pptx sin `presentation.xml` no se trata como dañado

- Evidencia: [`parsePptx`](../../js/office-parser.js) (línea 430) no comprueba que exista `ppt/presentation.xml`; un ZIP sin él produce «[The document contains no readable text.]». [`parseOpenDocument`](../../js/office-parser.js) (línea 652) sí comprueba `content.xml` y da el error de archivo dañado.
- Alternativa: la misma comprobación de una línea en pptx.
- Prueba: unitaria con un ZIP válido sin `ppt/presentation.xml` renombrado a `.pptx`.
- Prioridad: baja.

## Duplicación y acoplamiento en `js/office-parser.js`

### F-03 Cuatro tablas de formatos ofimáticos

- Evidencia: `FORMATS_BY_EXTENSION`, `FORMATS_BY_MIME_TYPE`, `DOCUMENT_KINDS` y `LEGACY_FORMATS` (líneas 23-52) describen los mismos formatos por separado.
- Alternativa: una tabla por formato (extensiones, tipos MIME, nombre legible y, si es antiguo, su formato moderno) de la que se deriven las búsquedas. M4-T14 (.doc y .xls) solo tocaría un sitio.
- Prioridad: media.

### F-04 Referencia de imagen docx reextraída por regex

- Evidencia: [`parseDocx`](../../js/office-parser.js) (líneas 317-319) recibe de `collector.add()` el Markdown de la imagen y vuelve a extraer la referencia `rag-image://` con una regex.
- Alternativa: que `add()` devuelva `{ id, markdown }` y usar el identificador directamente.
- Prioridad: media.

### F-05 Marcadores de imagen no mostrada repetidos

- Evidencia: `[Image omitted: …]` y `[Image not shown: … (linked external image)]` se escriben literalmente en las líneas 97, 99, 225, 315, 407-408 y 517.
- Alternativa: dos funciones auxiliares (`omittedImage(label)`, `externalImage(label)`).
- Prioridad: baja.

### F-06 Rama redundante en `blockMarkdown`

- Evidencia: líneas 294-295. `if (tag === 'p' || tag === 'div') return inlineMarkdown(node).trim();` coincide con la línea siguiente.
- Alternativa: eliminar la rama.
- Prioridad: baja.

### F-07 La ubicación de la imagen ODF se calcula dos veces

- Evidencia: `location()` (línea 495) y `where` dentro de `addImage` (línea 514) derivan la diapositiva, hoja o página por separado.
- Alternativa: una sola función que devuelva número y texto.
- Prioridad: baja.

### F-08 Marcadores de diapositiva/página resueltos de dos formas

- Evidencia: pptx compone cada sección como `--- Slide n ---\n…` (línea 441). ODF inserta los marcadores como bloques sueltos, añade `--- Page 1 ---` con `unshift` y después recoloca los saltos de línea con una regex (líneas 644-647).
- Alternativa: una función común `section(marker, blocks)` usada por ambos; ODF acumularía bloques por diapositiva o página.
- Prioridad: media.

### F-09 Acumulación de tablas duplicada entre pptx y ODF

- Evidencia: tabla, fila y celda se acumulan con la misma lógica en `readSlidePart` (líneas 400-421) y en `readOpenDocument` (líneas 571-636).
- Alternativa: un acumulador de tablas común.
- Límite: no se recomienda fusionar los dos recorridos XML completos. Se parecen, pero un recorrido genérico sería más difícil de seguir de lo que ahorra.
- Prioridad: baja.

### F-10 `content.xml` se recorre dos veces

- Evidencia: [`readNumberedListStyles`](../../js/office-parser.js) (líneas 454-469) recorre `styles.xml` y `content.xml` completos antes del recorrido principal de `content.xml`, que admite hasta 50 MB.
- Alternativa: los estilos automáticos preceden al cuerpo en `content.xml`, así que pueden recogerse en la misma pasada; solo `styles.xml` necesita una lectura previa.
- Prioridad: media (rendimiento con documentos grandes).

### F-11 Lista de tipos de imagen duplicada con `ChatUtils`

- Evidencia: `IMAGE_MIME_TYPES` (línea 54) repite los tipos que acepta `ChatUtils.sanitizeImageUrl`; el propio comentario lo indica.
- Alternativa: exportar la lista desde `ChatUtils` y usarla en ambos.
- Prioridad: baja.

## Duplicación en los consumidores

### F-12 Detección y lectura ofimática repetidas

- Evidencia: [`file-parser.js`](../../js/file-parser.js) (líneas 1245-1246) e [`ingestionEngine.js`](../../js/ingestionEngine.js) (líneas 90-91) repiten `getOfficeFormat(file.name, file.type)` seguido de `parseOfficeDocument(await file.arrayBuffer(), file.name, file.type)`. La ingesta calcula el formato dos veces: en `detectFileType` (línea 198) y de nuevo en `extractDocumentContent` (línea 90), aunque ya lo recibe en `fileType`.
- Alternativa: `ChatOfficeParser.parseOfficeFile(file)` y, en la ingesta, decidir por `fileType`.
- Prioridad: baja.

### F-13 «¿Es PDF?» se decide en tres sitios de `web-browser.js`

- Evidencia: [`web-browser.js`](../../js/web-browser.js): `isPdfUrl` con una regex sobre la URL (línea 487), `isPdf`/`isDocument` en `DirectFetchStrategy` (línea 425) y otra comprobación dentro de `describeDownloadedDocument` (línea 269). `isOfficeUrl` (línea 488) usa `documentFileName`, mientras que `isPdfUrl` analiza la URL completa.
- Alternativa: calcular el tipo de documento una sola vez a partir de `documentFileName` y del `content-type`, y pasárselo a `describeDownloadedDocument`.
- Prioridad: media.

### F-14 Cabeceras de adjuntos casi idénticas

- Evidencia: [`buildAttachmentsPayload`](../../js/attachments.js) (líneas 110-116): las cabeceras de PDF, documento ofimático y archivo genérico son tres plantillas que solo cambian la etiqueta y el lenguaje del bloque de código.
- Alternativa: una pequeña tabla de etiqueta y lenguaje por tipo.
- Prioridad: baja.

### F-15 Formatos admitidos copiados a mano en `ragStorage.js`

- Evidencia: [`validateDocument`](../../js/ragStorage.js) (línea 96) enumera `docx, xlsx, pptx, odt, ods, odp`.
- Riesgo: no sobra código, pero M4-T14 tendrá que añadir los formatos antiguos aquí además de en el parser.
- Alternativa: mantener la lista en la capa de persistencia (no debe depender del parser) y cubrirla con una prueba que compare ambas listas.
- Prioridad: baja.

## Librerías empaquetadas y build

### F-16 Convención de nombres de bundles definida tres veces

- Evidencia: la regla `js/vendor/<id>.browser.js` → global `ZeroChat<Id>`, con su expresión de identificador válido, está en [`vendor-loader.js`](../../js/vendor-loader.js) (líneas 27-36), en [`build-vendor.mjs`](../../scripts/build-vendor.mjs) (`bundlePaths`, línea 76) y en la prueba [`test_vendor_build.js`](../../tests/infrastructure/test_vendor_build.js) (líneas 11-12).
- Alternativa: que `ChatVendorLoader` exporte `bundleInfo(id)` y que la build y la prueba lo carguen en Node. No es exportar algo solo para pruebas, porque lo usa la build.
- Prioridad: media.

### F-17 Rama `exports === '*'` sin uso

- Evidencia: [`entryContents`](../../scripts/build-vendor.mjs) (línea 71). Ninguna entrada de `vendor-manifest.mjs` usa `'*'`.
- Alternativa: eliminarla.
- Prioridad: baja.

### F-18 `index.json` de licencias releído por cada paquete

- Evidencia: [`licenseText`](../../scripts/build-vendor.mjs) (línea 104) toma `stored = readStoredLicenses()` como valor por defecto, y `collectLicenses` la llama sin pasarlo, así que el archivo se lee una vez por paquete (78 por build).
- Alternativa: leerlo una vez en `main` y pasarlo.
- Prioridad: baja.

### F-19 ExcelJS pesa 924 KB e incluye 69 paquetes para solo leer hojas

- Evidencia: ExcelJS se publica como bundle precompilado con browserify, que incluye reimplementaciones de APIs de Node. `js/vendor/exceljs.browser.js` ocupa 924 KB y contiene 69 paquetes, todos listados en `THIRD_PARTY_NOTICES.md`:
  - 33 son la criptografía de Node reimplementada (`crypto-browserify`, `elliptic`, `bn.js`, `sha.js`, `pbkdf2`, `browserify-aes`…). ExcelJS solo la usa al escribir el hash de contraseñas de protección de hojas.
  - El resto son `stream`, `buffer`, `events`, `process`, `core-js` y `regenerator-runtime` (compatibilidad con navegadores antiguos), el lector CSV, `jszip`, `dayjs` y utilidades `lodash.*`.
  - En la lectura solo trabajan `jszip`, `saxes` y el código de ExcelJS.
- No son descargas separadas: es un solo archivo, descargado desde la propia web la primera vez que se lee una hoja y guardado en caché.
- Comparación: mammoth, que también descomprime y lee XML, ocupa 315 KB con 9 paquetes; fflate, 6 KB.
- Motivo original (M4-D6): se eligió ExcelJS porque escribe estilos y anchos de columna para M13.
- Cambio de contexto: M13 se orientará a generar archivos `.csv` en lugar de libros de Excel completos. La escritura de xlsx deja de ser necesaria, y con ella el único motivo para conservar ExcelJS.
- Alternativa: un lector xlsx propio sobre fflate (150–250 líneas, compartiendo `walkXml`, `readRelationships`, `markdownTable` y `sheetSection`), y retirar ExcelJS de `vendor-manifest.mjs` y de `package.json`. Elimina 924 KB y 69 avisos, y la lectura de xlsx pasa a depender solo de fflate (6 KB), como pptx y ODF. El CSV de M13 no necesita librería.
- Prueba: las fixtures actuales de xlsx (`exceljs.xlsx`, `libreoffice.xlsx`) ya cubren fórmulas, fechas, texto enriquecido, imágenes y el tope de filas; deben seguir pasando sin cambios.
- Prioridad: alta.

## Plan de corrección por dificultad

Cada nivel se entrega en cambios pequeños e independientes, con sus pruebas.

1. **Trivial**: F-02, F-04, F-05, F-06, F-07, F-11, F-14, F-17, F-18.
2. **Fácil**: F-01, F-03, F-08, F-10, F-12, F-13, F-15, F-16.
3. **Moderada**: F-09, F-19.

Orden recomendado: F-01 primero (pérdida de datos); después F-19, porque sustituye `parseXlsx` y conviene hacerlo antes de reorganizar F-03, F-08 y F-09 sobre el código resultante.

## Decisiones pendientes

- F-19: confirmar que M13 generará CSV y no libros xlsx, y en ese caso retirar ExcelJS y reescribir M13-T1 y M13-T3, que hoy prevén vendorizar «the xlsx library chosen in M4-T6» y una herramienta `create_xlsx`.
- F-09: aceptar la duplicación parcial entre pptx y ODF o extraer solo el acumulador de tablas.

## Normas sin prueba que las proteja

- Coherencia entre los formatos que lee el parser y los que acepta `ragStorage.js` (F-15).
- Una sola definición de la convención de nombres de los bundles (F-16): hoy cada copia podría divergir sin que fallen las pruebas, porque la prueba usa su propia copia.
