# Plan

## M1 Project setup: closed 2026-10-12

## M2 Audit closure, Anthropic connection and detected bugs: closed 2026-10-13
## M3 Playwright and browser_action configuration
Goal: A Navegador section in Settings that chooses the browsing tool (none, browser_action or Playwright MCP) and, for Playwright MCP, whether it drives its own browser (an installed Playwright engine with a persistent profile that can be cleared) or the user's Chrome or Edge with their sessions, so a later scripts project can rely on it.
Done when: the Navegador section chooses the browsing tool, installs and removes the Playwright engines, chooses the own engine or the user's browser, shows or hides the window and clears the own browser data; Playwright MCP launches with that configuration in the interactive session and in zerochat --prompt; what a profile can choose of it is designed and applied; with ES/EN help and tests.
- [x] M3-T1 Study with the user how to approach Playwright scripts and agree the milestone's Done when (2026-10-19)
- [x] M3-T2 True headless and concurrent zerochat.py --prompt runs on a copy of the user's browser profile, starting from M18-D2/D3/D5/D6/D7 (selective Firefox copy of storage/default/<UI origin> plus its moz_perms rows via the SQLite backup API with a raw copy+WAL fallback for exclusively locked databases, 0700 and deleted after use; Playwright storageState for Chromium; headless needs local network access granted) and the dropped M18-T4 code in git history (commit a4b9bbd, py/hh-firefox-profile.py) (dropped: outside the new M3 scope (Playwright and browser_action configuration); it concerns the browser running the ZeroChat UI in --prompt runs and needs a new task when taken up, see M3-D7)
- [x] M3-T3 Playwright parameters as a section of the profile (browser, headless, isolated or persistent browser profile, origins, code generation, output directory): the backend generates the MCP config.json from the active profile in ~/zerochat/config/playwright/<profile file id>.json (0700 directory, safe file name derived from the profile id, outside the MCP service directory), keeps persistent browser profiles in ~/zerochat/playwright-profiles/<profile file id>/ (0700), launches the MCP with --config and migrates the current headless option; deleting a profile deletes its generated config and persistent browser profile (dropped: replaced by M3-T10 and M3-T14, see M3-D7)
- [x] M3-T4 Playwright section in the profile editor: browser (installing it), headless, isolated or persistent browser profile, allowed/blocked origins, code generation and an output directory for screenshots and traces instead of the MCP service directory; profile backups and exports carry the parameters (dropped: replaced by M3-T12 and M3-T13, see M3-D7)
- [x] M3-T5 Playwright secrets of each profile in a 0600 .env passed with --secrets (dropped: secrets belong to the scripts project, not to ZeroChat, see M3-D5)
- [x] M3-T6 browser_action applies the active Playwright configuration (browser, headless, profile, origins) (dropped: replaced by M3-T10, see M3-D7)
- [x] M3-T7 zerochat --prompt --playwright-config <name> for one run, with a clear error when the persistent profile is in use (dropped: the profile chooses the Playwright configuration, see M3-T9 and M3-D2)
- [x] M3-T8 Installed Playwright version and browsers shown in the settings screen and given to the model with a read-only description of the active configuration, so generated scripts pin the same version and reuse the downloaded browsers (dropped: installed version and browsers go to the panel (M3-T11); what the model knows for script generation belongs to the scripts project, see M3-D7)
- [x] M3-T9 Applying the profile's Playwright parameters: activating a profile with other parameters restarts the MCP after a notice (last activated tab wins), --prompt --profile hands them to the run's backend before Playwright starts, and a clear error when the persistent browser profile is in use (dropped: replaced by M3-T14, see M3-D7)
- [x] M3-T10 Browser configuration kept by the backend in ~/zerochat/config/browser.json (0700 directory): browsing tool (none, browser_action, playwright), Playwright mode (own or user), own engine, user browser and show window; Playwright MCP launches from it, own mode with --browser <engine>, --user-data-dir ~/zerochat/playwright/profile/<engine> (0700) and --headless unless the window is shown, user mode with --extension on the chosen Chrome or Edge (Playwright MCP Bridge extension); first check that the installed @playwright/mcp supports --extension and choosing its browser; the current headless service option migrates into it and the browsing tool moves out of the profile until M3-T13 (2026-10-19)
- [x] M3-T11 Browser engines: list the installed Playwright version and its own engines (Chromium, Firefox, WebKit), install or remove them with progress inside the Playwright cache (removing the chosen engine switches to another installed one), and detect the system browsers for the user mode (Chrome, Edge; Firefox shown as not supported by the extension), never installing anything system-wide (2026-10-19)
- [ ] M3-T12 Navegador section in Settings (between MCP and Permissions) as in the agreed mockup: browsing tool first (none, browser_action, Playwright MCP) and Playwright options only for Playwright MCP; own browser with the engines (M3-T11; removing the chosen engine switches the configuration to another installed one), clear browser data (stops Playwright MCP after confirmation and deletes the engine's browser profile) and show window; user browser with the detected browser selector, the extension install guide and a warning that the model acts with the user's accounts; the browsing tool moves from the profile to the global config (frontend, like the native tool switches) and the Playwright options are read and saved through zerochat/browser/config/get and set (validate_browser_config); saving restarts Playwright MCP after a notice; the Playwright card in Settings › MCP keeps only start and stop and without the local server it shows the MCP bootstrap guide; ES/EN help
- [ ] M3-T13 Design with the user what a profile can choose of the browser configuration (the M29 Navegador chapter was provisional) and implement it, with --prompt --profile and profile backups and exports; after M3-T10 to M3-T12
- [x] M3-T14 Effective configuration: default plus the active profile's overrides, generated as the MCP config file of that profile (dropped: there are no per-profile overrides of Playwright parameters; launching from the configuration goes to M3-T10 and the profile part to M3-T13, see M3-D9)
- [ ] M3-T15 The remember parameter of zerochat/external/servers/start becomes required (no default in the backend RPC nor in McpServiceManager.start), so no default only serves old clients and tests
- [ ] M3-T16 Import Firefox sessions into the own browser: a button in the own mode copies cookies (and site storage when needed) from the user's Firefox profile into the chosen engine's browser profile with the SQLite backup API and raw copy+WAL fallback of M18, as a one-off snapshot (no sync, no saved passwords); after M3-T12

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

## M29 Configuration profiles: MCP servers per profile: closed 2026-10-19
