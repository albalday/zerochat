# M69 Esperas y comandos a la vista: planteamiento

Borrador para decidir antes de planificar el detalle. Objetivo: que **la persona vea lo
que hacen los comandos y las esperas**, y que el agente pueda **esperar con criterio**
(un tiempo, un texto en la salida, el final de un comando) dentro de su turno, sin
herramientas nuevas y sin que un turno acabado se despierte solo.

## 1. Fuera de alcance, por decisión

- **Despertar un turno acabado.** Un turno que terminó no vuelve a arrancar solo, y no
  se lanza una ejecución en servidor para una conversación que no se envió al servidor.
- **Tareas largas o planificadas.** Van por fuera: `zerochat --prompt` y
  `zerochat --conversation` ya existen para programarlas con `cron`, `at` o similar.
- **Avisos del sistema** (API `Notification`, push): no se añaden.
- **Herramientas nuevas.** Solo cambian parámetros de `check_command`.

## 2. Qué falla hoy

| Situación | Qué ve la persona | Causa |
|---|---|---|
| `check_command(wait_seconds=…)` esperando | Nada hasta que vuelve (hasta 600 s) | Usa la tarjeta genérica de herramientas; solo `run_command` tiene tarjeta viva (`js/mcp.js`) |
| Comando en segundo plano en marcha | Reloj y estado; la salida, solo si despliega la tarjeta | Plegada, la tarjeta no pide el log (`js/command-card.js`) |
| Un comando termina con el turno ya acabado | La tarjeta del comando cambia de estado, quizá fuera de la vista; el aviso del final del chat no cambia | `ui-command-jobs.js` pinta una foto fija: «No se actualiza» |
| El modelo quiere esperar a un texto («error», «listening») | No puede: `check_command` solo vuelve por tiempo o por fin del comando | Falta el filtro |
| El modelo quiere solo esperar | Lanza `sleep` en una shell, que choca con el plazo por defecto de 30 s de `run_command` | No hay espera sin proceso |

## 3. Propuesta

### 3.1 `check_command` con filtro de texto

```
check_command(job_id, wait_seconds=300, pattern="error|listening on")
```

Vuelve en cuanto una línea nueva de la salida cumple `pattern` (expresión regular, sin
distinguir mayúsculas, como `grep -iE`), además de por tiempo o por fin del comando. El
resultado dice por qué volvió (`returned_because`: `pattern_matched`, `command_finished` o `wait_elapsed`) y trae la línea que
coincidió. Patrón de longitud acotada y error claro si no es una expresión válida.

### 3.2 Espera sin shell

```
check_command(wait_seconds=120)
```

Sin `job_id`, espera ese tiempo sin lanzar ningún proceso, y vuelve antes si termina un
comando en segundo plano de la conversación. Es el `sleep` del agente: dentro del turno,
visible y cancelable. El plazo máximo sigue siendo el de `check_command` (600 s); para
esperar más, el modelo encadena llamadas y la persona lo ve.

### 3.3 La espera a la vista

`check_command` pasa a usar la tarjeta de comandos: mientras espera muestra la salida
nueva del comando según llega, el tiempo que lleva y lo que falta, y el patrón que
busca. El botón de detener corta la espera (no el comando), y la herramienta vuelve con
lo que haya.

### 3.4 La salida de los comandos en segundo plano, sin desplegar

La tarjeta plegada de un comando en marcha muestra su **última línea de salida**, que
llega con el latido junto al estado. Desplegada sigue mostrando el log completo, como hoy.

### 3.5 El final de un comando, visible

El aviso de «comandos en marcha» del final del chat deja de ser una foto fija: cuando un
comando termina, su línea pasa a «terminado» con el código de salida, la duración y las
últimas líneas, aunque el turno ya haya acabado. No se despierta al modelo: se entera
con el siguiente mensaje, como hoy (`buildCommandNotes`).

## 4. Reglas

| Regla | Valor propuesto |
|---|---|
| Longitud de `pattern` | 200 caracteres, con prueba en `N` y `N+1` |
| Sobre qué se busca | Solo la salida nueva desde la última consulta del modelo, línea a línea |
| Plazo de la espera | El actual: `COMMAND_MAX_WAIT` = 600 s |
| Última línea en el latido | Recortada a 200 caracteres |
| Ejecuciones en servidor | La espera cuenta como progreso para el supervisor (hoy corta a los 180 s sin progreso); a comprobar al implementarlo |

## 5. Decisiones abiertas

1. **Espera sin shell:** `check_command` sin `job_id` (recomendado: no añade herramienta
   ni parámetro) o un parámetro propio en otra herramienta.
2. **Plazo máximo de una espera:** mantener 600 s (recomendado) o subirlo.
3. **El botón de detener durante una espera:** corta solo la espera (recomendado) u ofrece
   también detener el comando.
4. **Fin de un comando:** basta con actualizar el aviso del final del chat (recomendado) o
   además se marca la conversación en el historial.
