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

## M41 Faster test suite without duplicates

Goal: the full suite runs in about half the time (~25 s → ~11 s locally) and keeps each behaviour tested once, at the lowest level that observes it.

Done when: browser waits on no real poll or timeout timers, Python unittest files run in parallel, the duplicate, obsolete and misplaced cases from the 2026-10-23 test review are removed or moved, and every level passes.
- [x] M41-T1 test:browser uses node --test default concurrency locally; CI and release pass --concurrency=2 explicitly (2026-10-23)
- [x] M41-T2 run_command card browser test drives its poll and clock timers with page.clock instead of real waits (2026-10-23)
- [x] M41-T3 Sandbox timeoutMs fallback test uses page.clock instead of waiting the real 2500 ms default (2026-10-23)
- [ ] M41-T4 MCP homonymous-tools integration test uses a JS fake host instead of embedded Python spawned per call
- [ ] M41-T5 Runner runs each test_*.py in its own parallel unittest process; shorter sleeps in test_run_command.py
- [ ] M41-T6 Sandbox browser suite merged into one probe case and one timeout case; drop cases that never reach CSP or the parent
- [ ] M41-T7 Drop duplicate browser cases: legacy 6.7.0 profiles, office RAG ingestion, hasOldLifecycle assertion
- [ ] M41-T8 test_local_server.js keeps only HTTP contract; tool logic moves to py unittest; drop removed-feature assertions
- [ ] M41-T9 Move the zerochat.html/precache library check from test_vendor_build.js to architecture
