# Auditoría de cambios 9.1.1 → 9.1.4

- Fecha: 2026-10-15
- Alcance: `git diff 7b4d870..bce9ddc` (desde `chore: bump version to 9.1.1` hasta `HEAD` en `dev`, que incluye 9.1.4 y M4-T4).
- Fuera de alcance: cambios sin confirmar en el árbol de trabajo (`js/vendor-loader.js`, `scripts/build-vendor.mjs`, `scripts/vendor-manifest.mjs`, `sw.js`, `zerochat.html`, `tests/infrastructure/test_vendor_build.js`), en curso para M4-T5.
- Áreas: código muerto, duplicación, calidad y normas de `AGENTS.md`.
- Línea base: `npm test` en verde (803 pasan, 1 omitida) antes de la auditoría. Ningún hallazgo lo detecta la suite actual.

## Resumen

| ID | Hallazgo | Tipo | Prioridad | Dificultad |
| --- | --- | --- | --- | --- |
| F-01 | La reconciliación de bloques congela el texto junto a imágenes | Fallo | Alta | 4 |
| F-02 | `openImageInNewTab` abre dos pestañas y no libera el blob | Fallo | Alta | 2 |
| F-03 | `normalizeMathNotation` corrompe rutas y precios | Fallo | Alta | 4 |
| F-04 | El filtro de tamaño de imágenes en la extracción por regex descarta imágenes válidas | Fallo | Media | 2 |
| F-05 | Botón de abrir imagen duplicado en cuatro módulos | Duplicación | Media | 3 |
| F-06 | Respaldos `getElementById` y guardas muertas en `ui-mcp.js` | Código muerto | Media | 3 |
| F-07 | Restablecer autorizaciones marca el formulario como modificado | Incoherencia | Media | 1 |
| F-08 | Imágenes enviadas dos veces al modelo en `fetch_web_page` | Duplicación | Media | 2 |
| F-09 | `markdown.js` depende de `ChatUIConversation` | Capas | Media | 3 |
| F-10 | `TASK_SCRIPT_TEMPLATE` duplica `.zerochat/task.py` | Duplicación | Media | 4 |
| F-11 | Caché `effectiveMaxTokens` mutable en un singleton y sin endpoint | Estado | Media | 3 |
| F-12 | Lectura de memoria de proyecto sin corte ante fallos | Calidad | Baja | 3 |
| F-13 | Guardas muertas en el adaptador Claude | Código muerto | Baja | 1 |
| F-14 | Respaldo muerto de `isEqualNode` | Código muerto | Baja | 1 |
| F-15 | Transiciones CSS anuladas por `base.css` | Código muerto | Baja | 1 |
| F-16 | Comentarios de `markdown.js` sin tildes | Documentación | Baja | 1 |
| F-17 | Guarda `typeof window` y colores literales en `openImageInNewTab` | Calidad | Baja | 1 |
| F-18 | Prefijo `//` redundante en `resolveImageUrl` | Código muerto | Baja | 1 |
| F-19 | Prueba de paridad de `task.py` duplicada | Duplicación | Baja | 1 |
| F-20 | `resolveImageUrl` exportada solo para pruebas | Norma | Baja | 2 |
| F-21 | Límite del presupuesto de razonamiento duplicado | Duplicación | Baja | 2 |
| F-22 | Literal de resultado vacío duplicado en `api.js` | Duplicación | Baja | 2 |
| F-23 | Éxito histórico de `read_knowledge_image` deducido por texto | Acoplamiento | Baja | 2 |

Dificultad: 1 trivial, 2 fácil, 3 moderada, 4 difícil.

## Fallos confirmados

### F-01 La reconciliación de bloques congela el texto junto a imágenes

- Evidencia: [`updateBlockChildren`](../../js/ui-conversation.js) (línea 99). Si el nodo actual y el nuevo tienen la misma etiqueta y contienen una `img.chat-embedded-image` con el mismo `src`, solo sincroniza `alt`, `title`, pie y cursor, y hace `continue`. El resto del contenido del nodo no se actualiza.
- Reproducción: `renderAssistantBlock(div, "- foo ![a](https://x.org/a.png) bar")` seguido de `renderAssistantBlock(div, "- foo ![a](https://x.org/a.png) bar BAZ\n\nfin")` deja «foo a bar fin»: se pierde «BAZ». Afecta también al render final (`streaming: false`), así que el texto se pierde de forma permanente en pantalla.
- Riesgo: estabilidad y presentación; el usuario ve una respuesta incompleta.
- Alternativa: aplicar la rama de conservación solo cuando el nodo es la `<figure>` de imagen; en el resto, reemplazar el nodo conservando la instancia `<img>` existente o reconciliar de forma recursiva.
- Prueba: unitaria en `tests/unit/test_ui_conversation.js` con texto creciente junto a imágenes en `<li>`, `<td>` y `<p>`, en streaming y en render final.
- Prioridad: alta.

