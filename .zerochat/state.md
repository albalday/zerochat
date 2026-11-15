# Current state
- Milestone: M73 Arreglos de seguridad
- Next task: M73-T12 CA del reverse proxy en el runner de Node, a debatir con el usuario: permitir que `minimal_child_env()` (`py/core/environment.py`) reenvíe `NODE_EXTRA_CA_CERTS` cuando esté definida en `os.environ` (opcionalmente validando que el fichero exista) para que `launch_node_runner` (`py/run_mode/supervisor.py`) con `--permission` pueda conectar con modelos locales tras un proxy con CA propia; valorar también alternativas (`--use-system-ca` según versión de Node o parámetro CLI) y registrar la decisión en `log.md`
- Last updated: 2026-11-15
