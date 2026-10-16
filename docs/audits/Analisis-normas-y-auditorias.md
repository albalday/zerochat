# Análisis: normas, agentes y auditorías de cambios

- Fecha: 2026-10-15
- Pregunta: ¿por qué cada cambio grande genera ~20 hallazgos (23 en [9.1.1-9.1.4], 19 en [9.1.4-9.1.5])? ¿Fallan las normas y los agentes, o las auditorías son exageradas?
- Fuentes: [`AGENTS.md`](../../AGENTS.md), [`js/README.md`](../../js/README.md), [`AuditFull.md`](./AuditFull.md), `.zerochat/plan.md` (M4) y `.zerochat/log.md` (M4-D4 a M4-D10).

[9.1.1-9.1.4]: retirada en `cb9ccf1` (`git show cb9ccf1^:docs/audits/Audit-9.1.1-9.1.4.md`).
[9.1.4-9.1.5]: retirada en `c20cab8` (`git show c20cab8^:docs/audits/Audit-9.1.4-9.1.5.md`).

## 1. Diagnóstico general

Pesa más el proceso de auditoría que la calidad del código. En 9.1.4-9.1.5, resolver F-01 a F-18 apenas redujo ~5 % de líneas y la propia auditoría concluía que «el código no está inflado»:

| Impacto real | Hallazgos (9.1.4-9.1.5) | Lectura |
| --- | --- | --- |
| **Sustancial (5)** | F-01 (pérdida de filas en el tope de 500), F-10 (doble recorrido de 50 MB), F-19 (924 KB de ExcelJS tras cambiar M13), F-03, F-13 | Fallos reales de borde, rendimiento o cambio de alcance |
| **Pulido menor (5)** | F-04, F-08, F-09, F-12, F-16 | Mejoras legítimas pero de bajo retorno |
| **Ruido (9)** | F-05, F-06, F-07, F-11, F-14, F-15, F-17, F-18 | Micro-optimizaciones o extracciones prematuras (~0 valor) |

## 2. Qué falla en las normas (`AGENTS.md`) y en el flujo

1. **Freno al refactor local de unificación (§1 y §2):** Prohibir refactorizar «sin justificación concreta» y «exportar funciones para pruebas» empuja al agente a copiar listas, predicados o convenciones en vez de reutilizar o importar una fuente única (F-11, F-13, F-16).
2. **Falta de reglas explícitas de diseño (§2):** No se exige buscar constantes/utilidades existentes antes de crear otra, mantener una única fuente por decisión ni evitar código o dependencias especulativas para hitos futuros no confirmados (F-06, F-17, F-19).
3. **Topes sin prueba de borde (§5):** Se exige probar cambios de comportamiento, pero no el valor exacto del límite (`N`, `N+1`) ni el aviso de truncado (causa de F-01).
4. **Cierre de tarea sin revisión del diff (§8):** `task.py done` solo verifica tests en verde. Sin una lista de comprobación previa al cierre, se encadenan tareas grandes (ej. M4-T7 con 7 formatos y 691 líneas) arrastrando duplicación entre variantes hermanas (F-07 a F-09).

## 3. Qué falla en las auditorías de cambios

1. **Sin procedimiento ni umbral para cambios acotados:** [`AuditFull.md`](./AuditFull.md) está diseñado para versiones mayores (`X.0.0`). Al auditar un rango de commits sin filtro de severidad ni tope de hallazgos, el auditor rellena la tabla con detalles menores.
2. **Ignora la regla de extracción de `AuditFull.md`:** Se piden utilidades compartidas sin que existan «dos o tres casos con el mismo contrato estable» (F-05, F-07, F-14).
3. **Todo hallazgo se vuelve tarea:** Sin categoría de «observación menor / no hacer nada», las micro-correcciones generan commits que alimentan la siguiente auditoría.

## 4. Acciones propuestas

- **En [`AGENTS.md`](../../AGENTS.md):**
  - **§1 / Planificación:** Limitar el tamaño de las tareas (~300 líneas máx.); en módulos con varias variantes, separar una tarea previa para la base común. No elegir dependencias ni añadir opciones por hitos futuros no confirmados.
  - **§2 Calidad:** Permitir el refactor local mínimo para no duplicar una decisión; obligar a buscar antes de crear y a mantener una sola fuente de verdad (importada también por los tests).
  - **§5 Pruebas:** Exigir prueba en el límite exacto y del aviso de descarte para todo tope (filas, bytes, elementos).
  - **§8 Finalización:** Incluir una verificación rápida del `git diff` antes de `task.py done` (sin ramas muertas, sin decisiones duplicadas, simetría entre variantes y topes probados).
- **En [`tests/README.md`](../../tests/README.md) y [`AuditFull.md`](./AuditFull.md):**
  - Reflejar en `tests/README.md` (§6) las pruebas de borde en límites (`N` y `N+1`) y la importación de fuentes de verdad.
  - Definir en `AuditFull.md` los criterios de **auditoría acotada de cambios**: máximo ~10 hallazgos accionables que sean fallos, riesgos de seguridad/rendimiento, duplicación en ≥3 sitios o ahorro >10 líneas; vincular cada hallazgo a la norma incumplida o ausente; relegar el resto a observaciones sin tarea.

