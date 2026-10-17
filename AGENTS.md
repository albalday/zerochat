# Normas de desarrollo de ZeroChat

Estas normas definen el nivel mínimo de calidad para cualquier cambio en ZeroChat.
Se aplican tanto al desarrollo humano como a los agentes de generación de código.


## Project memory

Rules for agents go in this file; if details live in other docs, link them from here.

Every agent working in this repository keeps the project memory up to date:

- `.zerochat/state.md`: current milestone and next task. Read it before starting work. Keep it under 30 lines.
- `.zerochat/plan.md`: milestones and tasks.
- `.zerochat/log.md`: decisions, one line each, append only and never archived. Search it; do not read it in full.
- `.zerochat/archive/M<n>.md`: plan sections of closed milestones. Search them; do not read them in full.

Tasks take one line each, with an ID numbered within their milestone: `- [ ] M2-T3 Short description`.
- Keep tasks scoped (~300 lines of code max); when a module spans several variants or formats, add a prior task for the shared base.
- Mark a task done by editing only its line: `- [x] M2-T3 Short description (YYYY-MM-DD)`. A dropped task is marked done with `(dropped: reason)`.
- Never renumber or reuse an ID. A new task or decision takes the next number in its milestone (M2-T4, M2-D2).
- Never rewrite .zerochat/plan.md or .zerochat/log.md as a whole: edit or append single lines.

To mark a task done, record decisions and update state atomically in one command:
`python3 .zerochat/task.py done <TASK_ID> [-d "Decision text"] [-n <NEXT_TASK>]`
(or edit files manually if python is unavailable).

Record architectural or design decisions by appending to .zerochat/log.md: `- YYYY-MM-DD M2-D1 Decision and reason (M2-T3)`. Routine code changes, bugfixes or implementations that code makes obvious do not require a log entry.

Before starting work that is not in .zerochat/plan.md, add it as the next task of the current milestone.
Right after finishing each task, before starting the next one: mark it in .zerochat/plan.md, append its decisions to .zerochat/log.md and set the next task in .zerochat/state.md (or use `task.py done`).

Ask the user before closing a milestone or adding a new one. Every milestone has a Goal and a Done when line.
When the user confirms a milestone is closed: move its section from .zerochat/plan.md to `.zerochat/archive/M<n>.md` (move, never delete), leave `## M<n> Title: closed YYYY-MM-DD` in .zerochat/plan.md and update .zerochat/state.md.

`.zerochat/` is versioned and never ignored: commit its changes on `dev` in the same commit as the work they record.

Other agent instruction files (CLAUDE.md, .cursorrules) only point here. Add rules to this file, not to them.


## 1. Fuente de verdad y arquitectura

El código fuente del proyecto se organiza en:
- `zerochat.html`: interfaz web servida estáticamente (GitHub Pages), sin proceso de empaquetado (bundle).
- `js/`: módulos del cliente web. Sus normas técnicas detalladas residen en [`js/README.md`](./js/README.md).
- `css/`: estilos y tokens semánticos de diseño.
- `py/`: módulos del backend local modularizado. Sus especificaciones y empaquetado residen en [`py/README.md`](./py/README.md).
- `zerochat.py`: ejecutable unificado del backend, generado con `npm run build:backend`.
- `tests/`: suite de pruebas descrita en [`tests/README.md`](./tests/README.md).
- `scripts/`: herramientas de automatización, validación y control de versiones.

Los cambios deben ser pequeños, coherentes con la arquitectura y limitarse a lo solicitado. Se permite y exige el refactor local mínimo para reutilizar una fuente de verdad existente (constantes, tipos, predicados o convenciones) en lugar de duplicarla. Las dependencias y opciones se justifican únicamente por su consumo en la tarea actual, nunca por hitos futuros no confirmados.


## 2. Calidad del código

El código nuevo debe:
- buscar antes de escribir: antes de crear una constante, tabla de tipos/formatos, predicado o utilidad, comprobar si ya existe en el código e importarla;
- mantener una única fuente por decisión: tablas de formatos, predicados de dominio y convenciones de nombres residen en un solo sitio, y las pruebas importan esa fuente real en lugar de reimplementarla;
- respetar los patrones ya utilizados en el módulo y mantener las interfaces públicas;
- separar lógica de dominio, persistencia, adaptadores y presentación;
- gestionar errores de forma explícita y validar entradas externas y de configuración;
- no añadir código especulativo (ramas, opciones o parámetros sin consumidor actual) ni de compatibilidad hacia atrás (alias, migraciones de datos, formatos antiguos) salvo petición expresa;
- eliminar todo lo que quede huérfano tras una retirada (funciones, estilos CSS, claves i18n, pruebas);
- en pruebas sin navegador no hay DOM: la lógica se prueba en Node con implementaciones en memoria de sus dependencias (`storage-env.js`, `tests/helpers/turn-view.js`) y todo lo que pinta o lee elementos se prueba en navegador (`tests/browser/`), sin simular elementos ni documentos; el código que solo corre en el navegador no lleva ramas ni guardas para Node;
- no exportar helpers internos exclusivamente para ser probados (exponer constantes o contratos del dominio sí forma parte de la interfaz pública).


## 3. Arquitectura y límites del sistema

