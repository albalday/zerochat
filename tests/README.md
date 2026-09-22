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

- **`unit/`**: comportamiento de un módulo aislado. Las dependencias externas se sustituyen por mocks ligeros o implementaciones en memoria.
- **`integration/`**: interacción entre varios módulos, estado compartido, servicios o flujos completos que no requieran un navegador real.
- **`browser/`**: comportamiento observable de la interfaz en Chromium headless: DOM, interacción, accesibilidad, temas y carga de la aplicación.
- **`architecture/`**: restricciones estáticas y contratos transversales que deben mantenerse independientemente de un flujo de usuario concreto.
- **`infrastructure/`**: herramientas que sustentan la ejecución y distribución local, como el runner, el servidor de pruebas, la versión y los recursos de proveedor construidos.
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
node --test tests/unit/test_icons.js
```

Para arrancar la aplicación localmente durante una comprobación manual, consulta las opciones de `zerochat.py` con `python3 zerochat.py --help`.

## 3. Grupos funcionales

Los grupos combinan suites de distintos niveles para acortar el ciclo de validación de un área. Los nombres disponibles son `turns`, `composer`, `generation`, `profiles`, `mcp`, `rag`, `providers` y `bundle`.

| Grupo | Área cubierta |
|---|---|
| `turns` | Turnos, estado de conversación y motor de chat. |
| `composer` | Entrada de usuario, adjuntos y composición de mensajes. |
| `generation` | Generación, streaming y estado visible de inferencia. |
| `profiles` | Perfiles, persistencia y su interfaz. |
| `mcp` | Cliente MCP, herramientas y configuración asociada. |
| `rag` | Ingesta, índice, almacenamiento y experiencia RAG. |
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

Los grupos funcionales son una selección explícita, no un descubrimiento automático. Si un nuevo test representa un flujo clave de uno de ellos, actualiza `GROUPS` en `scripts/test-runner.mjs` y la prueba de infraestructura que comprueba sus nombres. Evita incluir rutas inexistentes: el listado del grupo debe ser la comprobación final.

Los cambios en el runner requieren actualizar esta guía solo si cambian sus comandos públicos, niveles, criterios de descubrimiento o grupos disponibles.

## 6. Cómo añadir nuevas pruebas

1. Selecciona el nivel adecuado según la sección 1.
2. Crea el archivo con el patrón `test_<área>.js` o `<área>.test.js` dentro del nivel elegido.
3. Aísla efectos compartidos en `beforeEach` y `afterEach`; restaura mocks, temporizadores y estado global al terminar cada caso.
4. Para pruebas de navegador, usa los helpers de `tests/helpers/` y garantiza el cierre de páginas y contextos en `finally`.
5. Añade la suite a un grupo funcional solo cuando forme parte de su flujo representativo.
6. Ejecuta primero el nivel afectado y, cuando proceda, el grupo funcional y las validaciones exigidas por `AGENTS.md`.

## 7. Validación obligatoria

Las reglas que determinan qué validación corresponde a cada cambio están en `AGENTS.md` y prevalecen sobre esta guía. En particular, los cambios de HTML, CSS o DOM requieren `npm run test:browser`; los cambios de contratos, infraestructura o integración deben ejecutar su nivel correspondiente.

Antes de dar por terminado un cambio, aplica la validación proporcional indicada en `AGENTS.md`. No existe un bundle de la aplicación web que regenerar: se sirve estáticamente desde `zerochat.html`, `css/` y `js/`. `npm run build` construye únicamente recursos de proveedor cuando esa parte se haya modificado.
