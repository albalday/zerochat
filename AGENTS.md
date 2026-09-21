# Normas de desarrollo de ZeroChat

Estas normas definen el nivel mínimo de calidad para cualquier cambio en ZeroChat.
Se aplican tanto al desarrollo humano como a los agentes de generación de código.


## 1. Fuente de verdad

El código fuente se mantiene en:

- `zerochat.html` (interfaz web universal servida por GitHub Pages)
- `zerochat.py` (backend local unificado y gestor de entorno venv)
- `js/`
- `css/`
- `tests/`
- `scripts/`

No existe proceso de empaquetado (bundle). La aplicación web se sirve de forma directa
y estática por HTTPS desde GitHub Pages cargando sus módulos `css/` y `js/`.

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

El mantenimiento y las modificaciones de `ChatState` deben realizarse exclusivamente
mediante funciones de modificación de atributos y mutadores de dominio específicos
(`appendMessage`, `replaceMessages`, `removeTurn`, `saveSessionMetadata`, `removeSession`,
`replaceConversation`, `initializeConversation`, `setAttachments`, etc.) que garanticen cambios
atómicos y sincronizados con el estado actual, impidiendo desincronizaciones, escrituras
parciales no controladas o sobreescrituras arbitrarias.

Los módulos reutilizables deben conservar el patrón UMD utilizado por el proyecto
para poder ejecutarse en navegador y en las pruebas de Node.js.

Los proveedores de IA deben extender `BaseProviderAdapter` (`js/providers.js`) para
normalizar endpoints, streaming SSE, razonamiento (`reasoningChunk`), tool calls y telemetría.

La persistencia local en IndexedDB se canaliza mediante `ZeroChatDB` (`js/storage-db.js`),
manteniendo los adjuntos pesados (como imágenes Base64) aislados del árbol de mensajes.

El texto visible de la interfaz debe pasar por `ChatI18n`. Toda nueva clave debe
añadirse simultáneamente a los diccionarios español e inglés.

Los avisos, confirmaciones y solicitudes de texto deben utilizar exclusivamente
`ChatDialogs.alert`, `ChatDialogs.confirm` y `ChatDialogs.prompt` (`js/ui-dialogs.js`).
Está prohibido llamar a los diálogos nativos del navegador `alert()`, `confirm()`
y `prompt()`, también mediante alias o propiedades de `window`/`globalThis`.
Las confirmaciones y solicitudes de texto deben esperar su resultado con `await`,
respetar la cancelación y revalidar el estado antes de efectuar cambios cuando
pueda haber variado durante la espera. Los textos deben pasar por `ChatI18n`.

Los mensajes inyectados programáticamente en la conversación deben redactarse en
inglés.

La interfaz no debe usar emojis crudos en botones, badges, barras o acciones interactivas.
Debe utilizar exclusivamente iconos vectoriales SVG limpios a través del catálogo
`ChatIcons` (`js/icons.js`) o etiquetas `<svg class="ui-icon">`. Los emojis solo son
admisibles en contenido textual explicativo o mensajes del chat.

Para preservar el rendimiento durante el streaming de tokens SSE, se debe aplicar
renderizado eficiente (lazy rendering): evitar mutaciones masivas continuas del DOM y
actualizar paneles o popovers pesados bajo demanda al interactuar o al finalizar la inferencia.

Las herramientas deben respetar el contrato documentado en `js/tools/README.md`.
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
Las comunicaciones con `zerochat.py` requieren obligatoriamente el token efímero de sesión
suministrado en el arranque.


## 5. Pruebas y validación

Durante el desarrollo se puede usar la validación más específica:

- lógica sin interfaz: `npm run test:unit`;
- infraestructura de servidor local: `npm run test:infrastructure`;
- contratos de arquitectura: `npm run test:architecture`;
- integración de componentes: `npm run test:integration`;
- cambios de HTML, CSS o DOM: `npm run test:browser`.

Antes de considerar terminado un cambio:

1. deben pasar las pruebas aplicables;
2. los cambios de comportamiento deben tener pruebas nuevas o modificadas.

## 6. Control de versiones y Git

El flujo de trabajo en el repositorio debe seguir estas pautas:

- **Rama de trabajo**: Todo desarrollo o cambio se realiza sobre la rama `dev`.
- **Formato de commits**: Usar la convención Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Gestión unificada de versiones

Las versiones se actualizan exclusivamente mediante el script automatizado:

```bash
npm run bump <nueva_version | patch | minor | major>
```

