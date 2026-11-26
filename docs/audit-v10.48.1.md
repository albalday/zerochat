# Auditoría técnica y de seguridad de ZeroChat (`v10.48.1`)

Auditoría técnica, arquitectónica y de seguridad realizada frente a [`docs/audit.md`](./audit.md), [`AGENTS.md`](../AGENTS.md), [`docs/architecture.md`](./architecture.md), [`py/README.md`](../py/README.md), [`js/README.md`](../js/README.md), [`js/tools/README.md`](../js/tools/README.md), [`tests/README.md`](../tests/README.md) y los contratos activos de [`.zerochat/log.md`](../.zerochat/log.md).

> **Regla de oro (`docs/audit.md` §1):** esta auditoría no modifica código de producción, `.zerochat/plan.md` ni páginas de `help/`. Su único entregable es este informe de diagnóstico y propuesta de tareas.

---

## 1. Resumen y línea base

### 1.1. Estado del árbol y validaciones automáticas
- **Versión y commit revisados:** `zerochat@10.48.1` (`dev` == `master` == `0997c542`), auditoría completa (`js/`, `css/`, `zerochat.html`, `files.html`, `py/`, `services/`, `scripts/`, `tests/`).
- **`git status --short`:** sin cambios en código ni artefactos; solo cambios previos pendientes de memoria de proyecto (`M .zerochat/log.md`, `M .zerochat/plan.md`, `M .zerochat/state.md`, `?? .zerochat/archive/log_M81-M93.md`).
- **`npm run lint`:** **VERDE** (`ruff@0.17.5`: `All checks passed!`; `pyright@1.1.414`: `0 errors, 0 warnings, 0 informations`).
- **`npm run test:architecture`:** **VERDE** (`40 pass, 0 fail`).
- **`npm test`:** **VERDE** sobre el commit `0997c542` (477 pruebas Node + 216 `unittest` Python, 2 skipped).
- **Estado de artefactos generados (verificados sin regenerar previamente):** `zerochat.py` (sincronía AST con `py/`), `services/manifest.json`, `py/tools/sandbox_script.py`, `js/sandbox-node-script.js`, `js/vendor/` y `sitemap.xml` **en verde** según `tests/architecture/`.

### 1.2. Valoración general
La arquitectura de ZeroChat es coherente y disciplinada: la separación `Sesión = Proyecto` vs `Perfil = Modelo`, el punto único de ejecución (`py/server/tool_calls.py`), la protección contra bucles y bloqueo del GIL, la lista cerrada de `innerHTML` y la batería de `tests/architecture/` cubren una superficie muy amplia.

Los **28 hallazgos** detectados (2 críticos, 11 altos, 10 medios, 5 bajos) se concentran en **fronteras acopladas entre frontend y backend** donde el análisis estático no llega: validación de URL/permisos en el navegador automatizado (`F-01`, `F-25`), bypasses en el parser de `run_command` (`F-02`), exposición de secretos y tokens (`F-05`, `F-07`, `F-08`), políticas CORS/SSRF/borrado de proyectos (`F-03`, `F-04`, `F-06`, `F-10`, `F-26`), bugs funcionales/carreras en OAuth MCP y guardado del runner (`F-11`, `F-12`, `F-13`, `F-27`), y estabilidad/límites `N`/`N+1` (`F-14`–`F-20`).

### 1.3. Decisiones cerradas respetadas (no reportadas como defectos)
Contrastadas con [`docs/architecture.md`](./architecture.md) y [`.zerochat/log.md`](../.zerochat/log.md): ofuscación XOR en SQLite (`M75-D3`, `M75-D4`), `serve_forever(poll_interval=0.05)` (`M83-D1`), herencia de entorno del runner Node (`M73-D10`), entrega en memoria de API keys al runner (`M73-D17`), namespace plano de `zerochat.py` (`M64-D1`) y requisito de `R:` para `launch_agent` entre proyectos (`M87-D8`).

---

## 2. Tabla resumen de hallazgos (`F-01` a `F-28`)

| ID | Prioridad | Área | Dominio funcional (FE + BE) | Archivos principales | Título corto |
|---|---|---|---|---|---|
| **F-01** | **Crítica** | Seguridad | Navegador + Ejecución desatendida | `py/tools/browser_action.py`, `py/cli/main.py` | `browser_action` navega a `file://`/SSRF y se auto-autoriza junto a `browser_fill_secret` |
| **F-02** | **Crítica** | Seguridad | Permisos `run_command` | `py/security/rules.py` | Bypasses reproducidos (`command -- cd`, `>/dev/null.txt`, `2>&10`, `>$null.txt`) |
| **F-03** | **Alta** | Seguridad | Transporte HTTP / CORS / Preview | `py/server/handler.py`, `js/utils.js` | `Origin: null` admitido en `POST` sin preflight (DoS lockout + falsificación de actividad) |
| **F-04** | **Alta** | Seguridad | Permisos `AccessController` | `py/security/controller.py`, `js/tool-security.js` | `apply_tool_decision` omite validaciones de `authorize_challenge` (`M91-D2`, `M61-D25`) |
| **F-05** | **Alta** | Seguridad | Autenticación / Runner | `py/server/handler.py`, `py/auth/tokens.py` | `TokenGrant(runner)` no fija el proyecto y confía en `X-ZeroChat-Project` |
| **F-06** | **Alta** | Seguridad | Proxy Web Anti-SSRF | `js/web-browser.js`, `py/web/fetch.py` | Anti-SSRF asimétrico FE vs BE, DNS rebinding TOCTOU y `endswith("duckduckgo.com")` |
| **F-07** | **Alta** | Seguridad | Navegador / Secretos | `py/browser/config.py`, `py/browser/engines.py`, `js/ui-browser.js` | `extensionToken` devuelto en claro por JSON-RPC e inyectado en el DOM (`M75-D5`) |
| **F-08** | **Alta** | Seguridad | Perfiles / Backups cifrados | `js/profile-backup.js` | KDF débil (`SHA-256` sin sal ni iteraciones) en copias de seguridad exportadas |
| **F-10** | **Alta** | Seguridad | Comandos en segundo plano (`jobs`) | `py/tools/jobs.py` | `/tmp/zerochat-jobs-<uid>` sin validar dueño/symlink antes de `os.killpg(..., SIGKILL)` |
| **F-11** | **Alta** | Estabilidad | MCP OAuth | `py/mcp/stdio_client.py`, `js/mcp-external.js` | URL OAuth MCP corrompida (`state=***` / truncada) antes de extraerla y abrirla |
| **F-12** | **Alta** | Arquitectura | Runner Node / Persistencia | `js/run-node.js`, `js/generation-controller.js` | Carrera de guardado paso a paso en `run-node.js` (`M87-D10`) |
| **F-25** | **Alta** | Seguridad | Navegador / Secretos | `py/tools/browser_secret.py` | Oráculo de conjunto de caracteres y longitud en `browser_fill_secret` (`mode="keypad"`) |
| **F-26** | **Alta** | Seguridad | Gestión de proyectos (`M85-D2`) | `py/server/rpc.py`, `py/tools/filesystem.py` | `zerochat/project/delete` permite borrar datos de `general`/`PROJECT_DIR` y borrar `PROJECT_DIR` |
| **F-09** | **Media** | Seguridad | Servicios MCP / Secretos | `py/mcp/manager.py` | Expansión multipasada `${secret:...}` en `launch.env` desde valores de opciones |
| **F-13** | **Media** | Arquitectura | Runner / Persistencia SQLite | `py/storage/rpc.py`, `py/storage/db.py`, `js/storage.js` | Falta guarda servidor en `conversations/save` durante run activo + `delete_project_storage` |
| **F-14** | **Media** | Estabilidad | Navegador automatizado | `py/tools/browser_action.py`, `py/browser/engines.py`, `py/server/state.py` | `PersistentBrowserSession`: `stderr` sin drenar, sin timeout, sin `_kill_process_tree` ni cierre en shutdown |
| **F-15** | **Media** | Estabilidad | Orquestación / `run_mode` | `py/run_mode/state.py`, `py/tools/agents.py` | Stdin síncrono en `launch_run_file`, runs sin tope de concurrencia y `_EXITED` sin cota |
| **F-16** | **Media** | Estabilidad | Caché runner / Catálogo MCP | `py/run_mode/runner_loader.py`, `py/mcp/catalog.py`, `py/cli/main.py` | Ficheros `.tmp` fijos en paralelo y `start_catalog_refresh` en CLI efímera |
| **F-17** | **Media** | Seguridad | Renderizado Markdown / DOM | `js/markdown.js` | Placeholders `\u0001`/`\u0002` no limpiados y doble escape en `renderImage` |
| **F-18** | **Media** | Seguridad | Extracción Office / ZIP | `js/office-parser.js` | Protección ZIP-bomb insuficiente (confía en `originalSize`, sin tope acumulado y bypass en DOCX) |
| **F-19** | **Media** | Estabilidad | Herramientas FS / Diff / Jobs / Sandbox | `py/tools/common.py`, `filesystem.py`, `jobs.py`, `diff.py`, `sandbox.py`, `js/sandbox.js`, `js/tool-cards.js` | Pérdida de `st_mode`, lecturas sin tope, contratos `truncated` en `N`/`N+1` y `timeoutMs` |
| **F-20** | **Media** | Arquitectura | Servicios MCP / Estado vivo | `py/mcp/manager.py` | `list_servers` muta `self.services` y re-escanea disco en cada heartbeat (sin tocar `self._lock`) |
| **F-27** | **Media** | Arquitectura | Orquestación multi-agente | `py/tools/agents.py` | `check_agents(include_turn=True)` amputa el turno en mensajes sintéticos `_toolEvidence` |
| **F-21** | **Baja** | Estabilidad | Servicio MCP de correo | `services/mail/mail_mcp_server.py` | Fallo al responder correos con cabeceras plegadas (`\r\n\t`) |
| **F-22** | **Baja** | Código muerto/Duplicación | Navegador / HTTP / Backups | `py/browser/*`, `js/ui-browser.js`, `js/i18n.js`, `py/server/handler.py`, `js/profile-backup.js` | Acción huérfana "Borrar datos del navegador" (`M80-D1`) y ramas legacy sin uso |
| **F-23** | **Baja** | Arquitectura | Contexto / Red / Perfiles | `js/context-manager.js`, `js/web-browser.js`, `js/profile-repository.js` | Literales en español que evaden `test_english_literals.js` (`js/README.md` §5) |
| **F-24** | **Baja** | Pruebas | Suite de pruebas | `tests/architecture/*`, `tests/unit/test_utils.js`, `tests/browser/*`, `tests/infrastructure/py/*` | `files.html` fuera de `test_csp.js`, sleeps fijos, excepción obsoleta y cobertura de seguridad/`N`/`N+1` |
| **F-28** | **Baja** | Estabilidad | Autenticación remota (`login`) | `py/auth/login.py`, `py/server/handler.py`, `py/server/rpc.py` | `zerochat/login` sin rechazo de `\x00` ni captura defensiva fuera de `do_POST` |

