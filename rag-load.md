# Plan de arreglo: ingesta de ficheros RAG

## Objetivo

Mejorar la ingesta local de documentos para que:

1. El usuario pueda detener una ingesta en curso.
2. Un documento idéntico no se vuelva a ingerir.
3. Un documento con el mismo origen lógico pero contenido distinto permita elegir entre reemplazarlo o conservarlo como una nueva versión.
4. La cancelación, los duplicados y los errores no dejen documentos o chunks parciales.

No se debe modificar `zerochat.html` manualmente: se regenerará con `npm run build` al finalizar la implementación.

## Decisiones funcionales

### Cancelación

- Añadir un botón de detener visible mientras haya una cola activa.
- Usar `AbortController`/`AbortSignal` para propagar la cancelación desde `rag-ui.js` hasta `processDocumentQueue`.
- Comprobar la señal antes de comenzar cada archivo y después de cada operación asíncrona relevante.
- Intentar cancelar operaciones de lectura que lo permitan (`FileReader`, streams de descompresión) y detener la cola antes de guardar el siguiente documento.
- Representar la cancelación como estado explícito del resultado, separado de un error normal:
  - archivos ya guardados: permanecen válidos;
  - archivo que se estaba procesando: no se guarda si la cancelación ocurre antes de persistirlo;
  - archivos pendientes: quedan como cancelados/no procesados;
  - no se muestran como errores técnicos.
- Restaurar el estado del botón y limpiar el controlador activo cuando la cola termina, falla o se cancela.

### Identidad de documentos y duplicados

- Calcular una huella estable del contenido extraído y normalizado, preferentemente SHA-256 mediante `crypto.subtle.digest`.
- Guardar la huella en los metadatos de `rag_documents`, junto con:
  - `sourceKey` o clave de origen lógico normalizada, derivada del nombre sin extensión y con normalización de separadores;
  - `version` numérica;
  - `supersedesId`/relación con la versión anterior, si se conserva historial.
- La comparación exacta debe hacerse por `branchId + contentHash`, no solo por nombre.
- Si la huella coincide dentro de la misma rama:
  - omitir la persistencia y la indexación;
  - contabilizar el archivo como omitido por duplicado, no como error;
  - informar al usuario de que la versión existente ya es válida.
- Si la clave de origen coincide pero la huella es distinta:
  - ofrecer al usuario `Reemplazar` o `Guardar como nueva versión`;
  - `Reemplazar` debe actualizar o sustituir atómicamente el documento elegido y sus imágenes/chunks, invalidando el índice de la rama;
  - `Guardar como nueva versión` debe conservar la versión anterior, incrementar `version` y enlazarla mediante `supersedesId`;
  - cancelar la decisión debe omitir ese archivo sin considerarlo error.
- Si no existe coincidencia de origen lógico, insertar como documento nuevo con versión 1.
- La política debe aplicarse también a varios archivos equivalentes dentro de la misma cola, no solo contra documentos ya persistidos.
- Mantener compatibilidad con documentos antiguos sin hash: no inventar una coincidencia exacta; permitir que una futura ingesta los complete o pedir una decisión cuando el nombre coincida.

## Fases de implementación

### 1. Persistencia y esquema

Archivos principales:

- `js/storage-db.js`
- `js/ragStorage.js`

Trabajo:

- Incrementar la versión de IndexedDB si es necesario y conservar migración compatible.
- Extender la validación de documentos con hash, clave de origen, versión y relación de reemplazo.
- Añadir búsquedas por rama y hash, y por rama y clave de origen.
- Crear operaciones atómicas para:
  - guardar un documento nuevo;
  - reemplazar un documento y limpiar imágenes/chunks anteriores;
  - conservar una nueva versión;
  - eliminar o revertir una operación incompleta.
- Garantizar que los documentos y sus chunks/imágenes se escriben en una transacción coherente.
- Actualizar exportación/importación para conservar los nuevos metadatos y remapear referencias de imágenes sin romper respaldos existentes.

### 2. Motor de ingesta

Archivo principal:

- `js/ingestionEngine.js`

Trabajo:

- Aceptar `options.signal` y definir un error/estado de cancelación identificable.
- Exponer una función de hash reutilizable y comprobable en Node.js y navegador.
- Separar el flujo en extracción, cálculo de identidad, resolución de duplicado, persistencia y notificación de progreso.
- Añadir un callback o estrategia de resolución para los conflictos de contenido distinto, sin acoplar el motor a la UI.
- Verificar cancelación antes de persistir y evitar guardar el documento si la señal ya fue abortada.
- Ampliar el resultado con contadores explícitos, por ejemplo:
  - `processed`;
  - `skipped` para duplicados exactos;
  - `replaced`;
  - `versioned`;
  - `cancelled`;
  - `failed`.
