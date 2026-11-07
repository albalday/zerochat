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

## M45 Local backend storage for general connection profiles (Z-): closed 2026-11-06

## M46 Local backend storage and synchronization for conversations (SQLite)

Goal: zerochat.py stores conversations and messages locally in ~/zerochat/storage/zerochat.db via SQLite schema migration, exposes JSON-RPC endpoints for conversation list, get, save, rename and delete, and the frontend persists and synchronizes conversations with the backend when connected while preserving IndexedDB for offline operation.
Done when: conversations and their messages are stored in SQLite (0600) with cascade deletion, JSON-RPC endpoints zerochat/conversations/* handle CRUD operations, CLI flag --list-conversations inspects saved chats, the frontend saves and synchronizes conversations with the backend when connected and falls back to IndexedDB when disconnected, and passing test:architecture, test:infrastructure, test:unit, test:integration, and test:browser.
- [x] M46-T1 SQLite schema migration 002_create_conversations_tables and CRUD functions for conversations and messages in py/ee-storage.py with infrastructure tests (2026-11-06)
- [x] M46-T2 JSON-RPC endpoints for conversation list, get, save, rename and delete in py/ff-server.py with infrastructure tests (2026-11-07)
- [x] M46-T3 CLI inspection flag --list-conversations in py/zz-main.py reading from backend storage with infrastructure tests (2026-11-07)
- [x] M46-T4 Frontend conversation synchronization and backend storage adapter in js/storage.js and js/conversation-service.js (backend persistence when connected, IndexedDB fallback offline) with unit and integration tests (2026-11-07)
- [x] M46-T5 UI consistency and seamless offline/online conversation transitions in js/conversation-service.js with browser tests (2026-11-07)
- [x] M46-T6 Documentation in py/README.md, help/ and help/en/ for local conversation storage and CLI listing (2026-11-07)
- [x] M46-T7 Simplify conversation sync to initial connection and connection panel changes, normalize storage validation and remove fallbacks (2026-11-07)

## M47 Interactive terminal agent (zerochat --cli) with streaming Markdown interpreter

Goal: zerochat --cli provides an interactive terminal CLI (REPL or single-prompt) running a headless Playwright Chromium slave worker for the full agentic loop, while the Python CLI renders streamed assistant tokens, reasoning blocks, and tool executions with a pure standard-library ANSI Markdown interpreter, enables interactive terminal prompts for ask_user and tool approvals, and stores conversations in the backend SQLite database.
Done when: zerochat --cli launches the headless slave and presents an interactive terminal REPL (or executes an optional prompt), streams response chunks and thinking blocks with ANSI Markdown formatting without external Python dependencies, formats tool calls and results in terminal cards, handles interactive tool authorizations and user questions via terminal stdin, keeps the browser worker session alive across multi-turn prompts, persists sessions in backend storage, and passes test:architecture, test:infrastructure, test:unit, test:integration, and test:browser.
- [ ] M47-T1 Lightweight Python ANSI Markdown streaming interpreter in py/jj-cli.py (formatting headers, lists, bold/italic, code blocks, tool cards, and reasoning blocks with standard library only) with infrastructure tests
- [ ] M47-T2 Backend CLI session controller and JSON-RPC endpoints in py/ii-run-mode.py and py/ff-server.py supporting streaming chunks, tool events, interactive tool approval requests, and user question answering
- [ ] M47-T3 Frontend slave agentic loop streaming in js/run-mode.js: emit real-time token/reasoning deltas and tool execution lifecycle events over JSON-RPC
- [ ] M47-T4 Interactive tool authorization and ask_user delegation from frontend slave to CLI terminal via JSON-RPC request-response cycles
- [ ] M47-T5 Multi-turn interactive terminal REPL in py/jj-cli.py and py/zz-main.py with --cli flag: command loop, prompt input, Ctrl+C interrupt handling, session persistence across turns, and clean shutdown
- [ ] M47-T6 Documentation and help updates in py/README.md, help/run-mode.html and help/en/run-mode.html for zerochat --cli interactive terminal usage and options
