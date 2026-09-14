# Contratos JSON pendientes de implementar

Implementar schemas de catálogo, servidor, instalador y release antes de consumir los ejemplos. Validar tipos, campos obligatorios, enums, IDs y rutas relativas al directorio del catálogo. Las referencias `installer` y `documentation` de una ficha se resuelven desde la raíz `catalog/`, no desde `servers/`. Las rutas `locks/...` se resuelven desde la raíz de release.

Las variables permitidas son referencias tipadas del gestor, no expresiones shell: `serviceDir`, `browsersDir`, `nodeExecutable`, `releaseLock`. Rechazar variables desconocidas. Los argumentos de proceso permanecen como listas.

Los datos de instalación describen cómo obtener el producto; las herramientas y sus inputSchema solo proceden del discovery MCP. No aceptar un catálogo que suplante el inventario vivo de herramientas.

El ejemplo necesita locks de release aún no generados. Validación sintáctica de JSON no equivale a release instalable.
