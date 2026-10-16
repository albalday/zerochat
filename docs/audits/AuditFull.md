# Auditoría completa de código

Esta auditoría es un procedimiento de mantenimiento preventivo para preservar la
estabilidad, la coherencia arquitectónica y la capacidad de evolución de ZeroChat.

## Cuándo ejecutarla

Debe ejecutarse y documentarse antes de cualquier incremento de versión mayor
(`X.0.0`). También puede solicitarse explícitamente con la instrucción:

> Ejecuta la auditoría completa definida en `docs/audits/AuditFull.md`.

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

### Código muerto y especulativo

Buscar y confirmar con referencias estáticas y dinámicas:

- módulos, funciones, ramas, opciones o parámetros sin consumidor actual;
- código de compatibilidad previa (alias, migraciones, formatos antiguos);
- claves de `ChatI18n`, iconos, selectores HTML, reglas CSS y pruebas huérfanos;
- adaptadores o herramientas no registrados;
- listeners, temporizadores, workers o recursos que no se limpien.

Una referencia dinámica, una API pública o una carga desde `zerochat.html` impide
considerar un elemento como muerto hasta demostrar lo contrario. Cada eliminación
debe incluir búsqueda global y prueba pertinente.

### Duplicación

Distinguir dos casos:

- **Decisiones:** tablas de tipos o formatos, predicados de dominio, constantes y
  convenciones de nombres deben tener una única fuente (`AGENTS.md` §2). Repetirlas
  en 2 o más sitios, incluidas pruebas que las reimplementan, es un hallazgo.
- **Comportamiento:** cancelación, limpieza de recursos, errores, progreso,
  validación, persistencia y listeners. Extraer una utilidad compartida solo con
  3 o más consumidores con el mismo contrato estable (o 2 si ya han divergido);
  mantener la lógica local cuando la semejanza sea accidental o esté evolucionando.

Revisar también que las variantes hermanas de un mismo módulo apliquen las mismas
comprobaciones y límites.

### Fronteras de arquitectura y seguridad

Comprobar las fronteras de `AGENTS.md` §3 y §4, y además que las operaciones
cancelables usen `AbortSignal`, limpieza explícita y pruebas. Cuando sea posible,
convertir los hallazgos recurrentes en pruebas de `tests/architecture/`.

Todo dato de red, proveedores, MCP, herramientas, documentos, configuración o
usuario es texto no confiable: se presenta con `textContent` o las primitivas de
`ChatUtils` (`setText`, `clearElement`, `appendTextElement`), nunca interpolado en
`innerHTML`. `ChatUtils.setTrustedHtml` queda reservado a fragmentos propios
revisados (SVG de `ChatIcons`) dentro de la lista de `test_html_sinks.js`, y
Markdown mantiene su sanitización como frontera independiente. Cada superficie
nueva que muestre datos externos debe tener una prueba de inyección que compruebe
que el payload se conserva como texto y no crea nodos ni ejecuta atributos.

### Estabilidad y mantenibilidad

Revisar límites de tamaño y tiempo, errores explícitos, validación de entradas,
aislamiento de secretos, concurrencia, almacenamiento y recuperación tras
cancelación. Todo tope debe tener prueba en el borde exacto (`N` y `N+1`) y en su
aviso de truncado (`AGENTS.md` §5). Localizar dependencias implícitas entre módulos.

### Normas y pruebas

Cada norma de `AGENTS.md` se contrasta con la prueba que falla al infringirla. Una norma
solo se da por cumplida si existe esa prueba; si no, se indica si se ha comprobado con un
comando, con la lectura del código o no se ha comprobado. Las normas sin prueba se registran
como hallazgos, con la prueba que las protegería. Una norma nueva se añade con su prueba en
el mismo cambio.

## Entregable y priorización

El resultado son cuatro revisiones bilingües publicadas en la ayuda, escritas desde cero
y no como actualización de las anteriores: `help/audit-infrastructure.html` (infraestructura
y normas), `help/audit-functionalities.html` (funcionalidades), `help/audit-comparison.html`
(comparativa) y `help/audit-history.html` (historial), con sus versiones en `help/en/`.
No se crean informes en Markdown.

Cada hallazgo incluye, como mínimo:

- evidencia: archivos y referencias afectadas;
- norma de `AGENTS.md` o README de subsistema incumplida, o la norma o prueba de
  arquitectura que falta para evitar su recurrencia;
- riesgo: seguridad, estabilidad, deuda técnica o presentación;
- alcance y alternativa propuesta;
- prueba que demuestra la corrección;
- prioridad: crítica, alta, media o baja.

Los arreglos se planifican como tareas acotadas de `.zerochat/plan.md` (~300 líneas
como máximo; una tarea previa para la base compartida si afecta a varias variantes).
No mezclar limpieza, nuevas funciones y refactorización general en una misma tarea.

## Cierre de una auditoría mayor

Antes de aprobar una versión mayor, deben estar resueltos o aceptados explícitamente
los hallazgos críticos y altos. Ejecutar de nuevo:

```bash
npm test
npm run test:browser
npm run build
```

Confirmar que los archivos generados (`zerochat.py`, `py/dd-managed-services.py` y
`js/vendor/orama.browser.js`) están sincronizados, que no hay cambios inesperados y
que el informe refleja el estado final. La promoción a `master` sigue las reglas
de `AGENTS.md` y requiere el incremento de versión validado previamente en `dev`.

## Auditoría acotada de cambios (entre versiones menores o hitos)

Cuando se audite un rango de commits o un hito en lugar del proyecto completo, se
revisa su `git diff` con las áreas anteriores y la lista de `AGENTS.md` §8. Los
hallazgos se registran como tareas en `.zerochat/plan.md`, no en la ayuda.

1. **Umbral (máx. ~10 hallazgos accionables):** un hallazgo solo se numera (`F-XX`)
   y genera tarea si cumple al menos una condición:
   - es un fallo reproducible o una pérdida silenciosa de datos (con caso de reproducción);
   - supone un riesgo de seguridad o estabilidad, o un impacto medible en rendimiento o memoria;
   - incumple una norma de `AGENTS.md` (decisión duplicada, código especulativo,
     tope sin prueba de borde, variantes hermanas asimétricas…);
   - ahorra más de ~10 líneas netas sin acoplar módulos independientes, o desbloquea
     una tarea ya planificada.
2. **Observaciones menores (sin tarea):** lo que quede por debajo del umbral
   (micro-optimizaciones, extracciones de comportamiento con menos de 3 consumidores
   estables, retoques de estilo) se anota en un apartado «Observaciones menores» o se
   descarta si se concluye que el código no está inflado.
