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

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Extracción de herramientas locales a servicios MCP propios con versión independiente

Goal: Reducir `zerochat.py` a host estable (HTTP/RPC, seguridad, almacenamiento, trabajos de terminal y gestor MCP) extrayendo sus herramientas locales a servicios MCP `stdio` propios en `services/` con versión independiente y auto-refresco, sin mantener código ni formatos de compatibilidad hacia atrás.
Done when: `service.json` incluye `version` y soporta `builtin: true` (nombres de herramientas sin prefijo `<serverId>_`, paso de `_meta.workspaceDir`, evaluación de permisos del proyecto y `readOnlyHint` para `delegate_task`); `py/mcp/managed_services.py` desaparece de `zerochat.py` y `McpManager` sincroniza y reinicia automáticamente los servicios incluidos desde `services/manifest.json` cuando cambia su versión; `browser_action` y las seis herramientas de ficheros/diagnóstico viven como MCP `builtin` en `services/` y desaparecen de `LOCAL_TOOLS_DEFINITIONS`; contratos y ayuda bilingüe al día, y pasan todas las pruebas aplicables (§4).
- [ ] M72-T1 [Argon · Medium] Contrato de MCP `builtin` y `version` en `service.json`: nombres públicos sin prefijo en `py/mcp/manager.py` y `js/mcp.js` (con rechazo de colisiones), inyección de `_meta.workspaceDir` en `tools/call`, evaluación de permisos de proyecto en `ACCESS_CONTROLLER` y soporte de `annotations.readOnlyHint` en `delegate_task`; pruebas
- [ ] M72-T2 [Argon · Medium] Catálogo `services/manifest.json` y auto-refresco por versión: `scripts/build-managed-services.mjs` genera el manifiesto en lugar de `py/mcp/managed_services.py` (que se elimina), y `McpManager` actualiza en `<data_dir>/services/<id>` los servicios cuya versión cambie y los reinicia si estaban en marcha; pruebas
- [ ] M72-T3 [Hydrogen · Medium] Extracción de `browser_action` a servicio MCP `builtin` en `services/browser_action/`: servidor `stdio` propio, reserva en `BROWSER_LEASES`, disponibilidad en `py/browser/engines.py` y eliminación de `py/tools/browser_action.py` y de su entrada en `LOCAL_TOOLS_DEFINITIONS`; pruebas
- [ ] M72-T4 [Hydrogen · Medium] Extracción de `list_directory`, `read_file`, `write_file`, `edit_file`, `search_files` y `get_diagnostics` a servicio MCP `builtin` en `services/workspace/`: uso de `_meta.workspaceDir` y `readOnlyHint`, retirada de las seis herramientas de `LOCAL_TOOLS_DEFINITIONS` y limpieza de `py/tools/filesystem.py`; pruebas
- [ ] M72-T5 [Hydrogen · Low] Limpieza de ramas obsoletas en `py/tools/registry.py` y `py/server/handler.py`, recompilación de `zerochat.py` y actualización de contratos (`py/README.md`, `js/tools/README.md`) y ayuda bilingüe (`help/`)

## M73 Arreglos de seguridad