---

## 3. Auditoría agrupada por áreas funcionales acopladas (Frontend + Backend)

### Dominio 1 — Transporte HTTP, Autenticación, Sesión y Proxy Web Anti-SSRF
- **Programas acoplados (FE ↔ BE):** `js/backend-session.js`, `js/mcp.js`, `js/web-browser.js`, `js/utils.js` ↔ `py/server/handler.py`, `py/server/rpc.py`, `py/server/state.py`, `py/auth/tokens.py`, `py/auth/login.py`, `py/core/rate_limit.py`, `py/web/fetch.py`.
- **Revisión de seguridad:**
  - *Controles sólidos:* canal único `POST /`, filtro `..` previo a autenticación (`has_dot_segment`), comparación constante de tokens (`hmac.compare_digest`), rotación diaria, lockout tras 5 fallos en `zerochat/login`, rate-limiter saliente (`py/core/rate_limit.py`) y validación de redirecciones en `py/web/fetch.py`.
  - *Brechas:* **F-03** (`Origin: null` admitido en `POST` sin preflight → DoS de bloqueo de login durante 15 min y falsificación de actividad), **F-05** (`TokenGrant(runner)` sin pinning de proyecto, confiando en `X-ZeroChat-Project`), **F-06** (anti-SSRF asimétrico FE vs BE, ventana TOCTOU de DNS rebinding, `endswith("duckduckgo.com")` y error de redirección bloqueada devuelto como `{ok: False}` en vez de `-32602`), **F-28** (`\x00` en login no rechazado y fuera del `try/except` de `do_POST`), y ramas muertas en `handler.py` (**F-22**).

### Dominio 2 — Motor de Permisos (`AccessController`), `Sesión = Proyecto` y Herramientas de Host / FS / Diff
- **Programas acoplados (FE ↔ BE):** `js/tool-security.js`, `js/tool-cards.js`, `js/files-page.js`, `files.html`, `js/ui-project.js`, `js/ui-folder-picker.js`, `js/ui-command-jobs.js`, `js/command-card.js` ↔ `py/security/rules.py`, `py/security/controller.py`, `py/security/context.py`, `py/server/tool_calls.py`, `py/server/rpc.py`, `py/tools/registry.py`, `py/tools/common.py`, `py/tools/filesystem.py`, `py/tools/project_files.py`, `py/tools/diff.py`, `py/tools/jobs.py`, `py/tools/job_waits.py`, `py/tools/jobs_rpc.py`.
- **Revisión de seguridad:**
  - *Controles sólidos:* punto único de ejecución (`server/tool_calls.py`), retos de un solo uso con TTL, resolución canónica de symlinks (`SecurityContext.absolute`), `project_files.py` bien acotado a `ctx.workspace_dir.resolve()`, búsqueda fija sin regex del modelo (protección GIL) y escapado correcto en `render_diff_html`.
  - *Brechas:* **F-02** (bypasses reproducidos en `run_command`: `command -- cd` y `command -p cd` evaden permiso `X`; `>/dev/null.txt`, `2>&10` y `>$null.txt` en PowerShell evaden filtro de redirección), **F-04** (`apply_tool_decision` permite persistir `tools.run_command = allow` y `servers[""] = allow` omitiendo validaciones de `authorize_challenge`), **F-10** (`/tmp/zerochat-jobs-<uid>` sin comprobar dueño/symlink antes de `SIGKILL`), **F-26** (`zerochat/project/delete` rompe `M85-D2` permitiendo borrar datos de `general`/`PROJECT_DIR` y borrar `PROJECT_DIR` en disco), **F-19** (pérdida de `st_mode` en escritura atómica, lecturas sin tope en `edit_file`/`get_diagnostics`/`diff.py`, `truncate_terminal_output` sin reaplicar `max_chars`, flags `truncated` en `N`/`N+1`, y `openFileDiff` sin `noopener,noreferrer` ni `revokeObjectURL`).

### Dominio 3 — Navegador Automatizado (Playwright), Secretos y Servicios MCP Gestionados
- **Programas acoplados (FE ↔ BE):** `js/ui-browser.js`, `js/mcp-external.js`, `js/ui-mcp.js`, `js/mcp.js`, `js/ui-project.js` ↔ `py/tools/browser_action.py`, `py/tools/browser_secret.py`, `py/browser/config.py`, `py/browser/engines.py`, `py/browser/rpc.py`, `py/mcp/catalog.py`, `py/mcp/manager.py`, `py/mcp/stdio_client.py`, `py/mcp/rpc.py`, `services/mail/mail_mcp_server.py`.
- **Revisión de seguridad:**
  - *Controles sólidos:* `BrowserLease` exclusivo por conversación, verificación SHA-256 del catálogo MCP, secretos almacenados ofuscados en `secrets` e inyectados solo por entorno, y `outbox` seguro (`O_NOFOLLOW`, `lstat`/`fstat`, `M91-D1`) en `mail_mcp_server.py`.
  - *Brechas:* **F-01** (`browser_action` navega a `file://` y metadatos cloud sin filtro alguno, y tanto `browser_action` como `browser_fill_secret` se auto-autorizan en ejecuciones desatendidas), **F-25** (`browser_fill_secret` en `mode="keypad"` actúa como oráculo de caracteres y longitud), **F-07** (`extensionToken` devuelto en claro en RPC e inyectado en el DOM violando `M75-D5`), **F-09** (expansión multipasada `${secret:...}` en `launch.env`), **F-11** (URL OAuth mutilada con `state=***` antes de abrirla + `window.open` sin `noopener,noreferrer` ni chequeo de esquema), **F-14** (`PersistentBrowserSession` con `stderr` sin drenar, sin timeout y procesos huérfanos), **F-20** (`list_servers` mutando `self.services` y re-escaneando disco en cada latido), **F-21** (`mail_mcp_server.py` falla con cabeceras plegadas) y **F-22** (feature muerta `browser/data/clear` tras `M80-D1`).

### Dominio 4 — Ejecución Desatendida (CLI, Runner Node.js) y Orquestación Multi-Agente
- **Programas acoplados (FE ↔ BE):** `js/run-node.js`, `js/run-mode.js`, `js/server-run.js`, `js/generation-controller.js`, `js/headless-adapters.js`, `js/ui-sidebar.js` ↔ `py/cli/main.py`, `py/run_mode/state.py`, `py/run_mode/runner_loader.py`, `py/run_mode/supervisor.py`, `py/tools/agents.py`.
- **Revisión de seguridad:**
  - *Controles sólidos:* servidor de ejecución aislado en loopback con puerto efímero y token exclusivo `runner` (`M87-D2`), `--run-file` nunca amplía permisos ni herramientas (`M84-D1`), runner Node ejecutado con `--permission` acotado a su caché y enlazado al ciclo de vida del padre vía stdin (`M93-D2`), `launch_agent` valida `is_relative_to`, `R:` y `watchAgents`.
  - *Brechas:* **F-01** (auto-allow excesivo en `reset_session_authorizations`), **F-05** (runner token sin pinning de proyecto), **F-12** (`js/run-node.js` no encadena ni espera `saveActiveConversation` en `onStepHistory`), **F-15** (escritura síncrona a `proc.stdin` en `launch_run_file`, runs sin tope de concurrencia, `_EXITED` sin cota), **F-16** (`.tmp` fijos en paralelo + `start_catalog_refresh` en invocaciones CLI efímeras) y **F-27** (`check_agents(include_turn=True)` amputado por mensajes `_toolEvidence`).

