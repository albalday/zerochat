# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T8 Backend: _kill_process_tree con solo PID (core/process.py:46) espera la salida con pidfd/kqueue hasta grace_seconds en lugar de time.sleep(grace_seconds) completo, con la misma comprobación _pid_alive de reserva donde no exista; y estudiar sustituir serve_forever(poll_interval=0.05) por un bucle selectors con socketpair de parada (descartar con --drop si el coste no compensa 20 despertares/s en reposo)
- Last updated: 2026-11-21
