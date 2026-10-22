# Guía y arquitectura de pruebas de ZeroChat

ZeroChat utiliza el ejecutor nativo `node:test` y Playwright para las pruebas de navegador. La suite se organiza por nivel de responsabilidad y se ejecuta mediante `scripts/test-runner.mjs`.

El runner es la fuente de verdad para los archivos descubiertos y para los grupos funcionales. Para consultar el inventario actual sin depender de esta guía, usa sus opciones `--list`.

## 1. Estructura de directorios

```text
tests/
├── unit/             # Pruebas de módulos aislados
├── integration/      # Pruebas de colaboración entre módulos
├── browser/          # Pruebas de interfaz en Chromium con Playwright
├── architecture/     # Contratos estáticos y de arquitectura
├── infrastructure/   # Runner, servidor local, empaquetado de dependencias y versión
└── helpers/          # Utilidades compartidas, no descubiertas como tests
```

### Criterios por nivel

- **`unit/`**: comportamiento de un módulo aislado. Las dependencias externas se sustituyen por implementaciones en memoria: el almacenamiento lo aporta `storage-env.js` y las vistas del turno, `tests/helpers/turn-view.js`. No hay DOM: lo que pinta o lee elementos se prueba en `browser/`, nunca con objetos que imiten elementos.
- **`integration/`**: interacción entre varios módulos, estado compartido, servicios o flujos completos que no requieran un navegador real.
- **`browser/`**: flujos de usuario en Chromium headless que cumplen los criterios de la sección 6, no cada render. `browser_startup.test.js` contiene la prueba de humo que cubre el arranque.
- **`architecture/`**: restricciones estáticas y contratos transversales que deben mantenerse independientemente de un flujo de usuario concreto.
- **`infrastructure/`**: el backend `zerochat.py` (servidor local, procesos, MCP), el cambio de versión y los recursos de proveedor construidos.
- **`helpers/`**: código reutilizable de apoyo. No se ejecuta directamente como parte de la suite.

## 2. Comandos de ejecución

| Comando | Descripción |
|---|---|
| `npm test` | Ejecuta todos los niveles de prueba. |
| `npm run test:all` | Ejecuta toda la suite mediante el runner. |
| `npm run test:changed` | Selecciona pruebas según los archivos modificados detectados por Git. |
| `npm run test:unit` | Ejecuta `tests/unit/`. |
| `npm run test:integration` | Ejecuta `tests/integration/`. |
| `npm run test:browser` | Ejecuta `tests/browser/` con Playwright. |
| `npm run test:architecture` | Ejecuta `tests/architecture/`. |
| `npm run test:infrastructure` | Ejecuta `tests/infrastructure/`. |
| `npm run test:group -- <grupo>` | Ejecuta un grupo funcional definido por el runner. |

El runner admite comandos de inspección que no se quedan obsoletos al añadir o retirar suites:

```bash
# Archivos que se ejecutarían en toda la suite o en un nivel
node scripts/test-runner.mjs --list
node scripts/test-runner.mjs --level=unit --list

# Archivos impactados por el árbol de trabajo actual
node scripts/test-runner.mjs --changed --list

# Grupos disponibles y su contenido efectivo
node scripts/test-runner.mjs --group=composer --list

# Ejecutar una suite concreta
node scripts/test-runner.mjs tests/unit/test_icons.js
```

El runner carga `tests/helpers/storage-env.js` en cada proceso de prueba: IndexedDB simulado con `fake-indexeddb` y `localStorage`/`sessionStorage` en memoria. Los módulos usan así las mismas APIs que en el navegador, sin respaldos propios; para lanzar una suite con `node --test` directamente, añade `--require ./tests/helpers/storage-env.js`.

Para arrancar la aplicación localmente durante una comprobación manual, consulta las opciones de `zerochat.py` con `python3 zerochat.py --help`.

## 3. Grupos funcionales

Los grupos combinan suites de distintos niveles para acortar el ciclo de validación de un área. Los nombres disponibles son `turns`, `composer`, `generation`, `profiles`, `mcp`, `rag`, `project`, `providers` y `bundle`.

| Grupo | Área cubierta |
|---|---|
| `turns` | Turnos, estado de conversación y motor de chat. |
| `composer` | Entrada de usuario, adjuntos y composición de mensajes. |
| `generation` | Generación, streaming y estado visible de inferencia. |
| `profiles` | Perfiles, persistencia y su interfaz. |
| `mcp` | Cliente MCP, herramientas y configuración asociada. |
| `rag` | Ingesta, índice, almacenamiento y experiencia RAG. |
| `project` | Modo proyecto: detección, estados, inyección e inicialización. |
| `providers` | Adaptadores y consultas de modelos. |
| `bundle` | Arranque y recursos necesarios para la aplicación distribuida. |

La lista exacta de archivos de cada grupo se mantiene exclusivamente en `GROUPS` dentro de `scripts/test-runner.mjs`; compruébala con `npm run test:group -- <grupo> --list`.

## 4. Inventario de suites

No se mantiene aquí una lista manual de archivos ni un número fijo de suites: ambas cosas cambian con frecuencia y el runner las descubre automáticamente. Para obtener el inventario actual, ejecuta:

```bash
node scripts/test-runner.mjs --list
node scripts/test-runner.mjs --level=browser --list
```

La responsabilidad de cada nivel está definida en la sección 1. Cada archivo de prueba debe expresar en su nombre y casos el flujo o módulo que protege; los casos de seguridad deben permanecer junto al subsistema que validan, salvo los contratos arquitectónicos transversales.

