# Documentos ofimáticos de prueba

Documentos reales, sin datos personales, para las pruebas de `js/office-parser.js`.
Todos comparten el mismo contenido para poder comparar productores:

- Texto (`*.docx`, `*.odt`): título, negrita, cursiva, enlace, lista anidada, lista numerada,
  tabla con una barra vertical en una celda, imagen PNG roja de 8×8 con texto alternativo «Logo rojo» y una sección «Anexo».
- Presentaciones (`*.pptx`, `*.odp`): diapositivas «Portada» y «Resultados»; la segunda tiene viñetas,
  la imagen roja y la nota del orador «Nota del orador para resultados».
- Hojas (`*.xlsx`, `*.ods`): hoja «Ventas» con fórmula, fecha, texto enriquecido e imagen, y hoja «Largo» con 600 filas de datos.

| Archivo | Productor |
|---|---|
| `pandoc.docx`, `pandoc.odt`, `pandoc.pptx` | pandoc 3.10 desde Markdown (plantillas de referencia de Word y PowerPoint) |
| `libreoffice.docx`, `libreoffice.odt`, `libreoffice.pptx`, `libreoffice.odp` | LibreOffice 26.8 (conversión sin interfaz de los anteriores) |
| `exceljs.xlsx` | ExcelJS 4.4.0 |
| `libreoffice.ods`, `libreoffice.xlsx` | LibreOffice 26.8 desde `exceljs.xlsx` |
| `emf-image.pptx` | `pandoc.pptx` con la imagen guardada como EMF |
| `linked-image.docx` | `pandoc.docx` con la imagen enlazada a una URL externa en lugar de incrustada |

No hay documentos exportados directamente por Microsoft Office ni Google Docs: se validan a mano con documentos reales.
