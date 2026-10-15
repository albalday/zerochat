# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright automation scripts
Goal: Use ZeroChat to write and maintain Playwright automation scripts.
Done when: to be agreed with the user before the milestone starts.
- [ ] M3-T1 Study with the user how to approach Playwright scripts and agree the milestone's Done when

## M4 Images and office files in the chat
Goal: The chat shows images, such as a web page's, and reads office documents.
Done when: an image from a web page or tool result is displayed in the conversation, and docx/xlsx files can be attached and read, with tests and /help updated.
- [x] M4-T1 Show images in the chat (e.g. a web page image), beyond the existing MCP screenshot preview (2026-10-15)
- [x] M4-T2 Read office files (docx, xlsx) as attachments and from tools (dropped: split into M4-T4 to M4-T11)
- [x] M4-T3 Abrir imágenes en visor de pestaña sin forzar descarga y eliminar temblores en streaming (2026-10-15)
- [x] M4-T4 Generalize build:vendor (now Orama only) to bundle exact-pinned npm libraries into committed IIFE files in js/vendor/ with esbuild, adding each license to licenses/ and THIRD_PARTY_NOTICES.md (2026-10-15)
- [x] M4-T5 On-demand vendor loader: classic script injection loaded once, outside PRECACHE_ASSETS (the SW caches it on first use), working on file:// and in Node tests, with a clear error when offline and not yet cached (2026-10-15)
- [x] M4-T6 Choose and vendor the office libraries: mammoth (docx), SheetJS CE or ExcelJS (xlsx/ods, weighing the future write phase) and fflate (pptx/ODF ZIP); record versions, sizes and reasons (2026-10-15)
- [x] M4-T7 Office parser module (js/office-parser.js) returning {text, images} as Markdown with rag-image references: docx via mammoth, sheets as tables with a row cap, pptx/odt/odp via fflate with slide/page markers; EMF/WMF and external images become placeholders (2026-10-15)
- [x] M4-T8 Wire office files into attachments (accept list, type, header, icon, capped images for vision models), RAG ingestion (detected before the ZIP rejection) and web document tools; clear error for legacy .doc/.xls/.ppt, macros ignored (2026-10-15)
- [x] M4-T9 Office fixtures from several producers (Word, LibreOffice, Google Docs) with unit, integration and browser tests for parsing, attachments and RAG (2026-10-15)
- [x] M4-T10 Replace the own PDF parser with vendored pdf.js (dropped: moved to milestone M12)
- [x] M4-T11 Update /help (ES/EN): supported formats, first-use download and offline behaviour, third-party libraries (2026-10-15)
- [x] M4-T12 Add office fixtures exported by Microsoft Word, Excel, PowerPoint and Google Docs/Sheets/Slides (needs files from the user) to the parser, attachment and RAG tests (dropped: the user validates real Word and Google documents manually)
- [x] M4-T13 Complete third-party notices with the transitive packages bundled in each js/vendor/ file and their license texts (2026-10-15)
- [ ] M4-T14 Read legacy binary Word 97-2003 (.doc) and Excel 97-2003 (.xls) files in attachments, RAG and web tools, replacing the current rejection with a vendored reader
- [ ] M4-T15 Evaluate renaming the download_pdf tool to download_doc now that it also reads office documents (tool name, aliases, i18n, cards, prompts, tests and /help)

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
Done when: PDFs in attachments, RAG and download_pdf are read with vendored pdf.js keeping text, images and page markers, the own PDF code is removed from file-parser.js, and tests and /help are updated.
- [ ] M12-T1 Vendor pdf.js converted to IIFE with esbuild through build:vendor (ESM only since v4), with worker handling on file:// and isEvalSupported false
- [ ] M12-T2 Replace the own PDF parser with pdf.js in attachments, RAG and download_pdf, keeping {text, images} and page markers, and remove the orphan PDF code from file-parser.js
- [ ] M12-T3 Compare text, image and page extraction with the current PDF tests and fixtures, and update tests and /help (ES/EN)

## M13 Office document creation
Goal: The model creates downloadable office documents and fills docx templates in the browser with vendored libraries.
Done when: the model creates downloadable docx and xlsx files from a simple JSON spec and fills a docx template with data, with tests and /help updated.
- [ ] M13-T1 Choose and vendor the write libraries (docx, the xlsx library chosen in M4-T6, a docx template library) with build:vendor and the on-demand loader
- [ ] M13-T2 create_docx tool from a JSON block spec (headings, paragraphs, lists, tables, images) that returns a downloadable file in a tool card
- [ ] M13-T3 create_xlsx tool from a JSON spec (sheets, rows, header style, column widths, formulas)
- [ ] M13-T4 Fill a docx template from an attachment or the knowledge base with JSON data, keeping its format
- [ ] M13-T5 Tests and /help (ES/EN) for document creation; leave pptx, pdf-lib and free editing of existing documents out of scope

## M14 Project mode detection via task.py and legacy migration
Goal: Detect project mode via .zerochat/task.py instead of .zerochat/state.md alone to cleanly trigger migration/initialization for legacy projects.
Done when: js/project-context.js detects project mode readiness via .zerochat/task.py, bootstrap prompt marks initialization on task.py creation, i18n and tests are updated, and all unit/integration/architecture tests pass.
- [x] M14-T1 Detect project initialization using .zerochat/task.py sentinel, update bootstrap prompt and i18n (2026-10-15)
- [x] M14-T2 Update unit, integration and architecture tests for task.py sentinel detection and verify suite (2026-10-15)
