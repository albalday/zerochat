# Crear un MCP gestionado por ZeroChat

Esta carpeta es la referencia para crear servicios MCP gestionados. La ubicación de producción es el directorio personal del usuario, seguido de `zerochat/services` (por ejemplo, `/home/usuario/zerochat/services`). No uses `~`, `$HOME` ni una ruta relativa como `services/`: primero identifica la ruta absoluta del directorio personal y úsala para localizar este archivo. El nuevo servicio se crea como carpeta hermana de `ejemplo`, nunca dentro de ella.

## Procedimiento obligatorio

1. Lee `README.md`, `service.json` y `installer.json.example` de la carpeta `ejemplo` situada en el directorio de datos de ZeroChat.
2. Consulta solo la documentación oficial del MCP solicitado.
3. Crea una carpeta con un identificador seguro y descriptivo junto a `ejemplo`. Usa un `id` único en `service.json`, también cuando copies otro servicio.
4. Crea `service.json` copiando esta estructura y adapta únicamente los valores necesarios.
5. Crea `installer.json` solo si el MCP se distribuye como paquete npm. Copia `installer.json.example`, fija la versión exacta y declara la versión mínima de Node.js.
6. Añade `help.url` con la página oficial de instalación y etiquetas en español e inglés.
7. Si requiere una API key, declara la variable que exige el MCP en el objeto `env` de `launch` dentro de `service.json` con el valor literal `PASTE_API_KEY_HERE`. No pidas la clave al usuario ni la escribas en el chat: indica la ruta absoluta del JSON y el campo que debe editar a mano. El usuario guardará su clave únicamente en el JSON local de su carpeta propia.
8. No instales ni inicies el servicio. Al terminar, informa de los archivos creados, fuentes oficiales y requisitos pendientes.

## Límites de ZeroChat

ZeroChat gestiona procesos MCP por `stdio`. Puede instalar paquetes npm mediante `installer.json` y arrancarlos con `${nodeExecutable}`. También puede arrancar un ejecutable o script ya disponible con `launch`.

ZeroChat también puede usar `mcp-remote` como puente para un MCP remoto HTTP/SSE con OAuth o API key. Decláralo como un servicio `stdio`: el proceso local debe ser `mcp-remote`, mientras que `remote` describe el endpoint remoto para la interfaz. Conserva las credenciales y el almacén OAuth dentro de `${serviceDir}`.

## Contratos JSON

- `service.json` es obligatorio. Conserva `schemaVersion`, `id`, textos bilingües, `transport: "stdio"` y `launch`.
- En `launch`, usa `${serviceDir}`, `${nodeExecutable}` o `${pythonExecutable}`; no uses rutas absolutas de usuario.
- `launch.handshakeTimeoutSeconds` (15 s por defecto) limita el arranque y `launch.callTimeoutSeconds` (30 s por defecto) cada llamada a una herramienta; súbelo para MCP lentos, como la automatización de navegador.
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

## Servicios remotos y claves API

`launch.env` es el objeto `env` dentro de `launch` en `service.json`, no un archivo. El agente deja únicamente el marcador; el usuario introduce la clave real a mano en ese JSON. No crees un archivo `launch.env` o `.env`.

