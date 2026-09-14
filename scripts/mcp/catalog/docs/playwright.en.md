# Playwright MCP

Example catalog entry for the ZeroChat implementation plan. This entry does not install anything by itself. It requires the bootstrap and host described in `scripts/mcp/README.md` and a release with generated, tested locks and integrity records.

The official server is [Microsoft's `@playwright/mcp`](https://github.com/microsoft/playwright-mcp). It requires Node.js; the Python environment runs the host. The recipe proposes a private npm installation and Chromium under `~/.zerochat/mcp`, without global installations. Missing operating system libraries require a visible intervention step.

Clicking **Start external MCP services** prepares and starts this service when enabled. The browser runs headlessly with an isolated profile. Tools and their parameters are discovered through MCP; they are not defined in the bundle or in this entry.

Verify it by using a published tool to navigate to a local test page and interact with a button. Then stop and restart without network access: valid installations must be reused. The host must implement profile separation between conversations.
