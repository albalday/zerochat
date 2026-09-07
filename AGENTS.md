# Normas de desarrollo de ZeroChat

Estas normas definen el nivel mínimo de calidad para cualquier cambio en ZeroChat.
Se aplican tanto al desarrollo humano como a los agentes de generación de código.

## 1. Fuente de verdad

El código fuente se mantiene en:

- `index.html`
- `js/`
- `css/`
- `tests/`
- `scripts/`

`zerochat.html` es un artefacto generado. No debe editarse manualmente.
Cualquier modificación del código fuente que afecte a la aplicación debe terminar
con la regeneración del bundle mediante `npm run build`.

Los cambios deben ser pequeños, coherentes con la arquitectura existente y limitarse
al problema solicitado. No se deben introducir refactorizaciones generales, nuevas
abstracciones o dependencias sin una justificación concreta.

## 2. Calidad del código

El código nuevo debe:

- respetar los patrones y APIs ya utilizados por el módulo;
- mantener las interfaces públicas salvo que el cambio lo requiera;
- evitar duplicación y estado global innecesario;
- separar la lógica de dominio, persistencia, proveedores y presentación;
- gestionar errores de forma explícita, sin ocultarlos silenciosamente;
- validar entradas externas y valores procedentes de la configuración;
- ser comprobable mediante pruebas automatizadas;
- incluir comentarios únicamente cuando aclaren una decisión no evidente.

Antes de crear una utilidad, servicio o abstracción, debe comprobarse si ya existe
una solución equivalente en el repositorio.

## 3. Arquitectura y presentación

`app.js` coordina el arranque y la integración de módulos. La lógica específica debe
permanecer en su módulo correspondiente.

El estado compartido, persistente o necesario para coordinar subsistemas debe pasar
por `ChatState`, respetando sus slices canónicos (`config`, `sessions`, `messages`,
`streaming`, `agent`, `telemetry`, `ui`, `toolSecurity`). Está prohibido usar variables globales de
módulo que provoquen fugas de estado entre conversaciones.

Los módulos reutilizables deben conservar el patrón UMD utilizado por el proyecto
para poder ejecutarse en navegador y en las pruebas de Node.js.

Los proveedores de IA deben extender `BaseProviderAdapter` (`js/providers.js`) para
normalizar endpoints, streaming SSE, razonamiento (`reasoningChunk`), tool calls y telemetría.

La persistencia local en IndexedDB se canaliza mediante `ZeroChatDB` (`js/storage-db.js`),
manteniendo los adjuntos pesados (como imágenes Base64) aislados del árbol de mensajes.

El texto visible de la interfaz debe pasar por `ChatI18n`. Toda nueva clave debe
añadirse simultáneamente a los diccionarios español e inglés.

La interfaz no debe usar emojis crudos en botones, badges, barras o acciones interactivas.
Debe utilizar exclusivamente iconos vectoriales SVG limpios a través del catálogo
`ChatIcons` (`js/icons.js`) o etiquetas `<svg class="ui-icon">`. Los emojis solo son
admisibles en contenido textual explicativo o mensajes del chat.

Para preservar el rendimiento durante el streaming de tokens SSE, se debe aplicar
renderizado eficiente (lazy rendering): evitar mutaciones masivas continuas del DOM y
actualizar paneles o popovers pesados bajo demanda al interactuar o al finalizar la inferencia.

Las herramientas deben respetar el contrato documentado en `docs/TOOLS.md`.
No deben utilizarse las propiedades obsoletas `ui` ni `handler`.

## 4. Seguridad

Las entradas de usuario, respuestas de proveedores, contenido de documentos y
resultados de herramientas se consideran datos no confiables.

Todo cambio que afecte a MCP, ejecución de comandos, sandbox, persistencia de datos,
credenciales o contenido HTML debe incluir pruebas específicas y revisar:

- validación de entradas;
- autorización;
- límites de tamaño y tiempo;
- exposición de secretos;
- generación segura de HTML;
- comportamiento ante errores y cancelación.

No se deben registrar claves API, tokens ni contenido sensible en depuración o tests.

## 5. Pruebas y build

Durante el desarrollo se puede usar la validación más específica:

- lógica sin interfaz: `npm run test:unit`;
- cambios de HTML, CSS o DOM: `npm run test:browser`;
- validación completa: `npm test`;
- regeneración del distribuible: `npm run build`.

Antes de considerar terminado un cambio:

1. deben pasar las pruebas aplicables;
2. debe ejecutarse `npm test`;
3. debe ejecutarse `npm run build`;
4. debe comprobarse que `zerochat.html` queda actualizado;
5. los cambios de comportamiento deben tener pruebas nuevas o modificadas.

## 6. Control de versiones y Git

El flujo de trabajo en el repositorio debe seguir estas pautas:

- **Rama de trabajo**: Todo desarrollo o cambio se realiza sobre la rama `dev`.
- **Formato de commits**: Usar la convención Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- **Sincronización del bundle**: El archivo distribuible `zerochat.html` debe incluirse en la confirmación siempre que se modifique código fuente de la aplicación.

## 7. Regla de promoción a `master`

Todo cambio destinado a `master` debe prepararse primero en `dev`.

La promoción a `master` queda prohibida si:

- la versión del producto no se ha incrementado previamente en `dev`;
- la versión de `dev` y `master` coinciden o no hay un avance claro de versión;
- no se ejecuta la validación automática definida por el proyecto;
- cualquier comprobación crítica falla.

La validación automática mínima para un pase a `master` debe incluir:

- `npm test`;
- `npm run build`;
- `npm run test:browser` si el cambio afecta a HTML, CSS o DOM.

Si cualquiera de estas comprobaciones falla, el paso a `master` queda bloqueado.
`master` debe ser únicamente el estado validado y liberado, no una rama de trabajo.

## 8. Finalización

Un cambio está terminado cuando:

- implementa únicamente el comportamiento solicitado;
- conserva la compatibilidad existente, salvo decisión explícita;
- tiene pruebas adecuadas;
- mantiene español e inglés cuando afecta a la interfaz;
- no deja errores de consola en los tests de navegador;
- actualiza el bundle distribuible;
- deja la documentación coherente con el comportamiento real.