Para un remoto, lee también `service.json` e `installer.json` de la carpeta hermana `composio`. Crea una carpeta nueva con nombre e `id` propios; usa Composio como ejemplo del puente local, conservando `transport: "stdio"`. Consulta la documentación oficial del proveedor y de [mcp-remote](https://github.com/punkpeye/mcp-remote#custom-headers) para adaptar endpoint, transporte, cabeceras y autenticación. No copies sin verificar las opciones `--protocol`, los metadatos de cliente ni los parámetros OAuth específicos de Composio. Conserva `HOME` y `USERPROFILE` dentro de `${serviceDir}`.

Para un MCP local que requiera una variable, deja este campo dentro de `launch`, conservando sus demás campos y usando el nombre de variable documentado por el MCP:

```json
"env": {
  "SERVICE_API_KEY": "PASTE_API_KEY_HERE"
}
```

Para un remoto que acepte `Authorization: Bearer`, los campos dentro de `launch` pueden ser:

```json
"args": [
  "${serviceDir}/node_modules/mcp-remote/dist/proxy.js",
  "https://mcp.example.com/mcp",
  "--header",
  "Authorization: Bearer ${REMOTE_API_KEY}"
],
"env": {
  "HOME": "${serviceDir}",
  "USERPROFILE": "${serviceDir}",
  "REMOTE_API_KEY": "PASTE_API_KEY_HERE"
}
```

Adapta la cabecera y su formato a lo que exige el proveedor. `remote.authentication` solo describe el servicio; no configura la autenticación. La referencia `${REMOTE_API_KEY}` en la cabecera la resuelve `mcp-remote`. ZeroChat no resuelve variables de entorno genéricas: en `launch.env`, `${SERVICE_API_KEY}` se pasaría como texto literal. Solo sustituye `${serviceDir}`, `${nodeExecutable}`, `${pythonExecutable}` y `${option:...}`. No pongas claves reales en argumentos ni en URLs.

### Pasos para el usuario

1. Usa una carpeta propia bajo el directorio de servicios, con nombre e `id` únicos. Si copias un servicio incluido, copia sus definiciones, no sus dependencias ni credenciales OAuth. No edites `ejemplo`, `composio`, `playwright` ni `memory`: sus archivos distribuidos se restauran al arrancar.
2. Abre el `service.json` de tu carpeta y sustituye `PASTE_API_KEY_HERE` por la clave real en `launch.env`. Mantén el JSON válido y los demás campos. No necesitas `export`, `.env` ni otro JSON de credenciales.
3. Restringe el archivo a tu usuario con `chmod 600 /ruta/absoluta/zerochat/services/mi-servicio/service.json` en Linux o Termux. La clave queda en texto plano: no compartas el archivo ni lo subas al repositorio o al chat.
4. Inicia el servicio desde Ajustes → MCP. Si la nueva carpeta no aparece, reinicia ZeroChat y conecta de nuevo. Para cambiar una clave, detén primero el servicio, edita el JSON y vuelve a iniciarlo.
5. ZeroChat conserva los servicios propios al reiniciar y actualizar. Borrar el directorio de datos elimina también esas claves: guarda una copia privada si la necesitas.

## English: creating local and remote services

1. Locate the user's absolute home directory and read `README.md`, `service.json` and `installer.json.example` in `zerochat/services/ejemplo`.
2. Read the requested MCP's official documentation. Create a sibling folder with its own name and unique JSON `id`; do not modify bundled definitions. Preserve bilingual text, `schemaVersion`, `transport: "stdio"`, `launch` and official `help` links. `launch.handshakeTimeoutSeconds` (default 15 s) bounds startup and `launch.callTimeoutSeconds` (default 30 s) each tool call; raise it for slow MCPs such as browser automation.
3. For npm services, add `installer.json` with an exact package version and minimum Node.js major version. Otherwise use an existing executable or script.
4. For remote HTTP/SSE MCPs, also read the sibling `composio` JSON files and use its managed `mcp-remote` bridge as the example. Adapt endpoint, transport and authentication to the official provider and bridge documentation. Verify Composio-specific protocol and OAuth options before copying them. Keep `HOME` and `USERPROFILE` isolated inside `${serviceDir}`.
5. If an API key is required, put the literal `PASTE_API_KEY_HERE` under the required variable in the `env` object under `launch` inside `service.json`. `launch.env` is a JSON field, not a file. The user enters the actual key manually in that JSON; do not create a `launch.env` or `.env` file. Do not request the user's key or place real secrets in chat, arguments or URLs. Give the absolute JSON path and exact field to edit. For remote header authentication, use `--header` with the provider's required header and a reference to the variable, as shown above; `mcp-remote` resolves that reference. `remote.authentication` is descriptive only.
6. Do not install or start the service. Report created files, official sources and outstanding requirements; the user will start it from Settings → MCP.

The user replaces `PASTE_API_KEY_HERE` directly in their own folder's JSON, preserves valid JSON and existing fields, and restricts the file with `chmod 600 /absolute/path/zerochat/services/my-service/service.json` on Linux/Termux. No shell export, `.env` or separate credentials JSON is needed. ZeroChat only expands service/interpreter paths and `${option:...}`, not generic environment placeholders in `launch.env`. The key is stored in plain text: do not share or commit the file or paste it into chat.

If a new folder does not appear, restart ZeroChat and reconnect. Stop an active service before editing its key, then start it again. User-created folders survive restarts and updates. Bundled definitions are restored on startup: copy them into a new folder and change the JSON `id` to customize them, without copying dependencies or OAuth credentials. Deleting the data directory also deletes custom services and their keys; keep a private backup if needed.