- Emitir estados de progreso para `duplicate`, `conflict`, `cancelled` y `completed`.

### 3. Interfaz RAG

Archivo principal:

- `js/rag-ui.js`

Trabajo:

- Mantener el `AbortController` de la ingesta activa por instancia de la UI.
- Añadir al área de progreso un botón con icono SVG de detener, visible solo durante la ingesta.
- Deshabilitar selección repetida de archivos mientras se resuelve la cola, o definir explícitamente una cola adicional.
- Al pulsar detener, abortar la señal, actualizar el estado inmediatamente y permitir que finalice la limpieza de la operación actual.
- Mostrar los duplicados exactos como omitidos y los conflictos como una decisión clara del usuario.
- Revalidar rama, documento candidato y existencia del conflicto después de cualquier diálogo asíncrono antes de reemplazar o versionar.
- Usar exclusivamente `ChatDialogs.confirm`/`prompt`/`alert` y `ChatI18n` para textos visibles.
- No usar emojis en botones ni estados; emplear `ChatIcons` o SVG `ui-icon`.

### 4. Internacionalización y ayuda

Archivos principales:

- `js/i18n.js`
- `help/rag.html` o la página de ayuda RAG equivalente en español e inglés
- `help/help.js` si requiere actualización dinámica

Trabajo:

- Añadir claves en español e inglés para:
  - detener/cancelar ingesta;
  - ingesta cancelada;
  - duplicado omitido;
  - conflicto de contenido;
  - reemplazar documento;
  - guardar nueva versión;
  - versión creada;
  - operación ya modificada por otro flujo;
  - resumen final con indexados, omitidos, reemplazados, versionados, cancelados y errores.
- Actualizar la ayuda bilingüe para documentar la política de duplicados y la cancelación.

### 5. Pruebas

Archivos principales:

- `tests/integration/test_ingestion_engine.js`
- `tests/integration/test_rag_storage.js`
- tests de UI RAG existentes o un nuevo test en `tests/browser/` siguiendo los patrones del repositorio

Casos mínimos:

- Cancelar antes del primer archivo: no se guarda ningún documento.
- Cancelar entre dos archivos: el primero válido permanece y los pendientes no se procesan.
- Cancelar durante lectura/descompresión: no queda documento parcial.
- Reingestar exactamente el mismo contenido con otro nombre: se omite por hash.
- Reingestar el mismo contenido con el mismo nombre: se omite y no duplica chunks.
- Mismo origen lógico con contenido distinto: la UI permite cancelar la decisión, reemplazar o crear versión.
- Reemplazo elimina correctamente chunks/imágenes antiguos y mantiene el índice coherente.
- Versionado conserva ambas versiones y asigna números crecientes.
- Dos duplicados dentro de una misma cola no generan dos documentos.
- Documentos antiguos sin metadatos nuevos siguen siendo legibles e importables.
- Exportación/importación conserva hash, origen, versión y referencias de imágenes.
- La UI muestra y activa el botón de detener únicamente durante una ingesta.
- Los textos aparecen correctamente en español e inglés.

## Validación final de la implementación

Cuando se ejecute el plan, la secuencia prevista será:

1. `npm run test:unit`
2. `npm run test:integration`
3. `npm run test:browser`
4. `npm test`
5. `npm run build`
6. Comprobar que `zerochat.html` contiene la implementación actualizada.
7. Revisar que la ayuda española e inglesa describe el comportamiento real.

## Riesgos y decisiones pendientes durante la implementación

- La huella debe calcularse sobre el texto extraído normalizado, no sobre el nombre ni sobre el binario original, para que el mismo documento con distinto nombre se detecte como idéntico. Si se necesita distinguir cambios binarios que no alteran el texto, guardar también un hash binario opcional.
- Reemplazar por defecto puede destruir historial; la opción recomendada es conservar versiones y hacer que `Reemplazar` sea explícito.
- Una cola con muchos PDF puede mantener una extracción activa durante un tiempo; la cancelación debe ser cooperativa y no prometer interrupción inmediata cuando la librería PDF no exponga cancelación.
- La migración IndexedDB debe probarse con datos existentes y con el backend de memoria usado por los tests Node.js.
- No se deben introducir dependencias nuevas sin comprobar primero si `crypto.subtle` y las utilidades existentes cubren el cálculo de huellas.
