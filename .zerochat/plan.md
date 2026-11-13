# Plan

<!-- Hitos M1 a M51 archivados en .zerochat/archive/ -->

## M52 Robustez del transporte web en servidor: cabeceras de navegación y cadencia frente a retos anti-bot: closed 2026-11-08

## M53 Simplificación de la suite de pruebas, retirada de tests obsoletos y optimización de WebLLM: closed 2026-11-09

## M54 Mejoras al modo proyecto: normalización modal del panel de razonamiento y simplificación de memoria: closed 2026-11-09

## M55 Mejoras simples: closed 2026-11-10

## M56 Migración del control de acceso a MCPs y ejecuciones al backend y desacoplo para evolución multiusuario: closed 2026-11-10

## M57 Bucle agéntico desatendido en Node.js para --prompt y --conversation: closed 2026-11-10

## M58 Soporte de ejecución de JavaScript (execute_javascript) en Node.js desatendido: closed 2026-11-11

## M59 Habilitar render_chart en Node.js desatendido para visualización en cliente: closed 2026-11-11

## M60 Frontend sin evaluación de permisos: closed 2026-11-11

## M61 Integridad del sistema de permisos: closed 2026-11-12

## M62 Multisesión de un usuario y límites del multiusuario: closed 2026-11-12

## M63 Cambios pequeños y pruebas: closed 2026-11-13

## M64 Modularización del backend Python: closed 2026-11-13

## M65 Aislamiento de las ejecuciones en servidor: closed 2026-11-13

## M66 Coordinadores del frontend

Goal: Que js/app.js y js/mcp.js vuelvan a ser coordinadores: la sesión con el backend, el control de ejecución en servidor y el formateo de resultados MCP pasan a módulos propios sin cambiar el comportamiento (auditoría 10.14.0, F-10; la parte Python la cubre M64-T12).
Done when: app.js no contiene la conexión, identificación y guardado de la sesión del backend ni el estado de la ejecución en servidor; mcp.js no contiene el formateo de resultados e imágenes; los módulos nuevos siguen las normas de js/README.md y pasan las pruebas de arquitectura; y todos los niveles de §4 pasan en verde.
- [x] M66-T1 Sesión con el backend (fragmento de arranque, destino configurado, clave del proxy, conexión, identificación y guardado) de app.js a un módulo de dominio propio (2026-11-13)
- [x] M66-T2 Control de la ejecución en servidor (disponibilidad, estado vivo, ejecución activa y bloqueo del compositor) de app.js a un módulo propio (2026-11-13)
- [ ] M66-T3 Formateo de resultados de herramientas e imágenes MCP (formatToolCallResult, formatMcpMarkdown, imágenes seguras) de mcp.js a un módulo propio

## M67 Arreglos de estabilización

