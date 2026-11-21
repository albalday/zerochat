# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T9 Propuesta en docs/ y luego implementación: que las ejecuciones --conversation (otro proceso, solo visibles en SQLite) avisen al servidor principal de cada write_run_state y que este espere también la muerte de su PID, para retirar _EXTERNAL_RUN_POLL_SECONDS en wait_live_state y _WATCHDOG_RUN_RECHECK_SECONDS en heartbeat_watchdog. Validar el canal (autenticación con el token de sesión, servidor principal ausente) con el usuario antes de implementar; registrar la decisión con -d
- Last updated: 2026-11-21