### F-02 `openImageInNewTab` abre dos pestañas y no libera el blob

- Evidencia: [`openImageInNewTab`](../../js/utils.js) (líneas 67-117). Con la característica `noopener`, `window.open` devuelve siempre `null` según el estándar HTML, de modo que `if (win)` nunca se cumple: se abre el visor blob y además la URL directa, y `URL.revokeObjectURL` no se ejecuta.
- Riesgo: presentación (dos pestañas por clic) y fuga de memoria (blobs no revocados).
- Alternativa: no depender del valor devuelto; abrir solo el blob y programar siempre la revocación. Usar la apertura directa únicamente si falla la creación del blob.
- Prueba: unitaria en `tests/unit/test_utils.js` que espíe `window.open` devolviendo `null` y compruebe una sola llamada y la revocación.
- Prioridad: alta.

### F-03 `normalizeMathNotation` corrompe rutas y precios

- Evidencia: [`normalizeMathNotation`](../../js/markdown.js) (línea 337), aplicada a todo el texto fuera de código en `parseTextMarkdown`. Sustituye cualquier `\nombre` del mapa y retira `$…$` cuyo interior no sea solo numérico.
- Reproducción: `C:\data\in\times.txt` → `C:\data∈×.txt`; `Precio $5/$10 al mes` → `Precio 5/10 al mes`.
- Riesgo: presentación e integridad del contenido; rutas y cifras alteradas en las respuestas.
- Alternativa: normalizar solo dentro de delimitadores matemáticos (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) y no tocar texto con aspecto de ruta, URL o enlace; aplicar `^` y `_` solo dentro de esos delimitadores.
- Prueba: regresión en `tests/unit/test_markdown.js` con rutas Windows, precios, `snake_case`, URL y tablas, además de los casos LaTeX existentes.
- Prioridad: alta. Requiere decidir el alcance de la normalización.

### F-04 El filtro de tamaño de la extracción por regex descarta imágenes válidas

- Evidencia: [`extractReadableTextFromHtml`](../../js/web-browser.js) (líneas 240 y 245): `/\b(?:width|height)=["']?[0-2]["']?/i` coincide con `width="200"` o `height="150"` porque no exige que el número termine.
- Riesgo: el modelo no recibe imágenes legítimas cuando no hay `DOMParser` (Node, entornos restringidos).
- Alternativa: exigir fin de número (`[0-2](?![0-9])`). Unificar las dos expresiones `<img…>` en una que lea `src` y `alt` en cualquier orden; hoy un `alt` anterior a `src` se pierde.
- Prueba: unitaria en `tests/unit/test_web_tools.js` con `width="200"`, `width="1"` y `alt` antes de `src`.
- Prioridad: media.

## Duplicación

### F-05 Botón de abrir imagen duplicado en cuatro módulos

- Evidencia: el mismo bloque (`tabIndex = 0`, `role="button"`, `title`, `click` y `keydown` con Enter/Espacio llamando a `openImageInNewTab`) aparece en [markdown.js](../../js/markdown.js) (línea 696), [mcp.js](../../js/mcp.js) (línea 561), [ui-conversation.js](../../js/ui-conversation.js) (línea 325) y [read-knowledge-image.tool.js](../../js/tools/builtin/read-knowledge-image.tool.js) (línea 30). El CSS de cursor y hover se repite en `.chat-embedded-image`, `.mcp-screenshot-image` y `.rag-image-thumb`.
- Riesgo: deuda técnica; los cuatro comportamientos divergirán.
- Alternativa: `Utils.makeImageOpenable(img, url, title)` y una clase CSS común.
- Prueba: las pruebas existentes de cada superficie siguen pasando; una prueba unitaria de la utilidad con clic y teclado.
- Prioridad: media.

### F-08 Imágenes enviadas dos veces al modelo en `fetch_web_page`

- Evidencia: [`extractReadableTextFromHtml`](../../js/web-browser.js) sustituye cada `<img>` por su Markdown en línea y además añade la sección «Images on page» (línea 219) con las mismas URL.
- Riesgo: consumo de tokens y del límite `MAX_CONTENT_LENGTH`, que trunca antes el texto útil.
- Alternativa: conservar solo una de las dos representaciones (en línea mantiene el contexto).
- Prueba: unitaria que compruebe que cada URL aparece una sola vez.
- Prioridad: media.

