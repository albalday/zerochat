# ==============================================================================
# Servicios MCP gestionados incluidos en zerochat.py
# ==============================================================================

# Estas rutas son relativas a ~/zerochat/services. Se escriben en cada arranque
# para que los servicios ofrecidos por ZeroChat coincidan con el ejecutable.
MANAGED_SERVICE_FILES: dict[str, str] = {
    "ejemplo/README.md": r'''# Crear un MCP gestionado por ZeroChat

Esta carpeta es la referencia para crear servicios MCP gestionados. La ubicación de producción es el directorio personal del usuario, seguido de `zerochat/services` (por ejemplo, `/home/usuario/zerochat/services`). No uses `~`, `$HOME` ni una ruta relativa como `services/`: primero identifica la ruta absoluta del directorio personal y úsala para localizar este archivo. El nuevo servicio se crea como carpeta hermana de `ejemplo`, nunca dentro de ella.

## Procedimiento obligatorio

1. Lee `README.md`, `service.json` y `installer.json.example` de la carpeta `ejemplo` situada en el directorio de datos de ZeroChat.
2. Consulta solo la documentación oficial del MCP solicitado.
3. Crea una carpeta con un identificador seguro y descriptivo junto a `ejemplo`.
4. Crea `service.json` copiando esta estructura y adapta únicamente los valores necesarios.
5. Crea `installer.json` solo si el MCP se distribuye como paquete npm. Copia `installer.json.example`, fija la versión exacta y declara la versión mínima de Node.js.
6. Añade `help.url` con la página oficial de instalación y etiquetas en español e inglés.
7. No incluyas tokens, contraseñas ni valores privados. Decláralos en `launch.env` con un marcador, por ejemplo `${HOME_ASSISTANT_TOKEN}`.
8. No inicies el servicio. Al terminar, informa de los archivos creados, fuentes oficiales y requisitos pendientes.

## Límites de ZeroChat

ZeroChat gestiona procesos MCP por `stdio`. Puede instalar paquetes npm mediante `installer.json` y arrancarlos con `${nodeExecutable}`. También puede arrancar un ejecutable o script ya disponible con `launch`.

No inventes una configuración para un MCP que requiera OAuth interactivo, transporte remoto HTTP/SSE, Docker, Python u otro instalador no soportado por estos JSON. En ese caso, no crees archivos: explica el requisito y qué soporte faltaría.

## Contratos JSON

- `service.json` es obligatorio. Conserva `schemaVersion`, `id`, textos bilingües, `transport: "stdio"` y `launch`.
- En `launch`, usa `${serviceDir}`, `${nodeExecutable}` o `${pythonExecutable}`; no uses rutas absolutas de usuario.
- `installer.json` es opcional y hoy solo admite `type: "npm"`.
- `help` es opcional, pero debe incluirse en todo servicio creado:

```json
"help": {
  "url": "https://documentacion-oficial.example/install",
  "label": { "es": "Instalación oficial", "en": "Official installation" }
}
```

## Prompt para el usuario

Sustituye únicamente `<nombre-del-mcp>`:

```text
Para instalar el MCP <nombre-del-mcp>, lee primero services/ejemplo/README.md y sigue exactamente sus instrucciones.
```
''',
    "ejemplo/ejemplo_mcp_server.py": r'''#!/usr/bin/env python3
import json
import sys

def reply(req_id, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": req_id}
    if error:
        resp["error"] = error
    else:
        resp["result"] = result
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    try:
        req = json.loads(raw)
    except Exception:
        continue
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params", {})
    if method == "initialize":
        reply(req_id, {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "ZeroChat MCP Example", "version": "1.0.0"},
            "capabilities": {"tools": {}}
        })
    elif method == "tools/list":
        reply(req_id, {"tools": [{
            "name": "echo",
            "description": "Echo back a message for testing.",
            "inputSchema": {
                "type": "object",
                "properties": {"message": {"type": "string", "description": "Message to echo."}},
                "required": ["message"]
            }
        }]})
    elif method == "tools/call":
        if params.get("name") != "echo":
            reply(req_id, error={"code": -32601, "message": "Tool not found"})
            continue
        msg = params.get("arguments", {}).get("message", "")
        reply(req_id, {
            "content": [{"type": "text", "text": f"echo: {msg}"}],
            "isError": False
        })
''',
    "ejemplo/installer.json.example": r'''{
  "schemaVersion": 1,
  "type": "npm",
  "product": {
    "package": "@scope/mcp-package",
    "version": "1.2.3"
  },
  "requirements": {
    "node": {
      "minimumMajor": 18
    }
  }
}
''',
    "ejemplo/service.json": r'''{
  "schemaVersion": 1,
  "id": "ejemplo",
  "displayName": {
    "es": "Ejemplo de MCP",
    "en": "MCP example"
  },
  "description": {
    "es": "Plantilla mínima para crear servicios MCP gestionados por ZeroChat. Muestra el protocolo stdio y la estructura de configuración que debe seguir un nuevo MCP.",
    "en": "Minimal template for creating ZeroChat-managed MCP services. It demonstrates the stdio protocol and configuration structure for a new MCP."
  },
  "help": {
    "url": "help/mcp.html#crear-mcp-con-agente",
    "label": {
      "es": "Guía para crear un MCP gestionado",
      "en": "Guide to creating a managed MCP"
    }
  },
  "enabledByDefault": false,
  "transport": "stdio",
  "launch": {
    "executable": "${pythonExecutable}",
    "args": ["${serviceDir}/ejemplo_mcp_server.py"],
    "cwd": "${serviceDir}",
    "env": {},
    "handshakeTimeoutSeconds": 10
  }
}
''',
    "playwright/service.json": r'''{
  "schemaVersion": 1,
  "id": "playwright",
  "displayName": {
    "es": "Playwright MCP",
    "en": "Playwright MCP"
  },
  "description": {
    "es": "Automatización de navegador mediante el servidor MCP oficial de Playwright.",
    "en": "Browser automation through the official Playwright MCP server."
  },
  "enabledByDefault": false,
  "transport": "stdio",
  "launch": {
    "executable": "${nodeExecutable}",
    "args": ["${serviceDir}/node_modules/@playwright/mcp/cli.js", "--browser=chromium"],
    "cwd": "${serviceDir}",
    "env": {},
    "handshakeTimeoutSeconds": 30
  },
  "options": [
    {
      "id": "headless",
      "type": "boolean",
      "label": {
        "es": "Navegación en segundo plano (Headless)",
        "en": "Headless background mode"
      },
      "description": {
        "es": "Desactívalo para ver la ventana del navegador durante la automatización",
        "en": "Disable to display the browser window during automation"
      },
      "default": true,
      "argsWhenTrue": ["--headless"],
      "argsWhenFalse": []
    }
  ]
}

''',
    "playwright/installer.json": r'''{
  "schemaVersion": 1,
  "type": "npm",
  "product": {
    "package": "@playwright/mcp",
    "version": "0.0.81",
    "browser": "chromium"
  },
  "requirements": {
    "node": {
      "minimumMajor": 18
    }
  }
}
''',
    "memory/service.json": r'''{
  "schemaVersion": 1,
  "id": "memory",
  "displayName": {
    "es": "Memoria y Grafos (Knowledge Graph)",
    "en": "Memory & Knowledge Graph"
  },
  "description": {
    "es": "Almacenamiento persistente de entidades, preferencias y contexto histórico estructurado en un grafo de conocimiento.",
    "en": "Persistent storage of entities, preferences, and historical context structured as a knowledge graph."
  },
  "enabledByDefault": false,
  "transport": "stdio",
  "launch": {
    "executable": "${nodeExecutable}",
    "args": ["${serviceDir}/node_modules/@modelcontextprotocol/server-memory/dist/index.js"],
    "cwd": "${serviceDir}",
    "env": {
      "MEMORY_FILE_PATH": "${serviceDir}/memory.jsonl"
    },
    "handshakeTimeoutSeconds": 30
  }
}

''',
    "memory/installer.json": r'''{
  "schemaVersion": 1,
  "type": "npm",
  "product": {
    "package": "@modelcontextprotocol/server-memory",
    "version": "2026.8.31"
  },
  "requirements": {
    "node": {
      "minimumMajor": 18
    }
  }
}
''',
}


def materialize_managed_services(services_root: Path | None = None) -> None:
    """Instala siempre los archivos gestionados sin borrar datos ni servicios del usuario."""
    root = Path(services_root) if services_root else get_data_dir() / "services"
    for relative_path, content in MANAGED_SERVICE_FILES.items():
        destination = root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")