### Dominio 5 — Motor Agéntico, Proveedores LLM, Ventana de Contexto y Sandbox JS
- **Programas acoplados (FE ↔ BE):** `js/agent-core.js`, `js/chat-engine.js`, `js/providers.js`, `js/api.js`, `js/context-manager.js`, `js/sandbox.js`, `js/tools/builtin/execute-javascript.tool.js`, `scripts/sandbox-child.js` ↔ `py/tools/sandbox.py`, `py/tools/sandbox_script.py`.
- **Revisión de seguridad:**
  - *Controles sólidos:* API keys enviadas por cabeceras (nunca en query strings), contexto de herramientas restringido (`M63-D5`), sandbox Node en tres capas (`--permission`, `--disallow-code-generation-from-strings`, `minimal_child_env`, script único sincronizado), protección contra bucles y compactación por bloques atómicos.
  - *Brechas:* **F-19** (parte sandbox: `py/tools/sandbox.py:23` sin `math.isfinite`, `js/sandbox.js:268` sin cota `MAX_TIMEOUT_MS`), **F-23** (`js/context-manager.js` inyecta avisos en español al modelo). *Observación menor:* `OpenRouterProviderAdapter.applyContextCache` (`js/providers.js:1249-1254`) muta in-place `toolsList[toolsList.length - 1].cache_control`.

### Dominio 6 — Persistencia SQLite/IndexedDB, Perfiles/Cifrado y Documentos/RAG
- **Programas acoplados (FE ↔ BE):** `js/storage.js`, `js/storage-db.js`, `js/profile-repository.js`, `js/profile-backup.js`, `js/office-parser.js`, `js/html-document.js`, `js/rag-index.js`, `js/ragStorage.js` ↔ `py/storage/db.py`, `py/storage/rpc.py`, `py/storage/obfuscation.py`.
- **Revisión de seguridad:**
  - *Controles sólidos:* SQLite `0600`, transacciones `BEGIN IMMEDIATE`, subida por tramos acotada (`MAX_STAGED_CONVERSATION_BYTES`), recolección transaccional de blobs huérfanos, `ChatHtmlDocument` con límite de profundidad (`MAX_DEPTH = 512`), `ChatRagIndex` con control de revisiones anti-carrera.
  - *Brechas:* **F-08** (`SHA-256` sin sal ni iteraciones como KDF para backups cifrados de perfiles), **F-13** (falta guarda servidor en `conversations/save` durante `--conversation` activo + `delete_project_storage` sin comprobar `run_process_alive`), **F-18** (protección ZIP-bomb insuficiente en `js/office-parser.js` y bypass en `parseDocx`), **F-22** (`startsWith('La copia')` muerto en `js/profile-backup.js:184`), **F-23** (3 literales en español en `js/profile-repository.js`).

### Dominio 7 — Interfaz Web (DOM, Markdown, XSS, CSP) y Suite de Pruebas
- **Programas acoplados (FE ↔ BE):** `zerochat.html`, `files.html`, `js/markdown.js`, `js/utils.js`, `js/files-page.js`, `tests/*`.
- **Revisión de seguridad:**
  - *Controles sólidos:* `innerHTML` controlado por lista cerrada (`test_html_sinks.js`), `files.html` incluye CSP estricta (`default-src 'self'; script-src 'self'; object-src 'none'; frame-src 'none'`), `files-page.js` construye el DOM con `textContent`/`createElement`, y `openDocumentInNewTab` usa `<iframe sandbox>` sin `allow-same-origin`.
  - *Brechas:* **F-17** (placeholders `\u0001`/`\u0002` no limpiados y doble escape en `renderImage` en `js/markdown.js`), **F-24** (`test_csp.js` omite `files.html`; excepción obsoleta en `test_backend_hygiene.js:81`; sleeps fijos en 3 suites; faltan pruebas de regresión de seguridad y bordes `N`/`N+1`).

---

## 4. Auditoría descendida a programas concretos

### 4.1. Backend Python (`py/` → `zerochat.py`) y Servicios (`services/`)

| Programa | Contraparte FE acoplada | Evaluación de seguridad y calidad | Hallazgos |
|---|---|---|---|
| [`py/server/handler.py`](../py/server/handler.py) | `js/mcp.js`, `js/backend-session.js`, `js/utils.js` | Acepta `Origin: null` en `POST`/`GET` sin exigir preflight (`64, 370`); no fija `ctx` para `runner` (`429`); `_serve_login` fuera del `try/except` (`344, 385`); ramas muertas (`156, 263`). | **F-03, F-05, F-22, F-28** |
| [`py/server/rpc.py`](../py/server/rpc.py) | `js/mcp.js`, `js/ui-project.js` | `_delete_project` (`160-185`) omite validación cuando `deleteDirectory=False`; `rpc_login` (`66`) no atrapa `ValueError` de `ctypes`. | **F-26, F-28** |
| [`py/server/state.py`](../py/server/state.py) | `js/mcp.js`, `js/server-run.js` | `stop_zerochat_server` (`190-206`) no cierra `_BROWSER_SESSION`. `BrowserLease`, `wait_live_state` y watchdog correctos. | **F-14** |
| [`py/server/tool_calls.py`](../py/server/tool_calls.py) | `js/tool-security.js`, `js/tool-cards.js` | Punto único limpio; `BrowserLease` bien adquirido/renovado en `execute_tool` (`37-55`). Sin hallazgos. | — |
| [`py/auth/tokens.py`](../py/auth/tokens.py) | `js/backend-session.js`, `js/run-node.js` | Tiempo constante y rotación correctos; `TokenGrant(runner)` carece de `project_dir` para fijar el proyecto. | **F-05** |
| [`py/auth/login.py`](../py/auth/login.py) | `js/ui-connection.js` | PAM/`LogonUserW` bien serializado con `LOGIN_LOCK`; falta rechazar `\x00` en `user`/`password` (`138`). | **F-28** |
| [`py/security/rules.py`](../py/security/rules.py) | `js/tool-security.js` | Bypass reproducido en `_is_plain_segment` (`168`: `command -- cd`, `command -p cd`) y en `SAFE_REDIRECTION_PATTERN` / `POWERSHELL_SAFE_REDIRECTION_PATTERN` (`40, 42, 124`). | **F-02** |
| [`py/security/controller.py`](../py/security/controller.py) | `js/tool-security.js`, `js/server-run.js` | `apply_tool_decision` (`444-473`) omite validaciones de `authorize_challenge` (`500-548`), rompiendo `M91-D2` y `M61-D25`. | **F-04** |
| [`py/tools/browser_action.py`](../py/tools/browser_action.py) | `js/ui-browser.js` | `page.goto(req.url)` (`98, 107`) sin validación de esquema/SSRF (`file://`, metadatos); `stderr=PIPE` sin drenar, sin timeout ni `_kill_process_tree` (`153-209`). | **F-01, F-14** |
| [`py/tools/browser_secret.py`](../py/tools/browser_secret.py) | `js/ui-project.js` | En `mode="keypad"` (`63-64, 104`), filtra pertenencia de caracteres y longitud del secreto; auto-autorizado en modo desatendido. | **F-01, F-25** |
| [`py/tools/jobs.py`](../py/tools/jobs.py) | `js/ui-command-jobs.js`, `js/command-card.js` | `_jobs_base_dir` (`77-85`) usa `/tmp/zerochat-jobs-<uid>` sin comprobar `lstat`/dueño antes de `SIGKILL`; `truncate_terminal_output` (`53-70`) ignora `max_chars` con >80 líneas. | **F-10, F-19** |
| [`py/tools/common.py`](../py/tools/common.py) | — | `_atomic_write_text` (`29-34`) pierde `st_mode` y deja `.tmp_*` en error. | **F-19** |
| [`py/tools/filesystem.py`](../py/tools/filesystem.py) | `js/project-context.js`, `js/ui-folder-picker.js` | `validate_deletable_project_dir` (`405-415`) no protege `PROJECT_DIR`; lecturas sin tope (`251, 513, 541`); `truncated` ausente (`85-91, 579-592`) o falso positivo (`499`). | **F-19, F-26** |
| [`py/tools/project_files.py`](../py/tools/project_files.py) | `js/files-page.js`, `files.html` | Resolución de symlinks (`_inside`) y topes `MAX_LIST_ENTRIES`/`MAX_TEXT_VIEW_BYTES`/`MAX_DOWNLOAD_BYTES` correctos. | — |
| [`py/tools/diff.py`](../py/tools/diff.py) | `js/tool-cards.js` | Escapado HTML correcto; falta tope de 5 MB en `git show` (`624-627`), tope en `git diff`, y `noopener` / `revokeObjectURL` en `openFullFile` (`389`). | **F-19** |
| [`py/tools/sandbox.py`](../py/tools/sandbox.py) | `js/sandbox.js` | Aislamiento sólido; `_normalize_timeout_ms` (`23`) no verifica `math.isfinite`. | **F-19** |
| [`py/tools/agents.py`](../py/tools/agents.py) | `js/ui-sidebar.js` (pestaña Agentes) | `_last_turn` (`160`) no filtra `_toolEvidence`; `launch_agent` (`363`) sin tope de runs concurrentes. | **F-15, F-27** |
| [`py/browser/config.py`](../py/browser/config.py), [`engines.py`](../py/browser/engines.py), [`rpc.py`](../py/browser/rpc.py) | `js/ui-browser.js` | Devuelven `extensionToken` en claro (`config.py:101-119`, `engines.py:197`); `engines.py:235` usa `proc.kill()` en vez de `_kill_process_tree`; `clear_own_browser_data` / `own_browser_profile_dir` son código muerto tras `M80-D1`. | **F-07, F-14, F-22** |
| [`py/mcp/stdio_client.py`](../py/mcp/stdio_client.py) | `js/mcp-external.js` | `_drain_stderr` (`132-148`) aplica `_mcp_trace_text` antes de extraer `oauth_url`, corrompiendo `state=...` y truncando URLs >1000 chars. | **F-11** |
| [`py/mcp/manager.py`](../py/mcp/manager.py) | `js/mcp.js`, `js/mcp-external.js`, `js/ui-mcp.js` | `_expand` (`246-251`) multipasada sobre `option:*` y `secret:*`; `list_servers` (`215-243`) re-escanea disco y muta `self.services` por latido (debe arreglarse sin tomar `self._lock`). | **F-09, F-20** |
| [`py/mcp/catalog.py`](../py/mcp/catalog.py) | `services/manifest.json` | `install_service` (`108-110`) usa `.tmp` fijo con carrera entre procesos. | **F-16** |
| [`py/web/fetch.py`](../py/web/fetch.py) | `js/web-browser.js` | Ventana TOCTOU DNS rebinding (`93, 195`); `endswith("duckduckgo.com")` (`189`); `PermissionError` en `_ValidatingRedirectHandler` capturado en `except Exception` (`238`). | **F-06** |
| [`py/storage/rpc.py`](../py/storage/rpc.py), [`db.py`](../py/storage/db.py) | `js/storage.js` | Falta guarda en `_rpc_save_conversation` (`107-119`) durante run activo; `delete_project_storage` (`db.py:1570-1575`) no comprueba `run_process_alive`. | **F-13** |
| [`py/run_mode/state.py`](../py/run_mode/state.py), [`runner_loader.py`](../py/run_mode/runner_loader.py) | `js/run-node.js`, `js/run-mode.js`, `js/server-run.js` | `launch_run_file` (`450-455`) escribe stdin síncrono; sin tope de concurrencia; `_EXITED` (`93`) sin cota; `runner_loader.py:123-124` usa `.tmp` fijo. | **F-15, F-16** |
| [`py/cli/main.py`](../py/cli/main.py) | `js/run-node.js` | `reset_session_authorizations` (`355-365`) auto-autoriza `browser_action` y `browser_fill_secret`; `start_catalog_refresh` (`603`) corre en CLI efímera. | **F-01, F-16** |
| [`services/mail/mail_mcp_server.py`](../services/mail/mail_mcp_server.py) | `py/mcp/manager.py` | Outbox seguro (`O_NOFOLLOW`, `M91-D1`); fallo al responder correos con `References`/`Message-ID` plegados (`418-423`). | **F-21** |

