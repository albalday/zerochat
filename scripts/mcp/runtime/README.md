# Runtime descargable pendiente de implementar

Implementar un paquete Python instalable llamado `zerochat_mcp_host`, tomando como punto de partida el cliente stdio de `scripts/mcp_client.py`. No duplicarlo dentro de `js/ui-mcp.js`.

Módulos previstos: entrada por pipes, catálogo, instaladores, supervisor, cliente stdio y router. El supervisor posee los procesos y sus estados; la UI recibe snapshots saneados. No iniciar servicios al importar módulos o consultar catálogo.

Separar la instalación compartida de un producto de las instancias por conversación. Cada instancia mantiene su sesión MCP, contexto de navegador y tabla de solicitudes. Comprobar capacidad, límites y cierre de las instancias inactivas.

La receta Playwright requiere ejecutores Node/npm/navegador en este paquete descargable. No implementarlos en `zerochat_mcp.py`. Véase `../README.md`.
