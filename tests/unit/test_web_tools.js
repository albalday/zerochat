const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const WebSearch = require('../../js/web-search.js');
const WebBrowser = require('../../js/web-browser.js');

test('SearchProvider - DuckDuckGo Markdown & HTML parsing', () => {
  const ddg = new WebSearch.DuckDuckGoSearchProvider();

  // Test de parseo de Markdown procedente de Reader Gateway
  const sampleMarkdown = `
## [Result 1](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1)
[Example Page 1 Description with sufficient length to qualify as a snippet](https://example.com/page1)

## [Result 2](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage2)
This is an alternate snippet line that is long enough to be captured.
`;
  const mdResults = ddg.parseMarkdownResults(sampleMarkdown);
  assert.equal(mdResults.length, 2);
  assert.equal(mdResults[0].title, 'Result 1');
  assert.equal(mdResults[0].url, 'https://example.com/page1');
  assert.equal(mdResults[1].url, 'https://example.org/page2');

  // Test de parseo de HTML directo
  const sampleHtml = `
    <div class="results">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fhtml-example.com">HTML Title</a>
      <a class="result__snippet">HTML Snippet content</a>
    </div>
  `;
  const htmlResults = ddg.parseHtmlResults(sampleHtml);
  assert.equal(htmlResults.length, 1);
  assert.equal(htmlResults[0].title, 'HTML Title');
  assert.equal(htmlResults[0].url, 'https://html-example.com');
  assert.equal(htmlResults[0].snippet, 'HTML Snippet content');
});

test('SearchProvider - SearXNG JSON parsing', () => {
  const searx = new WebSearch.SearXNGSearchProvider({ baseUrl: 'https://custom-searx.org' });
  assert.equal(searx.id, 'searxng');

  const sampleJson = {
    results: [
      { title: 'SearXNG Title 1', url: 'https://searx-res1.com', content: 'Snippet 1', engine: 'google' },
      { title: 'SearXNG Title 2', url: 'https://searx-res2.com', snippet: 'Snippet 2', engine: 'bing' }
    ]
  };

  const parsed = searx.parseJsonResponse(sampleJson);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'SearXNG Title 1');
  assert.equal(parsed[0].url, 'https://searx-res1.com');
  assert.equal(parsed[0].snippet, 'Snippet 1');
  assert.equal(parsed[0].source, 'SearXNG (google)');
});

test('SearchProvider - Registry y cambio de proveedor sin alterar el cliente', async () => {
  const registry = new WebSearch.SearchProviderRegistry();

  // Crear e inscribir un proveedor mock personalizado
  class MockCustomSearchProvider extends WebSearch.BaseSearchProvider {
    constructor() {
      super({ id: 'mock-custom', label: 'Mock Custom Engine' });
    }
    async search(query, options = {}) {
      return {
        success: true,
        query: query,
        count: 1,
        results: [{ title: 'Custom Mock Result', url: 'https://mock.local/result', snippet: 'Mock content', source: this.label }],
        markdown: this.formatMarkdown(query, [{ title: 'Custom Mock Result', url: 'https://mock.local/result', snippet: 'Mock content', source: this.label }], options.lang),
        elapsedMs: 5
      };
    }
  }

  registry.register(new MockCustomSearchProvider());

  // Probar búsqueda con el proveedor explícito
  const res = await registry.search('inteligencia artificial', { provider: 'mock-custom', lang: 'es' });
  assert.equal(res.success, true);
  assert.equal(res.count, 1);
  assert.equal(res.results[0].url, 'https://mock.local/result');
  assert.ok(res.markdown.includes('Mock Custom Engine'));
});

test('PageFetcher - Validación de URLs y protección anti-SSRF', () => {
  // Protocolos válidos
  assert.equal(WebBrowser.validateUrlForFetch('https://es.wikipedia.org/wiki/Sol').valid, true);
  assert.equal(WebBrowser.validateUrlForFetch('http://example.com/api').valid, true);
  assert.equal(WebBrowser.validateUrlForFetch('example.com/path').valid, true); // Auto antepone https://

  // Protocolos prohibidos
  assert.equal(WebBrowser.validateUrlForFetch('file:///etc/passwd').valid, false);
  assert.equal(WebBrowser.validateUrlForFetch('data:text/html,<h1>Hacked</h1>').valid, false);
  assert.equal(WebBrowser.validateUrlForFetch('javascript:alert(1)').valid, false);
  assert.equal(WebBrowser.validateUrlForFetch('blob:http://example.com/123').valid, false);

  // Endpoints de metadatos cloud (SSRF)
  assert.equal(WebBrowser.validateUrlForFetch('http://169.254.169.254/latest/meta-data/').valid, false);
  assert.equal(WebBrowser.validateUrlForFetch('http://metadata.google.internal/computeMetadata/v1/').valid, false);
  assert.equal(WebBrowser.validateUrlForFetch('http://instance-data/latest/').valid, false);
  assert.equal(WebBrowser.validateUrlForFetch('http://100.100.100.200/latest/meta-data/').valid, false);

  // Evasiones decimales / hexadecimales de IP
  assert.equal(WebBrowser.validateUrlForFetch('http://2852039166/').valid, false); // 169.254.169.254 en decimal
  assert.equal(WebBrowser.validateUrlForFetch('http://2130706433/').valid, false); // 127.0.0.1 en decimal
  assert.equal(WebBrowser.validateUrlForFetch('http://0x7f000001/').valid, false); // 127.0.0.1 en hex
});

test('PageFetcher - Pipeline de estrategias y límite de longitud de contenido', async () => {
  const pipeline = new WebBrowser.PageFetcherPipeline();
  assert.ok(pipeline.strategies.length >= 4);

  // Test de estrategia simulada con contenido superior al límite
  const originalFetch = global.fetch;
  try {
    const hugeString = 'A'.repeat(70000);
    global.fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('r.jina.ai')) {
        return {
          ok: true,
          status: 200,
          text: async () => hugeString
        };
      }
      return { ok: false, status: 500 };
    };

    const res = await pipeline.fetch('https://example.com/large-page');
    assert.equal(res.success, true);
    assert.ok(res.content.length <= 60100, 'El contenido debe truncarse cerca de MAX_CONTENT_LENGTH');
    assert.ok(res.content.includes('[... Contenido truncado por límite de tamaño ...]'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('Web Tools - Esquemas de herramientas válidos para Function Calling', () => {
  assert.equal(WebSearch.SEARCH_TOOL_DEFINITION.function.name, 'search_web');
  assert.ok(WebSearch.SEARCH_TOOL_DEFINITION.function.parameters.required.includes('query'));

  assert.equal(WebBrowser.WEB_TOOL_DEFINITION.function.name, 'fetch_web_page');
  assert.ok(WebBrowser.WEB_TOOL_DEFINITION.function.parameters.required.includes('url'));

  assert.equal(WebBrowser.PDF_TOOL_DEFINITION.function.name, 'download_pdf');
  assert.ok(WebBrowser.PDF_TOOL_DEFINITION.function.parameters.required.includes('url'));
});

