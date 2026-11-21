# Plan

<!-- Hitos M1 a M77 archivados en .zerochat/archive/ -->

## M78 Compactación con los agentes locales: closed 2026-11-17

## M79 Usabilidad y propuestas de mejora: closed 2026-11-20

## M80 Entorno de ejecución por proyecto: closed 2026-11-20

## M81 Propuestas de mejora: closed 2026-11-21

## M82 Consolidación de la memoria privada de los agentes tras la compactación del 2026-11-20

Goal: que cada agente que trabaja en este repositorio traiga a .zerochat/ lo que solo guarda en su memoria privada.
Done when: el usuario confirma que todos los agentes que usa lo han hecho.
- [ ] M82-T1 Cada agente que lea esta tarea revisa su memoria privada de este proyecto frente al código y a .zerochat/, propone al usuario las tareas, decisiones y normas aún vigentes y no registradas (nunca secretos ni datos personales), las escribe una vez aprobadas y pregunta al usuario antes de marcar la tarea como hecha, porque otros agentes pueden faltar todavía

## M83 Esperas síncronas en lugar de sondeo (restos tras M81)

Goal: sustituir los bucles de sondeo y las pausas fijas que quedan en el backend, el frontend y las pruebas por esperas que despiertan con el evento que se espera.
Done when: no queda en py/, js/ ni tests/ ningún bucle sleep+comprobación ni pausa fija para esperar un estado, salvo los justificados que se dejen documentados (sandbox de Node por seguridad, reintento de conexión de --conversation, comprobaciones negativas de las pruebas, catálogo MCP del smoke de empaquetado), y pasan todos los niveles de §4.
Criterio: cada tarea distingue qué espera la prueba y qué espera producción. Las pruebas se sincronizan con lo que observan (log por long-poll, FIFO, pidfd, Event con mock wraps=, línea de stdout) sin añadir a producción parámetros ni ganchos solo para ellas. Producción puede ignorar a propósito salida que a la prueba sí le sirve: la firma rev del latido excluye _VOLATILE_JOB_FIELDS para que cada línea de stdout no despierte a todos los latidos, y eso no se cambia para acortar una espera de prueba.
- [x] M83-T1 Pruebas Python: helper único en tests/helpers para esperar la muerte de un PID ajeno sin sondeo (os.pidfd_open+select en Linux, kqueue NOTE_EXIT en macOS; Popen.wait si es hijo de la prueba) y usarlo en wait_dead de test_run_command.py y en el bucle os.kill(pid,0) de test_mcp_services.py (~596). Solo pruebas; producción no cambia (2026-11-21)
- [x] M83-T2 Pruebas Python: sustituir las puertas de fichero de BackgroundCommandTest (while [ ! -e gate ]; sleep 0.02, 5 casos en test_run_command.py) por FIFO (os.mkfifo + read _ < gate en el comando) que la prueba abre y escribe justo cuando toca, y retirar _release_gate_soon y su threading.Timer. Solo pruebas (las clases ya se saltan en Windows) (2026-11-21)
- [x] M83-T3 Backend+UI: zerochat/jobs/log y zerochat/jobs/get por key con wait_ms esperan a que el comando se registre (condición en JobManager notificada al registrar, con tope LONG_POLL_MAX_WAIT_MS y despertar en el cierre) en lugar de fallar al instante. Consumidor real: la primera lectura de la tarjeta en vivo, que deja la pausa ciega initialDelayMs=LOG_RETRY_DELAY_MS de command-card.js; revisar también el delay previo de followLog (~735) y quitarlo si no protege nada. Prueba en el borde: clave registrada durante la espera despierta y clave inexistente vuelve al vencer (2026-11-21)
- [x] M83-T4 Pruebas: cambiar los bucles que releen estado por long-poll existente o por sincronización propia de la prueba: test_run_command.py (~248 jobs/log con offset 0 y wait_ms hasta ver 'uno'; ~232 end_wait reintentado: Event activado al entrar en WAITS.open con mock.patch.object(..., wraps=)) y test_local_server.js (~248 jobs/get por key en bucle → espera de M83-T3). Sin ganchos nuevos en producción (2026-11-21)
- [x] M83-T5 Pruebas: last_line del latido (test_run_command.py ~282) sin sondear live_state. Producción no despierta el latido por stdout (last_line está en _VOLATILE_JOB_FIELDS y no cambia rev, para no provocar long-polls de vuelta inmediata en cada línea), así que la prueba no espera por rev: sigue el log con jobs/log wait_ms (avanzando offset) hasta tener la salida completa del caso y entonces lee live_state una vez (last_line se calcula del mismo búfer al leer). No tocar la firma rev (2026-11-21)
- [x] M83-T6 Pruebas: cambiar pausas fijas que esperan a que otro hilo ya esté esperando por un Event de la prueba: test_server_runs.py (~478 watchdog y ~506 long-poll del latido: envolver _WATCHDOG_COND.wait/_LIVE_STATE_COND.wait con wraps= y cambiar el run al entrar), test_mcp_services.py (~416 sleep antes de close: esperar la última traza capturada), test_mcp_tools.js (~199/~204: el mock de calls resuelve una promesa al llegar tools/call y zerochat/jobs/stop) y las pausas tras clics de browser_mcp_panel (~213, ~264) y browser_tool_cards (~309) con waitForFunction o la promesa del manejador. Dejar las comprobaciones negativas a propósito (browser_composer, browser_conversation ~449) y los setTimeout(0) de vaciado (2026-11-21)
- [x] M83-T7 Arranque en pruebas: waitForServer (tests/helpers/backend-env.js, sondeo de latido cada 100 ms) y el smoke de empaquetado (tests/packaging_smoke_test.py ~86) esperan en stdout la línea 'Servidor HTTP' de print_header (ya se imprime tras el bind) y hacen un único latido de confirmación; test_local_server.js ~459 espera la marca de la última RPC en serverOutput en lugar de setTimeout(150). En producción solo se vuelca la cabecera con flush (útil con la salida redirigida); no se añade ninguna marca exclusiva de pruebas (2026-11-21)
- [x] M83-T8 Backend: _kill_process_tree con solo PID (core/process.py:46) espera la salida con pidfd/kqueue hasta grace_seconds en lugar de time.sleep(grace_seconds) completo, con la misma comprobación _pid_alive de reserva donde no exista; y estudiar sustituir serve_forever(poll_interval=0.05) por un bucle selectors con socketpair de parada (descartar con --drop si el coste no compensa 20 despertares/s en reposo) (2026-11-21)
- [x] M83-T9 Propuesta en docs/ y luego implementación: que las ejecuciones --conversation (otro proceso, solo visibles en SQLite) avisen al servidor principal de cada write_run_state y que este espere también la muerte de su PID, para retirar _EXTERNAL_RUN_POLL_SECONDS en wait_live_state y _WATCHDOG_RUN_RECHECK_SECONDS en heartbeat_watchdog. Validar el canal (autenticación con el token de sesión, servidor principal ausente) con el usuario antes de implementar; registrar la decisión con -d (2026-11-21)

