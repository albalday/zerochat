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
- [x] M88-T3 Afinar plantillas de controlador (templates/project/mode-agent.txt y mode-agent-templates.txt): aclarar que check_agents(conversation_id=..., wait_seconds=...) ya devuelve el primer bloque de result_text (20000 chars) cuando el agente termina y que solo hace falta otra llamada con offset si next_offset no es null (o desde el listado general cuando result_text supera 4000 chars y viene solo result_chars), evitando relecturas duplicadas (2026-11-24)
- [x] M88-T4 Control de bucles en AgentRuntime (js/agent-core.js) ante esperas con progreso real (check_command y check_agents): no contabilizar como repetición estancada una llamada a check_command o check_agents que observe avance real sobre una ejecución en marcha (en check_command: status=='running' con new_output no vacío o transición a final; en check_agents: returned_because=='agent_changed' o algún agente en status=='running' cuya actividad updated_at/step_text/usage haya avanzado respecto a la llamada anterior), manteniendo loop_detected tras 5 repeticiones cuando el comando/agente ya terminó o lleva 5 esperas agotadas sin ningún avance, con pruebas en tests/integration/test_agent_runtime.js (2026-11-24)
- [x] M88-T5 Nivel de razonamiento en --run-file (reasoning: none, low, medium, high, xhigh; medium por defecto): validar reasoning en parse_run_request (py/run_mode/state.py) con medium por defecto cuando no se indique en --run-file, guardarlo en launch (RUN_LAUNCH_KEYS) para conservarlo al reanudar needs_input o continuar con --conversation, entregarlo en zerochat/run/prompt y aplicarlo en js/run-mode.js con Config.updateRuntime({ reasoningEffort }) tras activar el perfil de sesión, actualizando py/README.md, help/run-mode.html (es/en) y templates/project/mode-agent*.txt, con pruebas (2026-11-24)
- [x] M88-T6 Panel de proyecto en razonamiento (js/ui-reasoning.js, js/ui-project.js, js/project-context.js, js/generation-controller.js): (1) refrescar automáticamente ProjectContext antes de cada turno en generation-controller.js (como en run-node.js) y al abrir el modal de razonamiento, retirando el botón manual «Actualizar datos» (reload) y sus claves i18n; (2) añadir en estado ready la acción «Actualizar normas» (updateRules, con templates/project/update-rules.txt) que tras confirmar pida al agente sincronizar .zerochat/task.py, las secciones estándar de AGENTS.md y, si es proyecto de agentes (agents/), las plantillas agents/template.* y el contrato de herramientas en agents/*.md/.json conservando todo lo específico del proyecto; y (3) cuando no haya conexión con el backend (!project.cwd), indicar explícitamente en el panel de proyecto que no hay conexión con el servidor local (aunque projectMode esté desactivado, deshabilitando el interruptor sin conexión), actualizando help/project-mode.html (es/en) y con pruebas (2026-11-24)
- [x] M88-T7 Configuración no secreta (cajas de texto) en servicios MCP y en el MCP de correo (services/mail): soportar opciones type: 'text' en options de service.json (renderServerOptions y guardado en js/ui-mcp.js, expansión ${option:ID} y validación/reinicio si está en marcha en py/mcp/manager.py), pasar MAIL_IMAP_HOST y MAIL_USER en services/mail/service.json de secrets a options de texto dejando solo MAIL_PASSWORD como secreto, actualizar services/mail/README.md y services/manifest.json, con pruebas (2026-11-24)
- [ ] M88-T8 Evaluar soporte OAuth2 (XOAUTH2) para el MCP de correo (services/mail) frente a proveedores como Google (Gmail) sin contraseña de aplicación
- [ ] M88-T9 Añadir borrado de mensajes (delete_message) en el MCP de correo (services/mail): mover a Papelera (\Trash) o marcar \Deleted + EXPUNGE por UID en services/mail/mail_mcp_server.py (con soporte de carpeta y opción permanente o papelera), declararla en services/mail/service.json con enabledByDefault: false (activable por proyecto en Herramientas MCP), actualizar services/mail/README.md y services/manifest.json, con pruebas en test_mail_mcp.py
- [x] M88-T10 Simplificar y coordinar los límites de salida de herramientas con ChatContextManager (js/context-manager.js): reducir a 2 niveles coordinados para modelos de gran contexto (150K–1M): (1) techo único de turno activo DEFAULT_MAX_ACTIVE_TOOL_CHARS=64000 (acotado al inputBudget en modelos pequeños y retirando el parche ad-hoc de 45000 de read_knowledge_chunk) aplicado a todos los pasos del turno en curso (posteriores al último user) sin podar entre pasos para conservar datos y KV-cache; (2) poda solo en turnos pasados cerrados (anteriores al último user) con DEFAULT_MAX_HISTORICAL_TOOL_CHARS=4000; y (3) alinear read_file max_bytes por defecto a 60000 (READ_FILE_DEFAULT_MAX_BYTES en py/tools/filesystem.py y registry.py) junto a los 60000 de fetch_web_page y ChatMcpResults para que toda herramienta avise antes del techo de seguridad de 64000, con pruebas en borde exacto (2026-11-24)
- [x] M88-T11 Propagar la pausa por aprobación de las ejecuciones desatendidas desde el cliente MCP (js/mcp-results.js): formatToolCallResult traslada requiresAuthorization pero no awaitingApproval, de modo que la respuesta del servidor (_awaiting_approval) llegaba al bucle como un éxito con el texto del aviso, el turno no se cerraba, la ejecución acababa en completed en lugar de needs_input/tool_approval y no aparecía la tarjeta de aprobación (desde M87-T23 ninguna conversación guardó el JSON awaitingApproval); trasladar awaitingApproval con toolName, arguments, ruleOffer y details, con prueba que pase la respuesta real del servidor por formatToolCallResult y AgentRuntime y compruebe que el turno se cierra con la llamada pendiente (2026-11-25)
- [x] M88-T12 Tarjeta pendiente de aprobación con su propio resultado (js/ui-conversation.js): renderAssistantGroup buscaba el mensaje tool de cada llamada en todo el grupo por tool_call_id o por nombre, de modo que una llamada pausada (awaitingApproval) que repetía herramienta con otra anterior del mismo turno ya ejecutada tomaba ese resultado y no mostraba la petición de aprobación aunque la ejecución estuviera en needs_input (agente noticias.controller con dos run_command); buscar solo entre los mensajes tool del propio paso, por id o, sin id, por posición en el lote, con prueba de navegador (2026-11-25)

## M89 Adaptación del bucle agéntico al contexto del modelo: closed 2026-11-25

## M90 Reorganización del panel MCP: closed 2026-11-25

