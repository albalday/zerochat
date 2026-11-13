# Current state
- Milestone: M63 Cambios pequeños y pruebas
- Next task: M63-T37 Windows: _pid_alive (py/dd-commands.py) usa os.kill(pid, 0), que en Windows envía Ctrl+C a la consola del proceso y corta zerochat (en CI, KeyboardInterrupt en list_server_runs); comprobarlo con OpenProcess y GetExitCodeProcess, prueba que no envía señal, y volver a ejecutar el trabajo de Windows abriendo una tarea por cada fallo nuevo (CI de M63-T35)
- Last updated: 2026-11-13