Goal: Corregir los fallos detectados en bucles agénticos largos con herramientas multimedia y en la ejecución desatendida en Node.js (emparejamiento de llamadas paralelas con evidencia visual en todos los proveedores, captura completa de `thought_signature` en streaming SSE y análisis HTML sin `DOMParser` del navegador).
Done when: Las llamadas paralelas que incluyen herramientas con imágenes (`download_image`, `read_knowledge_image`, `browser_action`) mantienen íntegro su bloque `[assistant, tool...]` en `ChatEngine` y en los adaptadores de OpenAI, Gemini, Claude, OpenRouter y Ollama sin fabricar turnos `assistant` sintéticos; `thought_signature` se captura aunque llegue separado del delta de `tool_calls` o con `extra_content` parcial; la extracción HTML en `js/web-browser.js` y `js/office-parser.js` funciona en Node.js (`js/run-node.js`) sin `DOMParser`; y pasan las pruebas aplicables (§4).
- [ ] M67-T1 Evidencia visual diferida tras lotes completos de herramientas en `ChatEngine.buildEffectiveMessages` (`js/chat-engine.js`) y revisión transversal por proveedor (`js/providers.js`, `js/context-manager.js`): actualmente cada mensaje `tool` con `images` inyecta inmediatamente un mensaje `user` con la imagen, rompiendo los lotes paralelos `[assistant, tool_1, tool_2]` cuando `tool_1` lleva imagen y haciendo que `MessageTurns.hasMatchingToolCall` falle en `tool_2`; esto afecta de forma generalizada a todos los proveedores (en OpenAI/vLLM/Ollama/OpenRouter rompe la secuencia `assistant.tool_calls` → `tool*` y fabrica un `assistant` sintético con `arguments: '{}'`; en Claude rompe el requisito de tener todos los `tool_result` en el primer `user` tras `tool_use`; en Gemini además el `assistant` sintético carece de `thought_signature` y dispara HTTP 400). Qué hacer: acumular la evidencia visual durante cada racha contigua de mensajes `tool` y emitirla solo al terminar el lote completo (consolidada tras todos los `tool`), comprobar en `GeminiProviderAdapter.formatMessages` y `ClaudeProviderAdapter.formatMessages` el encaje de los mensajes resultantes (puente `assistant` único en Gemini y compatibilidad de `tool_result` + imagen en `user` para Anthropic), verificar atomicidad en `ContextManager.groupIntoAtomicBlocks`, y cubrir con pruebas en `tests/integration/test_chat_engine.js` y `tests/integration/test_providers.js` para Gemini, Claude y OpenAI
- [ ] M67-T2 Captura robusta de `thought_signature` y fusión segura de deltas en streaming SSE (`js/providers.js`, `js/api.js`): actualmente `BaseProviderAdapter.parseStreamChunk` solo busca `thought_signature` si existe `delta` y `createStreamAccumulator`/`applyChunk` solo la pasa a `mergeToolCallDelta` dentro del `if` de `toolCallDeltas`, perdiéndose si llega en un chunk previo de razonamiento, en el chunk final de cierre o a nivel de `choice`/`parsed` sin `delta`; además `mergeToolCallDelta` sobreescribe `call.extra_content` con deltas posteriores y cuando `delta.index === undefined` asigna un índice nuevo si `calls[0].id !== delta.id` sin comprobar si ese `id` ya existe en otro índice. Qué hacer: extraer `thought_signature` y `extra_content.google.thought_signature` en `parseStreamChunk` aunque no haya `delta`, retener la firma del paso en `createStreamAccumulator` para adjuntarla al primer `tool_call` del lote si falta al cerrar el stream, buscar por `delta.id` antes de abrir índice nuevo cuando `delta.index === undefined`, fusionar `extra_content` sin perder `google.thought_signature`, y añadir pruebas en `tests/unit/test_api_utils.js` y `tests/integration/test_providers.js`
- [ ] M67-T3 Extracción y parseo HTML compatible con Node.js sin `DOMParser` en `js/web-browser.js` y `js/office-parser.js` para el runner desatendido (`js/run-node.js`): en servidor (`py/ii-run-mode.py` → `js/run-node.js`), `extractReadableTextFromHtml` (`js/web-browser.js`) y `htmlToMarkdown` (`js/office-parser.js`) invocan `new DOMParser()`, lanzando `ReferenceError: DOMParser is not defined` al usar `fetch_web_page` o `download_doc` (DOCX). Qué hacer: sustituir o respaldar el uso directo de `DOMParser` en los módulos compartidos con un analizador HTML ligero sin dependencias del DOM de navegador (conservando en `extractReadableTextFromHtml` la extracción de `title`, `meta[name="description"]`, contenido principal, imágenes resueltas a Markdown y limpieza de `script`/`style`/`noscript`/`iframe`/`svg`/`canvas`/`nav`/`footer`/`form`, y en `htmlToMarkdown` la conversión de encabezados, listas y tablas) manteniendo la ruta nativa del navegador cuando exista `DOMParser`, y añadir pruebas unitarias ejecutadas en Node.js sin `globalThis.DOMParser`
