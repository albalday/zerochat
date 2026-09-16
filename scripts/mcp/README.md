# Servicios MCP externos

`zmcp.py` mantiene las cuatro herramientas locales sin depender de este directorio. Cuando el usuario pide arrancar los MCP externos, el servidor local descarga y ejecuta `bootstrap.py` para obtener una release verificada.

```text
scripts/
  zmcp.py                    # Servidor local: herramientas locales + router HTTP + puente a bootstrap
  mcp/
    bootstrap.py             # Descarga y ejecuta el host stdio de servicios externos
    services/
      services.json          # Manifiesto de servicios y archivos publicables
      <servicio>.mcp/        # Definición completa de un servicio
        service.json         # Identidad y comando
        installer.json       # Producto y versión exacta
        README.md            # Información humana
```

El servidor local compone la URL de origen combinando la URL base del servidor ZeroChat con la ruta relativa `/scripts/mcp`. Los servicios publicados se declaran en `services/services.json` indicando los archivos de cada servicio. El host descarga estos archivos directamente desde el servidor y carga su `service.json` e `installer.json`. Para añadir un servicio se crea un directorio nuevo con esa nomenclatura y se registra en `services.json`. El instalador declara `type: "none"` cuando el ejecutable ya está disponible, o `type: "npm"` con el paquete y versión exactos cuando debe instalarse.

`services/dummy_mcp.mcp/` es la implementación mínima de referencia: declara el servicio, no requiere instalación y expone la herramienta `echo` por stdio. Permanece desactivado por defecto y las pruebas de infraestructura lo usan directamente desde la release para validar el mismo contrato que seguirá cualquier servicio externo.

`services/playwright.mcp/` es un segundo servicio independiente. Instala una versión exacta del paquete oficial `@playwright/mcp` junto con el Chromium gestionado por Playwright. Declara en `service.json` opciones configurables por el usuario (como la navegación en segundo plano / headless), que se exponen en la interfaz de ZeroChat y se inyectan como argumentos al arrancar el servicio. También queda desactivado por defecto; se instala únicamente cuando el usuario decide iniciarlo.

`services/memory.mcp/` instala el paquete oficial `@modelcontextprotocol/server-memory` y permite persistir conocimiento estructurado (entidades, relaciones y hechos/observaciones) en formato grafo (`memory.jsonl`).

`services/lsp.mcp/` instala el servidor `@axivo/mcp-lsp` para ofrecer análisis estático y navegación de código (búsqueda de símbolos, definición de tipos, referencias cruzadas y jerarquías de llamadas) mediante el protocolo estándar LSP sin requerir la inyección manual de archivos masivos en el contexto.

El host no inicia, instala ni descarga productos mientras solo se usan las herramientas locales. La primera descarga de bootstrap ocurre al solicitar los MCP externos. La instalación de un producto ocurre al solicitar su arranque.

## Seguridad y aislamiento

1. **ZeroChat <> zmcp**: El servidor local solo atiende a orígenes autorizados (`null` para ejecución local `file://`, `https://albalday.github.io`, `127.0.0.1` y `localhost`). Peticiones de otros orígenes se rechazan con HTTP 403 y sin cabeceras CORS. En peticiones POST se exige la cabecera `X-ZeroChat-Client: 1`.
2. **Descarga de releases**: `bootstrap.py` y `zmcp.py` validan que la URL de release pertenezca al repositorio oficial (`https://albalday.github.io/zerochat/`) o a un servidor local de test (`127.0.0.1` / `localhost`).
3. **Aislamiento de servicios externos**: Los servicios externos se comunican exclusivamente a través de tuberías anónimas `stdio` con `bootstrap.py` sin abrir puertos de red. `bootstrap.py` y `zmcp.py` registran rutinas de apagado en cascada (`atexit` y detección de EOF en stdin) para garantizar la terminación de subprocesos al cerrar el servidor principal.

