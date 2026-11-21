# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora: closed 2026-11-21

## M83 Esperas síncronas en lugar de sondeo (restos tras M81): closed 2026-11-21

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20

Goal: que cada agente que trabaja en este repositorio traiga a .zerochat/ lo que solo guarda en su memoria privada.
Done when: el usuario confirma que todos los agentes que usa lo han hecho.
- [ ] M82-T1 Cada agente que lea esta tarea revisa su memoria privada de este proyecto frente al código y a .zerochat/, propone al usuario las tareas, decisiones y normas aún vigentes y no registradas (nunca secretos ni datos personales), las escribe una vez aprobadas y pregunta al usuario antes de marcar la tarea como hecha, porque otros agentes pueden faltar todavía

## M84 ZeroChat como ejecutor para orquestadores de agentes

Goal: dotar a ZeroChat (CLI, RPC y UI) de los contratos mínimos para actuar como ejecutor desatendido y bandeja HITL de un orquestador externo de agentes, sin meter lógica de orquestación de flota dentro de ZeroChat.
Done when: las tareas M84-T1 a M84-T4 se han discutido una a una con el usuario y las acordadas están implementadas con todos los niveles de §4 en verde.
Criterio: cada tarea se analiza y acuerda con el usuario antes de escribir código (o se descarta con --drop si se decide no incluirla).
- [ ] M84-T1 Salida estructurada en CLI (--json): acordar con el usuario el contrato JSON de finalización en stdout (conversation_id, status, text, needs_input, pasos/métricas) y confirmar si para seguimiento por RPC basta el long-poll ya existente en zerochat/heartbeat (runs y focus_run con since_rev + wait_ms, despertado sin sondeo por watch_run_exit tras M83-T9)
- [ ] M84-T2 Overrides efímeros de entorno por ejecución en CLI y zerochat/run/start: acordar con el usuario qué parámetros admitir por invocación (--project, --system-prompt, --tools) aplicados solo a ese RunSession sin modificar el project_environment guardado en SQLite
- [ ] M84-T3 Límites duros opcionales por ejecución (--max-steps y --timeout en CLI y zerochat/run/start): acordar con el usuario los parámetros, el estado/código de salida al alcanzarlos y su integración sin sondeo (wake.wait(timeout) en run_supervisor + _kill_process_tree de M83-T8 y tope de pasos en agent-core.js) conservando los pasos ya grabados
- [ ] M84-T4 Reanudación y aprobación de needs_input desde CLI y filtro visual en la interfaz web: acordar con el usuario cómo aprobar o responder desde CLI una conversación pausada en ask_user / tool_approval y cómo aprovechar live_state.runs (ya actualizado al instante por M83-T9) en la barra lateral de la UI para localizar las conversaciones running o en needs_input

