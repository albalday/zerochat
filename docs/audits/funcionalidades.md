# Auditoría Funcional: ZeroChat como Banco de Pruebas para Técnicos de IA

**Fecha**: 4 de octubre de 2026  
**Versión evaluada**: Web v8.12.4 / Backend v8.12  
**Commit base del código**: `aff1019`  
**Enfoque**: uso personal, autoformación y experimentación técnica en IA (no uso profesional ni empresarial).

### Autoría

| Papel | Agente |
|---|---|
| Primera aproximación (borrador) | Gemini 3.8 Flash en Google Antigravity |
| Verificación, corrección y redacción final | Claude Opus 5.5 (`claude-opus-5-5`) en Claude Code |

Los agentes trabajaron a partir de instrucciones del responsable del proyecto, sin redacción humana del contenido. Cada capacidad citada se ha comprobado en el código; las referencias permiten repetir la comprobación.

---

## 1. Objetivo

Evaluar ZeroChat desde la perspectiva de una persona técnica en IA (desarrollo de software de IA, ingeniería de prompts y agentes, investigación o estudio avanzado) que busca un banco de pruebas local para:

1. Entender la arquitectura interna de un cliente de modelos de lenguaje.
2. Experimentar con agentes, llamadas a herramientas y MCP.
3. Observar el flujo de inferencia, el razonamiento y el consumo de contexto.
4. Contrastar la ayuda (`help/`) con la implementación real.

---

## 2. Capacidades por área

ZeroChat expone buena parte de lo que los clientes comerciales ocultan: la petición exacta enviada al proveedor, el flujo SSE en crudo, el razonamiento separado de la respuesta y el estado del contexto. Esa transparencia es su principal valor para la experimentación.

| Área | Valoración | Capacidades verificadas | Límites verificados |
|---|---|---|---|
| **Proveedores** | Alta | OpenAI/LM Studio, Claude, Gemini, Ollama, OpenRouter, WebLLM (WebGPU en el navegador), Mirror y endpoint personalizado (`js/providers.js:1457-1463`). Cambio de proveedor dentro de la misma conversación. | Cada proveedor devuelve metadatos distintos (caché, razonamiento); la telemetría muestra lo que el proveedor informa. |
| **Razonamiento** | Alta | Separación en streaming del razonamiento (`reasoningChunk`). Niveles `none`, `minimal`, `low`, `medium`, `high`, `xhigh` y `on`, traducidos a la API de cada proveedor. | Los tokens de razonamiento se recogen (`js/api.js:486`) pero **no se muestran** en el panel de telemetría. |
| **Contexto y telemetría** | Alta | Tokens de entrada, salida y caché; semáforo de contexto (aviso ≥60 %, crítico ≥85 %, `js/ui-telemetry.js:73-74`); compactación automática al 70 % del presupuesto (`js/context-manager.js:421`). | La capacidad del contexto puede ser asumida si el servidor no la publica (se marca como tal). |
| **Agente y herramientas** | Alta | Function Calling nativo con JSON Schema y, para WebLLM, bloques `<tool_call>` en texto (`js/text-tool-calls.js`). Bucle de 5 a 200 turnos (por defecto 40) con `agent_checkpoint`, `update_plan` y `finish_task`. 12 herramientas integradas. | `<tool_call>` solo se activa en proveedores con capacidad `textTools` (hoy WebLLM); se añadió el 4 de octubre de 2026 y tiene poco recorrido. |
| **MCP** | Alta | Servidores locales por stdio gestionados por `zerochat.py` y servidores externos por HTTP con OAuth. `ToolSecurityManager` con políticas `ask`, `allow_all`, `workspace_trust` y reglas `deny`, detección de comandos encadenados y firmas HMAC en las llamadas al backend local. | No hay visor del tráfico JSON-RPC entre el backend y los servidores MCP. |
| **RAG local** | Media | Índice **léxico** Orama en el navegador sobre IndexedDB. Ingesta de PDF (texto e imágenes, con conversión CMYK), texto, Markdown, CSV/TSV, JSON, YAML, XML, HTML y código fuente (`zerochat.html:377`). | Sin embeddings ni búsqueda semántica. **Sin soporte DOCX** ni otros formatos ofimáticos. |
| **Sandbox de JavaScript** | Media | `<iframe>` con origen opaco, CSP `connect-src 'none'` y watchdog de tiempo. | El propio módulo advierte que no es una frontera de seguridad (`js/sandbox.js:11-14`). |

---

## 3. Correspondencia con la ayuda (`/help`)

| Página de ayuda | Implementación |
|---|---|
| `help/learning.html` | Propósito del proyecto y desarrollo con agentes (`AGENTS.md`) |
| `help/webllm.html` | `providers-webllm.js`, Web Worker, WebGPU, Cache Storage |
| `help/tools-agent.html` | `agent-core.js`, `js/tools/builtin/`, límite de turnos |
| `help/mcp.html` | `mcp.js`, `py/ee-mcp.py`, `tool-security.js` |
| `help/reasoning-telemetry.html` | `ui-reasoning.js`, `ui-telemetry.js`, `context-manager.js` |
| `help/debug.html` | `debug.js` (panel RAW e interceptor de peticiones) |
| `help/rag.html` | `rag-service.js`, `ingestionEngine.js`, índice Orama |
| `help/architecture.html` | `zerochat.py`, `storage-db.js`, compatibilidad de navegadores |

