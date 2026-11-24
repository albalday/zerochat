# ZeroChat

[English](#english) · [Español](#español)

---

<a name="english"></a>
## English

ZeroChat is a personal, private AI environment that scales progressively across five usage levels on the same engine: from a static browser chat client to a local workspace with project files and MCP services, CLI automation, unattended background runs on the server, and multi-agent orchestrations. This documentation covers the **10.x** series. Free and open source under the MIT licence.

### Usage levels

1. **Simple web chat (frontend only):** Static files in the browser, with no local filesystem access; history and settings stay in local browser storage.
2. **Chat with local backend:** Adds project workspaces, filesystem and shell tools, diagnostics, MCP services and local SQLite persistence.
3. **CLI (`--prompt`, `--conversation`):** Non-interactive requests for shell scripts and `cron`.
4. **Unattended server runs:** Execute turns in the background on the server so you can close the browser and inspect or resume the conversation later.
5. **Agent orchestrations (`--run-file`):** Unattended scheduled or coordinated agents (`launch_agent`, `check_agents`) with human-in-the-loop (HITL) supervision.

### Key features

- **AI Profiles & WebLLM:** OpenAI and compatible APIs, Ollama, OpenRouter, Claude, Gemini, plus in-browser WebGPU inference via WebLLM. Supports reasoning, vision and tool calling.
- **Documents & RAG:** Local document attachments and collections with client-side text extraction and Orama lexical search (no external embeddings required).
- **Agentic Tools & Projects:** JavaScript sandbox, web search/fetch, interactive charts and subagents; with the local backend, adds project folders, shell commands, MCP services and agent templates.
- **Diagnostics & History:** Conversation branches, JSON/Markdown export, PDF print, context metrics and request inspector.

### Quick start

1. **Web (client-only):** Open [ZeroChat on GitHub Pages](https://albalday.github.io/zerochat/zerochat.html), configure a profile, and start chatting.
2. **With local computer tools (Python backend):**

```bash
# Via PyPI (Linux, macOS, Windows)
pip install zerochat
zerochat

# Or download and run directly
curl -fsSL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py
python3 zerochat.py
```

### Documentation & Help

Comprehensive guides covering configuration, supported environments (Linux, Windows, macOS, Android/Termux), MCP services, and security:
- [ZeroChat 10.x Help — English](https://albalday.github.io/zerochat/help/en/index.html)
- [Ayuda de ZeroChat 10.x — Español](https://albalday.github.io/zerochat/help/index.html)

### Development

ZeroChat is developed on the `dev` branch:

```bash
git checkout dev
npm install
npm test
```

For development rules, architecture and test suites, see [`AGENTS.md`](./AGENTS.md), [`docs/architecture.md`](./docs/architecture.md), [`js/README.md`](./js/README.md), [`py/README.md`](./py/README.md) and [`tests/README.md`](./tests/README.md).

---

<a name="español"></a>
## Español

ZeroChat es un entorno personal y privado de IA que escala de forma progresiva en cinco niveles sobre un mismo motor: desde un cliente de chat estático en el navegador hasta un entorno local con archivos de proyecto y servicios MCP, automatización por CLI, ejecución desatendida en segundo plano en el servidor y orquestación de agentes. Esta documentación corresponde a la serie **10.x**. Proyecto de libre uso bajo licencia MIT.

### Niveles de uso

1. **Chat web simple (solo frontend):** Archivos estáticos en el navegador, sin acceso a archivos locales; historial y configuración se guardan en el almacenamiento local del navegador.
2. **Chat con backend local:** Añade proyectos, herramientas de archivos y comandos, diagnósticos, servicios MCP y persistencia local en SQLite.
3. **CLI (`--prompt`, `--conversation`):** Peticiones no interactivas desde terminal, scripts o `cron`.
4. **Ejecución desatendida en servidor:** Lanza turnos en segundo plano para poder cerrar el navegador y consultar o retomar la conversación más tarde.
5. **Orquestación de agentes (`--run-file`):** Agentes autónomos y coordinados (`launch_agent`, `check_agents`) en segundo plano con supervisión humana (*HITL*).

### Características principales

- **Perfiles de IA y WebLLM:** OpenAI y APIs compatibles, Ollama, OpenRouter, Claude, Gemini e inferencia local WebGPU en el navegador con WebLLM. Soporta razonamiento, visión y llamadas a herramientas (*tool calling*).
- **Documentos y RAG:** Adjuntos y colecciones locales con extracción de texto en el cliente y búsqueda léxica mediante Orama (sin requerir *embeddings* externos).
- **Herramientas agénticas y proyectos:** Entorno aislado de JavaScript, búsqueda/lectura web, gráficos interactivos y subagentes; con el backend local añade carpetas de proyecto, comandos, servicios MCP y plantillas de agente.
- **Diagnóstico e historial:** Ramas de conversación, exportación a JSON/Markdown, impresión en PDF, métricas de contexto e inspección de peticiones.

### Inicio rápido

1. **Web directa (solo cliente):** Abre [ZeroChat en GitHub Pages](https://albalday.github.io/zerochat/zerochat.html), configura un perfil y comienza.
2. **Con herramientas del equipo (backend Python):**

```bash
# Mediante PyPI (Linux, macOS, Windows)
pip install zerochat
zerochat

# O descarga directa del script
curl -fsSL https://albalday.github.io/zerochat/zerochat.py -o zerochat.py
python3 zerochat.py
```

### Documentación y ayuda

Guías completas de configuración, soporte de entornos (Linux, Windows, macOS, Android/Termux), servicios MCP y seguridad:
- [Ayuda de ZeroChat 10.x — Español](https://albalday.github.io/zerochat/help/index.html)
- [ZeroChat 10.x Help — English](https://albalday.github.io/zerochat/help/en/index.html)

### Desarrollo

El desarrollo se realiza en la rama `dev`:

```bash
git checkout dev
npm install
npm test
```

Las normas de desarrollo, arquitectura y suite de pruebas se describen en [`AGENTS.md`](./AGENTS.md), [`docs/architecture.md`](./docs/architecture.md), [`js/README.md`](./js/README.md), [`py/README.md`](./py/README.md) y [`tests/README.md`](./tests/README.md).