### 4.2. Frontend (`js/`, `zerochat.html`, `files.html`) y Pruebas (`tests/`)

| Programa | Contraparte BE acoplada | Evaluación de seguridad y calidad | Hallazgos |
|---|---|---|---|
| [`js/web-browser.js`](../js/web-browser.js) | `py/web/fetch.py` | `isDangerousIpAddress` (`176-218`) omite trailing dot, `.localhost`/`.local`/`.internal`, IPv6 privado/mapped y CGNAT; errores en español (`245, 251, 256`). | **F-06, F-23** |
| [`js/ui-browser.js`](../js/ui-browser.js) | `py/browser/*` | Inyecta `extensionToken` en claro en el DOM (`197`); mantiene el botón muerto "Borrar datos del navegador" (`160-163, 324-329`). | **F-07, F-22** |
| [`js/mcp-external.js`](../js/mcp-external.js) | `py/mcp/stdio_client.py` | `window.open(oauthUrl, '_blank')` (`167`) sin `'noopener,noreferrer'` ni validación defensiva de esquema `https?://`. | **F-11** |
| [`js/run-node.js`](../js/run-node.js) | `py/run_mode/*`, `py/storage/rpc.py` | `onStepHistory` (`380-394`) no encadena ni espera `saveActiveConversation` antes del guardado final (asimetría con `js/generation-controller.js:238, 268, 342`). | **F-12** |
| [`js/profile-backup.js`](../js/profile-backup.js), [`profile-repository.js`](../js/profile-repository.js) | `py/storage/rpc.py` | `keyMaterialFromPassword` (`77-80`) usa `SHA-256` sin sal ni iteraciones; rama muerta `startsWith('La copia')` (`184`); 3 errores en español en `profile-repository.js:316, 320, 330`. | **F-08, F-22, F-23** |
| [`js/markdown.js`](../js/markdown.js) | — | Línea `465` limpia `\u0000` pero no `\u0001`/`\u0002`; `renderImage` (`54-56`) hace doble escape de `altText`. | **F-17** |
| [`js/office-parser.js`](../js/office-parser.js) | `js/vendor/` (`fflate`, `mammoth`) | `openPackage` (`215-224`) confía en `file.originalSize` sin tope acumulado; `parseDocx` (`348-367`) evita el filtro por completo. | **F-18** |
| [`js/context-manager.js`](../js/context-manager.js) | — | Avisos de truncado en español dirigidos al modelo (`344, 376`). | **F-23** |
| [`js/sandbox.js`](../js/sandbox.js) | `py/tools/sandbox.py` | Línea `268` no acota `timeoutMs` a `MAX_TIMEOUT_MS` (la herramienta no expone `timeoutMs` al modelo, pero la API interna es asimétrica). | **F-19** |
| [`js/utils.js`](../js/utils.js), [`js/tool-cards.js`](../js/tool-cards.js) | `py/server/handler.py`, `py/tools/diff.py` | Preview HTML en `utils.js:384-401` tiene origen `null` (relevante junto a F-03); `tool-cards.js:279` abre diff sin `noopener,noreferrer` ni `revokeObjectURL`. | **F-03, F-19** |
| [`js/files-page.js`](../js/files-page.js), [`files.html`](../files.html) | `py/tools/project_files.py` | Implementación segura y CSP estricta en `files.html:6`, pero sin cobertura en `test_csp.js`. | **F-24** |
| [`tests/architecture/*`](../tests/architecture/), [`tests/unit/test_utils.js`](../tests/unit/test_utils.js), [`tests/browser/browser_conversation.test.js`](../tests/browser/browser_conversation.test.js), [`tests/infrastructure/py/test_server_runs.py`](../tests/infrastructure/py/test_server_runs.py) | Todo el sistema | `test_csp.js` omite `files.html`; excepción obsoleta en `test_backend_hygiene.js:81`; sleeps fijos en 3 suites; faltan pruebas de regresión de seguridad y bordes `N`/`N+1`. | **F-24** |

---

## 5. Detalle técnico de cada hallazgo (`F-01` a `F-28`)

