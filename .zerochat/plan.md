# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright and browser_action configuration: closed 2026-10-19

## M4 Images and office files in the chat: closed 2026-10-16

## M5 Test suite architecture and optimization: closed 2026-10-16

## M6 Investigation and rendering of LaTeX/math notation in chat responses: closed 2026-10-15

## M7 Temporary tests and scratchpad execution in /tmp: closed 2026-10-16

## M8 Project memory automation and acceleration: closed 2026-10-15

## M9 Update project management manual documentation: closed 2026-10-15

## M10 MCP state refresh on startup and in the panel: closed 2026-10-15

## M11 Fixes and refactoring from post-9.1.0 findings: closed 2026-10-15

## M12 PDF reading with pdf.js: closed 2026-10-16

## M13 Document generation in the chat: closed 2026-10-16

## M14 Project mode detection via task.py and legacy migration: closed 2026-10-16

## M15 Legacy binary Office (.doc and .xls) reading: closed 2026-10-16

## M16 RAG and web image rendering with local models and reasoning levels: closed 2026-10-17

## M17 Native XLSX reading without external libraries: closed 2026-10-16

## M18 Unattended prompt execution and browser profiles: closed 2026-10-19

## M19 Web image ingestion and multimodal analysis: closed 2026-10-16

## M20 Diff visualization for file edits: closed 2026-10-17

## M21 Unified browser resource download and public proxy removal: closed 2026-10-16

## M22 CI workflow optimization, retry resilience and browser test synchronization: closed 2026-10-17

## M23 Fallback cleanup, public proxy elimination and backend-first web transport: closed 2026-10-16

## M24 happy-dom removal: closed 2026-10-17

## M25 History summarization reliability, transcript sanitization and tool-call protection: closed 2026-10-17

## M26 Web transport hardening and post-9.2.3 audit fixes: closed 2026-10-17

## M27 Unified web fetch with backend or Jina Reader proxy: closed 2026-10-17

## M28 Quiet public presence: minimal discoverability: closed 2026-10-22

## M29 Configuration profiles: MCP servers per profile: closed 2026-10-19

## M30 Fixes from the 9.2.0–9.6.1 code quality audit: closed 2026-10-20

## M31 Fixes from the 9.2.0–9.7.1 scoped audit: closed 2026-10-20

## M32 Review of the tests added since 9.2.0: closed 2026-10-20

## M33 Live MCP state from the local server: closed 2026-10-21

## M34 Refactor of the spaghetti hotspots found in the 9.8.1 audit: closed 2026-10-21

## M35 Frontend complexity and spaghetti refactor: closed 2026-10-21

## M36 Native PDF stream bounds from /Length: closed 2026-10-22

## M37 Diff tool configuration onboarding: closed 2026-10-22

## M38 MVC separation between presentation and domain processes
Goal: Decouple presentation views from domain logic, persistence, and process orchestration where responsibilities or dependency directions are inverted, and structure self-contained UI dialog modules into explicit internal MVC zones without adding new script files.
Done when: attachments.js is a pure domain module with chip rendering in ui-composer.js; RAG backup gzip sniffing/decompression lives in ragStorage.js; domain/process modules (generation-controller.js, conversation-service.js, delegate-task.tool.js, mcp.js, app.js) no longer import UI modules for profile unlocking, MCP server lifecycle orchestration, or catalog context-limit resolution; rag-ui.js and ui-browser.js are internally organized into clear Model/State, View/Templates, and Controller/Events sections; and all unit, architecture, integration, and browser tests pass with zero behavior change.
- [x] M38-T1 Move DOM chip rendering (renderChips) from attachments.js to ui-composer.js so attachments.js is DOM/Icons/I18n-free, and move RAG backup gzip detection and decompression (isGzipBlob, readBackupText) from rag-ui.js into ragStorage.js alongside exportBranchBlob (2026-10-23)
- [x] M38-T2 Eliminate inverted domain-to-UI dependencies: move loadProfileUnlocked from ui-profiles.js to profile-repository.js (updating generation-controller.js, conversation-service.js, and delegate-task.tool.js), move profile MCP server lifecycle orchestration (startProfileServers, withExternalServerStopped) from ui-mcp.js to mcp.js, and unify catalog model context-limit calculation (getModelContextLimit, findModelInCatalog) into context-manager.js (2026-10-23)
- [x] M38-T3 Reorganize self-contained dialog modules rag-ui.js and ui-browser.js into explicit internal MVC zones (1. Model & state queries, 2. View & DOM templates, 3. Controller actions & event wiring) without changing public exports or behavior (2026-10-23)
- [x] M38-T4 Document in help/ (es/en) remote backend access from Android over an SSH tunnel (ConnectBot or Termux): sshd hardening, key restricted to forwarding 127.0.0.1:6883 and :1234 with a forced launch script that prints the daily-token URL; validate manually first (local-network permission, no-pty console, port already in use, stale token) with no ZeroChat code changes (2026-10-22)
- [x] M38-T5 Tolerate up to ±15 s client-server clock skew in tool-call authorization (remote backend over an SSH tunnel) by centering the signed expiry in the server acceptance window, JavaScript only (2026-10-22)
- [x] M38-T6 Add zerochat --print-url (prints the daily-token UI URL between five blank lines, implies --no-browser) to replace the remote launch script, widen tool-call authorization to ±30 s clock skew (server window 60 s), and update the Android remote help (es/en) (2026-10-22)
- [x] M38-T7 Split main() in py/zz-main.py into one function per step (parser, option validation, log redirection, self-test, environment, credentials, listening socket, URLs, header, interface, watchdog, signals, serving, run result) inside the same module, with no behavior change (2026-10-22)
- [ ] M38-T8 Move the one-time offer to restart the previous session's stopped MCP services (notifyStoppedExternalServices) from mcp.js to ui-mcp.js, called by app.js, and drop the connectProxy notifyStartup option that production always passes as false, so mcp.js no longer imports ui-mcp.js
