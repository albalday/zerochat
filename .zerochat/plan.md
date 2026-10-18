# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright automation scripts
Goal: Use ZeroChat to write and maintain Playwright automation scripts.
Done when: to be agreed with the user before the milestone starts.
- [ ] M3-T1 Study with the user how to approach Playwright scripts and agree the milestone's Done when
- [ ] M3-T2 True headless and concurrent zerochat.py --prompt runs on a copy of the user's browser profile, starting from M18-D2/D3/D5/D6/D7 (selective Firefox copy of storage/default/<UI origin> plus its moz_perms rows via the SQLite backup API with a raw copy+WAL fallback for exclusively locked databases, 0700 and deleted after use; Playwright storageState for Chromium; headless needs local network access granted) and the dropped M18-T4 code in git history (commit a4b9bbd, py/hh-firefox-profile.py)

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

## M18 Unattended prompt execution and browser profiles
Goal: Run a ZeroChat prompt from the zerochat.py command line, letting the UI process it and return the result, and find out how to reuse copies of the user's browser profiles (sessions, cookies, ZeroChat settings) for the UI and for Playwright automation, as groundwork for the Playwright scripts milestone (M3).
Done when: zerochat.py --prompt starts like a normal run (same port, UI and browser launcher), the UI runs the prompt with the user's ZeroChat configuration, only the final answer reaches stdout with the agreed exit codes, the run aborts on idle or total timeout or when the browser closes without a result, with tests and /help (ES/EN) updated; headless runs, profile copies and several concurrent runs are handled in later tasks.
- [x] M18-T1 Exploratory tests P1-P2: tab self-closing and headless UI behaviour (JS, IndexedDB, fetch to 127.0.0.1) in Firefox and Chromium across launch methods (2026-10-16)
- [x] M18-T2 Exploratory tests P3-P5: copying Firefox and Chromium profiles and inheriting sessions in Playwright (persistent context vs. storageState) (2026-10-16)
- [x] M18-T3 Decide the prompt/result transport (JSON-RPC over the existing token-checked POST) and the UI browser for run mode from the test results (2026-10-16)
- [x] M18-T4 Python module to locate the active Firefox profile and make the minimal 0700 copy of the GitHub Pages UI origin storage and its permissions (first verify the minimal file set), with tests on sample profiles (dropped: run mode uses the browser that zerochat.py normally opens; profile copies move to the Playwright milestone)
- [x] M18-T5 Backend run mode: --prompt/--prompt-file/--headless/--timeout, JSON-RPC zerochat/run/prompt, progress and result, own Firefox launch and watch, idle and total timeouts, stdout/stderr split, exit codes and guaranteed cleanup, with tests (2026-10-17)
- [x] M18-T6 UI run mode module: read run from the launch fragment, wait for the backend, send the prompt in a new conversation, report progress per step/tool/status, unattended dialogs and approvals, return {error} from handleSendMessage, send the result and close, with real-DOM tests (2026-10-17)
- [ ] M18-T7 /help (ES/EN) and py/README.md for run mode, and manual end-to-end check headless and visible (including whether the visible window closes)
- [x] M18-T8 Rework run mode onto the normal zerochat.py startup: default port and UI, normal browser launcher with run= in the fragment, heartbeat detects a closed browser; remove the Firefox profile module and --prompt-file/--timeout (2026-10-18)
- [x] M18-T9 Best-effort --headless for --prompt: launch the default browser executable with --headless on the normal profile, falling back to the normal launcher (2026-10-18)
- [x] M18-T10 --profile for --prompt: the UI runs with that connection profile (name or id) for this page only, without changing the saved active profile (2026-10-18)
- [x] M18-T11 General --log on|off option: on by default, off by default with --prompt (2026-10-18)
- [ ] M18-T12 Detect another running zerochat.py (default port in use or live session) when starting --prompt and decide how the run coexists with it
- [ ] M18-T13 Run --prompt from cron: no terminal or graphical session (DISPLAY/WAYLAND_DISPLAY, DBUS), environment and PATH, browser launch and output/exit codes for scheduled jobs
- [ ] M18-T14 Export the --prompt conversation with the current exporter options (Markdown, session JSON, print/PDF) to a file chosen on the command line, reusing ChatExport

## M19 Web image ingestion and multimodal analysis: closed 2026-10-16

## M20 Diff visualization for file edits: closed 2026-10-17

## M21 Unified browser resource download and public proxy removal: closed 2026-10-16

## M22 CI workflow optimization, retry resilience and browser test synchronization: closed 2026-10-17

## M23 Fallback cleanup, public proxy elimination and backend-first web transport: closed 2026-10-16

## M24 happy-dom removal: closed 2026-10-17

## M25 History summarization reliability, transcript sanitization and tool-call protection: closed 2026-10-17

## M26 Web transport hardening and post-9.2.3 audit fixes: closed 2026-10-17

## M27 Unified web fetch with backend or Jina Reader proxy: closed 2026-10-17

## M28 Search engine indexing of the public site
Goal: Make the GitHub Pages site (https://albalday.github.io/zerochat/) easy for Google to discover, crawl and show well in results, with the support files generated from the repository and a guide for the Search Console steps only the owner can do.
Done when: the site root serves a static bilingual landing page instead of the Jekyll-rendered README; every public page (landing, zerochat.html, help ES/EN) has a unique title and description, canonical URL, hreflang alternates and Open Graph tags, checked by an architecture test; sitemap.xml is generated by an npm script from the real page list and a test fails when it is stale; Lighthouse SEO scores 100 on the landing page and the help index; docs/seo.md explains Search Console verification, sitemap submission and follow-up, and the owner has submitted the sitemap.
- [ ] M28-T1 Static bilingual landing page at the site root (index.html ES/EN pair, what ZeroChat is, features, links to the app, help and install) and .nojekyll so Pages stops rendering README.md as the root
- [ ] M28-T2 Head metadata for help pages (ES/EN): canonical, hreflang es/en/x-default, Open Graph and Twitter card tags and unique descriptions, extending tests/architecture/test_help_pages.js
- [ ] M28-T3 Head metadata for zerochat.html and the landing page: canonical, hreflang, Open Graph, descriptive title and description, and SoftwareApplication JSON-LD on the landing page validated with the Rich Results Test
- [ ] M28-T4 Crawlable favicon (SVG and PNG files instead of the data: URI only) and a 1200x630 Open Graph preview image, referenced from every public page and the manifest
- [ ] M28-T5 npm run build:sitemap: generate sitemap.xml from the landing and help page list with hreflang alternates and lastmod from git, plus an architecture test that the committed sitemap matches the generated one; robots.txt limits documented (a project site cannot serve the domain root robots.txt)
- [ ] M28-T6 docs/seo.md: Search Console URL-prefix property and HTML-file verification, sitemap submission, URL inspection and coverage follow-up, GitHub repository description/topics/homepage and README links; link it from AGENTS.md §9
- [ ] M28-T7 Manual check with the owner: Lighthouse SEO on landing and help index, Rich Results Test, Search Console verification file committed and sitemap submitted
