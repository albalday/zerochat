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

## M73 Arreglos de seguridad: closed 2026-11-15
