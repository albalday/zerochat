# Análisis: normas, agentes y auditorías de cambios

- Fecha: 2026-10-15
- Pregunta: por qué cada cambio de cierto tamaño produce una auditoría con unos 20 hallazgos (23 en [9.1.1-9.1.4], 19 en [`Audit-9.1.4-9.1.5.md`](./Audit-9.1.4-9.1.5.md)). ¿Fallan las normas y los agentes, o las auditorías son exageradas?
- Fuentes: [`AGENTS.md`](../../AGENTS.md), [`js/README.md`](../../js/README.md), [`AuditFull.md`](./AuditFull.md), las dos auditorías de cambios, `.zerochat/plan.md` (M4-T4 a M4-T24) y `.zerochat/log.md` (M4-D4 a M4-D10).

[9.1.1-9.1.4]: retirada en `cb9ccf1`; consultar con `git show cb9ccf1^:docs/audits/Audit-9.1.1-9.1.4.md`.

## Conclusión

Las dos cosas son ciertas, pero pesa más el proceso de auditoría que la calidad del código. La propia auditoría 9.1.4-9.1.5 lo reconoce: aplicar F-01 a F-18 ahorra unas 50–70 líneas (~5 %) y «el código no está inflado».

Clasificación de los 19 hallazgos de 9.1.4-9.1.5 por impacto real:

| Grupo | Hallazgos | Valor |
| --- | --- | --- |
| Sustanciales | F-01 (pérdida silenciosa de filas), F-19 (924 KB de ExcelJS), F-10 (doble recorrido de hasta 50 MB) y, en menor medida, F-13, F-03 | Real |
| Pulido legítimo pero menor | F-04, F-08, F-09, F-12, F-16 | Bajo |
| Ruido | F-05, F-06, F-07, F-11, F-14, F-15 (la auditoría dice «no sobra código»), F-17, F-18 (un JSON leído 78 veces en un script de build) | ~0 |

F-19 no es un defecto del código: se debe al cambio de plan posterior de M13 (`4a64f7f`), que retiró el motivo por el que se eligió ExcelJS (M4-D6).

## Qué falla en las normas y en el flujo de los agentes

### N-1 Normas contradictorias entre sí

[`AGENTS.md`](../../AGENTS.md) §1 exige «limitarse a lo solicitado» y prohíbe refactorizar «sin justificación concreta». Al ampliar un módulo, el agente añade en lugar de unificar: por ejemplo, una tercera comprobación de «¿es PDF?» en `web-browser.js` (F-13). Después, la auditoría lo penaliza como duplicación.

Lo mismo pasa con «no exportar funciones exclusivamente para ser probadas» (§2): la prueba de vendor reimplementa la convención de nombres de los bundles en vez de importarla (F-16).

### N-2 Sin paso de revisión entre escribir y cerrar la tarea

§8 pide no dejar código «sin uso, duplicado ni de compatibilidad previa», pero no define cómo comprobarlo. `task.py done` solo exige pruebas en verde. Una norma sin un paso que la verifique se incumple de forma sistemática.

Ritmo observado: M4-T4 a M4-T13 (10 tareas), dos auditorías y sus correcciones llevan todas la fecha 2026-10-15. Ningún diff de tarea se revisa antes de pasar a la siguiente.

### N-3 Sin norma de «buscar antes de escribir»

- F-11: el comentario del propio código reconoce que `IMAGE_MIME_TYPES` repite la lista de `ChatUtils`.
- F-16: M4-D5 afirma «no second registry», pero la convención está en tres sitios.

El agente sabía que duplicaba y ninguna norma le obligaba a importar en lugar de copiar.

### N-4 Tareas demasiado grandes

M4-T7 es un módulo de 691 líneas con 7 formatos en una sola tarea. El agente escribe un formato tras otro y copia de pptx a ODF (F-07, F-08, F-09). Faltaba una tarea previa para diseñar la base común.

### N-5 Los topes no exigen prueba en el límite

F-01, el único fallo grave, aparece justo en un tope (500 filas). §5 pide pruebas de «todo cambio de comportamiento», pero no de los límites ni del aviso de truncado. `AuditFull.md` revisa los límites, pero solo en auditorías completas.