### F-10 `TASK_SCRIPT_TEMPLATE` duplica `.zerochat/task.py`

- Evidencia: [project-context.js](../../js/project-context.js) contiene las ~250 líneas de Python idénticas a [`.zerochat/task.py`](../../.zerochat/task.py); solo las une una prueba de paridad. El prompt de arranque incluye los 9,6 KB completos.
- Riesgo: deuda técnica y coste de tokens en cada inicialización.
- Alternativa: (a) generar uno a partir del otro en el build y comprobarlo en `test:infrastructure`; (b) aceptar la duplicación registrándola en `.zerochat/log.md` e indicar en la prueba qué fichero es la fuente.
- Prueba: la de paridad existente o una de infraestructura sobre el artefacto generado.
- Prioridad: media. Requiere decisión.

### F-19 Prueba de paridad de `task.py` duplicada

- Evidencia: [test_project_context.js](../../tests/unit/test_project_context.js) compara `TASK_SCRIPT_TEMPLATE` con el disco en las líneas 82-83 y de nuevo en el test de la línea 109.
- Alternativa: dejar solo el test específico.
- Prioridad: baja.

### F-21 Límite del presupuesto de razonamiento duplicado

- Evidencia: [providers.js](../../js/providers.js) aplica `Math.floor(max_tokens / 2)` al construir el payload (línea 815) y al reintentar en `handleHttpError` (línea 847).
- Alternativa: función local `clampThinkingBudget(budget, maxTokens)`.
- Prioridad: baja.

### F-22 Literal de resultado vacío duplicado en `api.js`

- Evidencia: [api.js](../../js/api.js) líneas 205 y 221 repiten el objeto de resultado con `truncated` y `recoveredReason`; la línea 367 tiene la misma forma.
- Alternativa: `streamResult(overrides)` local.
- Prioridad: baja.

## Código muerto

### F-06 Respaldos `getElementById` y guardas muertas en `ui-mcp.js`

- Evidencia: [ui-mcp.js](../../js/ui-mcp.js) líneas 457-582 usan `elements?.x || document.getElementById(...)` y guardas `if (radio)`, `if (rulesInput && rulesError)`, `if (btnClearAuths)`, aunque [app.js](../../js/app.js) (líneas 841-844) siempre pasa esos elementos y existen en `zerochat.html`. Los radios de política siguen buscándose por id, mezclando dos mecanismos.
- Riesgo: deuda técnica; contradice «sin código de compatibilidad» y «sin guardas sobre lo que siempre existe».
- Alternativa: usar solo `elements`, añadir los radios de política al mapa de `app.js` y retirar los respaldos.
- Prueba: `tests/unit/test_ui_mcp.js` con `installDom({ app: true })`.
- Prioridad: media.

### F-13 Guardas muertas en el adaptador Claude

- Evidencia: [providers.js](../../js/providers.js) línea 759 (`this.effectiveMaxTokens?.get`) y línea 843 (`if (!this.effectiveMaxTokens) …`); el `Map` se crea en el constructor (línea 638).
- Prioridad: baja.

### F-14 Respaldo muerto de `isEqualNode`

- Evidencia: [ui-conversation.js](../../js/ui-conversation.js) línea 120: `cur.isEqualNode ? … : cur.outerHTML === …`; todo `Node` tiene `isEqualNode`.
- Prioridad: baja.

### F-15 Transiciones CSS anuladas

- Evidencia: `transition: opacity 0.15s ease` añadidas en `css/components/markdown.css` y `css/components/tools.css`; [base.css](../../css/base.css) línea 122-127 fuerza `transition: none !important` en todos los elementos.
- Alternativa: retirarlas.
- Prioridad: baja.

### F-18 Prefijo `//` redundante en `resolveImageUrl`

- Evidencia: [web-browser.js](../../js/web-browser.js) línea 146 antepone `https:`; `new URL(url, base)` ya resuelve las URL relativas al protocolo con el protocolo de la base.
- Prioridad: baja.

## Calidad, capas y normas

### F-07 Restablecer autorizaciones marca el formulario como modificado

- Evidencia: [ui-settings.js](../../js/ui-settings.js) línea 296 llama a `markModified()` al pulsar `#btn-mcp-clear-auths`, en contra de la regla nueva (líneas 1414-1426 del diff) de que la sección MCP se aplica al momento y no deja cambios pendientes.
- Riesgo: presentación; aparece «Guardar» y la confirmación de cambios sin guardar.
- Alternativa: retirar esa línea.
- Prueba: ampliar «la sección MCP se aplica al momento» en `tests/unit/test_ui_settings.js` con el botón de restablecer.
- Prioridad: media.

