/**
 * Búsqueda web (ChatWebSearch) en DuckDuckGo HTML, la única vía de search_web.
 * - La página de resultados se pide con ChatWebBrowser.webFetch: por el backend local si está
 *   conectado o, si no, por Jina Reader, que devuelve el mismo HTML. Un solo analizador sirve
 *   para las dos rutas.
 * - Formatea los resultados en Markdown compacto para el modelo.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./web-browser.js'));
  } else {
    root.ChatWebSearch = factory(root.ChatWebBrowser);
  }
})(typeof self !== 'undefined' ? self : this, function (WebBrowser) {
  'use strict';

  const SEARCH_URL = 'https://html.duckduckgo.com/html/?q=';
  // Jina Reader tarda varios segundos en devolver la página de resultados.
  const DEFAULT_TIMEOUT_MS = 20000;
  const SOURCE_LABEL = 'DuckDuckGo';

  const { webFetch } = WebBrowser;

  /** URL real de un enlace de resultados de DuckDuckGo (parámetro uddg). */
  function unwrapDdgUrl(rawUrl) {
    if (!rawUrl) return '';
    const match = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch (_) {
        return match[1];
      }
    }
    if (rawUrl.startsWith('//')) return 'https:' + rawUrl;
    return rawUrl;
  }

  /**
   * Resultados de la página HTML de DuckDuckGo: título, URL real y fragmento, sin repetidos.
   * El fragmento se busca solo hasta el enlace del resultado siguiente, para que un resultado
   * sin fragmento no tome el de otro.
   */
  function parseHtmlResults(html) {
    const text = String(html || '');
    const anchors = [...text.matchAll(/<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)];
    const stripTags = value => value.replace(/<[^>]*>/g, '').trim();
    const results = [];
    const seenUrls = new Set();

    anchors.forEach((anchor, index) => {
      const href = anchor[1].match(/\bhref="([^"]*)"/)?.[1] || '';
      const realUrl = unwrapDdgUrl(href.trim().replace(/&amp;/g, '&'));
      if (!realUrl || seenUrls.has(realUrl.toLowerCase()) || realUrl.includes('duckduckgo.com/html')) return;
      seenUrls.add(realUrl.toLowerCase());
      const segment = text.slice(anchor.index + anchor[0].length, anchors[index + 1]?.index ?? text.length);
      const snippet = segment.match(/\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/)?.[1] || '';
      results.push({ title: stripTags(anchor[2]), url: realUrl, snippet: stripTags(snippet), source: SOURCE_LABEL });
    });
    return results;
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

  /**
   * Busca `query` en DuckDuckGo.
   * @returns {Promise<{ success: boolean, query: string, count: number, results: Array<{ title: string, url: string, snippet: string, source: string }>, markdown: string, elapsedMs: number, error?: string }>}
   */
  async function search(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const cleanQuery = String(query || '').trim();
    const startTime = performance.now();
    const elapsed = () => parseFloat((performance.now() - startTime).toFixed(2));
    const failure = error => ({ success: false, query: cleanQuery, count: 0, results: [], markdown: error, elapsedMs: elapsed(), error });

    if (!cleanQuery) return failure('No search query was given.');

    let res;
    try {
      res = await webFetch(`${SEARCH_URL}${encodeURIComponent(cleanQuery)}`, { timeoutMs, accept: 'text/html' });
    } catch (err) {
      return failure(err?.name === 'AbortError'
        ? `The search did not finish within ${timeoutMs}ms.`
        : `The search could not be done (${err?.message || 'network error'}).`);
    }
    if (!res.ok) return failure(res.error || `HTTP ${res.status}`);

    const results = parseHtmlResults(await res.text());
    return {
      success: true,
      query: cleanQuery,
      count: results.length,
      results,
      markdown: formatMarkdown(cleanQuery, results),
      elapsedMs: elapsed()
    };
  }

  return { parseHtmlResults, search };
});
