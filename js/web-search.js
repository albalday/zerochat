/**
 * Módulo de Búsqueda Web Desacoplado (ChatWebSearch) para ZeroChat.
 * - Arquitectura basada en SearchProvider con registro extensible (DuckDuckGo, SearXNG, etc.).
 * - Motor de búsqueda resiliente multitrayecto con fallback automático.
 * - Formateo estandarizado de resultados en Markdown optimizado para LLMs.
 * - Sin backend solo responden las vías con CORS: DuckDuckGo Instant Answer y la búsqueda de Wikipedia.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory(require('./web-browser.js'));
  } else {
    root.ChatWebSearch = factory(root.ChatWebBrowser);
  }
})(typeof self !== 'undefined' ? self : this, function (WebBrowser) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 10000;
  const WIKIPEDIA_RESULT_LIMIT = 8;

  const { webFetch } = WebBrowser;

  /** Texto plano de un fragmento HTML de resultados (etiquetas y entidades). */
  function htmlFragmentToText(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Desempaqueta URLs redirigidas de DuckDuckGo (parámetro uddg).
   */
  function unwrapDdgUrl(rawUrl) {
    if (!rawUrl) return '';
    const match = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch (e) {
        return match[1];
      }
    }
    if (rawUrl.startsWith('//')) return 'https:' + rawUrl;
    return rawUrl;
  }

  /**
   * Clase Base para proveedores de búsqueda web (SearchProvider).
   */
  class BaseSearchProvider {
    constructor(options = {}) {
      this.id = options.id || 'base';
      this.label = options.label || 'Base Search Provider';
    }

    /**
     * Realiza una búsqueda web y retorna una estructura estandarizada.
     * @param {string} query - Consulta de búsqueda.
     * @param {object} options - Opciones de búsqueda (lang, timeoutMs, etc.).
     * @returns {Promise<{ success: boolean, query: string, count: number, results: Array, markdown: string, elapsedMs: number, error?: string }>}
     */
    async search(query, options = {}) {
      const cleanQuery = (query || '').trim();
      const lang = options.lang || 'es';

      if (!cleanQuery) {
        return {
          success: false,
          query: '',
          count: 0,
          results: [],
          markdown: 'No search query was given.',
          elapsedMs: 0,
          error: 'Empty query'
        };
      }

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const rawResults = await this.fetchResults(cleanQuery, { lang, timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS });
      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

      return {
        success: rawResults.length > 0,
        query: cleanQuery,
        count: rawResults.length,
        results: rawResults,
        markdown: this.formatMarkdown(cleanQuery, rawResults),
        elapsedMs: parseFloat((endTime - startTime).toFixed(2))
      };
    }

    /**
     * Devuelve los resultados normalizados de una consulta no vacía.
     * @returns {Promise<Array<{ title: string, url: string, snippet?: string, source?: string }>>}
     */
    async fetchResults(_cleanQuery, _options) {
      throw new Error(`fetchResults() must be implemented by ${this.constructor.name}`);
    }

    /**
     * Formatea los resultados en Markdown estructurado y compacto para el asistente.
     */
    /** Resultados en Markdown para el modelo. */
    formatMarkdown(query, results = []) {
      const cleanQuery = (query || '').trim();

      if (!results || results.length === 0) {
        return `[${this.label} search for "${cleanQuery}"]: No direct results found. Try searching with different terms or use \`fetch_web_page\` directly with a specific URL.`;
      }

      let md = `### ${this.label} search results for: "${cleanQuery}" (${results.length} results found):\n\n`;

      results.forEach((item, idx) => {
        md += `${idx + 1}. **[${item.title}](${item.url})**\n`;
        md += `   - *Source:* \`${item.source || this.label}\`\n`;
        if (item.snippet) {
          md += `   - *Snippet:* ${item.snippet}\n`;
        }
        md += `   - *Link:* ${item.url}\n\n`;
      });

      return md;
    }
  }

  /**
   * Proveedor de búsqueda DuckDuckGo con arquitectura multitrayecto y fallbacks.
   */
  class DuckDuckGoSearchProvider extends BaseSearchProvider {
    constructor() {
      super({ id: 'duckduckgo', label: 'DuckDuckGo' });
    }


    /**
     * Parsea resultados de DuckDuckGo desde HTML crudo.
     */
    parseHtmlResults(html) {
      const results = [];
      const seenUrls = new Set();
      const blockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>|$)/g;

      let match;
      while ((match = blockRegex.exec(html || '')) !== null) {
        const rawUrl = match[1].trim();
        const rawTitle = match[2].replace(/<[^>]*>/g, '').trim();
        const snippet = (match[3] || match[4] || '').replace(/<[^>]*>/g, '').trim();
        const realUrl = unwrapDdgUrl(rawUrl);

        if (realUrl && !seenUrls.has(realUrl.toLowerCase()) && !realUrl.includes('duckduckgo.com/html')) {
          seenUrls.add(realUrl.toLowerCase());
          results.push({
            title: rawTitle,
            url: realUrl,
            snippet: snippet,
            source: 'DuckDuckGo Web'
          });
        }
      }
      return results;
    }

    /**
     * Consulta DuckDuckGo Instant Answer API.
     */
    async queryInstantAnswerApi(query, timeoutMs = 4000) {
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&pretty=1`;
        const res = await webFetch(url, {
          timeoutMs,
          accept: 'application/json,text/plain,*/*'
        });
        if (!res.ok) return [];
        const data = await res.json();
        const results = [];

        if (data.Answer) {
          results.push({
            title: 'Respuesta Directa',
            snippet: data.Answer,
            url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
            source: 'DuckDuckGo Instant Answer'
          });
        }
        if (data.AbstractText && data.AbstractURL) {
          results.push({
            title: data.Heading || query,
            snippet: data.AbstractText,
            url: data.AbstractURL,
            source: data.AbstractSource ? `DuckDuckGo (${data.AbstractSource})` : 'DuckDuckGo Abstract'
          });
        }
        if (data.Results && Array.isArray(data.Results)) {
          data.Results.forEach(r => {
            if (r.FirstURL && r.Text) {
              results.push({
                title: r.Text.split(' - ')[0] || r.Text,
                snippet: r.Text,
                url: r.FirstURL,
                source: 'DuckDuckGo'
              });
            }
          });
        }
        return results;
      } catch (_) {
        /* Error consultando API de respuesta rápida */
        return [];
      }
    }

    /**
     * Búsqueda de Wikipedia en el idioma de la interfaz. Su API admite CORS (origin=*), así que
     * responde también sin backend, donde DuckDuckGo HTML no es accesible.
     */
    async queryWikipediaApi(query, lang, timeoutMs = 4000) {
      const wiki = lang === 'en' ? 'en' : 'es';
      try {
        const url = `https://${wiki}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${WIKIPEDIA_RESULT_LIMIT}&format=json&origin=*`;
        const res = await webFetch(url, { timeoutMs, accept: 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        return (data?.query?.search || []).map(item => ({
          title: item.title,
          url: `https://${wiki}.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/ /g, '_'))}`,
          snippet: htmlFragmentToText(item.snippet),
          source: 'Wikipedia'
        }));
      } catch (e) {
        console.warn('[WebSearch] Wikipedia search failed:', e.message);
        return [];
      }
    }

    async fetchResults(cleanQuery, { lang, timeoutMs }) {
      let rawResults = [];

      try {
        const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
        const res = await webFetch(targetUrl, {
          timeoutMs: Math.min(timeoutMs, 6000),
          accept: 'text/html,application/xhtml+xml,*/*'
        });
        if (res.ok) {
          const html = await res.text();
          const parsed = this.parseHtmlResults(html);
          if (parsed.length > 0) {
            rawResults = parsed;
          }
        }
      } catch (e) {
        console.warn('[WebSearch] DuckDuckGo HTML search failed:', e.message);
      }

      // Vía DuckDuckGo Instant Answer API si no hubo resultados en HTML
      if (rawResults.length === 0) {
        const instantResults = await this.queryInstantAnswerApi(cleanQuery, Math.min(timeoutMs, 4000));
        if (instantResults.length > 0) {
          rawResults = instantResults;
        }
      }

      if (rawResults.length === 0) {
        rawResults = await this.queryWikipediaApi(cleanQuery, lang, Math.min(timeoutMs, 4000));
      }

      return rawResults;
    }
  }

  /**
   * Proveedor de búsqueda compatible con instancias SearXNG.
   */
  class SearXNGSearchProvider extends BaseSearchProvider {
    constructor() {
      super({ id: 'searxng', label: 'SearXNG' });
      this.baseUrl = 'https://searx.be';
    }

    /**
     * Parsea los resultados del formato JSON estándar de SearXNG.
     */
    parseJsonResponse(data) {
      if (!data || !Array.isArray(data.results)) return [];
      return data.results.slice(0, 10).map(r => ({
        title: r.title || 'Untitled',
        url: r.url || '',
        snippet: r.content || r.snippet || '',
        source: `SearXNG (${r.engine || 'web'})`
      })).filter(r => !!r.url);
    }

    async fetchResults(cleanQuery, { lang, timeoutMs }) {
      let rawResults = [];
      const url = `${this.baseUrl}/search?q=${encodeURIComponent(cleanQuery)}&format=json&language=${lang === 'en' ? 'en' : 'es'}`;

      try {
        const res = await webFetch(url, {
          timeoutMs,
          accept: 'application/json'
        });
        if (res.ok) {
          const data = await res.json();
          rawResults = this.parseJsonResponse(data);
        }
      } catch (err) {
        console.warn(`[WebSearch] SearXNG search failed (${this.baseUrl}):`, err.message);
      }

      return rawResults;
    }
  }

  /**
   * Registro central de proveedores de búsqueda (SearchProviderRegistry).
   */
  class SearchProviderRegistry {
    constructor() {
      this.providers = new Map();
      this.defaultProviderId = 'duckduckgo';

      // Registro de proveedores iniciales
      this.register(new DuckDuckGoSearchProvider());
      this.register(new SearXNGSearchProvider());
    }

    /**
     * Registra un proveedor de búsqueda.
     */
    register(provider) {
      if (provider && provider.id) {
        this.providers.set(provider.id.toLowerCase(), provider);
      }
    }

    /**
     * Obtiene un proveedor por su identificador.
     */
    get(id) {
      if (!id) return this.providers.get(this.defaultProviderId);
      return this.providers.get(String(id).toLowerCase()) || this.providers.get(this.defaultProviderId);
    }

    /**
     * Ejecuta una búsqueda utilizando el proveedor indicado o el por defecto.
     */
    async search(query, options = {}) {
      const providerId = options.providerId || options.provider;
      const provider = this.get(providerId);
      return provider.search(query, options);
    }
  }

  /**
   * Módulo de Búsqueda Web Desacoplado (ChatWebSearch) para ZeroChat.
   */
  /* ... */
  /**
   * Busca con el proveedor predeterminado del registro.
   */
  async function search(query, lang = 'es', options = {}) {
    return registry.search(query, { lang, ...options });
  }

  const registry = new SearchProviderRegistry();

  return {
    search,
    DuckDuckGoSearchProvider,
    SearXNGSearchProvider,
    registry
  };
});
