# Servicios MCP externos

`zmcp.py` mantiene las cuatro herramientas locales sin depender de este directorio. Cuando el usuario pide arrancar los MCP externos, el servidor local ejecuta `bootstrap/bootstrap.py`. En desarrollo, el bootstrap copia este árbol; en producción descarga una release verificada.

```text
scripts/mcp/
  bootstrap/                 # descarga/copia la release y crea ~/.zerochat/mcp/env
  runtime/                   # host que gestiona procesos MCP stdio
  services/
    <servicio>.mcp/          # definición completa de un servicio
      service.json           # identidad y comando
      installer.json         # producto y versión exacta
      README.md              # información humana
  release/                   # construye release.json con hashes
```

No hay un catálogo central con la definición de productos. El host descubre cada directorio `*.mcp` y carga su `service.json` e `installer.json`. Para añadir un servicio se crea un directorio nuevo con esa nomenclatura; no se modifica código Python, JavaScript ni una lista de funciones. El instalador declara `type: "none"` cuando el ejecutable ya está disponible, o `type: "npm"` con el paquete y versión exactos cuando debe instalarse.

`services/dummy_mcp.mcp/` es la implementación mínima de referencia: declara el servicio, no requiere instalación y expone la herramienta `echo` por stdio. Permanece desactivado por defecto y las pruebas de infraestructura lo usan directamente desde la release para validar el mismo contrato que seguirá cualquier servicio externo.

`services/playwright.mcp/` es un segundo servicio independiente. Instala una versión exacta del paquete oficial `@playwright/mcp` junto con el Chromium gestionado por Playwright y lo ejecuta en modo headless. También queda desactivado por defecto; se instala únicamente cuando el usuario decide iniciarlo.

El host no inicia, instala ni descarga productos mientras solo se usan las herramientas locales. La primera descarga de bootstrap ocurre al solicitar los MCP externos. La instalación de un producto ocurre al solicitar su arranque.
