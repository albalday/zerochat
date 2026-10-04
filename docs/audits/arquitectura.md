# Informe de Auditoría de Arquitectura y Calidad de Código

**Fecha**: 4 de octubre de 2026  
**Versión evaluada**: Web v8.12.4 / Backend v8.12  
**Commit base del código**: `aff1019` (`master`; `dev` solo añade cambios de `/help` y de este informe)  
**Alcance**: Backend local (`py/`, `zerochat.py`), frontend (`js/`, `js/tools/`), interfaz (`zerochat.html`), estilos (`css/`), scripts (`scripts/`) y pruebas (`tests/`).  
**Procedimiento de referencia**: [`AuditFull.md`](AuditFull.md)

### Autoría

| Papel | Agente |
|---|---|
| Primera aproximación (borrador) | Gemini 3.8 Flash en Google Antigravity |
| Verificación, corrección y redacción final | Claude Opus 5.5 (`claude-opus-5-5`) en Claude Code |

Los agentes trabajaron a partir de instrucciones del responsable del proyecto, sin redacción humana del contenido.

### Convención de evidencia

Cada afirmación indica su procedencia:

- **[test]**: comprobada por una prueba automatizada que se nombra.
- **[cmd]**: comprobada con un comando reproducible sobre el commit base.
- **[lectura]**: comprobada leyendo el código citado, sin prueba automática que la proteja.
- **[no verificado]**: afirmación del borrador que no se ha podido demostrar y se conserva solo como hipótesis.

---

## 1. Línea base

| Comprobación | Resultado | Procedencia |
|---|---|---|
| `npm test` | 680/680 pruebas, 13 suites | [cmd] |
| `npm run test:browser` | 86/86 pruebas en Chromium headless (Playwright 1.62.1) | [cmd] |
| `npm run test:integration` | 298/298 pruebas | [cmd] |
| `npm run test:infrastructure` | 30/30 pruebas | [cmd] |
| `npm run test:architecture` | 23/23 pruebas en 5 archivos (`tests/architecture/`) | [cmd] |
| Árbol de trabajo | Solo cambios de documentación (`docs/audits/`, `help/`) | [cmd] `git status --short` |

Los tiempos de ejecución varían entre máquinas y no se consideran evidencia.

---

## 2. Código muerto, i18n y recursos

### 2.1. Internacionalización (`ChatI18n`)
* **Paridad de diccionarios**: 649 claves en español y 649 en inglés en `js/i18n.js`, con el mismo conjunto de claves. [cmd]
* **Textos fuera de `ChatI18n`** (hallazgo H-03): existen literales visibles sin traducir, contrarios a `AGENTS.md`:
  * `js/debug.js:336` → `'Copiado'`.
  * `js/rag-ui.js:722` → `'¡Exportado!'`.
  
  La paridad de claves no garantiza que todo texto visible use claves; no existe prueba que lo impida. [cmd]

### 2.2. Iconos y sprite SVG
* Cada referencia `#icon-*` existe en el sprite de `zerochat.html`, el sprite no declara símbolos sin uso y cada glifo de `js/icons.js` tiene al menos un consumidor. [test] `tests/architecture/test_icon_sprite.js`
* Ausencia de emojis en controles: la prueba cubre solo `markdown.js` y el banner de importación (`test_ui_modernization.js:50`). La afirmación general del borrador ("ningún control usa emojis") es [no verificado] fuera de esos casos.

### 2.3. CSS
* `zerochat.html` enlaza 14 hojas de estilo y todas existen en disco. [cmd]
* "470 selectores sin reglas muertas": [no verificado]. El borrador no documenta el método y una búsqueda textual no detecta clases construidas dinámicamente.

### 2.4. Scripts
* `zerochat.html` carga 69 scripts y todos declaran `defer`. [cmd]

### 2.5. Marcadores de deuda
* No hay marcadores `FIXME` ni `HACK`. La única coincidencia de `TODO` (`js/tool-security.js:976`) es la palabra española "todo" en un comentario, no un marcador de deuda. [cmd]

---

## 3. Contratos de arquitectura (`AGENTS.md`)

