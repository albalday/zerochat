# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

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

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0

Goal: Que la CI de Windows y macOS vuelva a verde tras M73 y que el runner de Node de `--prompt`, `--conversation` y «Ejecutar en servidor» funcione en las tres plataformas, para publicar la siguiente versión del backend (10.20.0).
Done when: el motivo por el que termina el runner de Node aparece en el error de la ejecución; las ejecuciones con Node real pasan en Linux, Windows y macOS; las pruebas de infraestructura pasan en las tres plataformas sin saltarse ninguna nueva; la 10.20.0 está en master y en PyPI con la CI en verde.
- [x] M74-T1 El error «el runner se cerró sin resultado» lleva las últimas líneas de la salida de error del runner de Node, que hoy se descarta (stderr a DEVNULL en `launch_node_runner`); prueba (2026-11-15)
- [x] M74-T2 El runner de Node termina sin resultado en Windows y macOS (código 2 en las pruebas con Node real de `test_runner_loader.py`): diagnosticar con M74-T1 en la CI y corregir (2026-11-15)
- [x] M74-T3 Pruebas de infraestructura que fallan en Windows: tope de tamaño del cargador en el borde exacto, espera de `check_command` contada en una ejecución y carpeta temporal del modo desarrollo que no se puede borrar (2026-11-15)
