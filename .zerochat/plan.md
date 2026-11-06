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

## M42 MCP service state, JS–Python contract and reverse-proxy transport: closed 2026-10-24

## M43 Dark theme link contrast: closed 2026-10-23

## M44 WebP images readable by every vision model: closed 2026-11-05

## M45 Local backend storage for general connection profiles (Z-)

Goal: zerochat.py stores general connection profiles locally in an extensible SQLite database, exposes them via JSON-RPC, the frontend presents them with the Z- visual prefix and fetches them on connection/profile menu open, --prompt runs headless on Playwright Chromium by default using the Z-local backend profile unless --browser or --profile is specified, and Playwright MCP own browser runs isolated in memory (--isolated) by default with optional named storage per profile.
Done when: general profiles are persisted in ~/zerochat/storage/zerochat.db (0600), queried/managed by zerochat.py and CLI, fetched by the web client on connection and profile panel open, displayed with Z- prefix, --prompt defaults to headless Playwright Chromium and the Z-local general profile (with --browser and --browser --headless for the user browser), Playwright MCP defaults to --isolated unless a storage name is specified in the profile, and passing test:architecture, test:infrastructure, test:unit, test:integration, and test:browser.
- [x] M45-T1 Backend SQLite storage engine in py/ee-storage.py for general connection profiles with 0700/0600 permissions, schema migrations and infrastructure tests (2026-11-06)
- [x] M45-T2 JSON-RPC endpoints for general profile CRUD in py/ff-server.py and profiles_revision in live_state with infrastructure tests (2026-11-06)
- [x] M45-T3 Frontend repository and sync in js/profile-repository.js and js/mcp.js: load general profiles on backend connection and heartbeat with integration tests (2026-11-06)
- [x] M45-T4 Unified presentation and maintenance in js/ui-profiles.js: Z- prefix in active profile and selector, Local vs General scope selection in editor with browser tests (2026-11-06)
- [x] M45-T5 CLI --profile resolution in py/zz-main.py and py/ii-run-mode.py using backend storage directly without browser dependency (2026-11-06)
- [x] M45-T6 Simplify backend SQLite profile storage: close connections, remove heartbeat revision, dead RPC/params and test-only db_path, enforce lock/Espejo checks and test exact bounds (2026-11-06)
- [x] M45-T7 Simplify frontend general profiles: fetch on connection and profile panel open, allow copying across Local/General scopes, keep general profiles out of localStorage and preserve active general profile on reload (2026-11-06)
- [x] M45-T8 Default --prompt profile to backend general profile "Z-local" when --profile is omitted (failing with error if missing) and use the specified profile when --profile is given, in py/zz-main.py and py/ii-run-mode.py with infrastructure tests (2026-11-06)
- [x] M45-T9 Make --prompt run headless with Playwright Chromium by default and add --browser to use the user browser (visible with --prompt --browser, headless with --prompt --browser --headless) in py/zz-main.py, py/ii-run-mode.py and py/gg-browser.py with infrastructure tests (2026-11-06)
- [x] M45-T10 Update --prompt documentation in py/README.md, help/run-mode.html and help/en/run-mode.html for default headless Playwright Chromium, --browser, --headless and the default Z-local profile (2026-11-06)
- [x] M45-T11 Allow --prompt without --browser to fall back to a free port when the default port is busy in local development in py/zz-main.py, help/run-mode.html, help/en/run-mode.html and infrastructure tests (2026-11-06)
- [x] M45-T12 Default Playwright MCP own browser to --isolated and support optional named persistent storage in py/ee-browser-config.py, js/defaults.js, js/mcp.js, js/ui-browser.js and js/i18n.js with unit, integration, infrastructure and browser tests (2026-11-06)
- [x] M45-T13 Update documentation in py/README.md, help/browser-action.html, help/en/browser-action.html, help/profiles.html and help/en/profiles.html for isolated Playwright MCP default and named storage (2026-11-06)
- [x] M45-T14 Establish MCP parallel execution standards in services/ejemplo/README.md and review parallel capabilities of bundled services (2026-11-06)
