# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright automation scripts
Goal: Use ZeroChat to write and maintain Playwright automation scripts.
Done when: to be agreed with the user before the milestone starts.
- [ ] M3-T1 Study with the user how to approach Playwright scripts and agree the milestone's Done when

## M4 Images and office files in the chat: closed 2026-10-16

## M5 Browser test architecture and optimization
Goal: Refactor and optimize browser test files (tests/browser/) to modularize large suites, extract shared fixtures and helpers, and improve maintainability.
Done when: Large browser test suites are split by subdomains, common test setup and fixtures are shared in helpers, and npm run test:browser passes cleanly.
- [ ] M5-T1 Audit and split large browser test suites into focused files
- [ ] M5-T2 Extract shared fixtures and interaction helpers in tests/helpers/
- [ ] M5-T3 Verify suite execution and maintainability with npm run test:browser

## M6 Investigation and rendering of LaTeX/math notation in chat responses: closed 2026-10-15

## M7 Temporary tests and scratchpad execution in /tmp: closed 2026-10-16

## M8 Project memory automation and acceleration: closed 2026-10-15

## M9 Update project management manual documentation: closed 2026-10-15

## M10 MCP state refresh on startup and in the panel: closed 2026-10-15

## M11 Fixes and refactoring from post-9.1.0 findings: closed 2026-10-15

## M12 PDF reading with pdf.js: closed 2026-10-16

## M13 Document generation in the chat
Goal: The model generates documents only as Markdown shown in the chat, whose capabilities grow with external code, ad hoc CSS and writing rules; what the chat shows can later be exported or opened in a separate tab on request.
Done when: the model writes documents, and CSV data as Markdown tables, rendered in the chat with the agreed rules and styles, and a document shown in the chat can be exported or opened in a separate tab when asked, with tests and /help updated.
- [x] M13-T1 Choose and vendor the write libraries (docx, the xlsx library chosen in M4-T6, a docx template library) with build:vendor and the on-demand loader (dropped: documents are Markdown in the chat, M13-D1)
- [x] M13-T2 create_docx tool from a JSON block spec (headings, paragraphs, lists, tables, images) that returns a downloadable file in a tool card (dropped: documents are Markdown in the chat, M13-D1)
- [x] M13-T3 create_xlsx tool from a JSON spec (sheets, rows, header style, column widths, formulas) (dropped: tabular data and CSV are Markdown tables, M13-D1)
- [x] M13-T4 Fill a docx template from an attachment or the knowledge base with JSON data, keeping its format (dropped: documents are Markdown in the chat, M13-D1)
- [x] M13-T5 Tests and /help (ES/EN) for document creation; leave pptx, pdf-lib and free editing of existing documents out of scope (dropped: replaced by M13-T10)
- [ ] M13-T6 Agree with the user the writing rules for documents in the chat (allowed Markdown constructs, structure, length, when to use tables) and add them to the model instructions
- [ ] M13-T7 Extend chat rendering where plain Markdown falls short, with vendored external code or ad hoc CSS that follows the design tokens
- [ ] M13-T8 Generate CSV and tabular data as Markdown tables in the chat, with rules for wide or long tables
- [ ] M13-T9 Agree with the user and implement the export of a document already shown in the chat, to a file or to a separate tab, only on request
- [ ] M13-T10 Tests and /help (ES/EN) for document generation in the chat and its export
- [x] M13-T11 Remove the Run JS button and output panel from Markdown code blocks (duplicates the execute_javascript tool and rarely works) (2026-10-16)

## M14 Project mode detection via task.py and legacy migration: closed 2026-10-16

## M15 Legacy binary Office (.doc and .xls) reading
Goal: Read legacy binary Word 97-2003 (.doc) and Excel 97-2003 (.xls) files in attachments, RAG and web tools, replacing the current rejection with a vendored reader.
Done when: .doc and .xls files are parsed as attachments, in RAG ingestion and via web document tools using a vendored on-demand reader, with tests and /help (ES/EN) updated.
- [ ] M15-T1 Choose and vendor on-demand readers for legacy Word 97-2003 (.doc) and Excel 97-2003 (.xls) through build:vendor, recording versions, sizes and licenses
- [ ] M15-T2 Integrate .doc and .xls parsing into ChatOfficeParser, attachments, RAG and download_doc/fetch_web_page, replacing the legacy format rejection
- [ ] M15-T3 Add .doc and .xls fixtures and unit/integration/browser tests, and update /help (ES/EN)

## M16 RAG and web image rendering with local models and reasoning levels
Goal: Ensure images from RAG and web tools are shown consistently across local models as with Gemini, accounting for the dependence on the configured reasoning level (reasoningEffort), with a generic fix and no per-model rules.
Done when: the cause of missing RAG/web images in local models across reasoning levels (none, low, medium, high) is identified and fixed generically, with unit/integration tests covering different reasoningEffort values.
- [ ] M16-T1 Reproduce and compare how RAG and web tool images are handled with Gemini vs. local models across reasoningEffort levels (none, low, medium, high)
- [ ] M16-T2 Implement a generic fix for image reference preservation and rendering independent of model name and reasoning level, with tests

## M17 Native XLSX reading without external libraries: closed 2026-10-16

## M18 Unattended prompt execution and browser profiles
Goal: Run a ZeroChat prompt from the zerochat.py command line, letting the UI process it and return the result, and find out how to reuse copies of the user's browser profiles (sessions, cookies, ZeroChat settings) for the UI and for Playwright automation, as groundwork for the Playwright scripts milestone (M3).
Done when: exploratory tests on Firefox and Chromium settle self-closing, headless mode and profile copying, and the prompt/result round trip is decided; implementation tasks and their acceptance criteria are added after M18-T3.
- [x] M18-T1 Exploratory tests P1-P2: tab self-closing and headless UI behaviour (JS, IndexedDB, fetch to 127.0.0.1) in Firefox and Chromium across launch methods (2026-10-16)
- [x] M18-T2 Exploratory tests P3-P5: copying Firefox and Chromium profiles and inheriting sessions in Playwright (persistent context vs. storageState) (2026-10-16)
- [ ] M18-T3 Decide the prompt/result transport (GET + POST to the backend with the session token) and the UI browser for run mode from the test results
