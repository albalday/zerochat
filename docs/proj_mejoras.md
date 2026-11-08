# Propuestas de Mejora para el Sistema de Memoria y Planificación (`.zerochat`)

Este documento resume las recomendaciones para optimizar el mantenimiento de contexto y la gestión de memoria en proyectos que utilizan el protocolo `.zerochat` (como `zerochat` o `llama`).

---

## 1. Mantenimiento Periódico por Agentes (Housekeeping)

En lugar de añadir reglas rígidas o burocráticas a `AGENTS.md` (que consumen atención del modelo e introducen fricción continua), el enfoque más eficiente es programar **tareas periódicas de saneamiento** delegadas directamente a un agente cada 10–15 hitos (o cuando los archivos superen cierto umbral).

### Acciones del Mantenimiento Periódico

1. **Rotación y archivado de `log.md`**:
   - Cuando `log.md` supere las 150–200 entradas (~60–100 KB), mover las decisiones antiguas a bloques históricos en `.zerochat/archive/` (ej. `archive/log_M1-M39.md`).
   - Conservar en el `log.md` activo únicamente las decisiones de los hitos recientes (últimos 5 a 10 hitos).
2. **Compactación de hitos cerrados en `plan.md`**:
   - `plan.md` acumula decenas de líneas con títulos de hitos cerrados (`## Mn ...: closed YYYY-MM-DD`).
   - Mantener en `plan.md` solo los últimos 3–5 hitos cerrados como contexto inmediato.
   - Condensar los más antiguos en una sola línea de referencia:  
     `<!-- Hitos M1 a M45 archivados en .zerochat/archive/ -->`.
3. **Extracción de Invariantes Arquitectónicas**:
   - Durante la revisión, extraer en un archivo ligero (`.zerochat/invariants.md`, < 25 líneas) las reglas y límites de diseño vigentes que quedaron dispersos en decisiones pasadas (ej. límites de payload, flags obligatorios de entorno, configuraciones de VRAM validadas).  NO MEGUSTA. no es mejor en log.md resumido?

---

## 2. Nuevas Capacidades Recomendadas para `task.py`

Actualmente, [.zerochat/task.py](file:///home/alberto/vs/llama/.zerochat/task.py) cubre las operaciones atómicas de tareas (`done`, `add-task`, `next`, `status`), pero deja las operaciones de ciclo de vida del hito y de consulta a merced de ediciones manuales de markdown propensas a errores.

Se propone extender `task.py` con los siguientes subcomandos:

### A. `close-milestone <M_ID>`
Automatiza el cierre de un hito en un solo comando atómico:
- **Flujo ejecutado**:
  1. Extrae la sección completa del hito `M<n>` de `plan.md`.
  2. Crea el archivo `.zerochat/archive/M<n>.md` con dicho contenido.
  3. Sustituye la sección en `plan.md` por la cabecera condensada `## M<n> <Título>: closed YYYY-MM-DD`.
  4. Actualiza `state.md` limpiando el hito activo (`Milestone: none open` o marcando el siguiente).
- **Beneficio**: Elimina la fricción que provocaba que los hitos quedaran abiertos indefinidamente acumulando decenas de tareas (como ocurrió en M1).

### B. `new-milestone <M_ID> "Título" --goal "..." --done-when "..."`
Estandariza la apertura de nuevos hitos:
- **Flujo ejecutado**:
  1. Añade la estructura canónica en `plan.md` con sus secciones obligatorias `Goal:` y `Done when:`.
  2. Actualiza `state.md` fijando el nuevo hito y dejando `Next task: none pending` (o la primera tarea).
- **Beneficio**: Garantiza que ningún agente cree hitos sin metas o criterios de cierre claros y verificables.

### C. `search <query> [--archive]`
Búsqueda CLI optimizada para agentes:
- **Flujo ejecutado**:
  - Busca la coincidencia en `log.md` (o en `archive/` si se añade `--archive`).
  - Devuelve exclusivamente las líneas coincidentes y su ID de decisión.
- **Beneficio**: Evita que los agentes lean accidentalmente archivos completos de 100 KB para consultar una decisión pasada, ahorrando miles de tokens de contexto por turno.