### F-01 [Crítica — Seguridad] `browser_action` navega a `file://`/SSRF y se auto-autoriza junto a `browser_fill_secret` en modo desatendido
- **Evidencia:**
  - [`py/tools/browser_action.py:96-108, 234-252`](../py/tools/browser_action.py#L96-L108): pasa `req.url` a `page.goto()` sin validar esquema ni IP (admite `file:///etc/passwd`, `file:///home/<user>/zerochat/config/token.json`, `http://169.254.169.254/...`, `http://127.0.0.1:...`).
  - [`py/cli/main.py:355-365`](../py/cli/main.py#L355-L365): `reset_session_authorizations()` concede `POLICY_ALLOW` a toda herramienta de `LOCAL_TOOL_HANDLERS` fuera de `run_command`, `MASTER_TOOLS` y `get_integrated_path_access()`, lo que incluye `browser_action` y `browser_fill_secret` ([`py/tools/registry.py:285-286`](../py/tools/registry.py#L285-L286)).
- **Norma o contrato afectado:** `AGENTS.md` §3; `docs/architecture.md` §2.2.
- **Propuesta de solución y prueba:** Validar `req.url` exigiendo `http`/`https` y aplicando la validación anti-SSRF de `py/web/fetch.py` (con política explícita si se desea permitir `localhost` para pruebas web locales); excluir `browser_action` y `browser_fill_secret` del auto-allow en `py/cli/main.py:355-365`. Prueba en `tests/infrastructure/py/`.

### F-02 [Crítica — Seguridad] Bypasses reproducidos en `run_command` (`command -- cd` y redirecciones `>/dev/null.txt`, `2>&10`, `>$null.txt`)
- **Evidencia (reproducida directamente contra `py/security/rules.py` y `py/security/controller.py`):**
  - [`py/security/rules.py:168`](../py/security/rules.py#L168): `rest[rest[:1] == ["command"]:][:1] == ["cd"]` no contempla flags POSIX (`--`, `-p`). Con `RWX:<proj>/**` y `RW:<rw_only>/**` (sin `X`), `cd <rw_only> && ./evil.sh` devuelve `('ask', 'command_directory_without_execute')`, pero `command -- cd <rw_only> && ./evil.sh` y `command -p cd <rw_only> && ./evil.sh` devuelven **`('allow', 'directory_rule_allow')`**.
  - [`py/security/rules.py:40, 42, 124`](../py/security/rules.py#L40): `SAFE_REDIRECTION_PATTERN` sustituye `>/dev/null` y `\d?>&\d` sin delimitador final ni respeto a comillas (`split_command("echo pwn >/dev/null.txt")` → `[('', 'echo pwn  .txt')]`, `split_command("echo pwn 2>&10")` → `[('', 'echo pwn  0')]`). En PowerShell (`line 42`), `\$null\b` también coincide con `>$null.txt` y `>$null-out.txt` porque `.` y `-` son fronteras `\b`.
- **Norma o contrato afectado:** `AGENTS.md` §3 y §6 (simetría POSIX/PowerShell).
- **Propuesta de solución y prueba:** En `_is_plain_segment`, rechazar `command` cuando lleve opciones (`-p`, `--`, etc.) o saltarlas antes de detectar `cd`; añadir `(?=\s|$|[;&|)])` al final de todas las alternativas de `SAFE_REDIRECTION_PATTERN` y `POWERSHELL_SAFE_REDIRECTION_PATTERN` (evitando sustituir dentro de comillas). Pruebas en `tests/infrastructure/py/test_security_rules.py`.

### F-03 [Alta — Seguridad] `Origin: null` admitido en `POST` sin preflight → DoS de lockout de login y falsificación de actividad
- **Evidencia:** [`py/server/handler.py:62-65, 328-345, 370, 377`](../py/server/handler.py#L62-L65): `is_allowed_origin("null", require_origin=False)` devuelve `True`. Cualquier página web (vía `<iframe sandbox="allow-scripts">`) o el propio preview HTML en [`js/utils.js:384-401`](../js/utils.js#L384-L401) puede lanzar un `POST` CORS simple (`Content-Type: text/plain`, sin `OPTIONS`) a `http://127.0.0.1:6388/`, ejecutar `mark_browser_active()` (`line 377`) bloqueando `--exit-on-close` e invocar `zerochat/login` 5 veces activando el bloqueo de 15 min (`LOGIN_LOCKOUT_SECONDS = 900.0`).
- **Norma o contrato afectado:** `AGENTS.md` §3; `py/README.md` §3.
- **Propuesta de solución y prueba:** Rechazar `Origin: null` en `do_POST` y exigir `Content-Type: application/json` en `POST` para forzar preflight CORS (`do_OPTIONS` ya exige `require_origin=True`). Probar rechazo `403`/`415` en `tests/infrastructure/py/`.

### F-04 [Alta — Seguridad] `AccessController.apply_tool_decision` omite validaciones de `authorize_challenge` (`M91-D2`, `M61-D25`)
- **Evidencia:** [`py/security/controller.py:444-473`](../py/security/controller.py#L444-L473) frente a [`500-548`](../py/security/controller.py#L500-L548). Aunque `_record_decision` (`557-559`) limpia `decision, pattern` si hay `rules`, `apply_tool_decision`: (1) no lanza `ValueError` si llegan `directoryRule` y `commandPattern` a la vez (`M91-D2`); (2) permite `allow_always` sobre `run_command` sin `commandPattern`, persistiendo `global_state["tools"]["run_command"] = allow` (`line 593`, violando `M61-D25`); (3) permite `allow_server_always` con `server_id == ""` (escribe `servers[""] = allow`); (4) no valida `allow_project` ni que `commandPattern` cubra `tool_decision.args`.
- **Norma o contrato afectado:** `.zerochat/log.md` (`M61-D25`, `M91-D2`); `AGENTS.md` §2 y §6.
- **Propuesta de solución y prueba:** Extraer un validador único compartido entre `authorize_challenge` y `apply_tool_decision`, con pruebas en `tests/infrastructure/py/` por cada combinación inválida.

### F-05 [Alta — Seguridad] `TokenGrant(kind="runner")` no fija el contexto de proyecto
- **Evidencia:** [`py/auth/tokens.py:39-66`](../py/auth/tokens.py#L39-L66) acota `run_id` y `conversation_id`, pero [`py/server/handler.py:429`](../py/server/handler.py#L429) resuelve `ctx` desde la cabecera `X-ZeroChat-Project` sin restringirla para `grant.kind == "runner"`. Un proceso con ese token puede enviar otro `X-ZeroChat-Project` y ejecutar `tools/call` o `jobs/stop` bajo el `SecurityContext` y las políticas de otro proyecto.
- **Norma o contrato afectado:** `docs/architecture.md` §2.2 y §2.3; `AGENTS.md` §3.
- **Propuesta de solución y prueba:** Fijar `project_dir` en `TokenGrant(kind="runner")` y rechazar con `403` cualquier `X-ZeroChat-Project` distinto al proyecto del run (o forzar `project_context()`). Prueba en `tests/infrastructure/py/test_server_runs.py`.

### F-06 [Alta — Seguridad] Anti-SSRF asimétrico FE vs BE y ventana DNS rebinding
- **Evidencia:**
  - [`js/web-browser.js:176-218`](../js/web-browser.js#L176-L218): `isDangerousIpAddress` no normaliza trailing dot (`localhost.`, `metadata.google.internal.`), no bloquea `.localhost`/`.local`/`.internal`, IPv6 privado/ULA/link-local/mapped (`[::ffff:7f00:1]`, `[fe80::1]`, `[fc00::1]`, `[::]`) ni CGNAT (`100.64.0.0/10`).
  - [`py/web/fetch.py:93, 195`](../py/web/fetch.py#L93): doble resolución DNS (TOCTOU DNS rebinding entre `getaddrinfo` y `_WEB_OPENER.open`).
  - [`py/web/fetch.py:189`](../py/web/fetch.py#L189): `hostname.endswith("duckduckgo.com")` coincide con `evilduckduckgo.com`.
  - [`py/web/fetch.py:112-118, 238`](../py/web/fetch.py#L112-L118): `PermissionError` lanzado por `_ValidatingRedirectHandler` cae en `except Exception` devolviendo `{ok: False}` en vez de propagar `-32602` como en la URL inicial.
- **Norma o contrato afectado:** `docs/audit.md` §3.2 y §3.3; `AGENTS.md` §3.
- **Propuesta de solución y prueba:** Alinear `isDangerousIpAddress` en `js/web-browser.js`, corregir `duckduckgo.com` con `==` o `.endswith(".duckduckgo.com")`, relanzar `PermissionError`/`ValueError` antes de `except Exception`, y valorar fijación de IP validada al abrir el socket preservando SNI TLS. Pruebas en `tests/unit/` y `tests/infrastructure/py/`.

### F-07 [Alta — Seguridad] `extensionToken` de Playwright expuesto en claro por JSON-RPC y DOM
- **Evidencia:** [`py/browser/config.py:101-119`](../py/browser/config.py#L101-L119), [`py/browser/engines.py:197`](../py/browser/engines.py#L197) y [`js/ui-browser.js:197`](../js/ui-browser.js#L197): se guarda en la tabla `secrets`, pero se devuelve en claro en `zerochat/browser/engines/list` y `config/set` e inyecta en `value="..."` en el DOM.
- **Norma o contrato afectado:** `docs/audit.md` §3.3; `.zerochat/log.md` (`M75-D5`).
- **Propuesta de solución y prueba:** Devolver `extensionTokenConfigured: bool` (nunca el valor) y soportar actualización/borrado explícito igual que los secretos MCP. Prueba de contrato en `tests/infrastructure/py/test_browser_config.py`.

### F-08 [Alta — Seguridad] KDF débil (`SHA-256` sin sal ni iteraciones) en copias de seguridad cifradas de perfiles
- **Evidencia:** [`js/profile-backup.js:77-80`](../js/profile-backup.js#L77-L80) deriva la clave AES-GCM con un único `SHA-256(password)` sin sal ni coste computacional, dejando los ficheros de backup exportados expuestos a fuerza bruta offline rápida. *(Nota: la caché local de 24 h en `localStorage` en líneas 58–73 queda encuadrada en `M75-D3`, pero el fichero exportado sí sale del equipo).*
- **Norma o contrato afectado:** `AGENTS.md` §3.
- **Propuesta de solución y prueba:** Migrar el formato de copia exportada a `PBKDF2` (`SHA-256`, sal aleatoria de 16 bytes por cifrado, ≥ 210 000 iteraciones) con nueva versión del sobre (`version: 2`). Prueba unitaria verificando sales distintas y rechazo de contraseña errónea.

### F-09 [Media — Seguridad] Expansión multipasada de `${secret:...}` en `McpServiceManager._expand`
- **Evidencia:** [`py/mcp/manager.py:246-251, 425-428`](../py/mcp/manager.py#L246-L251): sustituye en bucle `option:*` antes que `secret:*`. Una opción de usuario con texto literal `${secret:API_KEY}` se expande al secreto real al construir `launch.env`. *(Severidad Media por requerir sesión autenticada `local`/`remote` para editar opciones).*
- **Norma o contrato afectado:** `AGENTS.md` §3; defensa en profundidad en secretos MCP.
- **Propuesta de solución y prueba:** Sustituir en una única pasada con `re.sub(r"\$\{([^{}]+)\}", lambda m: values.get(m.group(1), m.group(0)), value)`. Prueba en `tests/infrastructure/py/`.

### F-10 [Alta — Seguridad] `/tmp/zerochat-jobs-<uid>` sin comprobar propietario ni symlink antes de `os.killpg(..., SIGKILL)`
- **Evidencia:** [`py/tools/jobs.py:77-85, 97-126`](../py/tools/jobs.py#L77-L85): crea `/tmp/zerochat-jobs-<uid>` con `mkdir(mode=0o700, exist_ok=True)` sin verificar `lstat`, `st_uid == os.getuid()` ni `not is_symlink()`. En sistemas POSIX multiusuario, un atacante local puede pre-crear ese directorio o symlink y plantar un `jobs.json` para provocar `SIGKILL` sobre grupos de procesos del usuario al arrancar ZeroChat.
- **Norma o contrato afectado:** `AGENTS.md` §3.
- **Propuesta de solución y prueba:** Mover el estado de jobs a `get_data_dir() / "runtime" / "jobs"` (`0700`) o validar estrictamente `lstat` (`S_ISDIR`, dueño actual, modo `0700`, sin symlinks). Prueba en `tests/infrastructure/py/`.

### F-11 [Alta — Estabilidad] URL OAuth de MCP corrompida (`state=***` / truncada) antes de abrirla
- **Evidencia (reproducida directamente):** [`py/mcp/stdio_client.py:29-30, 132-148`](../py/mcp/stdio_client.py#L132-L148): `_drain_stderr` sanitiza `raw_line` con `_mcp_trace_text` (que sustituye `state=...` por `state=***` y trunca a 1000 chars) **antes** de extraer `self.oauth_url` (pese a que línea 145 vuelve a llamar a `_mcp_trace_text(url)` para el log). En frontend, [`js/mcp-external.js:167`](../js/mcp-external.js#L167) abre esa URL rota y sin `'noopener,noreferrer'` ni validación `^https?://`.
- **Norma o contrato afectado:** `AGENTS.md` §3; fallo funcional reproducible (`docs/audit.md` §4.1).
- **Propuesta de solución y prueba:** Extraer `self.oauth_url` desde `raw_line` (aplicando `_mcp_trace_text` solo al trace) y endurecer `window.open(oauthUrl, '_blank', 'noopener,noreferrer')` tras validar esquema `http(s):`. Prueba unitaria Python con línea stderr real de `mcp-remote`.

### F-12 [Alta — Arquitectura] `js/run-node.js` no encadena ni espera `saveActiveConversation` en `onStepHistory`
- **Evidencia:** [`js/run-node.js:380-394`](../js/run-node.js#L380-L394) dispara `sessionManager.saveActiveConversation(history)` sin encadenar ni esperar las promesas pendientes antes del guardado final (`line 393`), rompiendo la simetría con [`js/generation-controller.js:238, 265-270, 342`](../js/generation-controller.js#L238). Un guardado de paso lento (o por tramos >512 KiB) puede concluir después del guardado final y sobrescribir la respuesta final en SQLite.
- **Norma o contrato afectado:** `.zerochat/log.md` (`M87-D10`); `AGENTS.md` §6.
- **Propuesta de solución y prueba:** Aplicar el patrón `stepSave = stepSave.then(...)` y `await stepSave` antes del guardado final y `zerochat/run/result`. Prueba unitaria con guardado asíncrono fuera de orden.

### F-13 [Media — Arquitectura] Falta guarda en servidor contra escritura concurrente en `conversations/save` durante `--conversation`
- **Evidencia:** [`py/README.md:143`](../py/README.md#L143) y [`js/storage.js:536`](../js/storage.js#L536) asumen que el servidor rechaza con `-32000` `zerochat/conversations/save` desde el navegador mientras hay un run activo sobre esa conversación, pero [`py/storage/rpc.py:107-120`](../py/storage/rpc.py#L107-L120) no lo comprueba. Además: (a) `py/README.md:143` contradice `py/README.md:186` respecto a `delete` (que en `rpc.py:95-105` cancela el run intencionalmente); (b) `delete_project_storage` ([`py/storage/db.py:1570-1575`](../py/storage/db.py#L1570-L1575)) consulta `status = 'running'` sin comprobar `run_process_alive`, bloqueando el borrado ante filas huérfanas muertas.
- **Norma o contrato afectado:** `py/README.md` §5 y §6; integridad de datos.
- **Propuesta de solución y prueba:** En `_rpc_save_conversation` (cuando no sea el propio `RunSession`), rechazar con `-32000` si hay un run `running` con `run_process_alive(run)`; alinear `py/README.md:143` con `delete`; comprobar `run_process_alive` en `delete_project_storage`. Prueba en `tests/infrastructure/py/test_server_runs.py`.

### F-14 [Media — Estabilidad] `PersistentBrowserSession` sin drenaje de `stderr`, sin timeout y procesos huérfanos
- **Evidencia:** [`py/tools/browser_action.py:153-209`](../py/tools/browser_action.py#L153-L209): abre `stderr=subprocess.PIPE` sin leerlo nunca (riesgo de bloqueo al llenar el buffer de 64 KiB), `proc.stdout.readline()` no tiene timeout ni cota de tamaño, `close()` llama a `self._process.kill()` en vez de `_kill_process_tree` (igual que [`py/browser/engines.py:235`](../py/browser/engines.py#L235)), y [`py/server/state.py:190-206`](../py/server/state.py#L190-L206) (`stop_zerochat_server`) no invoca `_BROWSER_SESSION.close()`.
- **Norma o contrato afectado:** `docs/audit.md` §3.1 y §3.4.
- **Propuesta de solución y prueba:** Drenar `stderr` (hilo daemon acotado o `DEVNULL`), aplicar timeout y límite en lectura stdout, usar `_kill_process_tree` en ambos módulos, y cerrar `_BROWSER_SESSION` en `stop_zerochat_server`.

### F-15 [Media — Estabilidad] Bloqueo de hilo HTTP en `launch_run_file`, runs sin tope de concurrencia y `_EXITED` sin cota
- **Evidencia:**
  - [`py/run_mode/state.py:450-455`](../py/run_mode/state.py#L450-L455): escribe hasta 1 MiB de forma síncrona en `proc.stdin` dentro del hilo HTTP (si supera el buffer de pipe de 16–64 KiB antes de que el hijo lea, bloquea el hilo servidor).
  - [`py/tools/agents.py:363`](../py/tools/agents.py#L363) y `start_server_run` ([`py/run_mode/state.py:423`](../py/run_mode/state.py#L423)): sin límite máximo de ejecuciones concurrentes (asimétrico con `MAX_RUNNING_JOBS = 8`).
  - [`py/run_mode/state.py:93`](../py/run_mode/state.py#L93): `_EXITED` nunca expulsa entradas antiguas en servidores `--keep-server`.
- **Norma o contrato afectado:** `AGENTS.md` §4 regla 4; `docs/audit.md` §3.4.
- **Propuesta de solución y prueba:** Escribir stdin en hilo escritor dedicado o fichero temporal `0600`, añadir `MAX_CONCURRENT_RUNS` probado en `N`/`N+1`, y acotar `_EXITED`.

### F-16 [Media — Estabilidad] Ficheros `.tmp` fijos en paralelo y `start_catalog_refresh` en CLI efímera
- **Evidencia:** [`py/run_mode/runner_loader.py:123-124`](../py/run_mode/runner_loader.py#L123-L124) (`cacheFile + '.tmp'`) y [`py/mcp/catalog.py:108-110`](../py/mcp/catalog.py#L108-L110) (`destination.name + ".tmp"`) colisionan si dos procesos coinciden. Además, [`py/cli/main.py:603`](../py/cli/main.py#L603) lanza `start_catalog_refresh` incluso en ejecuciones efímeras `--prompt`/`--run-file`.
- **Norma o contrato afectado:** `docs/audit.md` §4.1 (condición de carrera).
- **Propuesta de solución y prueba:** Usar nombres temporales únicos (PID + aleatorio) con limpieza en error, y omitir `start_catalog_refresh` cuando `current_run_session() is not None`.

### F-17 [Media — Seguridad] Placeholders `\u0001`/`\u0002` no limpiados y doble escape en `js/markdown.js`
- **Evidencia:** [`js/markdown.js:465`](../js/markdown.js#L465) limpia `\u0000`, pero deja intactos `\u0001` (`MARKUP_PLACEHOLDER`, línea 62) y `\u0002` (`TABLE_PLACEHOLDER`), permitiendo que el texto del modelo inyecte o duplique fragmentos HTML ya procesados. Además, `renderImage` (`lines 54-56`) vuelve a aplicar `escapeHtml` sobre `altText` ya escapado en línea `465` (`&quot;` → `&amp;quot;`).
- **Norma o contrato afectado:** `AGENTS.md` §3.
- **Propuesta de solución y prueba:** Reemplazar `/[\u0000\u0001\u0002]/g` en línea `465` y evitar el doble escape en `renderImage`. Pruebas unitarias en `tests/unit/test_markdown.js`.

### F-18 [Media — Seguridad] Protección insuficiente contra ZIP-bomb en `js/office-parser.js`
- **Evidencia:** [`js/office-parser.js:215-224`](../js/office-parser.js#L215-L224) confía en la cabecera falsificable `file.originalSize` sin tope acumulado total entre entradas; `parseDocx` (`348-367`, vía `mammoth`) omite por completo el filtro de `openPackage`.
- **Norma o contrato afectado:** `AGENTS.md` §3 y §4 regla 4.
- **Propuesta de solución y prueba:** Validar el tamaño descomprimido real por entrada y el total acumulado también antes de `mammoth.convertToHtml`, con prueba en el borde exacto `N`/`N+1`.

### F-19 [Media — Estabilidad] Contratos de truncado `N`/`N+1`, lecturas sin tope y pérdida de `st_mode`
- **Evidencia:**
  - [`py/tools/common.py:29-34`](../py/tools/common.py#L29-L34): `_atomic_write_text` no preserva `st_mode` del fichero destino (`+x` o `0600` → `0644`) ni limpia `.tmp_*` en excepción.
  - [`py/tools/filesystem.py:251, 513, 541`](../py/tools/filesystem.py#L251): `edit_file` y `get_diagnostics` leen ficheros de tamaño arbitrario.
  - [`py/tools/filesystem.py:85-91, 499, 579-592`](../py/tools/filesystem.py#L85-L91): `list_directory` y `get_diagnostics` truncan sin campo `truncated`; `search_files:499` da falso positivo cuando hay exactamente `N` resultados.
  - [`py/tools/jobs.py:53-70`](../py/tools/jobs.py#L53-L70): `truncate_terminal_output` no reaplica `max_chars=8000` tras recortar a 50+30 líneas.
  - [`py/tools/diff.py:624-627`](../py/tools/diff.py#L624-L627): `git show` sin tope de 5 MB y `git diff` sin tope; [`js/tool-cards.js:279`](../js/tool-cards.js#L279) y `diff.py:389` abren blobs sin `noopener,noreferrer` ni `revokeObjectURL`.
  - [`py/tools/sandbox.py:23`](../py/tools/sandbox.py#L23) sin `math.isfinite`; [`js/sandbox.js:268`](../js/sandbox.js#L268) sin `MAX_TIMEOUT_MS`.
- **Norma o contrato afectado:** `AGENTS.md` §4 regla 4 y §6.
- **Propuesta de solución y prueba:** Preservar `st_mode` + limpieza en `try/finally` en `_atomic_write_text`, acotar lecturas, detectar truncado leyendo `N+1`, reaplicar `max_chars` en `truncate_terminal_output`, validar `math.isfinite` y `MAX_TIMEOUT_MS`, y cubrir los bordes `N`/`N+1`.

### F-20 [Media — Arquitectura] `McpServiceManager.list_servers` muta estado y re-escanea disco en cada heartbeat
- **Evidencia:** [`py/mcp/manager.py:215-243`](../py/mcp/manager.py#L215-L243) se llama en cada `live_state()` / `zerochat/heartbeat`, re-escanea disco (`self._load_services()`) y reasigna `self.services` concurrentemente con hilos de arranque.
- **Advertencia crítica de diseño:** **NO** debe protegerse con `self._lock`, porque `start()` ([`py/mcp/manager.py:333-336`](../py/mcp/manager.py#L333-L336)) mantiene `self._lock` durante todo `_start_locked()` (incluyendo `npm install` de hasta 600 s y esperas OAuth), lo que congelaría `zerochat/heartbeat` y `wait_server` y rompería [`py/README.md:82`](../py/README.md#L82).
- **Norma o contrato afectado:** `py/README.md` §4; `docs/audit.md` §3.4.
- **Propuesta de solución y prueba:** Cachear definiciones en memoria (recargando solo en arranque, refresco de catálogo o cambio de `mtime`) y proteger únicamente las lecturas/escrituras breves de `self.services`/`self.preferences` con un cerrojo ligero de metadatos separado (nunca sostenido durante I/O o subprocesos).

### F-21 [Baja — Estabilidad] `mail_mcp_server.py` falla al responder correos con cabeceras plegadas
- **Evidencia:** [`services/mail/mail_mcp_server.py:418-423`](../services/mail/mail_mcp_server.py#L418-L423): lee cabeceras con `policy=compat32` (conservando `\r\n\t`) y las asigna a `EmailMessage` (`policy=default`), lanzando `ValueError`.
- **Norma o contrato afectado:** fallo funcional reproducible (`docs/audit.md` §4.1).
- **Propuesta de solución y prueba:** Normalizar con `" ".join(val.split())` antes de asignar `In-Reply-To`/`References` y añadir prueba unitaria.

### F-22 [Baja — Código muerto/Duplicación] Acción huérfana "Borrar datos del navegador" (`M80-D1`) y restos legacy
- **Evidencia:**
  - [`py/browser/config.py:19-20, 68`](../py/browser/config.py#L68), [`py/browser/engines.py:42-50`](../py/browser/engines.py#L42-L50), [`py/browser/rpc.py:23`](../py/browser/rpc.py#L23), [`js/ui-browser.js:160-163, 324-329`](../js/ui-browser.js#L160-L163), [`js/i18n.js:497, 1500`](../js/i18n.js#L497) y [`py/README.md:41`](../py/README.md#L41): borran `~/zerochat/playwright/profile/<engine>`, que `playwright_launch_args` (`config.py:156-160`) ya nunca crea tras `M80-D1` (`--isolated`).
  - [`py/server/handler.py:156`](../py/server/handler.py#L156) (`else "*"` inalcanzable) y [`263`](../py/server/handler.py#L263) (rutas HTTP legacy `/zerochat/blobs`, `/zerochat/blobs/put`).
  - [`js/profile-backup.js:184`](../js/profile-backup.js#L184) (`startsWith('La copia')` muerto frente a errores ya en inglés).
- **Norma o contrato afectado:** `AGENTS.md` §2.
- **Propuesta de solución y prueba:** Retirar endpoint, UI, claves i18n, tests asociados, mención en `py/README.md:41` y ramas muertas.

### F-23 [Baja — Arquitectura] Literales en español que evaden `test_english_literals.js`
- **Evidencia:** [`js/context-manager.js:344, 376`](../js/context-manager.js#L344), [`js/web-browser.js:245, 251, 256`](../js/web-browser.js#L245), [`js/profile-repository.js:316, 320, 330`](../js/profile-repository.js#L316).
- **Norma o contrato afectado:** `js/README.md` §5.
- **Propuesta de solución y prueba:** Traducir dichos literales al inglés.

### F-24 [Baja — Pruebas] Higiene y huecos en `tests/`
- **Evidencia:**
  - [`tests/architecture/test_csp.js`](../tests/architecture/test_csp.js) solo valida `zerochat.html` y omite `files.html`.
  - [`tests/architecture/test_backend_hygiene.js:81`](../tests/architecture/test_backend_hygiene.js#L81) mantiene la excepción obsoleta `'py/core/environment.py:cwd = Path.cwd().resolve()'`.
  - Sleeps fijos: [`tests/unit/test_utils.js:32, 45`](../tests/unit/test_utils.js#L32), [`tests/browser/browser_conversation.test.js:449`](../tests/browser/browser_conversation.test.js#L449) y [`tests/infrastructure/py/test_server_runs.py:857`](../tests/infrastructure/py/test_server_runs.py#L857).
  - Faltan pruebas de regresión de seguridad para `F-01`–`F-07`, `F-10`, `F-11`, `F-25`, `F-26` y bordes `N`/`N+1` de `F-19`.
- **Norma o contrato afectado:** `tests/README.md` y `docs/audit.md` §3.5.
- **Propuesta de solución y prueba:** Incorporar `files.html` en `test_csp.js`, eliminar la excepción muerta, sustituir los sleeps por sincronización por evento/condición y acompañar cada corrección de su prueba en el nivel más bajo.

### F-25 [Alta — Seguridad] Oráculo de caracteres y longitud en `browser_fill_secret` (`mode="keypad"`)
- **Evidencia:** [`py/tools/browser_secret.py:60-69, 103-104`](../py/tools/browser_secret.py#L60-L69): antes de pulsar, comprueba `if any(ch not in keypad_map for ch in secret_value): return "keypad_map no cubre todos los caracteres del secreto."`, y al completar devuelve `"steps": len(secret_value)`. Un modelo bajo prompt injection puede probar subconjuntos de `keypad_map` (agravado por `F-01` en ejecuciones desatendidas) para inferir los caracteres exactos y la longitud del secreto.
- **Norma o contrato afectado:** `AGENTS.md` §3; `.zerochat/log.md` (`M85-D1`).
- **Propuesta de solución y prueba:** Exigir aprobación de usuario (junto a `F-01`), eliminar `"steps": len(secret_value)` de la respuesta, homogeneizar errores y acotar reintentos fallidos por turno/sesión. Prueba en `tests/infrastructure/py/`.

### F-26 [Alta — Seguridad] `zerochat/project/delete` incumple `M85-D2` (permite borrar datos de `general`/`PROJECT_DIR` y borrar `PROJECT_DIR` en disco)
- **Evidencia:** [`py/server/rpc.py:160-185`](../py/server/rpc.py#L160-L185) solo llama a `validate_deletable_project_dir(ctx)` dentro de `if delete_directory:`. Así:
  1. Con `deleteDirectory=False`, permite eliminar todos los datos en SQLite (conversaciones, políticas, entornos y secretos) de `~/zerochat/general` y de la carpeta de arranque `PROJECT_DIR`.
  2. Con `deleteDirectory=True`, [`py/tools/filesystem.py:405-415`](../py/tools/filesystem.py#L405-L415) comprueba `/`, `~`, `general` y `~/zerochat`, pero **no comprueba `PROJECT_DIR`**, permitiendo borrar en disco la carpeta de arranque del servidor.
- **Norma o contrato afectado:** `.zerochat/log.md` (`M85-D2`).
- **Propuesta de solución y prueba:** Rechazar siempre `ctx.workspace_dir.resolve() in {PROJECT_DIR, get_no_project_dir().resolve()}` al inicio de `_delete_project` (con y sin `deleteDirectory`) y añadir `PROJECT_DIR` a `validate_deletable_project_dir`. Pruebas en `tests/infrastructure/py/`.

### F-27 [Media — Arquitectura] `check_agents(include_turn=True)` amputa el último turno cuando hubo evidencia visual
- **Evidencia:** [`py/tools/agents.py:160`](../py/tools/agents.py#L160): `start = max((index for index, message in enumerate(history) if message.get("role") == "user"), default=0)`. No excluye mensajes sintéticos `{ role: "user", _toolEvidence: true }` añadidos por [`js/chat-engine.js:95`](../js/chat-engine.js#L95) (`M67-D1`), a diferencia de [`js/context-manager.js:736`](../js/context-manager.js#L736).
- **Norma o contrato afectado:** fallo funcional reproducible (`docs/audit.md` §4.1); asimetría FE/BE (`AGENTS.md` §6).
- **Propuesta de solución y prueba:** Filtrar con `message.get("role") == "user" and not message.get("_toolEvidence")`. Prueba en `tests/infrastructure/py/`.

### F-28 [Baja — Estabilidad] `zerochat/login` sin rechazo de `\x00` ni captura defensiva fuera de `do_POST`
- **Evidencia:** [`py/auth/login.py:138`](../py/auth/login.py#L138) admite `\x00` en `user`/`password`; [`py/server/rpc.py:66`](../py/server/rpc.py#L66) solo captura `(RuntimeError, OSError)`; y [`py/server/handler.py:344, 385`](../py/server/handler.py#L344) invoca `_serve_login` fuera del `try/except` de `do_POST`. En Windows (`LogonUserW` `LPCWSTR`), un `\x00` lanza `ValueError: embedded null character` sin capturar.
- **Norma o contrato afectado:** `AGENTS.md` §2 (validación de entradas externas).
- **Propuesta de solución y prueba:** Rechazar `"\x00"` en `login()` (`LoginError(-32602, ...)`) y asegurar captura controlada en `rpc_login`. Prueba unitaria en `tests/infrastructure/py/`.

---

## 6. Propuesta de tareas candidatas para discusión (≤ ~300 LOC c/u)

Listas para revisar y, si las apruebas, incorporar a `.zerochat/plan.md` con `python3 .zerochat/task.py`:

1. **T1 — Seguridad crítica en navegador y secretos (`F-01`, `F-25`):** validación de esquema/anti-SSRF en `browser_action`, excluir `browser_action` y `browser_fill_secret` del auto-allow en `py/cli/main.py`, y cerrar el oráculo de `browser_fill_secret` (`keypad`).
2. **T2 — Seguridad crítica en `run_command` y `AccessController` (`F-02`, `F-04`):** corregir `command -- cd`, delimitar `SAFE_REDIRECTION_PATTERN` / `POWERSHELL_SAFE_REDIRECTION_PATTERN`, y unificar el validador de `apply_tool_decision` con `authorize_challenge`.
3. **T3 — Seguridad alta en HTTP, tokens de runner y borrado de proyectos (`F-03`, `F-05`, `F-26`, `F-28`):** rechazar `Origin: null` y exigir `Content-Type: application/json` en `POST`, fijar proyecto en `TokenGrant(runner)`, proteger `PROJECT_DIR`/`general` en `zerochat/project/delete` y rechazar `\x00` en `login`.
4. **T4 — Seguridad alta en red, jobs, secretos y backups (`F-06`, `F-07`, `F-08`, `F-09`, `F-10`):** alinear anti-SSRF FE/BE, hacer `extensionToken` solo escritura, migrar `profile-backup.js` a `PBKDF2`, hacer `_expand` de una sola pasada y asegurar el directorio de `jobs`.
5. **T5 — Bugs funcionales y carreras de datos (`F-11`, `F-12`, `F-13`, `F-27`):** extraer `oauth_url` antes de redactar + endurecer `window.open`, encadenar `stepSave` en `js/run-node.js`, guarda servidor en `conversations/save` + `run_process_alive` en `delete_project_storage`, y excluir `_toolEvidence` en `check_agents`.
6. **T6 — Estabilidad, concurrencia y MCP (`F-14`, `F-15`, `F-16`, `F-20`, `F-21`):** endurecer `PersistentBrowserSession` y su cierre, stdin/concurrencia/`_EXITED` en `run_mode`, `.tmp` únicos + omitir `start_catalog_refresh` efímero, `list_servers` sin I/O por latido ni bloqueo sobre `self._lock`, y cabeceras plegadas en `mail_mcp_server.py`.
7. **T7 — Seguridad/límites FE, bordes `N`/`N+1` y limpieza (`F-17`, `F-18`, `F-19`, `F-22`, `F-23`, `F-24`):** `markdown.js`, protección ZIP-bomb en `office-parser.js`, `st_mode`/límites `N`/`N+1` en herramientas, retirada de código muerto (`M80-D1` y legacy), literales en inglés e higiene de `tests/`.

---

## 7. Límites del alcance y decisiones abiertas

1. **Rutas exclusivas de Windows:** PowerShell (`py/security/rules.py`), `LogonUserW` (`py/auth/login.py`) y `_WindowsKillOnCloseJob` (`py/tools/jobs.py`) se auditaron de forma estática en Linux.
2. **Compatibilidad `file://` y `Origin: null` (`F-03`):** confirmar que no existe ningún flujo soportado de apertura de `zerochat.html` desde `file://` antes de rechazar `Origin: null` en `POST`.
3. **DNS rebinding con HTTPS/SNI (`F-06`):** cerrar completamente el TOCTOU en stdlib (`urllib`/`http.client`) preservando SNI y verificación TLS exige una subclase de `HTTPSConnection`; conviene decidir si asumir esa complejidad en `zerochat.py` o documentar la limitación.
4. **Módulos revisados solo a nivel de contrato:** `sw.js`, `js/providers-webllm.js`, `js/ingestionEngine.js`, `js/rag-service.js` y los servicios MCP distintos de `mail` (`composio`, `playwright`, etc.) quedan como foco natural si se quiere una segunda pasada dedicada.
