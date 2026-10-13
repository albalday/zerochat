# ZeroChat

[English](#english) · [Español](#español)

---

<a name="english"></a>
## English

ZeroChat is a personal, private web client for chatting with AI models, consulting documents and running tools. This documentation covers the **9.x** series. Free and open source under the MIT licence.

The interface runs entirely in the browser as static files: history and settings remain in local browser storage without automatic cloud synchronization.

### Key features

- **AI Profiles:** OpenAI and compatible chat APIs, Ollama, OpenRouter, Claude and Gemini. Supports reasoning, vision and function calling.
- **WebLLM:** In-browser WebGPU inference with downloadable models (requires compatible hardware).
- **Documents & RAG:** Local document attachments and collections with client-side text extraction and Orama lexical search (no external embeddings required).
- **Agentic Tools:** JavaScript sandbox, web search, page fetching, interactive charts and read-only subagents. The optional local backend adds filesystem access, shell commands, diagnostics and MCP services.
- **Diagnostics:** Conversation branches, JSON and Markdown export, PDF print, context metrics and request inspector.

### Quick start

1. **Web (client-only):** Open [ZeroChat on GitHub Pages](https://albalday.github.io/zerochat/zerochat.html), configure a connection profile, and start chatting.
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
- [ZeroChat 9.x Help — English](https://albalday.github.io/zerochat/help/en/index.html)
- [Ayuda de ZeroChat 9.x — Español](https://albalday.github.io/zerochat/help/index.html)

### Development

ZeroChat is developed on the `dev` branch:

```bash
git checkout dev
npm install
npm test
```

For development rules, architecture and test suites, see [`AGENTS.md`](./AGENTS.md), [`js/README.md`](./js/README.md), [`py/README.md`](./py/README.md) and [`tests/README.md`](./tests/README.md).

---

<a name="español"></a>
## Español

ZeroChat es un cliente web de uso personal para conversar con modelos de IA, consultar documentos y ejecutar herramientas. Esta documentación corresponde a la serie **9.x**. Proyecto de libre uso bajo licencia MIT.

La interfaz se ejecuta íntegramente en el navegador como archivos estáticos: el historial y la configuración se conservan en el almacenamiento local del navegador, sin sincronización automática en la nube.

### Características principales

- **Perfiles de IA:** OpenAI y APIs compatibles, Ollama, OpenRouter, Claude y Gemini. Soporta razonamiento, visión y llamadas a herramientas (*tool calling*).
- **WebLLM:** Inferencia local en el navegador mediante WebGPU tras descargar el modelo (requiere hardware compatible).
- **Documentos y RAG:** Adjuntos y colecciones locales con extracción de texto en el cliente y búsqueda léxica mediante Orama (sin requerir *embeddings* externos).
- **Herramientas agénticas:** Entorno aislado de JavaScript, búsqueda y lectura web, gráficos interactivos y subagentes de solo lectura. El backend local opcional añade acceso al sistema de archivos, ejecución de comandos, diagnósticos y servicios MCP.
- **Diagnóstico e historial:** Ramas de conversación, exportación a JSON y Markdown, impresión en PDF, métricas de contexto e inspección de peticiones.

### Inicio rápido

1. **Web directa (solo cliente):** Abre [ZeroChat en GitHub Pages](https://albalday.github.io/zerochat/zerochat.html), configura un perfil de conexión y comienza.
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
- [Ayuda de ZeroChat 9.x — Español](https://albalday.github.io/zerochat/help/index.html)
- [ZeroChat 9.x Help — English](https://albalday.github.io/zerochat/help/en/index.html)

### Desarrollo

El desarrollo se realiza en la rama `dev`:

```bash
git checkout dev
npm install
npm test
```

Las normas de desarrollo, arquitectura y suite de pruebas se describen en [`AGENTS.md`](./AGENTS.md), [`js/README.md`](./js/README.md), [`py/README.md`](./py/README.md) y [`tests/README.md`](./tests/README.md).