Goal: Corregir los fallos y riesgos del análisis del backend posterior a la 10.15.0 (sandbox de JavaScript, estáticos del servidor de desarrollo, aprobaciones de un solo uso, esperas y navegador de ficheros) y reducir la complejidad de los despachadores y de las herramientas de comandos y ficheros sin cambiar su comportamiento.
Done when: el código de `execute_javascript` en el servidor no alcanza el proceso anfitrión y una prueba lo intenta con los objetos heredados; el servidor de desarrollo no sirve ninguna ruta fuera de su lista cerrada tras resolverla; una aprobación «solo esta vez» de una ejecución reanudada vale solo para la llamada aprobada; un patrón de `check_command` no puede dejar un hilo colgado; los riesgos menores están corregidos o aceptados de forma expresa en log.md; las simplificaciones no cambian ninguna respuesta de la API; pasan las pruebas aplicables (§4) y la ayuda y los contratos están al día.
- [x] M73-T1 Sandbox de `execute_javascript` en el servidor (`py/tools/sandbox.py`, y la vía local de `js/sandbox.js` si comparte el fallo): crear los objetos dentro del contexto en lugar de pasar los del proceso anfitrión, de modo que `Object.constructor('return process')()` no devuelva el `process` real ni dé acceso a la red; pruebas de escape con los objetos heredados (`Object`, `Array`, `Promise`, `console`) en `tests/infrastructure/py/test_sandbox.py` (2026-11-15)
- [ ] M73-T2 Estáticos del servidor de desarrollo (`serve_static_file` en `py/server/handler.py`): aplicar la lista cerrada a la ruta ya resuelta, para que `/js/../todo.txt` y similares respondan 404; prueba en `tests/infrastructure/test_local_server.js` con rutas sin normalizar
- [ ] M73-T3 Aprobación «solo esta vez» de una ejecución reanudada (`apply_tool_decision` y `one_time_tools` en `py/security/controller.py`): confirmar con una prueba que hoy vale para cualquier llamada a esa herramienta y ligarla a los argumentos aprobados; que la rotación del token a medianoche no la conceda de nuevo
- [ ] M73-T4 `pattern` de `check_command` (`py/tools/jobs.py`): acotar la longitud de línea que se compara para que una expresión catastrófica no deje un hilo colgado ni una espera imposible de cortar; prueba en el borde
- [ ] M73-T5 Navegador de ficheros (`py/tools/project_files.py`): aplicar el tope de entradas sin cargar ni ordenar toda la carpeta, leer el fichero una sola vez en `read_project_file`, y decidir con el usuario si la raíz debe limitarse a proyectos conocidos (hoy vale cualquier carpeta de `X-ZeroChat-Project`) o aceptarlo y registrarlo
- [ ] M73-T6 Riesgos menores, a decidir con el usuario y registrar en log.md: token del runner visible en los argumentos del proceso (pasarlo por entorno o stdin) y cookie de sesión del servidor de desarrollo compartida entre puertos de `127.0.0.1`
- [ ] M73-T7 `read_file(tail_lines)` no recorre el fichero entero: retirar o abaratar `total_lines` (`_count_lines` en `py/tools/filesystem.py`); `RunSession.begin_wait`/`end_wait` admite esperas simultáneas (`py/run_mode/state.py`); pruebas
- [ ] M73-T8 Despachadores como tabla método → función, sin cambiar ninguna respuesta: `_dispatch_local` (`py/server/handler.py`, complejidad 29) y `dispatch_run` (`py/run_mode/state.py`, 28); los despachadores de dominio salen de `handler.py` a su paquete, como `dispatch_files`
- [ ] M73-T9 Esperas de `check_command` en un módulo propio (`_wait_job`, `_plain_wait` y el registro de esperas cortables salen de `py/tools/jobs.py`), sin cambiar su comportamiento
- [ ] M73-T10 Reducir la complejidad de `run_session_from_args` (`py/cli/main.py`, 26) separando la validación de argumentos de la construcción de la sesión, y de `get_diagnostics` y `search_files` (`py/tools/filesystem.py`, 23 y 22) extrayendo el recorrido de ficheros que repiten
- [ ] M73-T11 Ampliar las reglas de `ruff` de la CI con las de fallos y seguridad que hoy pasan limpias y un umbral de complejidad que impida empeorar, y actualizar `py/README.md`
- [ ] M73-T12 CA del reverse proxy en el runner de Node, a debatir con el usuario: permitir que `minimal_child_env()` (`py/core/environment.py`) reenvíe `NODE_EXTRA_CA_CERTS` cuando esté definida en `os.environ` (opcionalmente validando que el fichero exista) para que `launch_node_runner` (`py/run_mode/supervisor.py`) con `--permission` pueda conectar con modelos locales tras un proxy con CA propia; valorar también alternativas (`--use-system-ca` según versión de Node o parámetro CLI) y registrar la decisión en `log.md`
