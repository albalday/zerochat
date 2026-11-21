# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T4 Pruebas: cambiar los bucles que releen estado por long-poll existente o por sincronización propia de la prueba: test_run_command.py (~248 jobs/log con offset 0 y wait_ms hasta ver 'uno'; ~232 end_wait reintentado: Event activado al entrar en WAITS.open con mock.patch.object(..., wraps=)) y test_local_server.js (~248 jobs/get por key en bucle → espera de M83-T3). Sin ganchos nuevos en producción
- Last updated: 2026-11-21
