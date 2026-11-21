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
Done when: las tareas M84-T1 a M84-T5 se han discutido una a una con el usuario y las acordadas están implementadas con todos los niveles de §4 en verde.
Criterio: cada tarea se analiza y acuerda con el usuario antes de escribir código (o se descarta con --drop si se decide no incluirla).
- [x] M84-T1 Fichero JSON de ejecución (--run-file FICHERO o - para stdin), único parámetro nuevo de la CLI: conversation_id elegido por el orquestador (si existe se continúa; si no, la conversación nueva se guarda con ese id, también con --browser), prompt, profile por nombre y systemDataPrompt, que sustituye al guardado solo en ese RunSession sin escribir en project_environments; campos desconocidos rechazados (código 4) y error de arranque (código 3) si la carpeta no tiene entorno de proyecto guardado. zerochat/run/start no cambia: es el lanzador interno de la UI, el orquestador lanza por CLI. Contrato de seguridad: el JSON nunca lleva permisos, herramientas ni MCP (tool_security, enabledTools, mcpServers), que salen siempre del proyecto, así que no puede ampliarlos (registrar como decisión con -d) (2026-11-21)
- [x] M84-T2 Contrato de salida, con dos destinatarios. CLI (ejecutor para personas y cron): stdout con el texto final, o con la pregunta de ask_user o la herramienta pendiente de tool_approval al pausarse; código de salida 5 para needs_input (hoy sale con 0 y JSON en stdout); stderr solo para personas. Orquestador (HTTP como el frontend, token por zerochat/login): la fila de runs es la única fuente de la situación de la ejecución; ya no se borra al terminar bien (status completed, finished_at), guarda el texto final del turno y las denegaciones de permisos (warnings, con tope y aviso de truncado), y se lee por zerochat/heartbeat focus_run con espera larga; sin --json, --result ni --status. El latido solo lleva en runs las no completadas (focus_run sí entrega la completada), needs_input pausa igual en conversaciones nuevas y borrar una conversación borra su fila de runs (2026-11-21)
- [x] M84-T3 Límites duros opcionales por ejecución (maxSteps y timeout dentro del JSON de M84-T1, sin flags nuevos): acordar con el usuario el estado/código de salida al alcanzarlos y su integración sin sondeo (wake.wait(timeout) en run_supervisor + _kill_process_tree de M83-T8 y tope de pasos en agent-core.js) conservando los pasos ya grabados (2026-11-21)
- [x] M84-T4 Conversaciones de --run-file reanudables desde la interfaz: una conversación nueva creada por --run-file queda marcada como ejecución en servidor con su perfil (serverRun y profileId, como --conversation) para que la interfaz la continúe en el servidor. La CLI no tiene ninguna interfaz de aprobaciones ni de respuestas al usuario: todo se hace en el frontend; el systemDataPrompt no se guarda en la conversación (el orquestador lo manda en cada JSON); los avisos de pestaña no cambian (2026-11-21)
- [ ] M84-T5 Vista de conversaciones con tareas pendientes en la barra lateral: opción en el selector Conversaciones a mostrar con las conversaciones de todos los proyectos en live_state.runs (running, needs_input, error, limit) y el número de las que piden atención; icono propio por estado (error y limit dejan de compartir el de needs_input) con el motivo como título, y banner de limit en la conversación abierta

