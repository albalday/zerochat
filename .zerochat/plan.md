# Plan

<!-- Hitos M1 a M90 archivados en .zerochat/archive/ -->

## M91 Adjuntos en el MCP de correo: closed 2026-11-25

## M92 Acciones durante un turno en marcha: closed 2026-11-25

## M93 Correcciones del navegador de agentes: closed 2026-11-25

## M94 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-25: closed 2026-11-26

## M95 Auditoría 10.48.1: closed 2026-11-26

## M96 Esquema único de agentes (.md), controlador y subagentes: closed 2026-11-26

## M97 Arreglos pequeños agentes

Goal: Corregir pequeños desajustes de interfaz, textos y comportamiento en subagentes (`delegate_task`) y agentes.
Done when: Las tareas abiertas de M97 quedan resueltas o evaluadas y descartadas con el usuario, con sus pruebas aplicables de `AGENTS.md` §4 en verde.
- [ ] M97-T1 Revisar el texto y alcance del interruptor «Subagentes» en el panel de razonamiento (`agent_delegate_task_desc` en `js/i18n.js` ES/EN y `zerochat.html`): verificar con el usuario qué refleja mejor el comportamiento real de `delegate_task` (múltiples subagentes en paralelo dentro del turno, con o sin servidor local, y restricción actual a solo lectura frente a agentes `--run-file`)
- [ ] M97-T2 Evaluar hacer `delegate_task` asíncrona (pendiente de evaluación: analizar si aporta frente a las llamadas paralelas del mismo turno y frente a `launch_agent`/`check_agents`)


