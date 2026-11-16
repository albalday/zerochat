# Plan

<!-- Hitos M1 a M69 archivados en .zerochat/archive/ -->

## M70 Arreglos de run_command: closed 2026-11-14

## M71 Navegador de ficheros del proyecto: closed 2026-11-14

## M72 Catálogo de servicios MCP con versión independiente

Goal: Sacar de `zerochat.py` los ficheros de los servicios MCP incluidos (`py/mcp/managed_services.py`) y publicarlos como catálogo versionado junto a la interfaz, para actualizar un servicio sin publicar en PyPI; las herramientas locales se quedan en el host.
Done when: `services/manifest.json` (generado por `scripts/build-managed-services.mjs`) lista cada servicio incluido con su `version` y sus ficheros; `McpServiceManager` lo descarga de la carpeta de la interfaz, actualiza en `<data_dir>/services/<id>` los que cambian de versión y reinicia los que estaban en marcha; `py/mcp/managed_services.py` desaparece; contratos y ayuda bilingüe al día, y pasan todas las pruebas aplicables (§4).
- [x] M72-T1 [Argon · Medium] Contrato de MCP `builtin` y `version` en `service.json`: nombres públicos sin prefijo en `py/mcp/manager.py` y `js/mcp.js` (con rechazo de colisiones), inyección de `_meta.workspaceDir` en `tools/call`, evaluación de permisos de proyecto en `ACCESS_CONTROLLER` y soporte de `annotations.readOnlyHint` en `delegate_task`; pruebas (dropped: las herramientas de ficheros están atadas al host (resolutor único de rutas, validación de argumentos, permisos y diff) y extraerlas obligaba a duplicar ese contrato para ganar solo actualizarlas sin PyPI; se quedan en el host (2026-11-16))
- [x] M72-T2 [Argon · Medium] Catálogo `services/manifest.json` y auto-refresco por versión: `scripts/build-managed-services.mjs` genera el manifiesto en lugar de `py/mcp/managed_services.py` (que se elimina), y `McpManager` actualiza en `<data_dir>/services/<id>` los servicios cuya versión cambie y los reinicia si estaban en marcha; pruebas (2026-11-16)
- [x] M72-T3 [Hydrogen · Medium] Extracción de `browser_action` a servicio MCP `builtin` en `services/browser_action/`: servidor `stdio` propio, reserva en `BROWSER_LEASES`, disponibilidad en `py/browser/engines.py` y eliminación de `py/tools/browser_action.py` y de su entrada en `LOCAL_TOOLS_DEFINITIONS`; pruebas (dropped: las herramientas de ficheros están atadas al host (resolutor único de rutas, validación de argumentos, permisos y diff) y extraerlas obligaba a duplicar ese contrato para ganar solo actualizarlas sin PyPI; se quedan en el host (2026-11-16))
- [x] M72-T4 [Hydrogen · Medium] Extracción de `list_directory`, `read_file`, `write_file`, `edit_file`, `search_files` y `get_diagnostics` a servicio MCP `builtin` en `services/workspace/`: uso de `_meta.workspaceDir` y `readOnlyHint`, retirada de las seis herramientas de `LOCAL_TOOLS_DEFINITIONS` y limpieza de `py/tools/filesystem.py`; pruebas (dropped: las herramientas de ficheros están atadas al host (resolutor único de rutas, validación de argumentos, permisos y diff) y extraerlas obligaba a duplicar ese contrato para ganar solo actualizarlas sin PyPI; se quedan en el host (2026-11-16))
- [x] M72-T5 [Hydrogen · Low] Limpieza de ramas obsoletas en `py/tools/registry.py` y `py/server/handler.py`, recompilación de `zerochat.py` y actualización de contratos (`py/README.md`, `js/tools/README.md`) y ayuda bilingüe (`help/`) (dropped: las herramientas de ficheros están atadas al host (resolutor único de rutas, validación de argumentos, permisos y diff) y extraerlas obligaba a duplicar ese contrato para ganar solo actualizarlas sin PyPI; se quedan en el host (2026-11-16))
- [ ] M72-T6 [Posible] search_files usa la consulta del modelo como expresión regular de Python: re no suelta el GIL y una consulta como (a+)+$ contra una línea larga bloquearía el servidor. Como sigue en el host, decidir entre texto fijo (como check_command, M73-D5), buscar en un proceso aparte con plazo o rechazar grupos repetidos anidados
- [ ] M72-T7 El runner de Node descarga entera la interfaz en cada ejecución (la caché solo sirve sin red y las peticiones no llevan comprobación de caché): medir primero lo que tarda desde GitHub Pages con una línea en el registro y, si compensa, guardar en la caché la versión con la que se descargó y, con una sola petición de la versión publicada, ejecutar la caché si coincide o descargar todo si no; en desarrollo descarga siempre; pruebas de misma versión sin pedir módulos, versión distinta, servidor de versión caído y desarrollo
- [x] M72-T8 Ajustar textos del modo proyecto y prompt de simplificación de memoria para trabajo multiagente y retención de invariantes en log.md (2026-11-16)

## M73 Arreglos de seguridad: closed 2026-11-15

## M74 Arreglos multiplataforma de la 10.19.0: closed 2026-11-16