### F-09 `markdown.js` depende de `ChatUIConversation`

- Evidencia: [markdown.js](../../js/markdown.js) línea 717 resuelve `ChatUIConversation` en el `load` de cada imagen para desplazar al final.
- Riesgo: dependencia inversa entre el parser y la interfaz.
- Alternativa: que `ui-conversation.js` escuche `load` en captura sobre el contenedor de mensajes o reutilice su observador de tamaño.
- Prueba: prueba de navegador del desplazamiento al cargar una imagen.
- Prioridad: media.

### F-11 Caché `effectiveMaxTokens` mutable en un singleton

- Evidencia: [providers.js](../../js/providers.js) guarda el límite aprendido en `ClaudeProviderAdapter`, instancia única del registro, con clave solo de modelo.
- Riesgo: dos endpoints de la API Messages con el mismo nombre de modelo comparten límite; estado mutable fuera de `ChatState`.
- Alternativa: clave `endpoint + modelo`, o llevar el valor a la configuración de la conexión.
- Prueba: integración en `tests/integration/test_providers.js` con dos endpoints.
- Prioridad: media.

### F-12 Lectura de memoria de proyecto sin corte ante fallos

- Evidencia: [project-context.js](../../js/project-context.js) en `refresh` lee `AGENTS.md` aunque `state.md` devuelva `denied` o `error`, y trata `unavailable` de `state.md` como ausente.
- Alternativa: secuencia centinela → estado → normas, cortando en el primer fallo y tratando `unavailable` de forma explícita.
- Prueba: casos en `tests/integration/test_project_context.js` para cada estado de `state.md`.
- Prioridad: baja.

### F-16 Comentarios de `markdown.js` sin tildes

- Evidencia: [markdown.js](../../js/markdown.js) líneas 396-434: «Código» → «Codigo», «código» → «codigo» y comentarios nuevos sin tildes. Contradice la norma de conservar comentarios no relacionados.
- Prioridad: baja.

### F-17 Guarda `typeof window` y colores literales en `openImageInNewTab`

- Evidencia: [utils.js](../../js/utils.js) línea 69 (`typeof window === 'undefined'`), colores `#0d1117` y `rgba(0,0,0,0.5)` en el HTML del visor y línea en blanco doble.
- Alternativa: retirar la guarda y documentar o centralizar los colores del visor.
- Prioridad: baja.

### F-20 `resolveImageUrl` exportada solo para pruebas

- Evidencia: [web-browser.js](../../js/web-browser.js) línea 548; solo la usa `tests/unit/test_web_tools.js`. Contradice «no exportar funciones exclusivamente para ser probadas».
- Alternativa: probarla a través de `extractReadableTextFromHtml` y `fetchPage`, y retirar la exportación.
- Prueba: la prueba de arquitectura de higiene debería detectarlo; revisar por qué no lo hace.
- Prioridad: baja.

### F-23 Éxito histórico de `read_knowledge_image` deducido por texto

- Evidencia: [read-knowledge-image.tool.js](../../js/tools/builtin/read-knowledge-image.tool.js) línea 54 usa `content.startsWith('Image retrieved')`, acoplado al texto de `toModel` (línea 78).
- Alternativa: constante compartida o basarse solo en `message.images`.
- Prioridad: baja.

## Plan de corrección por dificultad

Cada nivel se entrega en cambios pequeños e independientes, con sus pruebas.

1. **Trivial**: F-13, F-14, F-07, F-16, F-17, F-18, F-15, F-19.
2. **Fácil**: F-02, F-04, F-08, F-20, F-21, F-22, F-23.
3. **Moderada**: F-05, F-06, F-09, F-12, F-11.
4. **Difícil**: F-01, F-03, F-10.

## Decisiones pendientes

- F-03: alcance de la normalización matemática (solo dentro de delimitadores o también comandos sueltos).
- F-10: generar `task.py` desde una única fuente o aceptar la duplicación con registro en `.zerochat/log.md`.

## Normas sin prueba que las proteja

- «No exportar funciones exclusivamente para ser probadas» (F-20): la prueba de higiene no la detecta.
- «Colores solo en `css/tokens.css`» (F-17): la prueba solo revisa CSS, no HTML generado en JavaScript.
- Guardas sobre elementos siempre presentes del marcado (F-06): la prueba de guardas solo cubre módulos.

