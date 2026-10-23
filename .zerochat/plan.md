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

## M39 UI logic testable without a browser
Goal: Move decision logic that today lives in DOM state or is only observable through Playwright into pure functions the application calls with real data (no test-only injection), and make the backend tests maintainable: Python tests as real .py files and the local server suite split per behavior.
Done when: the profile editor and Settings › Browser save rules, the run_command card lifecycle and its log cap (tested at N and N+1), and the WebLLM progress/error parsing are pure functions covered in tests/unit; no Python test code is embedded in JavaScript strings and tests/infrastructure/py/*.py run through the test runner with per-case reporting; test_local_server.js shares one server process across one test per behavior; browser tests that duplicate node-level coverage are reduced to their user flow; and all test levels pass with zero behavior change.
- [x] M39-T1 Move parseWebLLMProgress and formatWebLLMErrorMessage from ui-inspector.js to providers-webllm.js, and getChronologicalCategory out of the sidebar rendering, with unit tables for progress texts, error shapes and date boundaries (2026-10-23)
- [x] M39-T2 Extract the run_command card lifecycle (applyDetails, applyResult, final states, badge view) and log paging (initial offset, appended page, MAX_LOG_CHARS cap) from CommandCardController into pure functions with unit tests including the cap at N and N+1, and reduce the browser run_command test to follow, expand and stop (2026-10-23)
- [x] M39-T3 Move the profile editor state (dirty, query ready, locked, loaded API key) out of dataset attributes and the input expando into a pure editor model with canSave, the save hint, save validation (name, read-only, duplicate name) and settings building, unit-tested, with ui-profiles.js only painting it; trim browser_profiles_settings to the representative flows (2026-10-23)
- [x] M39-T4 Extract Settings › Browser save decisions (token validity, config changed, restart offer, start Playwright when newly chosen) from ui-browser.js save() into a pure plan function with unit tests, keeping one browser flow (2026-10-23)
- [x] M39-T5 Split the 840-line first test of test_local_server.js into a describe with one shared server process (before/after) and one test per behavior (token, isolation, core tools, tool-call signature), with no production changes (2026-10-23)
- [ ] M39-T6 Add the Python test base: tests/infrastructure/py/ with a shared helper that loads zerochat.py once, discovery and execution of test_*.py with unittest from scripts/test-runner.mjs at the infrastructure level (listed by --list, failures reported per case), and the tests/README.md update
- [ ] M39-T7 Move the Python embedded in test_backend_runtime.js (tools, SSRF, read limits, diagnostics) to tests/infrastructure/py/test_*.py unittest cases, removing the JavaScript wrappers
- [ ] M39-T8 Move the Python embedded in test_backend_mcp.js (managed services, MCP keys, browser config, engines, traces) to tests/infrastructure/py/test_*.py unittest cases, removing the JavaScript wrappers
- [ ] M39-T9 Remove browser assertions already covered at node level (MCP start wait timeout kept in starting, conversation import size cap) keeping only what the browser alone observes
