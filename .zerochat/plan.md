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

## M7 Temporary tests and scratchpad execution in /tmp
Goal: Allow running temporary tests and scratch scripts without leaving orphan files in the project workspace, supporting execution in /tmp like Claude Code.
Done when: The approach for temporary tests (governance in AGENTS.md vs. code/security support in ChatToolSecurity and workspace_trust for /tmp) is defined and implemented with tests and updated documentation.
- [ ] M7-T1 Define the temporary test policy (/tmp vs. workspace scratchpad) and update AGENTS.md rules
- [ ] M7-T2 Support /tmp in ChatToolSecurity workspace_trust and command/file path handling
- [ ] M7-T3 Update agent tool instructions and prompts for temporary script execution and cleanup

## M8 Project memory automation and acceleration: closed 2026-10-15

## M9 Update project management manual documentation: closed 2026-10-15

## M10 MCP state refresh on startup and in the panel: closed 2026-10-15

## M11 Fixes and refactoring from post-9.1.0 findings: closed 2026-10-15

## M12 PDF reading with pdf.js
Goal: Replace the own PDF parser with the standard pdf.js library, vendored and loaded on demand.
Done when: PDFs in attachments, RAG and download_doc are read with vendored pdf.js keeping text, images and page markers, the own PDF code is removed from file-parser.js, and tests and /help are updated.
- [ ] M12-T1 Vendor pdf.js converted to IIFE with esbuild through build:vendor (ESM only since v4), with worker handling on file:// and isEvalSupported false
- [ ] M12-T2 Replace the own PDF parser with pdf.js in attachments, RAG and download_doc, keeping {text, images} and page markers, and remove the orphan PDF code from file-parser.js
- [ ] M12-T3 Compare text, image and page extraction with the current PDF tests and fixtures, and update tests and /help (ES/EN)

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

## M14 Project mode detection via task.py and legacy migration
Goal: Detect project mode via .zerochat/task.py instead of .zerochat/state.md alone to cleanly trigger migration/initialization for legacy projects.
Done when: js/project-context.js detects project mode readiness via .zerochat/task.py, bootstrap prompt marks initialization on task.py creation, i18n and tests are updated, and all unit/integration/architecture tests pass.
- [x] M14-T1 Detect project initialization using .zerochat/task.py sentinel, update bootstrap prompt and i18n (2026-10-15)
- [x] M14-T2 Update unit, integration and architecture tests for task.py sentinel detection and verify suite (2026-10-15)

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

