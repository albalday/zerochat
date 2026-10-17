/**
 * Búsqueda web (ChatWebSearch) con la API de Tavily, la única vía de search_web.
 * - Se llama directamente desde el navegador, con o sin backend: Tavily admite CORS y la
 *   petición lleva la clave del usuario, como las de los proveedores de modelos.
 * - La clave se guarda sin cifrar en el almacenamiento local (ChatStorage): es una clave
 *   gratuita de pruebas. Si Tavily la rechaza (401), se borra para pedirla de nuevo.
 * - Formatea los resultados en Markdown compacto para el modelo.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./utils.js'));
  } else {
    root.ChatWebSearch = factory(root.ChatUtils);
  }
})(typeof self !== 'undefined' ? self : this, function (Utils) {
  'use strict';

  const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
  const DEFAULT_TIMEOUT_MS = 15000;
  const MAX_RESULTS = 8;
  const SOURCE_LABEL = 'Tavily';
  const API_KEY_STORAGE_KEY = 'tavily_api_key';
  const API_KEY_URL = 'https://app.tavily.com';

  const { fetchWithTimeout, resolveDep } = Utils;
  const getStorage = () => resolveDep('ChatStorage', './storage.js');

  /** Clave de Tavily guardada; '' si no hay. */
  function getApiKey() {
    return String(getStorage().getStorageItem(API_KEY_STORAGE_KEY) || '').trim();
  }

  function saveApiKey(apiKey) {
    getStorage().setStorageItem(API_KEY_STORAGE_KEY, String(apiKey).trim());
  }

  function clearApiKey() {
    getStorage().deleteStorageItem(API_KEY_STORAGE_KEY);
  }

  /** Resultados en Markdown para el modelo. */
  function formatMarkdown(query, results) {
    if (results.length === 0) {
      return `[${SOURCE_LABEL} search for "${query}"]: No results found. Try different terms or use \`fetch_web_page\` directly with a specific URL.`;
    }
    let md = `### ${SOURCE_LABEL} search results for: "${query}" (${results.length} results found):\n\n`;
    results.forEach((item, idx) => {
      md += `${idx + 1}. **[${item.title}](${item.url})**\n`;
      if (item.snippet) md += `   - *Snippet:* ${item.snippet}\n`;
      md += `   - *Link:* ${item.url}\n\n`;
    });
    return md;
  }

  /** Mensaje de error de la API de Tavily (`detail.error`, `detail` o el estado HTTP). */
  async function readTavilyError(res) {
    try {
      const data = await res.json();
      const detail = data?.detail?.error || data?.detail || data?.error;
      if (typeof detail === 'string' && detail) return `Tavily answered HTTP ${res.status}: ${detail}`;
    } catch (_) { /* cuerpo sin JSON: basta el estado */ }
    return `Tavily answered HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`;
  }

  /**
   * Busca `query` en Tavily con `apiKey`.
   * @returns {Promise<{ success: boolean, query: string, count: number, results: Array<{ title: string, url: string, snippet: string, source: string }>, markdown: string, elapsedMs: number, error?: string }>}
   */
  async function search(query, apiKey, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const cleanQuery = String(query || '').trim();
    const startTime = performance.now();
    const elapsed = () => parseFloat((performance.now() - startTime).toFixed(2));
    const failure = error => ({ success: false, query: cleanQuery, count: 0, results: [], markdown: error, elapsedMs: elapsed(), error });

    if (!cleanQuery) return failure('No search query was given.');
    if (!apiKey) return failure('Web search needs a Tavily API key and the user did not provide one.');

    let res;
    try {
      res = await fetchWithTimeout(TAVILY_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query: cleanQuery, max_results: MAX_RESULTS, search_depth: 'basic' })
      }, timeoutMs);
    } catch (err) {
      return failure(err?.name === 'AbortError'
        ? `Tavily did not answer within ${timeoutMs}ms.`
        : `Tavily could not be reached (${err?.message || 'network error'}).`);
    }
    if (res.status === 401) {
      clearApiKey();
      return failure('Tavily rejected the API key (HTTP 401). It was removed and the user will be asked for a new one on the next search.');
    }
    if (!res.ok) return failure(await readTavilyError(res));

    const data = await res.json();
    const results = (Array.isArray(data?.results) ? data.results : [])
      .filter(item => item && typeof item.url === 'string' && item.url)
      .map(item => ({
        title: String(item.title || item.url),
        url: item.url,
        snippet: String(item.content || '').replace(/\s+/g, ' ').trim(),
        source: SOURCE_LABEL
      }));

    return {
      success: true,
      query: cleanQuery,
      count: results.length,
      results,
      markdown: formatMarkdown(cleanQuery, results),
      elapsedMs: elapsed()
    };
  }

  return { API_KEY_URL, getApiKey, saveApiKey, search };
});