| Regla | Estado | Procedencia |
|---|---|---|
| **Estado (`ChatState`)** | Cumple. Solo `state.js` y `ui-inspector.js` escriben el slice `ui` con `State.set`. | [test] `test_state_contract.js` |
| **Diálogos** | Cumple. Sin `alert()`, `confirm()` ni `prompt()` nativos. | [test] `tests/unit/test_dialogs.js:23` |
| **Proveedores** | Cumple. `ClaudeProviderAdapter`, `GeminiProviderAdapter`, `OllamaProviderAdapter`, `OpenRouterProviderAdapter`, `MirrorProviderAdapter` y `WebLLMProviderAdapter` extienden `BaseProviderAdapter`; OpenAI/LM Studio y "Personalizado" usan la clase base directamente (`js/providers.js:1457-1463`). | [lectura] |
| **Herramientas** | Cumple. 12 herramientas integradas en `js/tools/builtin/` sin las propiedades obsoletas `ui` ni `handler`. | [test] `test_tool_contract.js` |
| **Mensajes inyectados en inglés** | Cumple en los casos revisados (`Continue`, mensajes de evidencia visual y capturas). | [lectura] |
| **Ciclo de vida de listeners** | `ui-composer.js`, `ui-settings.js` y `ui-sidebar.js` exponen `dispose()`. No se ha comprobado de forma exhaustiva que liberen todos los listeners. | [lectura] |
| **Errores explícitos** | **No cumple de forma general**: 116 bloques `catch` vacíos en `js/` (hallazgo H-01). | [cmd] |

---

## 4. Seguridad y aislamiento

### 4.1. Contenido externo y HTML
* Existen primitivas seguras en `ChatUtils` (`setText`, `appendTextElement`) con pruebas de escape. [test] `ChatUtils - escapa HTML…` y `ChatUtils - primitivas de DOM…`
* "Todas las asignaciones `innerHTML` con datos externos están saneadas": [no verificado] de forma exhaustiva. Se recomienda una prueba de arquitectura que inventaríe los usos de `innerHTML`.

### 4.2. Sandbox de JavaScript (`js/sandbox.js`)
* `<iframe>` con `sandbox="allow-scripts"` (origen opaco), CSP `default-src 'none'; connect-src 'none'`, watchdog de tiempo y filtro `e.source === iframe.contentWindow` con identificador de solicitud. [lectura] `js/sandbox.js:440-447`, `:602`
* **Límite declarado**: el propio módulo advierte que *no debe considerarse un sandbox de seguridad a nivel de sistema operativo* (`js/sandbox.js:11-14`). Es una capa de contención para cálculos del modelo, no una frontera de seguridad frente a código hostil.

### 4.3. Backend local (`py/`)
* **Token diario**: `~/zerochat/config/token.json`, escrito con `0600` desde su creación en un directorio `0700`. [lectura] `py/cc-environment.py:64-82`
* **Autorización de herramientas del backend**: HMAC-SHA256 sobre versión, sesión, método, ruta, caducidad, nonce y hash SHA-256 del cuerpo; TTL acotado y consumo de nonces bajo lock, lo que impide repeticiones. [lectura] `py/ff-server.py:170-205`
* **Procesos**: `execute_command` y `PersistentShellSession` en `py/dd-tools.py`; `_kill_process_tree()` termina el grupo de procesos (`killpg`) al vencer el tiempo. [lectura]
* **Dependencias MCP** aisladas en `~/zerochat/.venv/`. [lectura]

### 4.4. Riesgos aceptados (no son defectos, pero deben constar)
| Riesgo | Situación |
|---|---|
| Origen compartido `https://albalday.github.io` | Otras páginas del mismo origen pueden leer cookie, `localStorage` e IndexedDB. Aceptado y documentado en `AGENTS.md` §4. |
| `--host` no local | Expone la ejecución de comandos a la red sin cifrar; el arranque avisa. |
| WebLLM desde CDN | El motor se importa de `cdn.jsdelivr.net` (`js/providers-webllm.js:14`); depende de un tercero en tiempo de ejecución. |
| Herramientas web | DuckDuckGo, Jina Reader y AllOrigins reciben las consultas y URLs solicitadas. |
| Proveedores remotos | Los mensajes salen del navegador hacia el proveedor elegido. |

