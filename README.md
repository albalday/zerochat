# ZeroChat

ZeroChat es un cliente web universal para interactuar con modelos de inteligencia artificial y agentes de forma privada, rápida y sin intermediarios.

Funciona de forma estática en el navegador (servido por GitHub Pages o directamente desde local en un único archivo HTML), almacenando tus conversaciones, configuraciones y datos de forma segura en tu propio dispositivo (IndexedDB).

## Características principales

- **Multi-proveedor y modelos locales**: compatible con APIs estándar (OpenAI, Anthropic Claude, Google Gemini, OpenRouter) y motores locales (Ollama, LM Studio, vLLM, WebLLM con WebGPU directo en el navegador).
- **Herramientas y MCP (Model Context Protocol)**: soporte para agentes, herramientas de búsqueda/cálculo y servidores MCP locales coordinados mediante `zerochat.py`.
- **Conocimiento local (RAG)**: carga de documentos y recuperación contextual procesada íntegramente en el navegador.
- **Privacidad absoluta**: tus claves API y datos viajan directamente de tu navegador al proveedor seleccionado, sin servidores puente de terceros.
- **Sin necesidad de empaquetado**: distribuible de forma universal y ligera.

## Inicio rápido

- **Uso web directo**: abre [zerochat.html en GitHub Pages](https://albalday.github.io/zerochat/zerochat.html).
- **Servidor local con herramientas MCP**:
  ```bash
  python3 zerochat.py
  ```
  Inicia el asistente local, crea su entorno virtual de forma desatendida y abre la interfaz web en tu navegador.
- **Instalación con PyPI**:
  ```bash
  pipx install zerochat
  zerochat
  ```
  La distribución incluye una copia local de la interfaz. Las versiones `major.minor` indican compatibilidad del backend; los parches corresponden a la interfaz web.

Las publicaciones se realizan desde el repositorio oficial mediante GitHub Actions y PyPI Trusted Publishing.

## Documentación y Ayuda

Para consultar guías paso a paso, configuración de modelos, perfiles y agentes:

- 📖 **[Centro de Ayuda de ZeroChat (Español)](https://albalday.github.io/zerochat/help/index.html)**
- 📖 **[ZeroChat Documentation & Help (English)](https://albalday.github.io/zerochat/help/en/index.html)**

## Desarrollo

Para ejecutar las pruebas del proyecto:

```bash
npm install
npm test
```

Consulta [`AGENTS.md`](./AGENTS.md) para conocer las normas de desarrollo y arquitectura, y [`tests/README.md`](./tests/README.md) para la suite de pruebas.
