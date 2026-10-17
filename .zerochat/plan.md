# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright automation scripts
Goal: Use ZeroChat to write and maintain Playwright automation scripts.
Done when: to be agreed with the user before the milestone starts.
- [ ] M3-T1 Study with the user how to approach Playwright scripts and agree the milestone's Done when

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

## M16 RAG and web image rendering with local models and reasoning levels
Goal: Ensure images from RAG and web tools are shown consistently across local models as with Gemini, accounting for the dependence on the configured reasoning level (reasoningEffort), with a generic fix and no per-model rules.
Done when: the cause of missing RAG/web images in local models across reasoning levels (none, low, medium, high) is identified and fixed generically, with unit/integration tests covering different reasoningEffort values.
- [ ] M16-T1 Reproduce and compare how RAG and web tool images are handled with Gemini vs. local models across reasoningEffort levels (none, low, medium, high)
- [ ] M16-T2 Implement a generic fix for image reference preservation and rendering independent of model name and reasoning level, with tests

## M17 Native XLSX reading without external libraries: closed 2026-10-16

## M18 Unattended prompt execution and browser profiles
Goal: Run a ZeroChat prompt from the zerochat.py command line, letting the UI process it and return the result, and find out how to reuse copies of the user's browser profiles (sessions, cookies, ZeroChat settings) for the UI and for Playwright automation, as groundwork for the Playwright scripts milestone (M3).
Done when: on Linux, zerochat.py --prompt runs the prompt with the production ZeroChat configuration from the user's Firefox profile, with or without a visible window, prints only the final answer to stdout with the agreed exit codes, aborts on idle or total timeout, and leaves no browser process or profile copy behind, with tests and /help (ES/EN) updated.
- [x] M18-T1 Exploratory tests P1-P2: tab self-closing and headless UI behaviour (JS, IndexedDB, fetch to 127.0.0.1) in Firefox and Chromium across launch methods (2026-10-16)
- [x] M18-T2 Exploratory tests P3-P5: copying Firefox and Chromium profiles and inheriting sessions in Playwright (persistent context vs. storageState) (2026-10-16)
- [x] M18-T3 Decide the prompt/result transport (JSON-RPC over the existing token-checked POST) and the UI browser for run mode from the test results (2026-10-16)
- [ ] M18-T4 Python module to locate the active Firefox profile and make the minimal 0700 copy of the GitHub Pages UI origin storage and its permissions (first verify the minimal file set), with tests on sample profiles
- [ ] M18-T5 Backend run mode: --prompt/--prompt-file/--headless/--timeout, JSON-RPC zerochat/run/prompt, progress and result, own Firefox launch and watch, idle and total timeouts, stdout/stderr split, exit codes and guaranteed cleanup, with tests
- [ ] M18-T6 UI run mode module: read run from the launch fragment, wait for the backend, send the prompt in a new conversation, report progress per step/tool/status, unattended dialogs and approvals, return {error} from handleSendMessage, send the result and close, with real-DOM tests
- [ ] M18-T7 /help (ES/EN) and py/README.md for run mode, and manual end-to-end check headless and visible (including whether the visible window closes)

## M19 Web image ingestion and multimodal analysis: closed 2026-10-16

## M20 Diff visualization for file edits
Goal: Allow users to view unified diffs of file modifications performed by local tools (edit_file and write_file) on demand in the chat UI, without cluttering the conversation or context window.
Done when: the backend computes unified diffs for file edits using Python's standard difflib, the tool card in the UI displays an on-demand expandable diff view with accessible semantic line highlighting (+ additions, - deletions), model context is protected from diff verbosity, with unit/browser tests and /help (ES/EN) updated.
- [ ] M20-T1 Study and decide diff payload design: backend difflib integration in edit_file/write_file, context token preservation and UI toggle behavior
- [ ] M20-T2 Backend implementation: generate unified diff in edit_file and write_file (when overwriting existing files), with tests
- [ ] M20-T3 UI tool card integration: interactive [View diff] toggle, syntax highlighting for additions/deletions via tokens.css, and historical reconstruction
- [ ] M20-T4 Tests (unit, architecture, browser) and /help (ES/EN) documentation update

## M21 Unified browser resource download and public proxy removal: closed 2026-10-16

## M22 CI workflow optimization, retry resilience and browser test synchronization
Goal: Make automated validation faster, more resilient to CI virtual machine jitter, and ensure UI tests never evaluate DOM state before asynchronous UI updates complete.
Done when: CI splits fast-fail checks from browser execution without unnecessary browser installs on early failure, test-runner supports single retry on CI for browser tests, and browser test assertions follow strict async UI synchronization patterns.
- [ ] M22-T1 Split CI workflow into fast-fail validation and browser jobs to fail fast without installing Chromium on early errors
- [ ] M22-T2 Add CI-only single retry support for browser tests in test-runner to absorb transient runner load spikes
- [ ] M22-T3 Audit browser test suite to ensure all post-async DOM assertions wait for UI reactivity rather than raw storage promises

