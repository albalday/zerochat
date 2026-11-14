# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario: closed 2026-11-10

## M57 Bucle agéntico desatendido en Node.js para --prompt y --conversation: closed 2026-11-10

## M58 Soporte de ejecución de JavaScript (execute_javascript) en Node.js desatendido: closed 2026-11-11

## M59 Habilitar render_chart en Node.js desatendido para visualización en cliente: closed 2026-11-11

## M60 Frontend sin evaluación de permisos: closed 2026-11-11

## M61 Integridad del sistema de permisos: closed 2026-11-12

## M62 Multisesión de un usuario y límites del multiusuario: closed 2026-11-12

## M63 Cambios pequeños y pruebas: closed 2026-11-13

## M64 Modularización del backend Python: closed 2026-11-13

## M65 Aislamiento de las ejecuciones en servidor: closed 2026-11-13

## M66 Coordinadores del frontend: closed 2026-11-13

## M67 Arreglos de estabilización: closed 2026-11-13

## M68 Arreglos pequeños 2: closed 2026-11-14

## M69 Esperas y comandos a la vista

Goal: Que la persona vea lo que hacen los comandos en segundo plano y las esperas, y que el agente pueda esperar dentro de su turno por tiempo, por un texto en la salida o por el final de un comando, sin herramientas nuevas y sin despertar turnos acabados, según el planteamiento de docs/M69-notificaciones.md.
Done when: `check_command` vuelve antes de tiempo cuando la salida nueva cumple `pattern` e indica por qué volvió; sin `job_id` espera sin lanzar ningún proceso; mientras espera, su tarjeta muestra la salida según llega y permite cortar la espera; la tarjeta plegada de un comando en marcha muestra su última línea; el aviso de comandos en marcha del final del chat refleja el final de cada comando aunque el turno haya acabado; los topes nuevos tienen su prueba en N y N+1; ayuda en español e inglés sincronizada y pasan las pruebas aplicables (§4).
- [x] M69-T1 Cerrar con el usuario las decisiones abiertas de docs/M69-notificaciones.md §5 (espera sin shell, plazo máximo, botón de detener durante la espera, señal del fin de un comando) y registrarlas en log.md (2026-11-14)
- [x] M69-T2 `pattern` en `check_command` (`py/tools/jobs.py`, `py/tools/registry.py`): expresión regular sin distinguir mayúsculas sobre la salida nueva, línea a línea; el resultado indica el motivo (`returned_because`: `pattern_matched`, `command_finished`, `wait_elapsed`) y la línea que coincidió (`matched_line`); tope de longitud en el borde y error claro si no es válida; pruebas en `tests/infrastructure/py/test_run_command.py` (2026-11-14)
- [x] M69-T3 Espera sin shell: `check_command` sin `job_id` espera `wait_seconds` sin lanzar ningún proceso y vuelve antes si termina un comando en segundo plano del proyecto; en una ejecución en servidor el tiempo de espera se suma al plazo total y el corte por inactividad sube de 180 s a 600 s (M69-D1); pruebas (2026-11-14)
- [x] M69-T4 Tarjeta viva para `check_command` (`js/mcp.js`, `js/command-card.js`): mientras espera muestra la salida nueva, el tiempo transcurrido y el patrón, y su botón corta la espera sin detener el comando; pruebas en `tests/browser/` (2026-11-14)
- [x] M69-T5 Última línea de salida de cada comando en marcha en el latido (recortada, con su tope en el borde) y en la tarjeta plegada de `run_command` (2026-11-14)
- [x] M69-T6 El aviso de comandos en marcha del final del chat (`js/ui-command-jobs.js`) se actualiza cuando un comando termina, con código de salida, duración y últimas líneas, aunque el turno haya acabado (2026-11-14)
- [x] M69-T7 Ayuda bilingüe y contratos (`py/README.md`): esperas de `check_command`, y cómo planificar tareas largas por fuera con `zerochat --prompt` y `cron` (2026-11-14)
