# ZeroChat
ZeroChat es un cliente web universal de chat, agente IA y conocimiento local. La distribución final se entrega como un único archivo autónomo, `zerochat.html`, que puede abrirse directamente mediante `file://` y no requiere backend propio.

## Características

- Proveedores compatibles con OpenAI, Ollama, OpenRouter, Anthropic Claude, Google Gemini y servidores locales con API compatible.
- Agente con herramientas para ejecutar JavaScript aislado, buscar y leer páginas web, descargar PDF, crear gráficos y usar servidores MCP.
- Historial de conversaciones, mensajes y adjuntos persistido en IndexedDB.
- Consola de depuración con eventos, tráfico SSE y payloads de las llamadas.
- Interfaz en español e inglés, temas claro y oscuro y exportación de conversaciones.
- Base de conocimiento local con IndexedDB y [Orama](https://orama.com/orama-js) embebido en el bundle.

## Conocimiento local

La ingesta, el índice y la recuperación se realizan completamente en el navegador. No se usa un LLM durante la ingesta ni se solicita acceso persistente a carpetas. Se pueden cargar PDF, Markdown y archivos de texto de cualquier extensión, como logs, código o configuraciones; los archivos binarios se rechazan. Los PDF formados solo por imágenes necesitan OCR previo.

Puedes respaldar y restaurar cada rama de conocimiento desde la interfaz. La lista actual de herramientas y sus contratos está en [docs/TOOLS.md](docs/TOOLS.md).

## Privacidad y persistencia

- Conversaciones, adjuntos y conocimiento se guardan localmente en IndexedDB.
- La configuración de conexión se guarda localmente en el navegador.
- La configuración operativa activa es única: interfaz y ejecución consultan el mismo estado. Los perfiles se guardan aparte, con versión propia, y sólo copian sus valores a esa configuración al activarse.
- Los documentos solo salen del navegador si el usuario los adjunta expresamente a una conversación o su contenido se incorpora a una petición del modelo.
- Orama funciona localmente y su índice puede reconstruirse desde los fragmentos persistidos.

## Uso

1. Descarga `zerochat.html`.
2. Ábrelo en un navegador moderno.
3. Configura el proveedor, endpoint, clave y modelo.
4. Para usar documentos, abre **Conocimiento**, crea una rama, carga los archivos y actívala.

## Desarrollo

Requisitos de compilación: Node.js, npm y Python 3. La aplicación generada no requiere instalarlos.

```bash
npm ci
npm test
npm run test:unit       # iteración rápida sin tests de navegador
npm run test:browser    # suite visual de Chromium/Playwright
npm run build
```

`npm run build` genera el bundle de Orama para navegador y después reconstruye `zerochat.html`. También puede reconstruirse únicamente el HTML con `python3 bundle.py index.html zerochat.html` cuando el vendor ya está actualizado. El empaquetador toma como fuente de verdad las etiquetas locales `<link rel="stylesheet">` y `<script src>` del HTML de entrada, por lo que puede reutilizarse con cualquier par de rutas de entrada y salida.

### Abrir el mismo proyecto en otro ordenador

El repositorio es la fuente única del código y del archivo distribuible `zerochat.html`. Para preparar un ordenador nuevo instala Git, una versión LTS actual de Node.js (incluye npm), Python 3 y VS Code; después ejecuta:

```bash
git clone https://github.com/albalday/zerochat.git
cd zerochat
git switch dev
npm ci
code .
```

`npm ci` reconstruye `node_modules/` exactamente a partir de `package-lock.json`; esa carpeta no se versiona porque es generada y varía según el sistema. Para ejecutar la aplicación no hace falta compilar nada: abre `zerochat.html` en un navegador. Para desarrollar o verificar cambios usa `npm test` y `npm run build`. Si se van a ejecutar las pruebas de navegador, instala Chromium de Playwright una vez con `npx playwright install chromium`.

Al volver a trabajar en ese ordenador, actualiza antes de empezar con `git pull --ff-only origin dev`. Tras confirmar y subir los cambios desde cualquiera de los equipos, el otro queda sincronizado con el mismo comando.

No se sincronizan deliberadamente los datos privados o propios de cada navegador: claves API, perfiles, conversaciones, adjuntos y bases de conocimiento locales (se guardan en localStorage/IndexedDB), ni `.gh/` (configuración y credenciales locales de GitHub CLI). Las conversaciones se pueden mover con **Exportar** → JSON e **Importar**; las ramas de conocimiento tienen **Respaldo** y **Restaurar**. No subas claves API a GitHub.

## Consultar la estructura actual

No se mantiene un inventario manual de archivos en este documento: se quedaría obsoleto. Para ver el contenido exacto de la versión clonada o confirmada, ejecuta:

```bash
git ls-tree -r --name-only HEAD
```

Para localizar un componente concreto, usa por ejemplo `rg --files js tests css`.

Las reglas de contribución, pruebas y empaquetado están en [AGENTS.md](AGENTS.md). Las dependencias de terceros y sus licencias se detallan en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
