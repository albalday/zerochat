# Análisis Comparativo: ZeroChat frente a Clientes de IA Gratuitos

**Fecha**: 4 de octubre de 2026  
**Versión evaluada**: ZeroChat Web v8.12.4 / Backend v8.12  
**Objetivo**: situar ZeroChat frente a alternativas gratuitas o de código abierto para interactuar con LLMs, ejecutar modelos locales, RAG y herramientas agénticas.

### Autoría

| Papel | Agente |
|---|---|
| Primera aproximación (borrador) | Gemini 3.8 Flash en Google Antigravity |
| Verificación, corrección y redacción final | Claude Opus 5.5 (`claude-opus-5-5`) en Claude Code |

Los agentes trabajaron a partir de instrucciones del responsable del proyecto, sin redacción humana del contenido.

### Advertencia de vigencia

Los datos de ZeroChat se han comprobado en su código. Los datos de las demás herramientas proceden de su documentación pública consultada el 4 de octubre de 2026 (ver [Fuentes](#7-fuentes)). Estos productos cambian cada pocas semanas, así que esta comparación caduca pronto. No se han realizado mediciones de memoria ni de rendimiento: el documento no incluye cifras de RAM.

---

## 1. Herramientas analizadas

1. **Open WebUI**: plataforma autoalojada (Python + Svelte, habitualmente con Docker), orientada a uso individual o de equipo.
2. **LibreChat**: clon multiproveedor de ChatGPT con agentes (Node.js + MongoDB, habitualmente con Docker Compose).
3. **Chatbox**: cliente de escritorio y web multiplataforma.
4. **Jan**: aplicación de escritorio para descargar y ejecutar modelos locales con llama.cpp integrado.
5. **Claude Desktop**: cliente oficial de Anthropic (propietario, gratuito con limitaciones de uso), cliente de referencia de MCP.

---

## 2. Matriz comparativa

| Dimensión | ZeroChat | Open WebUI | LibreChat | Chatbox | Jan | Claude Desktop |
|---|---|---|---|---|---|---|
| **Despliegue** | Web estática (GitHub Pages) + backend Python opcional de un solo archivo | Servidor (Docker o pip) | Servidor (Docker Compose + MongoDB) | App de escritorio/web | App de escritorio | App de escritorio |
| **Modelos en el navegador (WebGPU)** | Sí (WebLLM) | No | No | No | No (motor nativo llama.cpp) | No |
| **Modelos locales** | Sí (Ollama, LM Studio u otro endpoint compatible con OpenAI) | Sí (integración profunda con Ollama) | Sí | Sí | Sí (motor propio) | No |
| **Proveedores remotos** | OpenAI, Claude, Gemini, OpenRouter y endpoints compatibles | Amplio | Amplio | Amplio | Varios | Solo Claude |
| **MCP** | Sí: stdio local gestionado por el backend y HTTP externo con OAuth | Sí: nativo por Streamable HTTP (desde v0.6.31), solo administradores | Sí: configuración YAML y panel | Sí | Sí | Sí: stdio local y conectores remotos |
| **Permisos de herramientas** | Políticas `ask` / `allow_all` / `workspace_trust` / `deny`, reglas por ruta y comando | Por administrador | Por configuración | Por configuración | Por configuración | Por herramienta: siempre / preguntar / nunca |
| **Tool calling en modelos pequeños** | Nativo y `<tool_call>` en texto para WebLLM | Nativo o por prompt según el modelo | Depende del modelo | Depende del modelo | Depende del modelo | Solo modelos Claude |
| **RAG** | Léxico en navegador (Orama + IndexedDB) | Vectorial con embeddings | Vectorial con embeddings | Base de conocimiento | Adjuntos y recuperación local | Projects |
| **Inspección de peticiones** | Interceptor para ver y editar el JSON antes de enviarlo; panel RAW SSE | Logs del servidor | Logs del servidor | Limitada | Limitada | No |
| **Multiusuario y roles** | No | Sí | Sí | No | No | No (cuenta individual) |

---

## 3. Análisis cualitativo

### 3.1. Frente a Open WebUI y LibreChat
* **Despliegue**: ambos son servidores con base de datos pensados para dar servicio a varios usuarios. ZeroChat no necesita servidor para chatear: la interfaz es estática y el backend local solo hace falta para MCP, comandos y navegador automatizado.
* **Persistencia**: en ZeroChat las conversaciones viven en el IndexedDB del navegador y la configuración del backend en `~/zerochat/`. No hay servidor intermedio de ZeroChat que guarde historiales. Los mensajes sí llegan al proveedor remoto elegido.
* **Dónde ganan**: multiusuario, permisos por rol, RAG vectorial, voz integrada y administración centralizada.
* **Dónde gana ZeroChat**: arranque sin Docker ni privilegios de administrador, funcionamiento en Android con Termux (sin automatización de navegador: Playwright no se puede usar actualmente en Termux) y transparencia de la petición enviada.

### 3.2. Frente a Chatbox y Jan
* **Runtime**: Chatbox y Jan son aplicaciones de escritorio con su propio runtime. ZeroChat usa el navegador ya instalado (también como PWA).
* **Inferencia local**: Jan ejecuta modelos GGUF con llama.cpp nativo, con mejor rendimiento y más catálogo que WebLLM. ZeroChat ejecuta modelos en la propia pestaña con WebGPU, sin instalar nada, a cambio de modelos más limitados y de depender de WebGPU.
* **Dónde gana Jan**: catálogo y descarga de modelos, rendimiento local y servidor local compatible con OpenAI.

### 3.3. Frente a Claude Desktop
* **Proveedores**: Claude Desktop solo usa modelos de Anthropic. ZeroChat usa MCP con cualquier proveedor, incluidos modelos locales.
* **Seguridad de MCP**: Claude Desktop permite configurar cada herramienta como "permitir siempre", "preguntar" o "nunca". ZeroChat añade reglas por directorio y por comando (`workspace_trust`, detección de comandos encadenados) y firma con HMAC de un solo uso cada llamada del navegador al backend local, lo que impide repetir o alterar una llamada ya autorizada.
* **Dónde gana Claude Desktop**: integración oficial, conectores remotos gestionados, calidad de los modelos Claude y soporte del fabricante.

---

## 4. Diferenciadores de ZeroChat para el técnico de IA

1. **Interceptor de peticiones** (`js/debug.js`): detiene la petición, muestra el JSON exacto y permite editarlo antes del envío. Es útil para depurar prompts y diferencias entre APIs.
2. **`<tool_call>` en texto**: permite experimentar con herramientas en modelos de WebLLM sin tool calling nativo. Es una función reciente (4 de octubre de 2026).
3. **Contexto visible**: tokens de entrada, salida y caché; aviso al 60 %, estado crítico al 85 % y compactación automática al 70 % del presupuesto.
4. **Razonamiento separado**: el bloque de razonamiento se muestra aparte de la respuesta durante el streaming.
5. **Portabilidad**: Linux, Windows, macOS (sin probar) y Android (Termux), sin Docker. En Termux no es posible usar Playwright actualmente, así que `browser_action` y Playwright MCP no están disponibles.

---

## 5. Cuándo elegir cada herramienta

* **ZeroChat**: si quieres ver y modificar lo que ocurre en cada petición, probar MCP con varios proveedores o modelos locales, y trabajar sin Docker ni instalación pesada.
* **Open WebUI o LibreChat**: si necesitas usuarios, permisos, RAG vectorial o un servicio centralizado para un equipo.
* **Jan**: si tu objetivo principal es ejecutar modelos GGUF locales con buen rendimiento y una interfaz sencilla.
* **Chatbox**: si buscas un cliente multiproveedor sencillo y pulido en escritorio y móvil.
* **Claude Desktop**: si trabajas solo con modelos de Anthropic y quieres la integración MCP oficial.

---

## 6. Conclusión

ZeroChat no compite con plataformas multiusuario como Open WebUI o LibreChat, ni con el rendimiento de inferencia local de Jan. En 2026, MCP ya no es un diferenciador por sí mismo, porque las cinco alternativas lo soportan. Lo que distingue a ZeroChat es la combinación de despliegue sin servidor, WebGPU en el navegador, políticas de seguridad de herramientas por ruta y comando, y la posibilidad de inspeccionar y modificar cada petición.

---

## 7. Fuentes

Consultadas el 4 de octubre de 2026:

* Open WebUI, MCP: <https://docs.openwebui.com/features/mcp>
* LibreChat, MCP: <https://www.librechat.ai/docs/features/mcp>
* Jan, migración de Cortex a llama.cpp: <https://jan.ai/changelog/2025-07-31-llamacpp-tutorials>
* Chatbox, capacidades MCP: <https://glama.ai/mcp/clients/chatbox>
* Claude, conectores y permisos de herramientas: <https://support.claude.com/en/articles/11175166>