### N-6 Dependencias elegidas para hitos no confirmados

ExcelJS se eligió porque M13 iba a escribir libros xlsx (M4-D6). Al cambiar el plan, quedan 924 KB y 69 avisos de licencia sin justificación (F-19).

### N-7 Desequilibrio en AGENTS.md

Unas 30 de las 143 líneas describen la memoria del proyecto, mientras que el diseño del código ocupa 7 viñetas en §2. Faltan reglas de reutilización, de fuente única de verdad y contra el código especulativo (F-06, F-17).

## Qué falla en las auditorías

### A-1 Sin procedimiento para auditar cambios

[`AuditFull.md`](./AuditFull.md) está pensado para versiones mayores. La auditoría de cambios se improvisa con áreas abiertas («fallos, duplicación, código muerto, rendimiento») y sin umbral de importancia, así que recoge todo lo que encuentra.

### A-2 No se aplica la regla de extracción de AuditFull.md

`AuditFull.md` dice: «extraer una utilidad compartida únicamente cuando existan al menos dos o tres casos con el mismo contrato estable». F-05, F-07 y F-14 no la cumplen.

### A-3 Sin salida «no hacer nada»

Cada hallazgo se convierte en tarea (M4-T16 a M4-T19, M4-T21 a M4-T24). Las correcciones generan código nuevo que la siguiente auditoría vuelve a revisar: es un ciclo que se alimenta solo.

### A-4 Sesgo del auditor

Un modelo al que se le pide auditar tiende a llenar la tabla. Nada le obliga a justificar el coste frente al beneficio ni limita el número de hallazgos.

### Qué conviene conservar

- La reproducción concreta en los fallos (F-01).
- La valoración global y el cálculo de ahorro.
- La sección «Normas sin prueba que las proteja».

## Propuestas de mejora

### En AGENTS.md

1. **Resolver la contradicción de §1:** se permite, dentro de la misma tarea, el refactor local mínimo necesario para no duplicar una decisión existente (un tipo, una lista, una convención).
2. **Buscar antes de escribir:** antes de crear una constante, tabla o utilidad, buscar si ya existe. Si un comentario dice «debe coincidir con X», se importa X.
3. **Una sola fuente por decisión:** tablas de formatos y convenciones de nombres en un único sitio. Las pruebas importan esa fuente y no la reimplementan.
4. **Topes con prueba en el límite:** todo límite (filas, tamaño, número de elementos) lleva una prueba justo en el borde y otra que compruebe que se avisa de lo descartado.
5. **Nada especulativo:** ni ramas ni opciones sin un consumidor actual. Una dependencia se justifica por su uso actual, no por hitos sin confirmar.
6. **Revisión del diff antes de `task.py done`**, con esta lista:
   - ramas sin uso;
   - literal repetido 3 o más veces;
   - misma decisión en 2 o más sitios;
   - topes con prueba;
   - comprobaciones simétricas entre variantes hermanas (pptx y ODF).

   Se puede apoyar en `/simplify` o `/code-review low` sobre el diff de la tarea.

### En el plan

7. Tareas de unas 300 líneas de código como máximo. En módulos con varias variantes, primero una tarea para la base común y después una por variante.

### En las auditorías

8. **Crear `docs/audits/AuditChange.md`** con un umbral de importancia. Un hallazgo solo se registra si cumple una de estas condiciones:
   - es un fallo;
   - supone un riesgo de seguridad o estabilidad;
   - es una decisión duplicada en 3 o más sitios;
   - ahorra más de unas 10 líneas;
   - complica una tarea ya planificada.

   El resto va a una lista de «Observaciones menores», sin tareas, que se aplica cuando se vuelva a tocar el archivo. Como máximo unos 10 hallazgos por auditoría.
9. **Cada hallazgo indica qué norma se incumplió o qué norma falta.** Los hallazgos recurrentes se convierten en norma de AGENTS.md o en prueba de arquitectura, para que la auditoría corrija el proceso y no solo el código.

### Para la auditoría 9.1.4-9.1.5

10. Abordar F-01, F-19 y F-10, y opcionalmente F-13, F-03 y F-16. El resto pasa a observaciones menores, y M4-T22 a M4-T24 se fusionan o se descartan.
