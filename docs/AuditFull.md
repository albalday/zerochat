# Auditoría completa de código

Esta auditoría es un procedimiento de mantenimiento preventivo para preservar la
estabilidad, la coherencia arquitectónica y la capacidad de evolución de ZeroChat.

## Cuándo ejecutarla

Debe ejecutarse y documentarse antes de cualquier incremento de versión mayor
(`X.0.0`). También puede solicitarse explícitamente con la instrucción:

> Ejecuta la auditoría completa definida en `docs/AuditFull.md`.

No sustituye las validaciones ordinarias de un cambio. Su objetivo es revisar el
proyecto completo y producir un plan de corrección verificable; no autoriza por
sí sola refactorizaciones amplias ni cambios no relacionados.

## Línea base

Antes de analizar código, registrar el estado de partida:

```bash
npm test
npm run test:browser
npm run build
git status --short
```

Anotar los fallos, avisos de consola, archivos modificados previamente y cualquier
limitación del entorno. No atribuir a la auditoría cambios ajenos que ya estuvieran
en el árbol de trabajo.

## Áreas de revisión

### Código muerto

Buscar y confirmar con referencias estáticas y dinámicas:

- módulos, funciones, ramas, flags y compatibilidades sin uso;
- claves de `ChatI18n`, iconos, selectores HTML y reglas CSS sin consumidores;
- adaptadores o herramientas no registrados;
- listeners, temporizadores, workers o recursos que no se limpien.

Una referencia dinámica, una API pública o una carga desde `index.html` impide
considerar un elemento como muerto hasta demostrar lo contrario. Cada eliminación
debe incluir búsqueda global, prueba pertinente y regeneración del bundle.

### Duplicación

Identificar duplicación por comportamiento y contrato, no solo por texto. Dar
prioridad a cancelación, limpieza de recursos, manejo de errores, progreso,
validación, persistencia y ciclo de vida de listeners.

Extraer una utilidad compartida únicamente cuando existan al menos dos o tres
casos con el mismo contrato estable. Mantener la lógica local cuando la semejanza
sea accidental o todavía esté evolucionando.

### Infraestructura obligatoria

Comprobar que el código respeta estas fronteras:

| Área | Regla |
| --- | --- |
| Estado compartido | Solo `ChatState` y sus mutadores de dominio |
| Diálogos | Solo `ChatDialogs`; nunca APIs nativas |
| Texto de interfaz | Claves simultáneas en español e inglés mediante `ChatI18n` |
| Proveedores | Extensión de `BaseProviderAdapter` |
| Persistencia y adjuntos | `ZeroChatDB` y sus APIs correspondientes |
| Herramientas | Contrato declarativo actual, sin propiedades obsoletas |
| Iconos | `ChatIcons` o SVG; sin emojis en controles |
| Operaciones cancelables | `AbortSignal`, limpieza explícita y pruebas |

Cuando sea posible, convertir los hallazgos recurrentes en pruebas de arquitectura
que impidan reintroducir la infracción.

### Límite de contenido externo y HTML

Todo dato de red, proveedores, MCP, herramientas, documentos, configuración o
usuario es texto no confiable. Para presentarlo en la interfaz, usar las
primitivas de `ChatUtils` (`setText`, `clearElement` y `appendTextElement`) o
`textContent`; no interpolarlo en `innerHTML`.

`ChatUtils.setTrustedHtml` queda reservado a fragmentos producidos por el propio
código y revisados como SVG de `ChatIcons`. Markdown mantiene su sanitización
como frontera independiente. Cada superficie nueva que muestre datos externos
debe tener una prueba de inyección que compruebe que el payload se conserva como
texto y no crea nodos ni ejecuta atributos.

### Estabilidad y mantenibilidad

Revisar límites de tamaño y tiempo, errores explícitos, validación de entradas,
aislamiento de secretos, seguridad HTML, concurrencia, almacenamiento y recuperación
tras cancelación. Localizar dependencias implícitas entre módulos y documentar las
interfaces públicas que no puedan cambiarse sin migración.

## Entregable y priorización

Crear un informe con cada hallazgo y, como mínimo:

- evidencia: archivos y referencias afectadas;
- riesgo: seguridad, estabilidad, deuda técnica o presentación;
- alcance y alternativa propuesta;
- prueba que demuestra la corrección;
- prioridad: crítica, alta, media o baja.

Separar los arreglos en cambios pequeños e independientes. No mezclar limpieza,
nuevas funciones y refactorización general en un único cambio.

## Cierre de una auditoría mayor

Antes de aprobar una versión mayor, deben estar resueltos o aceptados explícitamente
los hallazgos críticos y altos. Ejecutar de nuevo:

```bash
npm test
npm run test:browser
npm run build
```

Confirmar que `zerochat.html` está actualizado, que no hay cambios inesperados y
que el informe refleja el estado final. La promoción a `master` sigue las reglas
de `AGENTS.md` y requiere el incremento de versión validado previamente en `dev`.
