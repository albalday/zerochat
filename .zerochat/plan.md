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
- [x] M97-T2 Evaluar hacer `delegate_task` asíncrona (pendiente de evaluación: analizar si aporta frente a las llamadas paralelas del mismo turno y frente a `launch_agent`/`check_agents`) (dropped: con servidor local «Subagentes» ya da launch_agent/check_agents, asíncronas; sin él, el coste (registro en la pestaña, tarjeta viva, final de turno, choques con WebLLM o servidores de un hueco) no compensa)
- [x] M97-T3 Renombrar la sección de configuración «Agente» a «Herramientas» / «Tools» (zerochat.html, js/i18n.js ES/EN, help/ y referencias en UI/pruebas) porque solo activa/desactiva las herramientas del entorno del proyecto (2026-11-26)
- [ ] M97-T4 Añadir la herramienta integrada update_plan(items: [{text, status}]) en js/tools/builtin/: cada llamada sustituye la lista entera del turno, sin estado en el servidor (no es un motor de planificación, §2.4); la descripción limita su uso a tareas de 3 o más pasos y a actualizar al cerrar cada paso; js/context-manager.js conserva siempre la última llamada a update_plan del turno frente a la poda intra-turno y el corte de exclusión (M89), sin inyectarla en el prompt de sistema para no invalidar la caché KV
- [ ] M97-T5 Mostrar el plan vigente de update_plan como checklist fija encima del compositor (pendiente / en curso / hecho, ES/EN en js/i18n.js), también en ejecuciones en segundo plano y en el modo supervisión de la bandeja Agentes, y su tarjeta de herramienta compacta en el historial
- [x] M97-T6 Servidor: el chat interactivo y su ejecución en segundo plano con «Subagentes» son controladores: check_agents, launch_agent, stop_agent y prune_agents se publican en el servidor de la interfaz (marcados como del controlador) con estado por conversación (zerochatConversationId), y zerochat/run/prompt devuelve subagents = controller (2026-11-26)
- [x] M97-T7 Interfaz: «Subagentes» da las herramientas del controlador con el servidor local conectado y delegate_task solo sin él; Ajustes › MCP muestra su permiso sin interruptor; ayuda ES/EN y docs (2026-11-26)
- [x] M97-T8 Simplificar el controlador interactivo: las herramientas del controlador no piden permiso (lo da «Subagentes» o controller: true) y no aparecen en Ajustes › MCP (2026-11-26)
- [x] M97-T9 Reducir el controlador de la interfaz a un único estado del servidor (monousuario): sin estado por conversación ni zerochatConversationId en las herramientas del controlador (2026-11-26)
- [x] M97-T10 Con «Subagentes» encendido, el icono del agente sustituye al medidor del botón de razonamiento en lugar de ir a su lado (2026-11-26)
- [x] M97-T11 Recuperar el medidor de razonamiento con «Subagentes» y poner el icono del agente a su lado, ensanchando el botón (el selector [data-subagents="true"] nunca casaba) (2026-11-26)
- [x] M97-T12 Aviso visual de conversaciones que necesitan atención (needs_input o error) en todos los proyectos, sin cambios en el servidor: una única definición de atención en js/server-run.js (estados y recuento agentes/chats × needs_input/error desde mcp.serverRuns y la lista de sesiones) que usan una tarjeta pasiva sobre el compositor, la pestaña vía TabAlert (título con contador que alterna con la pestaña oculta y punto en el favicon; sustituye su aviso de permiso de la conversación activa) y el historial (vista Pendientes, que pasa a incluir los errores, su contador y el punto del selector chats/agentes); un error cuenta hasta relanzar o borrar su conversación (2026-11-27)
- [x] M97-T13 Botón de cerrar en el aviso de atención: oculta solo la tarjeta (no el título ni el favicon) hasta que aparezca una conversación o estado que no estaba al cerrarla (firma conversación:estado en memoria de la pestaña; resolverse alguna no la reabre) (2026-11-27)
- [x] M97-T14 Pendiente de decisión: Playwright MCP sin --caps=vision ni browser_mouse_click_xy frente a browser_fill_secret (mode='keypad' con coordenadas [x, y] en py/tools/registry.py y py/tools/browser_secret.py): decidir si activar --caps=vision (fijo u opcional en Ajustes › Navegador / services/playwright/service.json, valorando --snapshot-boxes y las 6 herramientas extra en contexto) o limitar keypad_map a refs de browser_click (2026-11-27)
- [ ] M97-T15 Pendiente de decisión: al marcar «Mostrar la ventana» (headless=False) en Linux con zerochat.py arrancado sin DISPLAY (p. ej. con nohup por SSH), @playwright/mcp cae silenciosamente a --headless sin error ni aviso; decidir si mostrar advertencia en Ajustes › Navegador / log o comprobar DISPLAY antes de arrancar
- [x] M97-T16 Permitir que las herramientas MCP devuelvan imágenes visibles para el modelo (o añadir lectura de imágenes a read_file como evidencia visual multimodal) (2026-11-27)
- [x] M97-T17 Añadir browser_save_state y browser_load_state en el backend (sobre --caps=vision,storage de Playwright MCP, ocultando las 17 herramientas crudas de storage) para guardar y restaurar cookies/localStorage por proyecto con permisos 0700/0600 (2026-11-27)

