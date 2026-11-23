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
- [ ] M87-T3 Espera sin sondeo del master: añadir a check_agents una espera larga opcional hasta que algún agente vigilado cambie de estado (reutilizando notify_live_change y un tope de espera), y documentar en templates/project/mode-agent*.txt el lanzamiento de workers en paralelo con run_command en segundo plano y zerochat --run-file, con pruebas
- [ ] M87-T4 Avisos activos de agentes: punto de aviso explícito en agents/template.sh (comando configurable) para needs_input (5), limit (6) y error, de modo que un agente de cron que se pausa o falla avise sin abrir la interfaz
- [ ] M87-T5 Salida para orquestadores de shell: emitir en stderr (siempre, también con --log off) el conversation_id de la ejecución de --run-file, sobre todo si es nueva, para que el script la siga sin HTTP; documentarlo en py/README.md y las plantillas, con prueba
- [ ] M87-T6 Mejoras menores a valorar con el usuario: consumo de tokens por ejecución en la fila de runs, retención o limpieza de conversaciones efímeras por agente y hooks antes/después de herramientas (decidir cuáles se hacen o descartar con --drop)

