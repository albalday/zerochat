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
- [ ] M72-T6 [Posible] search_files usa la consulta del modelo como expresión regular de Python: re no suelta el GIL y una consulta como (a+)+$ contra una línea larga bloquearía el servidor. Decidir al extraerla (M72-T4): buscar en un proceso aparte con plazo, rechazar grupos repetidos anidados o dejarlo si el servicio MCP propio ya lo aísla

## M73 Arreglos de seguridad

Goal: Corregir los fallos y riesgos del análisis del backend posterior a la 10.15.0 (sandbox de JavaScript, estáticos del servidor de desarrollo, aprobaciones de un solo uso, esperas y navegador de ficheros) y reducir la complejidad de los despachadores y de las herramientas de comandos y ficheros sin cambiar su comportamiento.
Done when: el código de `execute_javascript` en el servidor no alcanza el proceso anfitrión y una prueba lo intenta con los objetos heredados; el servidor de desarrollo no sirve ninguna ruta fuera de su lista cerrada tras resolverla; una aprobación «solo esta vez» de una ejecución reanudada vale solo para la llamada aprobada; un patrón de `check_command` no puede dejar un hilo colgado; los riesgos menores están corregidos o aceptados de forma expresa en log.md; las simplificaciones no cambian ninguna respuesta de la API; pasan las pruebas aplicables (§4) y la ayuda y los contratos están al día.
- [x] M73-T1 Sandbox de `execute_javascript` en el servidor (`py/tools/sandbox.py`, y la vía local de `js/sandbox.js` si comparte el fallo): crear los objetos dentro del contexto en lugar de pasar los del proceso anfitrión, de modo que `Object.constructor('return process')()` no devuelva el `process` real ni dé acceso a la red; pruebas de escape con los objetos heredados (`Object`, `Array`, `Promise`, `console`) en `tests/infrastructure/py/test_sandbox.py` (2026-11-15)
- [x] M73-T2 Estáticos solo en desarrollo y solo para el propio equipo: el modo desarrollo exige que `zerochat.py` esté dentro del repositorio, no que la carpeta actual lo parezca (`get_dev_root` en `py/core/environment.py`); los estáticos solo se sirven a clientes de una dirección local; se retira la lista cerrada de `serve_static_file` (`py/server/handler.py`) y se sirve lo que hay bajo la raíz salvo ficheros ocultos y rutas que al resolverse salen de ella; pruebas de cada condición (2026-11-15)
- [x] M73-T3 «Permitir solo esta vez» no guarda nada: se retira `one_time_tools` del servidor (`apply_tool_decision` y `evaluate_authorization` en `py/security/controller.py`), de modo que esa decisión no se almacena ni en sesión ni de forma permanente ni se reaplica al rotar el token; al reanudar una ejecución en servidor la decisión viaja con los argumentos aprobados y el runner solo contesta al reto de esa misma llamada (nombre y argumentos con las claves ordenadas); pruebas: hoy pasa una llamada con otros argumentos, con el cambio se pausa, y la rotación no la concede (2026-11-15)
- [x] M73-T4 `pattern` de `check_command` (`py/tools/jobs.py`): pasa de expresión regular a uno o varios textos separados por `|`, buscados sin distinguir mayúsculas, porque `re` no suelta el GIL y una expresión con retroceso catastrófico bloqueaba todo el servidor y la espera no se podía cortar; prueba con `(a+)+$` sobre una línea que como expresión tardaría horas (2026-11-15)
- [x] M73-T5 Navegador de ficheros (`py/tools/project_files.py`): aplicar el tope de entradas sin cargar ni ordenar toda la carpeta, leer el fichero una sola vez en `read_project_file`, y decidir con el usuario si la raíz debe limitarse a proyectos conocidos (hoy vale cualquier carpeta de `X-ZeroChat-Project`) o aceptarlo y registrarlo (dropped: el usuario quiere poder navegar a cualquier carpeta del sistema: se identifica con su cuenta de Linux y puede leer lo mismo por otras vías)
- [x] M73-T6 Riesgos menores, a decidir con el usuario y registrar en log.md: token del runner visible en los argumentos del proceso (pasarlo por entorno o stdin) y cookie de sesión del servidor de desarrollo compartida entre puertos de `127.0.0.1` (dropped: riesgos aceptados por el usuario de momento: token del runner visible en los argumentos del proceso en equipos con varias cuentas, y cookie de sesión del servidor de desarrollo legible desde otras páginas de 127.0.0.1 (por ejemplo ComfyUI), con el servidor aceptando como origen cualquier puerto local; en producción la cookie vive en GitHub Pages y no se ve afectada)
- [x] M73-T7 `read_file(tail_lines)` no recorre el fichero entero: retirar o abaratar `total_lines` (`_count_lines` en `py/tools/filesystem.py`); `RunSession.begin_wait`/`end_wait` admite esperas simultáneas (`py/run_mode/state.py`); pruebas (dropped: el recuento de total_lines cuesta 0,12 s con un log de 476 MB en caché y solo se notaría con logs de varios GB leídos en frío; y dos esperas simultáneas en una ejecución no pueden ocurrir, porque el agente ejecuta las herramientas de un paso en serie y el servidor de una ejecución solo atiende a su runner (retomarlo si algún día se ejecutan en paralelo))
- [x] M73-T8 Despachadores como tabla método → función, sin cambiar ninguna respuesta: `_dispatch_local` (`py/server/handler.py`, complejidad 29) y `dispatch_run` (`py/run_mode/state.py`, 28); los despachadores de dominio salen de `handler.py` a su paquete, como `dispatch_files` (2026-11-15)
- [x] M73-T9 Esperas: la espera de `check_command` a un comando y el registro de esperas cortables pasan a `py/tools/job_waits.py`; `check_command` exige `job_id` (se quita la espera sin comando, que no tiene sentido en el servidor ni en `--prompt`) y `wait_seconds` es un máximo; nueva herramienta nativa `wait` (`seconds` o `until` HH:MM[:SS], hasta 24 h) en el navegador, cortada por «Detener», con su tarjeta siempre visible y no disponible en el runner sin interfaz (2026-11-15)
- [x] M73-T10 Reducir la complejidad de `run_session_from_args` (`py/cli/main.py`, 26) separando la validación de argumentos de la construcción de la sesión, y de `get_diagnostics` y `search_files` (`py/tools/filesystem.py`, 23 y 22) extrayendo el recorrido de ficheros que repiten (2026-11-15)
- [x] M73-T11 Ampliar las reglas de `ruff` de la CI con las de fallos y seguridad que hoy pasan limpias y un umbral de complejidad que impida empeorar, y actualizar `py/README.md` (2026-11-15)
- [x] M73-T12 CA del reverse proxy en el runner de Node, a debatir con el usuario: permitir que `minimal_child_env()` (`py/core/environment.py`) reenvíe `NODE_EXTRA_CA_CERTS` cuando esté definida en `os.environ` (opcionalmente validando que el fichero exista) para que `launch_node_runner` (`py/run_mode/supervisor.py`) con `--permission` pueda conectar con modelos locales tras un proxy con CA propia; valorar también alternativas (`--use-system-ca` según versión de Node o parámetro CLI) y registrar la decisión en `log.md` (2026-11-15)
- [x] M73-T13 Rechazar en el servidor HTTP cualquier URL con un segmento `..`, a discutir con el usuario: hoy ninguna ruta legítima lo lleva, pero el servidor las acepta y cada consumidor decide por su cuenta (`serve_static_file` resuelve la ruta; `do_POST` busca `/mcp/external` dentro de la ruta sin normalizar). Decidir el alcance (GET, POST y OPTIONS; también `%2e%2e` y la barra invertida), la respuesta (400 antes de leer el cuerpo y de mirar el token) y si sustituye o se suma a M73-T2; prueba con rutas sin normalizar (2026-11-15)
- [x] M73-T14 Simplificar la distribución y el montaje de `runner.js` (el usuario lo llamó runner.sh): hoy se genera con esbuild, se versiona en el repositorio, se publica en GitHub Pages y el servidor lo descarga con caché y tope de tamaño, y dos olvidos de `npm run build:runner` en M68 dejaron la copia desincronizada; revisar con el usuario qué partes sobran y proponer un montaje con menos pasos (2026-11-15)
- [x] M73-T15 Una espera de comando no termina: «Dejar de esperar» y detener el turno no cortaban una espera de `check_command`, porque `call_tool` (`py/server/tool_calls.py`) solo pasaba la clave de la invocación (`_meta.zerochatJobKey`) a `run_command`; pasársela también a `check_command`, con una prueba por `tools/call` como en uso real (2026-11-15)
- [ ] M73-T16 Repasar los permisos de `--prompt` y `--conversation` con el usuario: qué aprueba cada modo sin preguntar (`answerToolApprovals` en `js/run-mode.js`: `allow_session` para todo salvo las herramientas peligrosas en modo clásico), qué hace `--allow-dangerous-tools` y qué capa de seguridad aplica `tool_security`; decidir qué cambia y registrarlo
- [ ] M73-T17 Fallo intermitente en infraestructura: «zerochat.py --prompt: arranque normal…» (tests/infrastructure/test_backend_run_mode.js) acaba a veces con «Fatal Python error: _enter_buffered_busy: could not acquire lock for <stdout> at interpreter shutdown, possibly due to daemon threads»; un hilo daemon escribe en stdout mientras sale el intérprete. Visto 1 de 6 pasadas
- [ ] M73-T18 --prompt sin --conversation termina con error 1 desde M68-T4: la credencial del runner solo permite zerochat/conversations/save de la conversación de --conversation, y con --prompt solo no hay ninguna (403 al guardar tras la respuesta del modelo). Las pruebas de arranque no lo ven porque sustituyen Node por un guion; añadir una prueba con Node real
