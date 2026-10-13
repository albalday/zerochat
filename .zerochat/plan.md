# Plan

## M1 Project setup: closed 2026-10-12

## M2 Images and office files in the chat
Goal: The chat shows images, such as a web page's, and reads office documents.
Done when: an image from a web page or tool result is displayed in the conversation, and docx/xlsx files can be attached and read, with tests and /help updated.
- [ ] M2-T1 Show images in the chat (e.g. a web page image), beyond the existing MCP screenshot preview
- [ ] M2-T2 Read office files (docx, xlsx) as attachments and from tools
- [x] M2-T3 Audit R-01: drop WebLLM guards over always-loaded modules, with hygiene test (2026-10-13)
- [x] M2-T4 Audit R-04: test that every registered provider adapter extends BaseProviderAdapter (2026-10-13)
- [x] M2-T5 Audit R-06: tool rule cites only README keys, with a test against the Tool constructor (2026-10-13)
- [x] M2-T6 Audit R-03: architecture test for the persistence boundary (2026-10-13)
- [x] M2-T7 Audit R-09: help pages test (translation, cross links, version series); language switch on the API key pages (2026-10-13)
- [x] M2-T8 Audit R-07: emoji test extended to zerochat.html, icons.js and control texts (2026-10-13)

## M3 Playwright automation scripts
Goal: Use ZeroChat to write and maintain Playwright automation scripts.
Done when: to be agreed with the user before the milestone starts.
- [ ] M3-T1 Study with the user how to approach Playwright scripts and agree the milestone's Done when
