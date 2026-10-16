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
