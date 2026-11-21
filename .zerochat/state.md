# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T7 Arranque en pruebas: waitForServer (tests/helpers/backend-env.js, sondeo de latido cada 100 ms) y el smoke de empaquetado (tests/packaging_smoke_test.py ~86) esperan en stdout la línea 'Servidor HTTP' de print_header (ya se imprime tras el bind) y hacen un único latido de confirmación; test_local_server.js ~459 espera la marca de la última RPC en serverOutput en lugar de setTimeout(150). En producción solo se vuelca la cabecera con flush (útil con la salida redirigida); no se añade ninguna marca exclusiva de pruebas
- Last updated: 2026-11-21
