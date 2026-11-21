# M83 Avisos de las ejecuciones en servidor: planteamiento (M83-T9)

Borrador para decidir antes de implementar. Objetivo: que el servidor de la interfaz se entere
de los cambios de una ejecución `--conversation` (progreso, petición de permiso, final, caída)
cuando ocurren, y retirar los dos sondeos de 1 s que quedan en producción.

## 1. Qué pasa hoy

Una ejecución en segundo plano es otro proceso `zerochat --conversation <id>`. Su estado solo
existe en SQLite (tabla `runs`), que escribe `write_run_state` en cada paso. El servidor de la
interfaz no recibe ningún aviso. Por eso, mientras alguna ejecución figura en marcha:

| Dónde | Qué hace | Constante |
|---|---|---|
| `wait_live_state` (`py/server/state.py`), el long-poll del latido | En vez de esperar 25 s al cambio, se despierta cada segundo para releer SQLite | `_EXTERNAL_RUN_POLL_SECONDS` |
| `heartbeat_watchdog` | Con el navegador ya cerrado, comprueba cada segundo si la ejecución ha terminado para apagar el servidor | `_WATCHDOG_RUN_RECHECK_SECONDS` |

Cada ejecución en marcha cuesta así una relectura de SQLite por segundo y por latido en espera,
y la interfaz ve los cambios con hasta 1 s de retraso.

Hay además un detalle relacionado: `start_server_run` (`py/run_mode/state.py`) lanza el worker
con `Popen` y descarta el objeto, así que nadie espera al proceso cuando termina.

## 2. Propuesta: una tubería heredada del proceso que la lanza

Casi todas las ejecuciones las lanza el propio servidor de la interfaz (`start_server_run`).
Puede pasarle un canal directo, sin red y sin token:

1. `start_server_run` crea una tubería (`os.pipe()`) y el worker hereda el extremo de
   escritura. En POSIX se pasa con `pass_fds`; en Windows, como handle heredable con
   `STARTUPINFO.lpAttributeList["handle_list"]`. El número llega en una variable de entorno
   (`ZEROCHAT_RUN_NOTIFY`), como ya llegan `ZEROCHAT_RUN_ID` y `ZEROCHAT_RUN_SECURITY`.
2. El worker escribe un byte en ese canal después de cada `write_run_state` (sin bloquearse
   ni fallar si nadie lee).
3. En el servidor de la interfaz, un hilo por ejecución lanzada se bloquea leyendo el canal:
   - cada byte llama a `notify_live_state_changed()`, que ya despierta a los latidos y al
     vigilante; estos recalculan la firma `rev` y solo devuelven si cambió;
   - el fin de fichero (EOF) significa que el worker terminó, por la causa que sea (final,
     error, `kill -9`, caída): se avisa una última vez y se recoge el proceso con `proc.wait()`.
4. `wait_live_state` y `heartbeat_watchdog` solo mantienen la relectura de 1 s mientras hay en
   marcha alguna ejecución **sin canal**. Las que sí lo tienen se reconocen por su `run_id` en
   un registro en memoria de las lanzadas por este proceso.

Lo que queda sin canal, y por eso conserva el sondeo de 1 s:

- una ejecución lanzada a mano desde un terminal (`zerochat --conversation …`) mientras la
  interfaz está abierta;
- una ejecución lanzada por una instancia anterior del servidor que sigue viva tras reiniciar
  la interfaz.

Para estas dos se podría detectar el final, aunque no el progreso, esperando su PID con
`wait_pid_exit` (M83-T8) en un hilo. Lo dejaría fuera salvo que interese.

### Por qué no otras vías

- **RPC del worker al servidor de la interfaz por HTTP**, con la URL y el token en el entorno:
  añade autenticación, reintentos y el caso «servidor ausente», y no detecta una caída
  (`kill -9`) sin otro mecanismo. La tubería da el final por EOF sin código extra.
- **Usar el stdout del worker como canal:** el worker escribe ahí su consola (cabecera y
  registro de peticiones de su runner). Cada línea despertaría a los latidos para nada.
- **Vigilar el fichero de SQLite** (inotify, FSEvents): no es portable y avisa de cualquier
  escritura, no de las de `runs`.
- **Dejarlo como está:** cuesta poco (1 s por ejecución en marcha) y es la referencia si la
  tubería no compensa.

## 3. Alcance estimado

- `py/run_mode/state.py`: la tubería en `start_server_run`, el byte tras `write_run_state` y el
  registro de ejecuciones con canal (unas 60 líneas, con la rama de Windows).
- `py/server/state.py`: el hilo lector y las dos condiciones «hay alguna en marcha sin canal».
- Pruebas (`test_server_runs.py`): un worker falso que escribe en el canal despierta un
  `wait_live_state` de 25 s sin sondear; su EOF despierta al vigilante; una ejecución sin canal
  sigue con la relectura.
- Invariante para `.zerochat/log.md`: «el estado de una ejecución lanzada por este servidor
  llega por su canal; la relectura de 1 s queda solo para las que no tienen canal».

## 4. Preguntas

1. ¿Tubería (recomendado), RPC por HTTP, o dejarlo como está?
2. ¿Hay que cubrir también las ejecuciones lanzadas desde un terminal con la interfaz abierta,
   o basta con que sigan con la relectura de 1 s?
3. ¿Se detecta el final de esas ejecuciones sin canal esperando su PID, o se deja fuera?
