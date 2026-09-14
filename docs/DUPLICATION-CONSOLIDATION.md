# Consolidación posterior a la extracción de módulos

## Situación revisada

Base: `c99c731`, rama `dev`. Antigravity extrajo compositor, perfiles, shell,
transferencias, reset, conversaciones, vista y controlador de generación.
`app.js` conserva integración, callbacks y fallbacks; el motor aún presenta DOM.
Este trabajo adapta `dupli.md` a esa situación y no completa ni rehace la
refactorización de arquitectura. La suite inicial pasa: 547 pruebas.

## Fases y puntos de retorno

Cada fase termina con build, suite completa, pruebas de navegador cuando
corresponda y commit/push a `dev`. Se preservan los cambios locales ajenos.

1. **Reglas de turnos:** `message-turns.js` concentra identificación de IDs,
   reconocimiento de mensajes iniciales de fecha y eliminación/saneamiento.
   Estado, motor, servicio y vista lo reutilizan. Se conservan las APIs públicas,
   el predicado de `State.removeTurn` y su bloqueo durante generación.
2. **Consultas y configuración:** centralizar lectura de modelos completados en
   WebLLM y retirar configuración de respaldo duplicada en el arranque.
3. **Presentación común:** compartir copia, errores de conexión y bloques de
   respuestas sin igualar los ciclos de historial y streaming.

## Diferencias conservadas deliberadamente

La inferencia del ID base en `State.removeTurn` usa la convención histórica de
los dos primeros segmentos; el motor elimina sufijos de turnos. Ambas fachadas
normalizan su selección antes de llamar al algoritmo común. Cambiar esa política
sería un cambio de comportamiento, no una deduplicación.

Se conserva asimismo la asociación histórica de resultados de herramientas con
el asistente inmediatamente anterior y su fallback por nombre. Revisar esa
política para grupos con varios resultados consecutivos requiere un cambio
funcional específico; no se altera durante esta consolidación.

## Validación de fase 1

Build correcto; `npm test`: 550 pruebas aprobadas; suite de navegador aprobada.
Se añadieron pruebas de inmutabilidad, selección, compatibilidad de las fachadas
y bloqueo durante generación. Las comprobaciones que lanzan Chromium o procesos
requieren ejecución fuera del sandbox de este entorno.
