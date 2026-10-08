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
  function isMobileDevice(nav = typeof navigator !== 'undefined' ? navigator : null) {
    if (!nav) return false;
    if (typeof nav.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(String(nav.userAgent || ''));
  }

  function getWebllmDefaultContextWindowSize(nav) {
    return isMobileDevice(nav) ? WEBLLM_MOBILE_CONTEXT_WINDOW_SIZE : WEBLLM_DESKTOP_CONTEXT_WINDOW_SIZE;
  }

  const DEFAULT_THEME = 'dark';
  const CONFIG_SCHEMA_VERSION = 3;
  const DEFAULT_SYSTEM_DATA_PROMPT = '[Format: Always use standard Markdown and plain text. Never use LaTeX syntax or delimiters ($ or $$); write mathematics, formulas, and numbers directly in readable text using standard symbols (+, -, ×, /, =).]';

  /** Configuración de ejecución por defecto: estado inicial de ChatState y base de ChatConfig.normalize. */
  const CONFIG_DEFAULTS = Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    activeProfile: null,
    apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: '', modelContextLimit: null, contextLimitOverride: null,
    systemPrompt: '', systemDataPrompt: DEFAULT_SYSTEM_DATA_PROMPT, temperature: '0.7', reasoningEffort: 'medium', reasoningTransport: 'auto',
    maxAgentTurns: 40,
    modelReasoningConfig: null,
    enabledTools: Object.freeze({ execute_javascript: true, search_web: true, fetch_web_page: true, download_pdf: true, render_chart: true }),
    enableRawLogs: false, enableContextCache: true,
    apiKeyLocked: false,
    theme: DEFAULT_THEME, language: 'es', enableDebugMessages: false,
    activeRagBranchId: '', activeRagBranchIds: Object.freeze([]),
    mcpHost: '127.0.0.1', mcpPort: 6388, mcpAutoConnect: false,
    projectMode: true, projectDeclined: Object.freeze([]),
    webllmConfig: Object.freeze({
      context_window_size: String(getWebllmDefaultContextWindowSize()),
      prefill_chunk_size: 'default'
    })
  });

  return Object.freeze({
    DEFAULT_THEME,
    CONFIG_SCHEMA_VERSION,
    DEFAULT_SYSTEM_DATA_PROMPT,
    CONFIG_DEFAULTS,
    WEBLLM_CONTEXT_WINDOW_SIZES: Object.freeze([4096, 8192, 16384, 32768, 65536, 131072]),
    WEBLLM_DEFAULT_CONTEXT_WINDOW_SIZE: getWebllmDefaultContextWindowSize(),
    getWebllmDefaultContextWindowSize
  });
});
