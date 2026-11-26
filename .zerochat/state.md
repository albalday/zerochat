# Current state
- Milestone: M97 Arreglos pequeños agentes
- Next task: M97-T4 Añadir la herramienta integrada update_plan(items: [{text, status}]) en js/tools/builtin/: cada llamada sustituye la lista entera del turno, sin estado en el servidor (no es un motor de planificación, §2.4); la descripción limita su uso a tareas de 3 o más pasos y a actualizar al cerrar cada paso; js/context-manager.js conserva siempre la última llamada a update_plan del turno frente a la poda intra-turno y el corte de exclusión (M89), sin inyectarla en el prompt de sistema para no invalidar la caché KV
- Last closed: M95 and M96 (2026-11-26)
- Last updated: 2026-11-26