## M23 Fallback cleanup, public proxy elimination and backend-first web transport: closed 2026-10-16

## M24 happy-dom removal
Goal: Run non-browser tests without a simulated DOM, then cut the suite down to tests that catch real failures: no trivial, smoke-covered, cosmetic, duplicated, absence or mock-only tests, and no production code whose only consumer is a test (plan in docs/plan-simplificacion-pruebas.md).
Done when: no test or module depends on happy-dom and Node-only branches are gone; AGENTS.md and tests/README.md state the keep/delete criteria; every test file has been reviewed against them; test-only exports and parameters are removed and the hygiene test covers every exported name; the suite size and run time targets agreed in M24-T27 are met.
- [x] M24-T1 Inject a view into ChatEngine.executeAgentTurnLoop and AgentCore.dispatchToolCall instead of a DOM container (generation controller, delegate_task), with Node tests using an in-memory view (2026-10-17)
- [x] M24-T2 ConversationService branches by message ids instead of the DOM wrapper and receives viewport and loading indicator from its caller, with Node tests (2026-10-17)
- [x] M24-T3 ProfileExportBundle takes the base URL as a parameter and RagStorage tests drop the stray installDom (2026-10-17)
- [x] M24-T4 Office parser and web page extraction: move DOMParser-dependent tests to the browser and remove the regex extraction fallback (2026-10-17)
- [x] M24-T5 Delete DOM tests already covered by browser tests (2026-10-17)
- [x] M24-T6 Move the remaining DOM tests to browser tests (dropped: split into M24-T10..T15 by area, ~105 tests)
- [x] M24-T7 Remove Node-only branches (typeof document/window guards, sandbox non-iframe executor if unused) (2026-10-17)
- [x] M24-T8 Remove happy-dom, dom-env.js and the AGENTS.md/tests README rule (2026-10-17)
- [x] M24-T9 Review tests that still check the use of removed public proxies (r.jina.ai and others removed in M21/M23) and delete or adapt them (2026-10-17)
- [x] M24-T10 Move the composer, sidebar and conversation transfer DOM tests to browser tests (ui_composer, ui_sidebar, ui_transfer) (2026-10-17)
- [x] M24-T11 Move the profiles, settings and RAG UI DOM tests to browser tests (ui_profiles, ui_settings, rag_ui) (2026-10-17)
- [x] M24-T12 Move the conversation rendering DOM tests to browser tests (ui_conversation) (2026-10-17)
- [x] M24-T13 Move the MCP panel and inspector DOM tests to browser tests (ui_mcp, ui_inspector) (2026-10-17)
- [x] M24-T14 Move the tool card, Markdown, chart, attachment and utils DOM tests to browser tests (tool_cards, builtin_tools, command_card, delegate_task, mcp, charts, markdown, attachments, utils) (2026-10-17)
- [x] M24-T15 Move the generation, status, telemetry, reasoning, debug and reset DOM tests to browser tests (generation_controller, ui_generation_status, ui_telemetry, ui_reasoning, debug, error_infrastructure, storage_reset) (2026-10-17)
- [x] M24-T16 Rules: keep/delete test criteria and no test-only production code in AGENTS.md §2/§5/§8 and tests/README.md; log M24-D9 revoking M24-D4 (2026-10-17)
- [x] M24-T17 Extend the browser startup test into the single smoke test (send with Mirror, open every settings section and MCP panel, conversation CRUD, no console errors) (2026-10-17)
- [x] M24-T18 Review the browser tests added or moved in M24 (diff b15e953..) and delete trivial ones; decide whether createTurnView/createCardView/turn-view.js stay (2026-10-17)
- [x] M24-T19 Review architecture and infrastructure tests (delete absence, cosmetic and duplicated checks) (2026-10-17)
- [x] M24-T20 Review unit tests (2026-10-17)
- [x] M24-T21 Review integration tests of the agent loop (chat_engine, agent_runtime, agent_core, tool_dispatcher, delegate_task, generation_controller) (2026-10-17)
- [x] M24-T22 Review integration tests of providers, WebLLM, inspector, context manager and context cache (2026-10-17)
- [x] M24-T23 Review integration tests of MCP, tool security, security and builtin tools (security cases kept as tables) (2026-10-17)
- [x] M24-T24 Review integration tests of RAG, ingestion, profiles, project context, conversation service and storage reset (2026-10-17)
- [ ] M24-T25 Review the remaining browser tests (cosmetic layout, duplicated flows, smoke-covered checks)
- [ ] M24-T26 Remove exports, parameters and helpers whose only consumer is a test, and extend the hygiene test to every exported name
- [ ] M24-T27 Measure tests, lines and run time before/after, agree the targets with the user and update the Done when figures
