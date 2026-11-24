# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora: closed 2026-11-21

## M83 Esperas síncronas en lugar de sondeo (restos tras M81): closed 2026-11-21

## M84 ZeroChat como ejecutor para orquestadores de agentes: closed 2026-11-21

## M85 Secretos por proyecto y relleno seguro en navegador: closed 2026-11-22

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20: closed 2026-11-22

## M86 Mejoras para proyectos de agentes y `--run-file`: closed 2026-11-23

## M87 Mejoras sistema de agentes: closed 2026-11-24

## M88 Ajustes de control de agentes

Goal: corregir las esperas de check_agents tras launch_agent y sobre agentes ya terminados, evitar filas huérfanas en runs y afinar las plantillas de controlador a partir de la prueba real de orquestación.
Done when: las tareas de M88 están implementadas con todos los niveles de §4 en verde.
- [x] M88-T1 Espera de check_agents sin salidas a los 5 s tras launch_agent, sin bloqueos en agentes ya terminados y esperando a todos los running en paralelo: en py/tools/agents.py (_wait_for_change / _selected) y py/run_mode/state.py (launch_run_file), (1) devolver de inmediato sin esperar wait_seconds cuando todas las conversaciones consultadas ya han dejado de estar en running (completed, error, limit, needs_input); (2) en esperas sobre varios agentes (listado general con wait_seconds), seguir esperando dentro de wait_seconds mientras quede algún agente consultado en running salvo que alguno entre en needs_input o error; y (3) hacer que la conversación recién lanzada por launch_agent exista desde el arranque (o se lea de runs antes del primer guardado en conversations) para que check_agents no falle con wait_seconds=0 ni salga a los 5 s por pasar de None a running, con pruebas (2026-11-24)
- [x] M88-T2 Evitar filas huérfanas en runs cuando una ejecución falla antes de arrancar y limpiarlas en list_server_runs: no escribir fila en runs antes de pasar las validaciones previas de arranque (o borrarla si aborta antes de lanzar el runner, p. ej. proyecto sin entorno guardado o conversación ocupada) y en list_server_runs limpiar filas no-running cuya conversación no exista en conversations, con pruebas (2026-11-24)
- [ ] M88-T3 Afinar plantillas de controlador (templates/project/mode-agent.txt y mode-agent-templates.txt): aclarar que check_agents(conversation_id=..., wait_seconds=...) ya devuelve el primer bloque de result_text (20000 chars) cuando el agente termina y que solo hace falta otra llamada con offset si next_offset no es null (o desde el listado general cuando result_text supera 4000 chars y viene solo result_chars), evitando relecturas duplicadas
- [ ] M88-T4 Control de bucles en AgentRuntime (js/agent-core.js) ante esperas con progreso real (check_command y check_agents): no contabilizar como repetición estancada una llamada a check_command o check_agents que observe avance real sobre una ejecución en marcha (en check_command: status=='running' con new_output no vacío o transición a final; en check_agents: returned_because=='agent_changed' o algún agente en status=='running' cuya actividad updated_at/step_text/usage haya avanzado respecto a la llamada anterior), manteniendo loop_detected tras 5 repeticiones cuando el comando/agente ya terminó o lleva 5 esperas agotadas sin ningún avance, con pruebas en tests/integration/test_agent_runtime.js
- [ ] M88-T5 Nivel de razonamiento en --run-file (reasoning: none, low, medium, high, xhigh; medium por defecto): validar reasoning en parse_run_request (py/run_mode/state.py) con medium por defecto cuando no se indique en --run-file, guardarlo en launch (RUN_LAUNCH_KEYS) para conservarlo al reanudar needs_input o continuar con --conversation, entregarlo en zerochat/run/prompt y aplicarlo en js/run-mode.js con Config.updateRuntime({ reasoningEffort }) tras activar el perfil de sesión, actualizando py/README.md, help/run-mode.html (es/en) y templates/project/mode-agent*.txt, con pruebas
- [ ] M88-T6 Sincronizar las normas y el manual del controlador en ../noticias (/home/alberto/vs/noticias/AGENTS.md, agents/controller.md y agents/template.json) con los nuevos textos de M88-T3 y M88-T5 sin recrear el proyecto: actualizar en AGENTS.md la descripción de check_agents y el campo reasoning de --run-file, y ajustar en agents/controller.md el flujo de espera para usar el result_text que ya devuelve check_agents(conversation_id=..., wait_seconds=240) al pasar a completed (llamando de nuevo solo con offset si next_offset no es null) sin volver a pedir los resultados completados

