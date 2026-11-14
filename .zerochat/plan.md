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

## M69 Esperas y comandos a la vista: closed 2026-11-14

## M70 Arreglos de run_command

Goal: Que un modelo poco hábil no pierda ni duplique trabajo con `run_command`: que vea siempre el resultado de una herramienta que falla, que un comando que agota su plazo siga en segundo plano en lugar de morir, que la salida de los programas llegue en vivo, que se le avise al relanzar un comando que ya está en marcha y que las descripciones le den ejemplos concretos, según el análisis de la conversación «Ejecuta bego-plata» (generación de ComfyUI de ~20 minutos).
Done when: el modelo recibe la salida y el aviso de un `run_command` que falla o agota su plazo, no «Unknown error executing tool.»; un comando en primer plano que agota su plazo pasa a segundo plano con su `job_id`; los comandos se lanzan con `PYTHONUNBUFFERED=1`; un comando idéntico a uno en marcha en el proyecto lo indica en su resultado; las descripciones y notas de `run_command` y `check_command` dan ejemplos concretos; pasan las pruebas aplicables (§4) y la ayuda en español e inglés está al día.
- [x] M70-T1 El modelo recibe el contenido de una herramienta MCP que devuelve `isError` (`js/mcp-results.js`, `js/agent-core.js` `toToolMessageContent`): hoy un `run_command` con código distinto de 0 o plazo agotado le llega como «Unknown error executing tool.»; prueba en `tests/integration/` (2026-11-14)
- [x] M70-T2 Un `run_command` en primer plano que agota su plazo pasa a segundo plano en lugar de matarse (`py/tools/jobs.py`): devuelve `status: running`, su `job_id` y una nota; la tarjeta lo muestra en segundo plano; pruebas en `tests/infrastructure/py/test_run_command.py` (2026-11-14)
- [x] M70-T3 Los comandos se lanzan con `PYTHONUNBUFFERED=1` para que la salida de los programas Python llegue en vivo; prueba con un `print` sin `flush` (2026-11-14)
- [x] M70-T4 Un `run_command` idéntico a otro en marcha en el mismo proyecto lo indica en su resultado (`job_id` del que sigue); prueba (2026-11-14)
- [x] M70-T5 Descripciones y notas de `run_command` y `check_command` con ejemplos concretos: segundo plano desde el principio para tareas de minutos, `check_command(job_id, wait_seconds=600, pattern="error|Traceback")`, aviso cuando una espera vuelve sin salida nueva y cómo seguir un comando hasta que termine; ayuda bilingüe al día (2026-11-14)
