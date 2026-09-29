# Crear un MCP gestionado por ZeroChat

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
