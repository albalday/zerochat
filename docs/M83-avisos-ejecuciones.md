# M83 Avisos de las ejecuciones en servidor (M83-T9)

Decidido el 2026-11-21. Objetivo: que el servidor de la interfaz se entere de los cambios de una
ejecución `--conversation` sin releer SQLite cada segundo cuando nadie mira su progreso.

## 1. Punto de partida

Una ejecución en segundo plano es otro proceso `zerochat --conversation <id>`. Su estado solo
existe en SQLite (tabla `runs`), que escribe `write_run_state` en cada paso. El servidor de la
interfaz no recibe ningún aviso. Por eso, mientras alguna ejecución figuraba en marcha:

| Dónde | Qué hacía |
|---|---|
| `wait_live_state`, el long-poll del latido | Se despertaba cada segundo para releer SQLite, en vez de esperar 25 s al cambio |
| `heartbeat_watchdog` | Con el navegador ya cerrado, comprobaba cada segundo si la ejecución había terminado para apagar el servidor |

## 2. Lo que cambia en una ejecución y cómo se sabe

| Cambio | Cuándo ocurre | Cómo se entera el servidor de la interfaz |
|---|---|---|
| Final: completada, a la espera del usuario (`needs_input`) o con error | Al guardar el resultado (`_rpc_result`); justo después el worker para su servidor y el proceso termina | Esperando su PID sin sondeo: `watch_run_exit` |
| Caída sin resultado | El proceso termina | Igual; `list_server_runs` la marca en error |
| Progreso (`step_text`) | Con el proceso vivo, en cada `zerochat/run/progress` | No avisa: relectura de 1 s solo mientras la interfaz muestra esa conversación (`focus_run` en marcha) |

`list_server_runs` lanza un hilo por cada ejecución en marcha y viva, que espera su PID con
`wait_pid_exit(pid, None)`: pidfd en Linux, kqueue en macOS y el handle del proceso en Windows.
Al terminar el proceso, ese hilo llama a `notify_live_change()`, que despierta a los latidos en
espera y al vigilante. Recuerda además el proceso (PID y huella de arranque) como terminado:
la interfaz lanza el worker y no lo recoge, así que queda como zombi y `_pid_alive` lo seguiría
dando por vivo.

Vale para cualquier ejecución, también para las lanzadas a mano desde un terminal, sin saber
quién la lanzó. Un pidfd abierto mientras el proceso vive queda fijado a él, así que un PID
reutilizado no confunde la espera.

Donde no se puede esperar un PID (Linux anterior a 5.3, `pid_exit_waitable`), el latido y el
vigilante releen cada segundo con cualquier ejecución en marcha, como antes.

## 3. Por qué no otras vías

- **Una tubería heredada del proceso que la lanza**, con un byte por cada `write_run_state`: el
  progreso llegaría al momento, pero solo para las ejecuciones lanzadas por este servidor, con
  más código y una rama de Windows para heredar el handle. La relectura de 1 s con la
  conversación a la vista ya funciona bien, y solo entonces se ve el progreso.
- **Capturar el stdout o el stderr del worker con una tubería:**
  - ataría el worker al servidor de la interfaz, al que debe sobrevivir: sin lector, el
    siguiente `print` falla con `BrokenPipeError`; con un lector lento, la tubería se llena y
    el worker se bloquea;
  - por ahí sale toda su consola, así que cada línea despertaría a los latidos para nada;
  - el EOF se retrasa si un descendiente hereda esa salida.
- **Una RPC por HTTP del worker al servidor de la interfaz:** añade autenticación, reintentos y
  el caso «servidor ausente», y no detecta una caída (`kill -9`).