* **Estado compartido:** Reside exclusivamente en `ChatState` con mutadores de dominio atómicos (`appendMessage`, `replaceMessages`, `removeTurn`, etc.). Prohibidas variables globales mutables de módulo.
* **Persistencia:** Canalizada únicamente por `ChatStorage` y `ChatRagStorage` a través de `ZeroChatDB`. Ningún otro módulo toca almacenamiento web ni cookies.
* **Texto e i18n:** Todo texto visible pasa por `ChatI18n` (simultáneo en español e inglés). Los mensajes inyectados programáticamente en el chat van exclusivamente en inglés.
* **Diálogos:** Avisos y confirmaciones usan exclusivamente `ChatDialogs` (`alert`, `confirm`, `prompt`) con `await`. Prohibidos los diálogos nativos del navegador.
* **Estilos e iconos:** Colores y radios provienen de `css/tokens.css` (sin respaldo en `var()`). Los elementos se ocultan con el atributo `hidden`, nunca con `style.display`. Controles interactivos usan iconos vectoriales SVG (`ChatIcons`), sin emojis crudos.
* **Proveedores y herramientas:** Los adaptadores de IA extienden `BaseProviderAdapter`. Las herramientas nativas usan solo claves documentadas en [`js/tools/README.md`](./js/tools/README.md).

> Para especificaciones detalladas de frontend, UMD, eventos y estilos, consulta [`js/README.md`](./js/README.md).


## 4. Seguridad

Las entradas de usuario, respuestas de modelos y datos externos no son confiables:
- Inserción segura: pintar texto plano o escapar con `escapeHtml`. `innerHTML` queda restringido a la lista cerrada revisada en `tests/architecture/test_html_sinks.js`.
- Cambios que afecten a ejecución de comandos, sandbox o datos sensibles deben incluir pruebas específicas de límites y autorización.
- El backend requiere el token diario de sesión (`~/zerochat/config/token.json`, permisos `0600`) y escucha por defecto en `127.0.0.1`.


## 5. Pruebas y validación

Validaciones según el nivel afectado:
- Lógica sin interfaz: `npm run test:unit`
- Infraestructura y servidor: `npm run test:infrastructure`
- Contratos de arquitectura: `npm run test:architecture`
- Integración de componentes: `npm run test:integration`
- Cambios de HTML, CSS o DOM: `npm run test:browser`

Antes de considerar terminado un cambio:
1. deben pasar todas las pruebas aplicables;
2. todo cambio de comportamiento debe incluir pruebas nuevas o modificadas;
3. todo límite o tope (filas, bytes, elementos, tiempo) debe incluir prueba en el valor exacto del borde (`N` y `N+1`) y comprobar el aviso o marcador de truncado.


## 6. Control de versiones y Git

- **Rama de trabajo:** Todo desarrollo se realiza sobre `dev`.
- **Commits:** Convención Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- **Gestión de versiones:** Se actualizan exclusivamente con `npm run bump <patch | minor | major>`.
  - `patch`: actualiza solo la versión de la interfaz web.
  - `minor` / `major`: actualizan también la versión del backend y PyPI.
  - Durante el trabajo iterativo en `dev` no se incrementa versión en cada commit; `bump` se ejecuta solo al consolidar para release o pase a `master`. Prohibido modificar números de versión manualmente.
  - El empaquetado y release a PyPI se describe en [`py/README.md`](./py/README.md).


## 7. Regla de promoción a `master`

Todo cambio destinado a `master` debe prepararse primero en `dev`. La promoción queda prohibida si:
- no se ha ejecutado `npm run bump` previo en `dev`;
- la versión de `dev` coincide con la de `master` o no hay avance de versión;
- falla cualquier comprobación de la validación automática (`test:unit`, `test:infrastructure`, `test:architecture`, `test:integration`, y `test:browser` si afecta a UI).

**Excepción:** Los cambios que afecten exclusivamente a `/help/`, `/docs/`, `.zerochat/` y `AGENTS.md` están exentos de bump y de la suite completa, pudiendo sincronizarse directamente con `master`.


## 8. Finalización

Antes de cerrar una tarea (`task.py done`), revisar el `git diff` frente a esta lista:
- sin ramas muertas, opciones especulativas ni código de compatibilidad previa;
- ninguna decisión, lista de formatos o convención duplicada en 2 o más sitios;
- comprobaciones y límites simétricos entre variantes hermanas de un mismo módulo;
- topes cubiertos con prueba en el borde exacto y su aviso de truncado;
- español e inglés sincronizados si afecta a la interfaz o a `/help/`;
- backend recompilado (`npm run build:backend`) si se modificó `py/`;
- documentación y memoria de proyecto (`.zerochat/`) actualizadas.


## 9. Política de documentación y colocación (colocation)

La documentación se organiza canónicamente en:
- **`AGENTS.md` (Gobernanza y normas globales):** Normas universales de obligado cumplimiento, límites de seguridad y flujo de trabajo. No se infla con contratos detallados de subsistemas.
- **Documentación técnica colocada (`<subsistema>/README.md`):**
  - Frontend y UI: [`js/README.md`](./js/README.md).
  - Backend y distribución: [`py/README.md`](./py/README.md).
  - Herramientas agénticas: [`js/tools/README.md`](./js/tools/README.md).
  - Pruebas y validación: [`tests/README.md`](./tests/README.md).
- **Memoria del proyecto (`.zerochat/`):** Plan, estado y registro de decisiones.
- **Documentación de usuario (`help/`):** Ayuda web estática bilingüe (español e inglés) servida por GitHub Pages.
- **Histórico y archivo (`docs/`):** Procedimientos de auditoría y propuestas técnicas en borrador.
