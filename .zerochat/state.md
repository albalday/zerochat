# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T1 Pruebas Python: helper único en tests/helpers para esperar la muerte de un PID ajeno sin sondeo (os.pidfd_open+select en Linux, kqueue NOTE_EXIT en macOS; Popen.wait si es hijo de la prueba) y usarlo en wait_dead de test_run_command.py y en el bucle os.kill(pid,0) de test_mcp_services.py (~596). Solo pruebas; producción no cambia
- Last updated: 2026-11-21
