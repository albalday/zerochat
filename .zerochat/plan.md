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
- [ ] M4-T1 Show images in the chat (e.g. a web page image), beyond the existing MCP screenshot preview
- [ ] M4-T2 Read office files (docx, xlsx) as attachments and from tools

## M5 Browser test architecture and optimization
Goal: Refactor and optimize browser test files (tests/browser/) to modularize large suites, extract shared fixtures and helpers, and improve maintainability.
Done when: Large browser test suites are split by subdomains, common test setup and fixtures are shared in helpers, and npm run test:browser passes cleanly.
- [ ] M5-T1 Audit and split large browser test suites into focused files
- [ ] M5-T2 Extract shared fixtures and interaction helpers in tests/helpers/
- [ ] M5-T3 Verify suite execution and maintainability with npm run test:browser

## M6 Investigation and rendering of LaTeX/math notation in chat responses
Goal: Investigate unrendered LaTeX/math syntax (e.g. $\rightarrow$) appearing as raw text in chat responses, and support or normalize math notation.
Done when: The cause of unrendered math notation is analyzed, a solution (such as KaTeX integration, character substitution or custom parsing) is agreed and implemented with tests, and /help is updated if applicable.
- [ ] M6-T1 Investigate raw LaTeX/math syntax in chat responses and define the rendering or normalization approach

## M7 Temporary tests and scratchpad execution in /tmp
Goal: Allow running temporary tests and scratch scripts without leaving orphan files in the project workspace, supporting execution in /tmp like Claude Code.
Done when: The approach for temporary tests (governance in AGENTS.md vs. code/security support in ChatToolSecurity and workspace_trust for /tmp) is defined and implemented with tests and updated documentation.
- [ ] M7-T1 Define the temporary test policy (/tmp vs. workspace scratchpad) and update AGENTS.md rules
- [ ] M7-T2 Support /tmp in ChatToolSecurity workspace_trust and command/file path handling
- [ ] M7-T3 Update agent tool instructions and prompts for temporary script execution and cleanup