El primer y segundo nivel (`major.minor`) identifican la compatibilidad de `zerochat.py` y del paquete PyPI. El tercer nivel identifica cambios de la interfaz web compatibles con ese backend.

El script `scripts/bump-version.mjs` actualiza automáticamente:
- `package.json` y `package-lock.json`
- `zerochat.html` (título)
- `sw.js` (nombre de caché)
- `pyproject.toml` únicamente cuando cambia `major.minor`

Por tanto, `patch` actualiza solo la interfaz web; `minor` y `major` actualizan también la versión publicable en PyPI. `zerochat.py` informa de `major.minor` y debe seguir siendo compatible con todos los parches de esa serie.

**Prohibido** modificar manualmente los números de versión en archivos individuales. Toda actualización debe realizarse exclusivamente mediante este script.

Ejemplos:
```bash
npm run bump patch      # 7.0.8 → 7.0.9
npm run bump minor      # 7.0.9 → 7.1.0
npm run bump major      # 7.1.0 → 8.0.0
npm run bump 7.2.5      # Versión específica
```

## 7. Regla de promoción a `master`

Todo cambio destinado a `master` debe prepararse primero en `dev`.

La promoción a `master` queda prohibida si:

- la versión del producto no se ha incrementado previamente en `dev`;
- la versión de `dev` y `master` coinciden o no hay un avance claro de versión;
- no se ejecuta la validación automática definida por el proyecto;
- cualquier comprobación crítica falla.

La validación automática mínima para un pase a `master` debe incluir:

- `npm run test:unit`;
- `npm run test:infrastructure`;
- `npm run test:architecture`;
- `npm run test:integration`;
- `npm run test:browser` si el cambio afecta a HTML, CSS o DOM.

Si cualquiera de estas comprobaciones falla, el paso a `master` queda bloqueado.
`master` debe ser únicamente el estado validado y liberado, no una rama de trabajo.

Si el usuario lo ha pedido expresamente se podrá no ejecutar los test de pase a produccion. pidiendo confirmacion y dejando el motivo en el commit y push. no s epodrán hacer excepciones en numeros seguidos de version. en medio ha de haber una sin excepciones

### Excepción para documentación en `/help`

Los archivos de ayuda y documentación contenidos en el subdirectorio `/help/` no forman parte del bundle distribuible de la aplicación y están destinados a su publicación en línea para GitHub Pages en `master`. Se autoriza la publicación o sincronización directa a `master` de cambios exclusivos de `/help/` sin requerir incremento de versión del producto ni la ejecución obligatoria de la suite completa de tests, manteniéndose siempre sincronizados con la rama `dev`.

## 8. Finalización

Un cambio está terminado cuando:

- implementa únicamente el comportamiento solicitado;
- conserva la compatibilidad existente, salvo decisión explícita;
- tiene pruebas adecuadas;
- mantiene español e inglés cuando afecta a la interfaz;
- actualiza y mantiene automáticamente la documentación de `/help` en formato bilingüe (español e inglés) ante cualquier actualización o cambio de funcionalidades;
- no deja errores de consola en los tests de navegador;
- actualiza el bundle distribuible;
- deja la documentación coherente con el comportamiento real.

## 9. Política de documentación y colocación (colocation)

La documentación se organiza de forma canónica en los siguientes niveles:

- **`AGENTS.md` (Gobernanza y normas globales)**:
  Contiene exclusivamente las normas de obligado cumplimiento, límites de seguridad, restricciones arquitectónicas transversales y directrices del flujo de trabajo (build, test, git). No debe inflarse con contratos detallados ni especificaciones técnicas exhaustivas de APIs o subsistemas.
- **Documentación técnica de subsistemas (Colocación / Colocation)**:
  La documentación técnica profunda reside obligatoriamente en la carpeta raíz del subsistema que describe bajo el nombre estándar `README.md`. Está prohibido que los agentes creen archivos `.md` sueltos en la raíz o en carpetas genéricas:
  - Pruebas y suite de test: `tests/README.md`.
  - Herramientas agénticas y contratos de ejecución: `js/tools/README.md`.
- **Documentación de usuario final (`help/`)**:
  Contenido HTML estático bilingüe (español e inglés) servido por GitHub Pages para usuarios de la aplicación.
- **Histórico y archivo (`docs/`)**:
  Reservado exclusivamente para informes de auditoría cerrados (`docs/audits/`) y propuestas técnicas de diseño en borrador (`docs/proposals/`).
