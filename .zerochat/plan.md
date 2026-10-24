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

## M38 MVC separation between presentation and domain processes: closed 2026-10-23

## M39 UI logic testable without a browser: closed 2026-10-23

## M40 Automatic reconnection to the local backend: closed 2026-10-23

## M41 Faster test suite without duplicates: closed 2026-10-23

## M42 MCP service state, JS–Python contract and reverse-proxy transport

Goal: unify the MCP service state model and JS–Python contract, and simplify the frontend–backend protocol (`X-ZeroChat-Proxy: 1`, direct `POST` without `/sse`, no heartbeat when `exit_on_close` is false, and profile-level reverse-proxy mode reusing the profile's `apiUrl` and `apiKey` behind Caddy without daily tokens) so `zerochat.py` can run as an always-on service behind a reverse proxy.

Done when: ee-mcp.py keeps one record per service and derives the public status in a pure function tested with unittest transition tables; enabled/remembered is written in a single place; the client reads status only through one predicates module; a shared fixture (engines, user browsers, extension token pattern, service statuses) is checked by both the JS and the Python tests; `zerochat.py` and `js/mcp.js` communicate over direct `POST` with `X-ZeroChat-Proxy: 1`, return initial live state in `initialize`, skip heartbeat when `exit_on_close` is false, and connect through the active profile's `apiUrl` + `apiKey` when `mcpProxy` is enabled in the profile; `zerochat.py` is rebuilt and every test level passes.
- [x] M42-T1 Shared fixture in tests/fixtures/ with Playwright engines, user browsers and the extension token pattern (js/defaults.js, js/ui-browser.js, py/ee-browser-config.py), checked by test_ui_browser.js and test_browser_config.py (2026-10-24)
- [x] M42-T2 ee-mcp.py: one record per service instead of the parallel states/errors/clients/browsers dicts, with the public status derived by a pure function from the record and process liveness, tested with unittest tables (2026-10-24)
- [x] M42-T3 ee-mcp.py: enabled/remembered written in a single place for start, stop and restart, with unittest cases for remember true/false, profile start and withExternalServerStopped restart (M29-T8, M31-D4) (2026-10-24)
- [x] M42-T4 Client status predicates module (isActive, canStart, canStop, isBusy) used by mcp.js, ui-mcp.js, ui-profiles.js and ui-browser.js instead of inline status string comparisons, with the status list added to the M42-T1 fixture and unit tests (2026-10-24)
- [ ] M42-T5 py/ff-server.py and py/zz-main.py: allow X-ZeroChat-Proxy in CORS, include live state (cwd, jobs, exit_on_close, playwright, servers) in initialize, and accept X-ZeroChat-Proxy: 1 without the daily token when running as a persistent loopback service (--keep-server --no-browser) while keeping tools/call HMAC authorization
- [ ] M42-T6 js/mcp.js: send X-ZeroChat-Proxy: 1 on all requests, use direct POST JSON-RPC to zerochat.py without opening /sse, apply live state from initialize, and disable the 10 s heartbeat timer when exit_on_close is false
- [ ] M42-T7 js/profile-repository.js, js/config-store.js, js/defaults.js and js/mcp.js: add mcpProxy boolean profile setting and connectProxy support using the active profile's apiUrl origin and apiKey (Authorization: Bearer) on startup and profile activation
- [ ] M42-T8 js/ui-profiles.js, js/ui-mcp.js and js/i18n.js: profile editor control to enable mcpProxy, reverse-proxy connection status in Settings › MCP, and unit/browser tests
- [ ] M42-T9 Rebuild zerochat.py (npm run build:backend) and update py/README.md, help/mcp.html (ES/EN) and ../llama/zero-caddy.md
- [x] M42-T10 Settings › MCP: browser tools (browser_action, Playwright MCP) list their authorization without the disabled on/off switch, since they are chosen in Settings › Browser (2026-10-24)

## M43 Dark theme link contrast: closed 2026-10-23
