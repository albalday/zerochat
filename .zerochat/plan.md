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

## M87 Mejoras sistema de agentes

Goal: cerrar los huecos del sistema de agentes detectados al compararlo con otros ejecutores (concurrencia, worktrees, espera del master, avisos y salida para orquestadores).
Done when: las tareas acordadas de M87 están implementadas con todos los niveles de §4 en verde.
- [ ] M87-T1 Impedir dos ejecuciones simultáneas de la misma conversación también desde la CLI: aplicar _check_no_active_run (py/run_mode/state.py) en run_session_from_args (py/cli/main.py) para --run-file y --conversation (solape de cron con conversation_id fijo), con código de salida acordado y prueba
- [ ] M87-T2 Worktrees y supervisión: que una carpeta git worktree de un proyecto herede su entorno guardado (sin salir con código 3) y que check_agents del master vea a los agentes que trabajan en worktrees del mismo proyecto, en lugar de filtrar solo por project == ctx.workspace_dir; decidir el modelo (proyecto padre vs. carpeta) con el usuario antes de empezar, con pruebas
- [ ] M87-T3 Espera sin sondeo del controlador: añadir a check_agents una espera larga opcional hasta que algún agente vigilado cambie de estado o termine (completed, error, limit, needs_input), apoyándose en watch_run_exit/notify_live_change y un tope de espera, con pruebas
- [ ] M87-T4 Avisos activos de agentes: punto de aviso explícito en agents/template.sh (comando configurable) para needs_input (5), limit (6) y error, de modo que un agente de cron que se pausa o falla avise sin abrir la interfaz
- [ ] M87-T5 Salida para orquestadores de shell: emitir en stderr (siempre, también con --log off) el conversation_id de la ejecución de --run-file, sobre todo si es nueva, para que el script la siga sin HTTP; documentarlo en py/README.md y las plantillas, con prueba
- [ ] M87-T6 Mejoras menores a valorar con el usuario: consumo de tokens por ejecución en la fila de runs, retención o limpieza de conversaciones efímeras por agente y hooks antes/después de herramientas (decidir cuáles se hacen o descartar con --drop)
- [x] M87-T7 Historial: conmutador Chats/Agentes en lugar de mezclar ambos, Tareas pendientes solo con needs_input y cabeceras de agente sin estirarse en vertical (2026-11-24)
- [x] M87-T8 Historial de agentes plano: cada conversación con el nombre de su agente y fecha, sin secciones plegables; conmutador Chats/Agentes en su propia línea (2026-11-24)
- [x] M87-T9 Historial: borrar la conversación de agente abierta no vuelve a Chats; aviso de solo lectura sobre el compositor en conversaciones de agente (2026-11-24)
- [x] M87-T10 CI: las pruebas que arrancan zerochat.py reintentan con otro puerto si otro proceso de la suite ocupa el de freePort() (2026-11-24)
- [ ] M87-T11 Lanzamiento de agentes desde un controlador: herramienta local acotada (junto a check_agents y sus patrones permitidos) para lanzar agentes del mismo proyecto de forma desacoplada (sin run_command ni morir en JOBS.stop_all, devolviendo conversation_id y run_id y respetando el entorno guardado del proyecto), documentando el flujo controlador+workers en templates/project/mode-agent*.txt, con pruebas
- [ ] M87-T12 Aislamiento de red del servidor en modo ejecución (--prompt, --conversation, --run-file): escuchar siempre en 127.0.0.1 (ignorando ZEROCHAT_HOST) y en puerto efímero libre del SO (puerto 0, rango dinámico ≥ 32768/49152, nunca 6388 ni ZEROCHAT_PORT salvo --port explícito), y aceptar en POST únicamente el runner_token del proceso Node lanzado (sin token diario ni zerochat/login), con pruebas
- [x] M87-T13 Revalidación del perfil activo (ProfileCheck.recheck): volver a comprobar el perfil y recoger su límite de contexto al pulsar el perfil ya activo en el menú, al inspeccionarlo con la lupa (si es el activo) y automáticamente al volver a la pestaña (visibilitychange) o completar un turno cuando quedó en error, con pruebas (2026-11-24)
- [x] M87-T14 Auditoría M87 (F-01, F-02): acotar deleteAllSessions al historial activo (Chats o Agentes, con filtro en ChatStorage y zerochat/conversations/delete, deshabilitando el botón si está vacío) y hacer que deleteSession elija el sustituto en el mismo historial/proyecto para no saltar de Agentes a Chats ni cambiar proyecto sin confirmación, actualizando help/conversations.html (es/en) y con pruebas en integration, py y browser (ver docs/audit-M87.md) (2026-11-24)
- [x] M87-T15 Auditoría M87 (F-04, F-05, F-06): hacer .has-pending simétrico entre Chats y Agentes, ocultar Renombrar en conversaciones de agentes, reiniciar estado de módulo en UISidebar.mount(), extraer helper de repintado en tests/browser/browser_sidebar.test.js, sincronizar docs/architecture.md y templates/project/mode-agent.txt con el historial plano de M87 y ajustar los detalles menores de CSS (ver docs/audit-M87.md) (2026-11-24)
- [ ] M87-T16 Auditoría M87 (F-03): unificar y hacer portable (Windows WinError 10048 y locales no ingleses con Errno 98/48) la detección y reintento de puerto ocupado entre tests/helpers/backend-env.js y tests/infrastructure/test_backend_run_mode.js, o usar --port 0 en open_server actualizando set_active_address (ver docs/audit-M87.md)