### Afirmaciones de la ayuda comprobadas
1. `help/rag.html` indica que la búsqueda es léxica, sin embeddings ni índice vectorial, y que puede no encontrar sinónimos o traducciones. Coincide con el código.
2. `help/architecture.html` declara la incompatibilidad con Safari (restricciones de Private Network Access y almacenamiento) y que en macOS debería funcionar con Firefox o navegadores basados en Chromium, aunque no se ha probado. Los entornos documentados son Linux (x86_64 y ARM), Windows 10/11 y Android con Termux. En Termux no es posible usar Playwright actualmente, así que `browser_action` y Playwright MCP no están disponibles en Android.
3. `help/tools-agent.html` describe Jina Reader, la conexión directa y el proxy AllOrigins como estrategias de las herramientas web, y DuckDuckGo como buscador.
4. `help/reasoning-telemetry.html` describe la compactación al 70 % y el aviso «Compactando contexto» en el chat.
5. `help/learning.html` presenta ZeroChat como proyecto personal de aprendizaje sobre clientes de IA y ejecución agéntica.

**Conclusión**: en los puntos revisados la ayuda es coherente con el código y no promete capacidades inexistentes. La revisión es por muestreo: no se ha contrastado cada frase de cada página.

---

## 4. Casos de uso

### Caso 1: Probar un servidor MCP propio
* **Qué ofrece ZeroChat**: registrar el servidor (stdio local o HTTP externo), ver sus herramientas y probar cómo responde el agente con políticas `ask`, `allow_all` o `workspace_trust`. Las tarjetas de herramienta muestran argumentos y resultados de cada llamada.
* **Qué no ofrece**: no muestra los mensajes JSON-RPC crudos entre el backend y el servidor MCP. Para eso sigue siendo necesario el MCP Inspector oficial o registrar el tráfico en el propio servidor.

### Caso 2: Comparar el razonamiento de distintos modelos
* **Qué ofrece**: regular la intensidad de razonamiento y ver el razonamiento en un bloque separado de la respuesta, en streaming. Útil con modelos de razonamiento de Anthropic, OpenAI, Google, DeepSeek o Qwen.
* **Qué no ofrece**: la interfaz no muestra el recuento de tokens de razonamiento, aunque se recoge internamente. Para medirlo hay que consultar el JSON crudo en el panel de depuración.

### Caso 3: Interceptar y modificar peticiones
* Con **Debug messages** activo, `js/debug.js` detiene cada petición antes de enviarla y muestra el JSON exacto (`messages`, `tools`, parámetros). Se puede editar, validar como JSON y enviar la versión modificada, o cancelar (`js/debug.js:342-362`).

### Caso 4: Inferencia local con WebGPU
* WebLLM se ejecuta en un Web Worker dedicado, sin backend. El catálogo recomienda modelos con mejor comportamiento de herramientas (Qwen3/3.5, Hermes 3, Hermes 2 Pro), que usan el formato `<tool_call>` en texto.
* El motor se descarga de `cdn.jsdelivr.net`, y los modelos ocupan desde cientos de MB hasta varios GB en Cache Storage.

### Caso 5: Estudiar la arquitectura de un cliente de IA
* JavaScript modular con patrón UMD, sin empaquetador ni framework, ejecutable en navegador y en Node.js para pruebas. El repositorio permite estudiar:
  * El parsing de Server-Sent Events y la normalización entre proveedores.
  * La cancelación con `AbortController`.
  * La terminación de grupos de procesos (`killpg`) y la persistencia del estado de la shell mediante `trap ... EXIT` en `py/dd-tools.py`.

---

## 5. Límites para uso profesional o corporativo

1. **Monousuario**: sin sesiones concurrentes ni control de acceso por roles. El token diario protege el backend local, pero asume un único usuario propietario de la máquina.
2. **Datos en el navegador**: conversaciones e índices RAG viven en IndexedDB. Si se borran los datos del sitio sin exportar, se pierden.
3. **Origen compartido**: la interfaz se sirve desde `albalday.github.io`, origen compartido con otras páginas del autor (riesgo aceptado en `AGENTS.md` §4).
4. **RAG léxico**: sin búsqueda semántica ni traducción entre idiomas.
5. **Navegadores**: Chromium y Firefox funcionan; Safari/WebKit no está soportado. WebLLM requiere WebGPU.
6. **Termux**: el backend funciona en Android con Termux, pero Playwright no se puede usar actualmente, así que no hay automatización de navegador (`browser_action`, Playwright MCP).
7. **Privacidad condicionada**: con proveedores remotos los mensajes salen del navegador, y las herramientas web usan servicios de terceros.

---

## 6. Dictamen

**Muy adecuado como laboratorio personal de IA.** ZeroChat cumple su objetivo de entorno de experimentación transparente: deja ver y modificar la petición, el streaming, el razonamiento, el contexto y la orquestación agéntica. La ayuda describe con honestidad sus límites principales.

Mejoras que aumentarían su valor para técnicos de IA:
1. Mostrar los tokens de razonamiento en la telemetría.
2. Registrar en el panel de depuración el tráfico JSON-RPC de MCP.
3. Añadir una guía práctica de experimentos reproducibles (interceptor, comparación entre proveedores, prueba de un servidor MCP propio).
