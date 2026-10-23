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


## 1. Estructura y documentación

Los cambios son pequeños, coherentes con la arquitectura y limitados a lo solicitado. Cada subsistema tiene normas técnicas propias, de obligado cumplimiento al tocarlo:

| Ruta | Contenido | Normas |
|---|---|---|
| `zerochat.html`, `js/`, `css/` | Interfaz web estática (GitHub Pages), sin bundle | [`js/README.md`](./js/README.md) |
| `js/tools/` | Herramientas agénticas nativas | [`js/tools/README.md`](./js/tools/README.md) |
| `py/`, `zerochat.py` | Backend local; `zerochat.py` se genera con `npm run build:backend` | [`py/README.md`](./py/README.md) |
| `tests/` | Suite de pruebas | [`tests/README.md`](./tests/README.md) |
| `scripts/` | Automatización, validación y versiones | — |
| `help/` | Ayuda de usuario bilingüe (español e inglés) | — |
| `docs/` | Auditorías y propuestas en borrador | — |

Este fichero solo contiene normas globales; los contratos de cada subsistema van en su README.


## 2. Calidad del código

El código nuevo debe:
- buscar antes de escribir: antes de crear una constante, tabla de tipos/formatos, predicado o utilidad, comprobar si ya existe e importarla, con el refactor local mínimo que haga falta;
- mantener una única fuente por decisión: tablas de formatos, predicados de dominio y convenciones de nombres residen en un solo sitio, y las pruebas importan esa fuente real;
- respetar los patrones del módulo y mantener las interfaces públicas;
- separar lógica de dominio, persistencia, adaptadores y presentación;
- gestionar errores de forma explícita y validar entradas externas y de configuración;
- no añadir código especulativo (ramas, opciones, parámetros o dependencias sin consumidor en la tarea actual) ni de compatibilidad hacia atrás (alias, migraciones, formatos antiguos) salvo petición expresa;
- eliminar todo lo que quede huérfano tras una retirada (funciones, estilos CSS, claves i18n, pruebas);
- no añadir a producción código que solo usan las pruebas (parámetros, inyecciones, guardas para objetos falsos o para Node en código de navegador); cómo se prueba sin él, en [`tests/README.md`](./tests/README.md#qué-merece-una-prueba).


## 3. Seguridad

Las entradas de usuario, respuestas de modelos y datos externos no son confiables:
- Inserción segura: pintar texto plano o escapar con `escapeHtml`. `innerHTML` queda restringido a la lista cerrada de `tests/architecture/test_html_sinks.js`.
- Los cambios que afecten a ejecución de comandos, sandbox o datos sensibles incluyen pruebas de límites y autorización.
- El backend exige token de sesión y escucha por defecto en `127.0.0.1` (detalles en [`py/README.md`](./py/README.md#3-seguridad-y-red)).


## 4. Pruebas y validación

Validaciones según el nivel afectado:
- Lógica sin interfaz: `npm run test:unit`
- Infraestructura y servidor: `npm run test:infrastructure`
- Contratos de arquitectura: `npm run test:architecture`
- Integración de componentes: `npm run test:integration`
- Cambios de HTML, CSS o DOM: `npm run test:browser`

Antes de considerar terminado un cambio:
1. pasan todas las pruebas aplicables;
2. llevan prueba los cambios de seguridad, lógica no trivial, integridad de datos, contratos externos y corrección de fallos reales; no la llevan textos, maquetación, estilos, valores por defecto ni lo que cubre la prueba de humo de arranque (criterios en [`tests/README.md`](./tests/README.md#qué-merece-una-prueba));
3. cada comportamiento se prueba una sola vez, en el nivel más bajo que lo observa;
4. todo tope que protege memoria, contexto o seguridad se prueba en el borde exacto (`N` y `N+1`) con su aviso de truncado.


## 5. Git y versiones

- Todo desarrollo se hace en `dev`, con Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- Las versiones cambian solo con `npm run bump <patch | minor | major>`, nunca a mano: `patch` sube la interfaz web; `minor`/`major` también el backend y PyPI. No se ejecuta en cada commit, solo al consolidar para pasar a `master` (release PyPI en [`py/README.md`](./py/README.md#4-distribución-y-publicación-en-pypi)).
- Se promueve a `master` solo desde `dev`, tras `npm run bump` con versión superior a la de `master` y con todos los niveles de §4 en verde.
- **Excepción:** los cambios exclusivos de `help/`, `docs/`, `.zerochat/` y `AGENTS.md` no necesitan bump ni la suite completa y pueden sincronizarse directamente con `master`.
- Los cambios que no modifican lo publicado (ni la interfaz web ni el paquete de PyPI), como `tests/`, `.github/` o los scripts y README de desarrollo, se promueven sin bump, pero con todos los niveles de §4 en verde.


## 6. Finalización

Antes de cerrar una tarea (`task.py done`), revisar el `git diff` frente a esta lista:
- sin ramas muertas, opciones especulativas, código de compatibilidad previa ni código que solo usan las pruebas;
- ninguna decisión, lista de formatos o convención duplicada en 2 o más sitios;
- comprobaciones y límites simétricos entre variantes hermanas de un mismo módulo;
- topes cubiertos en el borde exacto; sin pruebas triviales, duplicadas, cosméticas o de ausencia de algo retirado;
- español e inglés sincronizados si afecta a la interfaz o a `help/`;
- `sitemap.xml` regenerado (`npm run build:sitemap`) si se añade o retira una página pública;
- backend recompilado (`npm run build:backend`) si se modificó `py/`;
- documentación y memoria de proyecto (`.zerochat/`) actualizadas.
