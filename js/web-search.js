/**
 * Módulo de Búsqueda Web Desacoplado (ChatWebSearch) para ZeroChat.
 * - Arquitectura basada en SearchProvider con registro extensible (DuckDuckGo, SearXNG, etc.).
 * - Motor de búsqueda resiliente multitrayecto con fallback automático.
 * - Formateo estandarizado de resultados en Markdown optimizado para LLMs.
 * - Compatible con entornos file://, http:// y Node.js.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ChatWebSearch = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 10000;

  function getUtils() {
    if (typeof window !== 'undefined' && window.ChatUtils) return window.ChatUtils;
    if (typeof require !== 'undefined') {
      try { return require('./utils.js'); } catch (e) {}
    }
    return null;
  }

  /**
   * Realiza una petición fetch con timeout controlado mediante AbortController.
   */
  async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const Utils = getUtils();
    if (Utils && typeof Utils.fetchWithTimeout === 'function') {
      return Utils.fetchWithTimeout(url, options, timeoutMs);
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      return await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      throw new Error(`El método search() debe ser implementado en ${this.constructor.name}`);
    }

    /**
     * Formatea los resultados en Markdown estructurado y compacto para el asistente.
     */
    formatMarkdown(query, results = [], lang = 'es') {
      const isEn = (lang === 'en');
      const cleanQuery = (query || '').trim();

      if (!results || results.length === 0) {
        return isEn
          ? `[${this.label} search for "${cleanQuery}"]: No direct results found. Try searching with different terms or use \`fetch_web_page\` directly with a specific URL.`
          : `[Búsqueda ${this.label} para "${cleanQuery}"]: No se encontraron resultados directos. Puedes intentar buscar con otros términos o usar directamente la herramienta \`fetch_web_page\` con una URL concreta.`;
      }

      let md = isEn
        ? `### 🔍 ${this.label} search results for: "${cleanQuery}" (${results.length} results found):\n\n`
        : `### 🔍 Resultados de búsqueda ${this.label} para: "${cleanQuery}" (${results.length} resultados encontrados):\n\n`;

      results.forEach((item, idx) => {
        md += `${idx + 1}. **[${item.title}](${item.url})**\n`;
        md += `   - *${isEn ? 'Source' : 'Fuente'}:* \`${item.source || this.label}\`\n`;
        if (item.snippet) {
          md += `   - *${isEn ? 'Snippet' : 'Resumen'}:* ${item.snippet}\n`;
        }
        md += `   - *${isEn ? 'Link' : 'Enlace'}:* ${item.url}\n\n`;
      });

      return md;
    }
  }

  /**
   * Proveedor de búsqueda DuckDuckGo con arquitectura multitrayecto y fallbacks.
   */
  class DuckDuckGoSearchProvider extends BaseSearchProvider {
    constructor(options = {}) {
      super({
        id: 'duckduckgo',
        label: 'DuckDuckGo',
        ...options
      });
    }

    /**
     * Parsea resultados de DuckDuckGo desde Markdown de Reader Gateway.
     */
    parseMarkdownResults(md) {
      const results = [];
      const seenUrls = new Set();
      const sections = (md || '').split(/\n(?=##\s*\[)/);

      for (const sec of sections) {
        const titleMatch = sec.match(/^##\s*\[([^\]]+)\]\(([^)]+)\)/);
        if (!titleMatch) continue;
        const rawTitle = titleMatch[1].trim();
        const rawUrl = titleMatch[2].trim();
        const realUrl = unwrapDdgUrl(rawUrl);

        if (!realUrl || seenUrls.has(realUrl.toLowerCase()) || realUrl.includes('duckduckgo.com/html') || realUrl.includes('duckduckgo.com/?q=')) {
          continue;
        }
        seenUrls.add(realUrl.toLowerCase());

        const linkMatches = [...sec.matchAll(/\[([^\]]{25,})\]\([^)]+\)/g)];
        let snippet = '';
        if (linkMatches.length > 0) {
          snippet = linkMatches[linkMatches.length - 1][1].replace(/\*\*/g, '').trim();
        } else {
          const lines = sec.split('\n').filter(l => !l.startsWith('##') && !l.startsWith('[!') && l.trim().length > 20);
          if (lines.length > 0) {
            snippet = lines.join(' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '').trim();
          }
        }

        results.push({
          title: rawTitle,
          url: realUrl,
          snippet: snippet,
          source: 'DuckDuckGo Web'
        });
      }
      return results;
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
        const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, timeoutMs);
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
      } catch (e) {
        return [];
      }
    }

    /**
     * Fallback de búsqueda en Wikipedia API.
     */
    async queryWikipediaApi(query, timeoutMs = 4000) {
      try {
        const wikiUrl = `https://es.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json&origin=*`;
        const res = await fetchWithTimeout(wikiUrl, {}, timeoutMs);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data) && data[1] && data[1].length > 0) {
            const wikiResults = [];
            for (let i = 0; i < data[1].length; i++) {
              wikiResults.push({
                title: data[1][i],
                snippet: data[2] ? data[2][i] || '' : '',
                url: data[3] ? data[3][i] : '',
                source: 'Wikipedia'
              });
            }
            return wikiResults;
          }
        }
      } catch (e) {}
      return [];
    }

    async search(query, options = {}) {
      const cleanQuery = (query || '').trim();
      const lang = options.lang || 'es';
      const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

      if (!cleanQuery) {
        return {
          success: false,
          query: '',
          count: 0,
          results: [],
          markdown: 'No se especificó ninguna consulta de búsqueda.',
          elapsedMs: 0,
          error: 'Consulta vacía'
        };
      }

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let rawResults = [];

      // 1. Vía Universal Reader Gateway (con bypass CORS transparente para resultados web completos)
      try {
        const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
        const readerUrl = `https://r.jina.ai/${targetUrl}`;
        const res = await fetchWithTimeout(readerUrl, { headers: { 'Accept': 'text/plain' } }, Math.min(timeoutMs, 7000));
        if (res.ok) {
          const md = await res.text();
          const parsed = this.parseMarkdownResults(md);
          if (parsed.length > 0) {
            rawResults = parsed;
          }
        }
      } catch (e) {
        console.warn('Reader Gateway no disponible para búsqueda DuckDuckGo, intentando vía directa:', e.message);
      }

      // 2. Vía Directa a DuckDuckGo HTML
      if (rawResults.length === 0) {
        try {
          const targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
          const res = await fetchWithTimeout(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
          }, Math.min(timeoutMs, 5000));
          if (res.ok) {
            const html = await res.text();
            const parsed = this.parseHtmlResults(html);
            if (parsed.length > 0) {
              rawResults = parsed;
            }
          }
        } catch (e) {
          console.warn('DuckDuckGo HTML directo no disponible:', e.message);
        }
      }

      // 3. Vía DuckDuckGo Instant Answer API
      if (rawResults.length === 0) {
        const instantResults = await this.queryInstantAnswerApi(cleanQuery, Math.min(timeoutMs, 4000));
        if (instantResults.length > 0) {
          rawResults = instantResults;
        }
      }

      // 4. Vía Wikipedia Search API
      if (rawResults.length === 0) {
        const wikiResults = await this.queryWikipediaApi(cleanQuery, Math.min(timeoutMs, 4000));
        if (wikiResults.length > 0) {
          rawResults = wikiResults;
        }
      }

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = parseFloat((endTime - startTime).toFixed(2));
      const mdOutput = this.formatMarkdown(cleanQuery, rawResults, lang);

      return {
        success: rawResults.length > 0,
        query: cleanQuery,
        count: rawResults.length,
        results: rawResults,
        markdown: mdOutput,
        elapsedMs: elapsed
      };
    }
  }

  /**
   * Proveedor de búsqueda compatible con instancias SearXNG.
   */
  class SearXNGSearchProvider extends BaseSearchProvider {
    constructor(options = {}) {
      super({
        id: 'searxng',
        label: 'SearXNG',
        ...options
      });
      this.baseUrl = (options.baseUrl || 'https://searx.be').trim().replace(/\/+$/, '');
    }

    /**
     * Parsea los resultados del formato JSON estándar de SearXNG.
     */
    parseJsonResponse(data) {
      if (!data || !Array.isArray(data.results)) return [];
      return data.results.slice(0, 10).map(r => ({
        title: r.title || 'Sin título',
        url: r.url || '',
        snippet: r.content || r.snippet || '',
        source: `SearXNG (${r.engine || 'web'})`
      })).filter(r => !!r.url);
    }

    async search(query, options = {}) {
      const cleanQuery = (query || '').trim();
      const lang = options.lang || 'es';
      const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

      if (!cleanQuery) {
        return {
          success: false,
          query: '',
          count: 0,
          results: [],
          markdown: 'No se especificó ninguna consulta de búsqueda.',
          elapsedMs: 0,
          error: 'Consulta vacía'
        };
      }

      const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let rawResults = [];

      try {
        const url = `${this.baseUrl}/search?q=${encodeURIComponent(cleanQuery)}&format=json&language=${lang === 'en' ? 'en' : 'es'}`;
        const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, timeoutMs);
        if (res.ok) {
          const data = await res.json();
          rawResults = this.parseJsonResponse(data);
        }
      } catch (err) {
        console.warn(`Error consultando SearXNG (${this.baseUrl}):`, err.message);
      }

      const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const elapsed = parseFloat((endTime - startTime).toFixed(2));
      const mdOutput = this.formatMarkdown(cleanQuery, rawResults, lang);

      return {
        success: rawResults.length > 0,
        query: cleanQuery,
        count: rawResults.length,
        results: rawResults,
        markdown: mdOutput,
        elapsedMs: elapsed
      };
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
     * Establece el proveedor predeterminado.
     */
    setDefault(id) {
      if (id && this.providers.has(String(id).toLowerCase())) {
        this.defaultProviderId = String(id).toLowerCase();
      }
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
   * Función de búsqueda web compatible con la interfaz histórica de ZeroChat.
   */
  async function search(query, lang = 'es', options = {}) {
    return registry.search(query, { lang, ...options });
  }

  const registry = new SearchProviderRegistry();

  /**
   * Definición estándar de herramienta (Tool/Function Calling) para OpenAI y LLMs compatibles.
   */
  const SEARCH_TOOL_DEFINITION = {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Busca en internet en tiempo real información actualizada, noticias, artículos y enlaces web utilizando DuckDuckGo.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Términos o consulta de búsqueda en DuckDuckGo (ej: "INE poblacion Ceuta padron", "DeepSeek R1").'
          }
        },
        required: ['query']
      }
    }
  };

  return {
    search,
    SEARCH_TOOL_DEFINITION,
    BaseSearchProvider,
    DuckDuckGoSearchProvider,
    SearXNGSearchProvider,
    SearchProviderRegistry,
    registry
  };
});
