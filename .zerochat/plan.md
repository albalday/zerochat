# Plan

<!-- Hitos M1 a M90 archivados en .zerochat/archive/ -->

## M91 Adjuntos en el MCP de correo: closed 2026-11-25

## M92 Acciones durante un turno en marcha: closed 2026-11-25

## M93 Correcciones del navegador de agentes: closed 2026-11-25

## M94 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-25: closed 2026-11-26

## M95 Auditoría 10.48.1: closed 2026-11-26

## M96 Esquema único de agentes (.md), controlador y subagentes: closed 2026-11-26

## M97 Arreglos pequeños agentes

Goal: Corregir pequeños desajustes de interfaz, textos y comportamiento en subagentes (`delegate_task`) y agentes, y añadir un plan del turno que el modelo mantiene, protegido de la poda de contexto y visible para el usuario (`update_plan`).
Done when: Las tareas abiertas de M97 quedan resueltas o evaluadas y descartadas con el usuario, con sus pruebas aplicables de `AGENTS.md` §4 en verde.
- [x] M97-T1 Revisar el texto y alcance del interruptor «Subagentes» en el panel de razonamiento (`agent_delegate_task_desc` en `js/i18n.js` ES/EN y `zerochat.html`): verificar con el usuario qué refleja mejor el comportamiento real de `delegate_task` (múltiples subagentes en paralelo dentro del turno, con o sin servidor local, y restricción actual a solo lectura frente a agentes `--run-file`) (2026-11-26)
- [ ] M97-T2 Evaluar hacer `delegate_task` asíncrona (pendiente de evaluación: analizar si aporta frente a las llamadas paralelas del mismo turno y frente a `launch_agent`/`check_agents`)
- [ ] M97-T3 Renombrar la sección de configuración «Agente» a «Herramientas» / «Tools» (zerochat.html, js/i18n.js ES/EN, help/ y referencias en UI/pruebas) porque solo activa/desactiva las herramientas del entorno del proyecto
- [ ] M97-T4 Añadir la herramienta integrada update_plan(items: [{text, status}]) en js/tools/builtin/: cada llamada sustituye la lista entera del turno, sin estado en el servidor (no es un motor de planificación, §2.4); la descripción limita su uso a tareas de 3 o más pasos y a actualizar al cerrar cada paso; js/context-manager.js conserva siempre la última llamada a update_plan del turno frente a la poda intra-turno y el corte de exclusión (M89), sin inyectarla en el prompt de sistema para no invalidar la caché KV
- [ ] M97-T5 Mostrar el plan vigente de update_plan como checklist fija encima del compositor (pendiente / en curso / hecho, ES/EN en js/i18n.js), también en ejecuciones en segundo plano y en el modo supervisión de la bandeja Agentes, y su tarjeta de herramienta compacta en el historial
- [ ] M97-T6 Servidor: el chat interactivo y su ejecución en segundo plano con «Subagentes» son controladores: check_agents, launch_agent, stop_agent y prune_agents se publican en el servidor de la interfaz (marcados como del controlador) con estado por conversación (zerochatConversationId), y zerochat/run/prompt devuelve subagents = controller
- [ ] M97-T7 Interfaz: «Subagentes» da las herramientas del controlador con el servidor local conectado y delegate_task solo sin él; Ajustes › Servidor local muestra su permiso sin interruptor; ayuda ES/EN y docs