## M98 Auditoría 10.51.0: closed 2026-11-28

## M99 Validación 10.50.0..HEAD

Goal: Corregir los fallos claros sin cambio funcional detectados al revisar los cambios desde 10.50.0 (`ddef26ea..HEAD`) y dejar abiertas como tareas las recomendaciones de diseño, robustez, cobertura y documentación.
Done when: Las tareas de fallos claros están corregidas con sus pruebas y `npm run lint` + `npm test` en verde, y las recomendaciones quedan resueltas o descartadas con el usuario.
- [x] M99-T1 Backend agentes: preservar launch guardado al reanudar un agente en línea con launch_agent, arreglar stop_agent ante SIGTERM en POSIX (RUN_INTERRUPTED_ERROR), acotar _final_answer al último turno, excluir entradas pending no guardadas de prune_agents y exigir conversation_id + limpiar ZEROCHAT_RUN_SUBAGENTS en py/cli/main.py (2026-11-27)
- [x] M99-T2 Compactar y reloadActiveSession (js/conversation-service.js, js/app.js): bloquear compactación en agentes de solo lectura y chats con ejecución en servidor activa, capturar errores y actualizar en sitio sin wipe de adjuntos/depuración, sincronizar #btn-compact-context mientras el popover está abierto y añadir guardia de secuencia/updatedAt en reloadActiveSession (2026-11-27)
- [x] M99-T3 Topes y guardas de parsers/secretos/herramientas: guardia Number.isSafeInteger en beginbfrange y límite de profundidad en /Kids (js/file-parser.js), tope e invalidación de resolvedRagImagesCache (js/markdown.js, M98-T15), cryptoOrThrow fuera de catch en decryptApiKey (js/profile-secrets.js), disabledTools para herramientas con showInSettings false (js/agent-core.js), ipv6Groups sin RangeError (js/web-browser.js), JSDoc en js/providers.js y bordes N/N+1 de MAX_PACKAGE_BYTES/MAX_XML_BYTES en test_office_parser.js (2026-11-27)
- [x] M99-T4 Service Worker (sw.js): restringir cacheo dinámico a rutas estáticas conocidas sin interceptar APIs del mismo origen, registrar event.waitUntil de forma síncrona y capturar errores de cache.put, actualizando tests/unit/test_service_worker.js (2026-11-27)
- [x] M99-T5 Runner de pruebas y contratos M98 pendientes: corregir --changed y unhandled rejection de py en scripts/test-runner.mjs; cerrar huecos en test_csp.js, test_state_contract.js, test_i18n_literals.js y test_ui_listeners.js; completar M98-T2 (caso unitario password y retirar mocks de ChatDialogs.prompt en browser_settings_navigation y browser_mcp_panel) y retirar waitForTimeout fijos en browser_composer.test.js (2026-11-27)
- [x] M99-T6 Recomendación backend agentes (py/run_mode/state.py, py/tools/agents.py): añadir Lock y tope a ControllerState (INTERFACE_CONTROLLER) limpiando fantasmas al borrar conversaciones/proyectos en UI (coordinado con M98-T21); validar historial/perfil antes de lanzar en launch_agent; rechazar agent+conversation_id contradictorios en check_agents; alinear bloques sin cerrar en parse/format_run_request; unificar errores en inglés y actualizar comentarios y --help (disabledTools) (2026-11-28)
- [x] M99-T7 Recomendación avisos de atención (js/server-run.js, js/ui-composer.js, js/tab-alert.js): incluir runId en la firma de descarte, conservar el descarte tras desconexiones breves (LIVE_RESET), mejorar accesibilidad del cierre (foco y aria-hidden en SVG) y evitar repintados redundantes de favicon/parpadeo en TabAlert (2026-11-28)
- [ ] M99-T8 Recomendación sincronización de API keys (js/profile-repository.js): curar en una sola sincronización las claves antiguas ilegibles cuando localTime > remoteTime mediante revealRemote y limpiar claves ilegibles en perfiles locales nuevos sin remoto
- [ ] M99-T9 Recomendación cobertura de pruebas: probar webllmModuleUrl ante hash inválido o error HTTP (test_webllm.js), RagStorage.readBackupText con rag_import_too_large (test_ingestion_engine.js), recarga al finalizar ejecución en reloadActiveSession (browser_run_mode.test.js) y ampliar test_ui_listeners.js a módulos UI restantes y funciones flecha
- [x] M99-T10 Recomendación documentación y ayuda (js/README.md, py/README.md, docs/architecture.md, help/): sincronizar js/README.md (retirar Cifrado/Agente, excepción WebLLM SHA-384 y Math.max de fflate), corregir 'Ejecución en segundo plano' en help/tools-agent.html ES/EN, reflejar errores en el punto Chats/Agentes y stop_agent/prune_agents/disabledTools en help/ y docs/architecture.md, y retirar menciones residuales a 'master' (2026-11-27)
- [ ] M99-T11 Revisar y sincronizar documentación y ayuda (docs/, js/README.md, py/README.md, help/ ES/EN) una vez completadas las tareas pendientes de M97, M98 y M99

