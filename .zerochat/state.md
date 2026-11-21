# Current state
- Milestone: M83 Esperas síncronas en lugar de sondeo (restos tras M81)
- Next task: M83-T12 Backend: usar select.poll en lugar de select.select sobre el descriptor de os.pidfd_open en wait_pid_exit (py/core/process.py) para no depender del límite FD_SETSIZE (1024)
- Last updated: 2026-11-21