## 5. Mantenimiento de la suite

Al crear, mover o eliminar una suite, el runner la descubre si el archivo está bajo uno de los niveles anteriores y usa el patrón `test_*.js` o `*.test.js`. Después de cualquier cambio de estructura, confirma el resultado con `--list`.

Los grupos funcionales son una selección explícita, no un descubrimiento automático. Si un nuevo test representa un flujo clave de uno de ellos, actualiza `GROUPS` en `scripts/test-runner.mjs`. Evita incluir rutas inexistentes: el listado del grupo debe ser la comprobación final.

Los cambios en el runner requieren actualizar esta guía solo si cambian sus comandos públicos, niveles, criterios de descubrimiento o grupos disponibles.

## 6. Cómo añadir nuevas pruebas

1. Selecciona el nivel adecuado según la sección 1.
2. Crea el archivo con el patrón `test_<área>.js` o `<área>.test.js` dentro del nivel elegido.
3. Aísla efectos compartidos en `beforeEach` y `afterEach`; restaura mocks, temporizadores y estado global al terminar cada caso.
4. Para pruebas de navegador, usa los helpers de `tests/helpers/browser-env.js` (como `withTestApp`, que gestiona contexto, arranque y cierre automático) y garantiza el cierre de páginas y contextos en `finally`. Espera a la aplicación con `waitForAppReady(page)` (no solo a `zerochat-ready`, que se marca antes de cargar la sesión) y nunca con esperas fijas.
5. Para pruebas que arrancan `zerochat.py`, usa `tests/helpers/backend-env.js`: `freePort()` para el puerto, `tokenDataDir()` para el token y `waitForServer()` para el arranque. Los comportamientos que comparten la misma configuración de arranque (misma CLI, mismo entorno) se prueban en un único proceso compartido, nunca con un spawn por comprobación; solo se arranca otro proceso cuando difieren los flags, el entorno o el ciclo de vida.
6. Para topes que protegen memoria, contexto o seguridad (filas, tamaño, elementos, tiempo), incluye en la prueba de tabla del módulo el borde exacto (`N` y `N+1`) y comprueba el aviso o marcador de truncado. Importa las listas de formatos, constantes o convenciones desde el módulo o manifiesto de origen en lugar de reimplementarlas en el test.
7. Añade la suite a un grupo funcional solo cuando forme parte de su flujo representativo.
8. Ejecuta primero el nivel afectado y, cuando proceda, el grupo funcional y las validaciones exigidas por `AGENTS.md`.

### Qué merece una prueba

Antes de escribir una prueba, clasifícala. Solo se escriben las de la columna «conservar»; las de la otra columna no se escriben ni se apartan en una categoría sin ejecutar: se borran.

| Conservar | No escribir |
|---|---|
| **S** Seguridad: escape, SSRF, sandbox, permisos, token, rutas | **A** Lo cubre el arranque: un fallo se nota al abrir la aplicación o enviar un mensaje |
| **L** Lógica no trivial con ramas o bordes que no se ven al usar la aplicación (parsers, SSE, presupuesto de contexto, bucles, ranking) | **T** Trivial: getters, formateadores de pocas líneas, constantes, valores por defecto, textos de prompt, existencia de métodos |
| **D** Integridad de datos: persistencia, migraciones, borrados en cascada, cifrado | **C** Cosmética: colores, contornos, alineación o anchos sin consecuencia funcional |
| **X** Contrato externo: formato de proveedores, MCP, paridad JS-Python, `task.py` | **Z** Ausencia de algo ya retirado |
| **R** Regresión de un fallo real que costó encontrar | **M** Prueba del mock: la aserción comprueba lo que devuelve la simulación |
| | **2** Duplicado: el comportamiento ya se prueba en otro nivel; queda solo en el más bajo que lo observa |

Además:
- Un caso más de una función ya probada es una fila o aserción de su prueba existente, no una prueba nueva.
- Las funciones reexportadas por fachadas se prueban una vez, en su módulo de origen.
- No se añade a producción código que la aplicación no ejecuta: funciones, parámetros u opciones que nadie pasa, inyecciones de dependencias o ramas para objetos falsos. Las pruebas usan los módulos reales y sustituyen solo métodos de sus objetos con `mock.method` (restaurados en `afterEach`) y la plataforma con `storage-env.js`; para vaciar la base de conocimiento usan `tests/helpers/rag-data.js`. Se puede exportar una pieza que la aplicación ejecuta para probarla aislada; `test_code_hygiene.js` rechaza funciones y clases que la aplicación no ejecuta.
- Lo que solo lee ficheros sin ejecutar nada no va en `browser/`, sino en `architecture/` o `unit/`.
- Las esperas reales a temporizadores se sustituyen por `t.mock.timers`.

## 7. Validación obligatoria

Las reglas que determinan qué validación corresponde a cada cambio están en `AGENTS.md` y prevalecen sobre esta guía. En particular, los cambios de HTML, CSS o DOM requieren `npm run test:browser`; los cambios de contratos, infraestructura o integración deben ejecutar su nivel correspondiente.

Antes de dar por terminado un cambio, aplica la validación proporcional indicada en `AGENTS.md`. No existe un bundle de la aplicación web que regenerar: se sirve estáticamente desde `zerochat.html`, `css/` y `js/`. `npm run build` construye únicamente recursos de proveedor cuando esa parte se haya modificado.
