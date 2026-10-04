# ZeroChat

ZeroChat es un cliente web de uso personal para conversar con modelos de IA, consultar documentos y utilizar herramientas. Esta documentación corresponde a la serie **8.x**, que consolida las funcionalidades existentes. El desarrollo de nuevas funcionalidades queda en pausa por el momento.

La interfaz se sirve como archivos estáticos: `zerochat.html` necesita sus módulos `js/` y `css/`. El historial y la configuración se guardan en el navegador; no se sincronizan automáticamente entre dispositivos. Los proveedores remotos reciben el contenido incluido en las peticiones, y las herramientas web pueden utilizar servicios intermediarios. Almacenamiento local no significa privacidad absoluta.

*English:* ZeroChat is a web client for personal use: chatting with AI models, consulting documents and using tools. This documentation covers the **8.x** series, which consolidates existing features. New feature development is paused for now.

The interface is served as static files: `zerochat.html` needs its `js/` and `css/` modules. History and settings are stored in the browser, without automatic cross-device sync. Remote providers receive content included in requests, and web tools may use intermediary services. Local storage does not mean absolute privacy.

## Características principales / Main features

- **Perfiles:** OpenAI y APIs de chat compatibles, Ollama, OpenRouter, Claude y Gemini. La visión, las herramientas y el razonamiento dependen del modelo y del adaptador.
- **WebLLM:** inferencia en el navegador con WebGPU, tras descargar un modelo. Necesita hardware compatible y memoria suficiente.
- **Documentos:** adjuntos y colecciones RAG con extracción local y búsqueda léxica mediante Orama; sin embeddings. Los fragmentos recuperados se envían al modelo elegido. La extracción de PDF tiene límites y no incluye OCR general.
- **Herramientas:** JavaScript aislado, búsqueda y lectura web, gráficos, planes y puntos de control. El backend opcional añade archivos, comandos, diagnósticos, automatización de navegador y servicios MCP.
- **Historial y diagnóstico:** ramas de conversación, exportación JSON y Markdown, impresión a PDF, métricas de contexto y revisión de peticiones antes del envío.

*English:*

- **Profiles:** OpenAI and compatible chat APIs, Ollama, OpenRouter, Claude and Gemini. Vision, tools and reasoning depend on the model and adapter.
- **WebLLM:** browser inference through WebGPU after downloading a model. Requires compatible hardware and enough memory.
- **Documents:** attachments and RAG collections with local extraction and Orama lexical search, without embeddings. Retrieved passages are sent to the selected model. PDF extraction has limitations and no general OCR.
- **Tools:** isolated JavaScript, web search and retrieval, charts, plans and checkpoints. The optional backend adds files, commands, diagnostics, browser automation and MCP services.
- **History and diagnostics:** conversation branches, JSON and Markdown export, printing to PDF, context metrics and request inspection before sending.

## Inicio rápido / Quick start

Abre [ZeroChat en GitHub Pages](https://albalday.github.io/zerochat/zerochat.html), crea un perfil, introduce la URL y la clave si corresponde, consulta los modelos con **Query** y guarda. El perfil **Espejo** permite probar la interfaz sin inferencia. Para WebLLM, prepara un modelo del catálogo.

*English:* Open [ZeroChat on GitHub Pages](https://albalday.github.io/zerochat/zerochat.html), create a profile, enter the URL and key where required, query models with **Query**, and save. **Mirror** lets you try the interface without inference. For WebLLM, prepare a catalogue model.

Para añadir herramientas del equipo, instala y ejecuta el backend con Python. / To add computer tools, install and run the Python backend:

```bash
pip install zerochat
zerochat
# En Windows (si zerochat no está en PATH): py -m zerochat
```

También puedes descargar el script y ejecutarlo. / You can also download and run the script:

```bash
curl -sL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py
python3 zerochat.py
```

> **Entornos probados / Tested environments:** Linux (x86_64, ARM), Windows 10/11 (PowerShell, `py -m zerochat`), Android (Termux con `python`; Playwright no se puede usar actualmente en Termux / Playwright cannot currently be used on Termux).  
> **Navegadores / Browsers:** ZeroChat **no es compatible con Safari / does not work on Safari**. En macOS debería funcionar con Firefox o Chromium, pero no se ha probado / On macOS it should work with Firefox or Chromium, but it has not been tested.

Fuera del repositorio de desarrollo, ambos modos abren la interfaz de GitHub Pages. Crean `~/zerochat/` para configuración y servicios, con `.venv/` para dependencias MCP Python. Mantén el proceso abierto y usa su enlace de arranque para autenticar la conexión local. Revisa **Ajustes → MCP** y **Permisos** antes de habilitar herramientas: los comandos actúan con los permisos del proceso local y detenerlos no deshace cambios.

Borrar `~/zerochat/` elimina ese estado y los MCP gestionados, no el ejecutable, los archivos modificados fuera de esa carpeta ni los datos del navegador. Exporta las conversaciones y perfiles que quieras conservar; sus copias no incluyen las colecciones RAG ni los modelos descargados. El cifrado predeterminado de perfiles utiliza una clave integrada conocida: trata las copias como archivos sensibles.

*English:* Outside the development repository, both modes open the GitHub Pages interface. They create `~/zerochat/` for configuration and services, with `.venv/` for Python MCP dependencies. Keep the process running and use its startup link to authenticate the local connection. Review **Settings → MCP** and **Permissions** before enabling tools: commands run with the local process permissions, and stopping them does not undo changes.

Deleting `~/zerochat/` removes that state and managed MCP services, not the executable, files changed elsewhere or browser data. Export conversations and profiles you want to keep; these backups do not include RAG collections or downloaded models. Default profile encryption uses a known built-in key: treat backups as sensitive files.

## Documentación y ayuda / Documentation and help

- [Ayuda de ZeroChat 8.x — Español](https://albalday.github.io/zerochat/help/index.html)
- [ZeroChat 8.x help — English](https://albalday.github.io/zerochat/help/en/index.html)

Las guías explican configuración, uso y límites.

*English:* The guides explain setup, usage and limits.

## Desarrollo / Development

Trabaja en `dev`. Para instalar dependencias y ejecutar las pruebas del proyecto: / Work on `dev`. To install dependencies and run the project tests:

```bash
npm install
npm test
```

Dentro del repositorio, `python3 zerochat.py` sirve la interfaz local de desarrollo. Si modificas `py/`, reconstruye `zerochat.py` con `npm run build:backend`. La web carga directamente sus módulos, sin un bundle de aplicación.

*English:* Inside the repository, `python3 zerochat.py` serves the local development interface. After changing `py/`, rebuild `zerochat.py` with `npm run build:backend`. The web app loads its modules directly, without an application bundle.

Las normas y validaciones se describen en [`AGENTS.md`](./AGENTS.md) y [`tests/README.md`](./tests/README.md).

*English:* See those files for the applicable development rules and validation.
