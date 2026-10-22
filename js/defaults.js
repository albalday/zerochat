/**
 * Valores predeterminados compartidos por el arranque y la configuración.
 */
(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatDefaults = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEBLLM_MOBILE_CONTEXT_WINDOW_SIZE = 4096;
  const WEBLLM_DESKTOP_CONTEXT_WINDOW_SIZE = 16384;

  // Se usa el dispositivo y no el ancho de ventana: lo que limita es la memoria de la GPU.
  function isMobileDevice(nav = navigator) {
    if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(String(nav.userAgent || ''));
  }

  function getWebllmDefaultContextWindowSize(nav) {
    return isMobileDevice(nav) ? WEBLLM_MOBILE_CONTEXT_WINDOW_SIZE : WEBLLM_DESKTOP_CONTEXT_WINDOW_SIZE;
  }

  // Idioma inicial de la interfaz: el del navegador si es inglés; en otro caso, español.
  function getBrowserLanguage(nav = navigator) {
    const language = String(nav.languages?.[0] || nav.language || '').toLowerCase();
    return language.startsWith('en') ? 'en' : 'es';
  }

  // Versión publicada en el título de zerochat.html, que actualiza `npm run bump`.
  const APP_VERSION = (typeof document !== 'undefined' && document.title.match(/v?(\d+\.\d+(?:\.\d+)?)/)?.[1]) || 'dev';

  const DEFAULT_THEME = 'dark';
  const DEFAULT_SYSTEM_DATA_PROMPT = '[Format: Always use standard Markdown and plain text. For documents, reports and structured content, use standard Markdown elements (headings #/##/###, lists, quotes, and Markdown tables). Embed images using standard Markdown ![caption](url). Never output raw HTML tags (e.g. <div>, <table>, <p>, <img>) or HTML code blocks unless the user explicitly requests HTML web development code. For tabular data, always format it as a valid Markdown table with headers. Use direct Unicode symbols (→, ≤, ≥, ≈, ≠, ×, ÷, ±, ²) for mathematics and logic; never output LaTeX commands (\\rightarrow, \\le, \\frac) or delimiters ($ or $$).]';

  /** Herramientas de navegación de Ajustes › Navegador: ninguna, browser_action o Playwright MCP. */
  const BROWSER_TOOLS = Object.freeze(['none', 'browser_action', 'playwright']);
  /** Motores propios de Playwright y navegadores del usuario que maneja su extensión. */
  const PLAYWRIGHT_ENGINES = Object.freeze(['chromium', 'firefox', 'webkit']);
  const USER_BROWSERS = Object.freeze(['chrome', 'msedge', 'chromium']);

  /**
   * Navegador que exige un perfil para Playwright MCP: el propio con un motor, y `headless: false`
   * si exige la ventana visible, o el del usuario con uno de sus navegadores. El resto de la
   * configuración es la de Ajustes › Navegador.
   */
  function isPlaywrightBrowser(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort().join(',');
    if (value.mode === 'own') {
      return (keys === 'engine,mode' || (keys === 'engine,headless,mode' && value.headless === false)) && PLAYWRIGHT_ENGINES.includes(value.engine);
    }
    if (value.mode === 'user') return keys === 'mode,userBrowser' && USER_BROWSERS.includes(value.userBrowser);
    return false;
  }

  /** Configuración de ejecución por defecto: estado inicial de ChatState y base de ChatConfig.normalize. */
  const CONFIG_DEFAULTS = Object.freeze({
    activeProfile: null,
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: '', modelContextLimit: null, contextLimitOverride: null,
    systemPrompt: '', systemDataPrompt: DEFAULT_SYSTEM_DATA_PROMPT, temperature: '0.7', reasoningEffort: 'medium',
    modelReasoningConfig: null,
    enabledTools: Object.freeze({ execute_javascript: true, search_web: true, fetch_web_page: true, download_doc: true, render_chart: true }),
    enableRawLogs: false, enableContextCache: true,
    apiKeyLocked: false,
    theme: DEFAULT_THEME, language: getBrowserLanguage(), enableDebugMessages: false,
    activeRagBranchIds: Object.freeze([]),
    mcpServers: Object.freeze([]), browser: 'browser_action', playwrightBrowser: null,
    mcpHost: '127.0.0.1', mcpPort: 6388, mcpAutoConnect: false,
    projectMode: true, projectDeclined: Object.freeze([]),
    webllmConfig: Object.freeze({
      context_window_size: String(getWebllmDefaultContextWindowSize()),
      prefill_chunk_size: 'default'
    })
  });

  return Object.freeze({
    APP_VERSION,
    BROWSER_TOOLS,
    PLAYWRIGHT_ENGINES,
    USER_BROWSERS,
    isPlaywrightBrowser,
    DEFAULT_THEME,
    DEFAULT_SYSTEM_DATA_PROMPT,
    CONFIG_DEFAULTS,
    WEBLLM_CONTEXT_WINDOW_SIZES: Object.freeze([4096, 8192, 16384, 32768, 65536, 131072]),
    WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE: getWebllmDefaultContextWindowSize(),
    getWebllmDefaultContextWindowSize
  });
});