---

## 5. Mapa de subsistemas

```
                      +------------------------------------------+
                      |         zerochat.html (Frontend)         |
                      +------------------------------------------+
                                           |
                                           v
+------------------+          +--------------------------+          +-------------------+
|  ChatProviders   | <------- | ChatState (Store Único)  | -------> |  ChatToolSecurity |
| (WebLLM/Remote)  |          +--------------------------+          |  (Políticas/CWD)  |
+------------------+                       |                        +-------------------+
         |                                 v                                  |
         |                    +--------------------------+                    |
         +------------------> |  ChatEngine / AgentCore  | <------------------+
                              +--------------------------+
                                   |                 |
                   +---------------+                 +---------------+
                   v                                                 v
      +------------------------+                        +-------------------------+
      |  RAG léxico (Orama)    |                        |  Backend (zerochat.py)  |
      +------------------------+                        +-------------------------+
```

1. **Inferencia y streaming**: SSE normalizado por adaptador, con separación del razonamiento (`reasoningChunk`) y herramientas nativas o en texto (`<tool_call>`, solo con proveedores que declaran `textTools`, hoy WebLLM).
2. **Agente**: ciclo acotado por `maxAgentTurns` (5–200, por defecto 40; `js/config-store.js:67`) con `agent_checkpoint`, `update_plan` y `finish_task`.
3. **RAG**: índice **léxico** Orama en el navegador sobre IndexedDB (`ZeroChatDB`); sin embeddings. Ingesta de PDF (con conversión CMYK→RGB de imágenes), texto, Markdown y código.
4. **Seguridad de herramientas**: políticas `ask`, `allow_all`, `workspace_trust` y reglas `deny`, detección de comandos encadenados y verificación de rutas.

---

## 6. Hallazgos

| ID | Prioridad | Riesgo | Evidencia | Propuesta | Prueba de cierre |
|---|---|---|---|---|---|
| **H-01** | Media | Estabilidad / diagnóstico | 116 `catch {}` vacíos en `js/`. Caso crítico: `js/agent-core.js:1347`, donde falla en silencio la respuesta final tras agotar `maxAgentTurns`. | Clasificarlos: los de carga opcional de módulos (`require` en UMD) pueden quedar justificados con un comentario; el resto debe registrar en `Debug`/`console.warn` o propagar. | Prueba de arquitectura que rechace `catch` vacíos fuera de una lista permitida. |
| **H-02** | Baja | Mantenibilidad | `js/sandbox.js:641-650`: `execute()` acepta `timeoutMs` como número u objeto. | Normalizar a número en la próxima versión mayor. | Prueba unitaria del contrato de `execute`. |
| **H-03** | Baja | Presentación / i18n | Literales visibles sin `ChatI18n`: `js/debug.js:336`, `js/rag-ui.js:722`. | Crear claves en ambos diccionarios. | Prueba de arquitectura que detecte asignaciones de texto literal a `textContent`. |
| **H-04** | Baja | Seguridad (documental) | La ayuda y los informes previos presentaban el sandbox JS como frontera de seguridad. | Alinear la documentación con el aviso de `js/sandbox.js:11-14`. | Revisión de `/help`. |
| **I-01** | Informativa | — | `py/ff-server.py:113` sirve `help/` en modo local. | Comportamiento previsto. | — |

---

## 7. Conclusión

Las suites de prueba pasan íntegramente y los contratos de `AGENTS.md` protegidos por pruebas (estado, diálogos, herramientas, iconos) se cumplen. La seguridad del backend (token diario, firmas HMAC con nonce, terminación de procesos) está implementada como se describe.

Quedan deudas que el borrador anterior no detectó: el patrón sistemático de `catch` vacíos (H-01) y textos fuera de i18n (H-03). Varias afirmaciones de "cero defectos" (CSS, emojis fuera de los casos probados, `innerHTML`) no tienen hoy un método reproducible; deberían convertirse en pruebas de arquitectura antes de afirmarse.
