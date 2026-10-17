const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const WebSearch = require('../../js/web-search.js');
const WebBrowser = require('../../js/web-browser.js');
const ChatMCP = require('../../js/mcp.js');

test('SearchProvider - DuckDuckGo HTML parsing', () => {
  const ddg = new WebSearch.DuckDuckGoSearchProvider();

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
  assert.deepEqual(pipeline.strategies.map(s => s.name), ['LocalDocumentExtractor', 'WikipediaArticle', 'DirectFetch']);

  // Los artículos de Wikipedia se leen con la API REST de contenido, que admite CORS.
  const restUrl = pipeline.strategies[1].constructor.restUrl;
  assert.equal(restUrl('https://es.wikipedia.org/wiki/Sol'), 'https://es.wikipedia.org/api/rest_v1/page/html/Sol');
  assert.equal(restUrl('https://en.m.wikipedia.org/wiki/AC%2FDC'), 'https://en.wikipedia.org/api/rest_v1/page/html/AC%2FDC');
  assert.equal(restUrl('https://es.wikipedia.org/w/index.php?title=Sol'), '');
  assert.equal(restUrl('https://example.com/wiki/Sol'), '');

  // Test de estrategia simulada con contenido superior al límite
  const originalFetch = global.fetch;
  try {
    const hugeString = 'A'.repeat(70000);
    global.fetch = async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => hugeString
      };
    };

    const res = await pipeline.fetch('https://example.com/large-page');
    assert.equal(res.success, true);
    assert.ok(res.content.length <= 60100, 'El contenido debe truncarse cerca de MAX_CONTENT_LENGTH');
    assert.ok(res.content.includes('[... Content truncated at the size limit ...]'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatWebBrowser.webFetch - backend si está conectado y, sin backend, fetch solo con cabeceras CORS-safelisted', async () => {
  const origIsProxyConnected = ChatMCP.manager.isProxyConnected;
  const origFetchWebResource = ChatMCP.manager.fetchWebResource;
  const origFetch = global.fetch;

  try {
    // 1. Con backend, la petición va por él con las opciones de un solo nombre
    ChatMCP.manager.isProxyConnected = () => true;
    let calledUrl = null;
    let calledOptions = null;
    ChatMCP.manager.fetchWebResource = async (url, options) => {
      calledUrl = url;
      calledOptions = options;
      return { ok: true, status: 200, content_type: 'text/html; charset=utf-8', text: '<p>Contenido Backend</p>', byte_size: 24, truncated: true };
    };
    const res = await WebBrowser.webFetch('https://example.com/test', { timeoutMs: 3000, maxBytes: 4096, accept: 'text/html' });
    assert.equal(calledUrl, 'https://example.com/test');
    assert.deepEqual(calledOptions, { accept: 'text/html', timeoutMs: 3000, maxBytes: 4096, binary: false });
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.equal(await res.text(), '<p>Contenido Backend</p>');
    assert.equal(new TextDecoder().decode(await res.arrayBuffer()), '<p>Contenido Backend</p>');

    // 2. El cuerpo en base64 (tipo no textual) se lee como binario y como texto
    ChatMCP.manager.fetchWebResource = async () => ({ ok: true, status: 200, content_type: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') });
    const binary = await WebBrowser.webFetch('https://example.com/pdf/1');
    assert.equal(Buffer.from(await binary.arrayBuffer()).toString(), '%PDF-1.7');
    assert.equal(await binary.text(), '%PDF-1.7');

    // 3. Si el backend falla, no hay fallback al navegador
    ChatMCP.manager.fetchWebResource = async () => ({ ok: false, status: 502, error: 'Bad Gateway' });
    const failRes = await WebBrowser.webFetch('https://example.com/test');
    assert.equal(failRes.ok, false);
    assert.equal(failRes.status, 502);
    assert.equal(failRes.error, 'Bad Gateway');

    // 4. Sin backend, el navegador solo envía Accept: otra cabecera (User-Agent) forzaría un preflight CORS
    ChatMCP.manager.isProxyConnected = () => false;
    let sentHeaders = null;
    global.fetch = async (_url, init) => {
      sentHeaders = init.headers;
      return new Response('ok', { status: 200 });
    };
    const direct = await WebBrowser.webFetch('https://example.com/test', { accept: 'application/json' });
    assert.deepEqual(sentHeaders, { Accept: 'application/json' });
    assert.equal(direct.truncated, false);
    assert.equal(await direct.text(), 'ok');
  } finally {
    ChatMCP.manager.isProxyConnected = origIsProxyConnected;
    ChatMCP.manager.fetchWebResource = origFetchWebResource;
    global.fetch = origFetch;
  }
});

test('SearchProvider - DuckDuckGo prioriza transporte backend y hace fallback si no está conectado', async () => {
  const ddg = new WebSearch.DuckDuckGoSearchProvider();
  const origIsProxyConnected = ChatMCP.manager.isProxyConnected;
  const origFetchWebResource = ChatMCP.manager.fetchWebResource;
  const origFetch = global.fetch;

  try {
    // 1. Backend conectado: se usa el backend sin tocar fetch del navegador
    ChatMCP.manager.isProxyConnected = () => true;
    let backendCalled = false;
    ChatMCP.manager.fetchWebResource = async () => {
      backendCalled = true;
      return {
        ok: true,
        status: 200,
        text: `
          <div class="results">
            <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fbackend-result.com">Backend Result</a>
            <a class="result__snippet">Contenido desde el servidor local</a>
          </div>
        `
      };
    };

    const results = await ddg.fetchResults('test query', { timeoutMs: 3000 });
    assert.equal(backendCalled, true);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Backend Result');
    assert.equal(results[0].url, 'https://backend-result.com');

    // 2. Backend desconectado: fallback a fetch directo
    ChatMCP.manager.isProxyConnected = () => false;
    let browserFetchCalled = false;
    global.fetch = async () => {
      browserFetchCalled = true;
      return {
        ok: true,
        status: 200,
        text: async () => `
          <div class="results">
            <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fbrowser-result.com">Browser Result</a>
            <a class="result__snippet">Contenido directo</a>
          </div>
        `
      };
    };

    const fallbackResults = await ddg.fetchResults('fallback query', { timeoutMs: 3000 });
    assert.equal(browserFetchCalled, true);
    assert.equal(fallbackResults.length, 1);
    assert.equal(fallbackResults[0].title, 'Browser Result');
    assert.equal(fallbackResults[0].url, 'https://browser-result.com');
  } finally {
    ChatMCP.manager.isProxyConnected = origIsProxyConnected;
    ChatMCP.manager.fetchWebResource = origFetchWebResource;
    global.fetch = origFetch;
  }
});

test('BinaryFetcher - transporte binario vía backend con límites en el borde (N y N+1)', async () => {
  const origIsProxyConnected = ChatMCP.manager.isProxyConnected;
  const origFetchWebResource = ChatMCP.manager.fetchWebResource;

  try {
    ChatMCP.manager.isProxyConnected = () => true;

    // Caso 1: N bytes exactos sin truncar: se pide al backend exactamente el límite
    const maxBytes = 100;
    const exactBytes = Buffer.alloc(maxBytes, 'A');
    let requestedMaxBytes = null;
    ChatMCP.manager.fetchWebResource = async (_url, options) => {
      requestedMaxBytes = options.maxBytes;
      return { ok: true, status: 200, content_type: 'application/pdf', base64: exactBytes.toString('base64'), truncated: false };
    };

    const resExact = await WebBrowser.fetchBinaryResource('https://example.com/test.pdf', { maxBytes, resourceKind: 'document' });
    assert.equal(requestedMaxBytes, maxBytes);
    assert.equal(resExact.success, true);
    assert.equal(resExact.byteSize, maxBytes);

    // Caso 2: N+1 bytes en origen: el backend corta en N y marca truncated
    ChatMCP.manager.fetchWebResource = async () => ({
      ok: true,
      status: 200,
      content_type: 'application/pdf',
      base64: exactBytes.toString('base64'),
      truncated: true
    });

    const resOver = await WebBrowser.fetchBinaryResource('https://example.com/test.pdf', { maxBytes, resourceKind: 'document' });
    assert.equal(resOver.success, false);
    assert.ok(resOver.error.includes('exceeds the size limit'));

    // Caso 3: Recurso vacío (0 bytes)
    ChatMCP.manager.fetchWebResource = async () => ({
      ok: true,
      status: 200,
      content_type: 'application/pdf',
      base64: ''
    });

    const resEmpty = await WebBrowser.fetchBinaryResource('https://example.com/test.pdf', { maxBytes, resourceKind: 'document' });
    assert.equal(resEmpty.success, false);
    assert.ok(resEmpty.error.includes('is empty (0 bytes)'));
  } finally {
    ChatMCP.manager.isProxyConnected = origIsProxyConnected;
    ChatMCP.manager.fetchWebResource = origFetchWebResource;
  }
});

test('ImageFetcher - detectVisionImageMimeType reconoce formatos de visión raster y rechaza SVG y otros', () => {
  // Por Content-Type
  assert.equal(WebBrowser.detectVisionImageMimeType('', 'image/png'), 'image/png');
  assert.equal(WebBrowser.detectVisionImageMimeType('', 'image/jpeg'), 'image/jpeg');
  assert.equal(WebBrowser.detectVisionImageMimeType('', 'image/jpg'), 'image/jpeg');
  assert.equal(WebBrowser.detectVisionImageMimeType('', 'image/webp'), 'image/webp');
  assert.equal(WebBrowser.detectVisionImageMimeType('', 'image/gif'), 'image/gif');
  assert.equal(WebBrowser.detectVisionImageMimeType('', 'image/png; charset=utf-8'), 'image/png');

  // Por extensión en nombre o URL
  assert.equal(WebBrowser.detectVisionImageMimeType('chart.png', 'application/octet-stream'), 'image/png');
  assert.equal(WebBrowser.detectVisionImageMimeType('photo.jpg', ''), 'image/jpeg');
  assert.equal(WebBrowser.detectVisionImageMimeType('photo.jpeg', ''), 'image/jpeg');
  assert.equal(WebBrowser.detectVisionImageMimeType('image.webp?w=400&h=300', ''), 'image/webp');
  assert.equal(WebBrowser.detectVisionImageMimeType('animation.gif', ''), 'image/gif');

  // Rechazo de SVG, PDF, HTML y tipos no soportados
  assert.equal(WebBrowser.detectVisionImageMimeType('vector.svg', 'image/svg+xml'), '');
  assert.equal(WebBrowser.detectVisionImageMimeType('vector.svg', ''), '');
  assert.equal(WebBrowser.detectVisionImageMimeType('doc.pdf', 'application/pdf'), '');
  assert.equal(WebBrowser.detectVisionImageMimeType('page.html', 'text/html'), '');
  assert.equal(WebBrowser.detectVisionImageMimeType('bitmap.bmp', 'image/bmp'), '');
  assert.equal(WebBrowser.detectVisionImageMimeType('', ''), '');
});

test('ImageFetcher - validación de URLs y protección anti-SSRF en fetchImage', async () => {
  // URLs inválidas o protocolos no permitidos
  const r1 = await WebBrowser.fetchImage('file:///etc/shadow');
  assert.equal(r1.success, false);
  assert.ok(r1.error.includes('Protocolo no permitido'));

  const r2 = await WebBrowser.fetchImage('javascript:alert(1)');
  assert.equal(r2.success, false);

  // SSRF a metadatos cloud y loopback
  const r3 = await WebBrowser.fetchImage('http://169.254.169.254/latest/meta-data/');
  assert.equal(r3.success, false);
  assert.ok(r3.error.includes('Acceso bloqueado') || r3.error.includes('SSRF'));

  const r4 = await WebBrowser.fetchImage('http://127.0.0.1/private.png');
  assert.equal(r4.success, false);
  assert.ok(r4.error.includes('Acceso bloqueado') || r4.error.includes('SSRF'));
});

test('ImageFetcher - límites de tamaño exactos en el borde (N y N+1) y rechazo de vacíos', async () => {
  const originalFetch = global.fetch;
  const boundaryLimit = 100; // N = 100 bytes

  try {
    // Caso 1: Borde exacto N (100 bytes) -> ACEPTADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array(boundaryLimit).buffer
    });

    const resN = await WebBrowser.fetchImage('https://example.com/border.png', { maxBytes: boundaryLimit });
    assert.equal(resN.success, true);
    assert.equal(resN.byteSize, boundaryLimit);
    assert.equal(resN.mimeType, 'image/png');
    assert.ok(resN.dataUrl.startsWith('data:image/png;base64,'));

    // Caso 2: Borde exacto N + 1 (101 bytes) -> RECHAZADO por sobrepasar límite
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array(boundaryLimit + 1).buffer
    });

    const resNPlus1 = await WebBrowser.fetchImage('https://example.com/oversize.png', { maxBytes: boundaryLimit });
    assert.equal(resNPlus1.success, false);
    assert.ok(resNPlus1.error.includes('Image exceeds the size limit'));

    // Caso 3: Imagen vacía (0 bytes) -> RECHAZADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => new Uint8Array(0).buffer
    });

    const resEmpty = await WebBrowser.fetchImage('https://example.com/empty.png', { maxBytes: boundaryLimit });
    assert.equal(resEmpty.success, false);
    assert.ok(resEmpty.error.includes('empty (0 bytes)'));

    // Caso 4: Cabecera Content-Length sobrepasa el límite N antes de descargar el buffer -> RECHAZADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': String(boundaryLimit + 50) }),
      arrayBuffer: async () => { throw new Error('No debe descargar el buffer si la cabecera ya excede'); }
    });

    const resHeaderOversize = await WebBrowser.fetchImage('https://example.com/header-huge.png', { maxBytes: boundaryLimit });
    assert.equal(resHeaderOversize.success, false);
    assert.ok(resHeaderOversize.error.includes('Image exceeds the size limit'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('ImageFetcher - validación de tipos MIME y conversión base64 dataUrl', async () => {
  const originalFetch = global.fetch;

  try {
    const sampleBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header bytes
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => sampleBytes.buffer
    });

    const res = await WebBrowser.fetchImage('https://example.com/sample.png');
    assert.equal(res.success, true);
    assert.equal(res.mimeType, 'image/png');
    assert.equal(res.byteSize, sampleBytes.byteLength);
    assert.ok(res.dataUrl.startsWith('data:image/png;base64,'));
    assert.ok(res.dataUrl.includes('iVBORw0KGgo=')); // Base64 del magic PNG

    // Rechazo de formato no admitido (SVG)
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/svg+xml' }),
      arrayBuffer: async () => new TextEncoder().encode('<svg></svg>').buffer
    });

    const resSvg = await WebBrowser.fetchImage('https://example.com/vector.svg');
    assert.equal(resSvg.success, false);
    assert.ok(resSvg.error.includes('Unsupported image format'));

    // Error HTTP 404
    global.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers()
    });

    const res404 = await WebBrowser.fetchImage('https://example.com/not-found.png');
    assert.equal(res404.success, false);
    assert.equal(res404.status, 404);
    assert.ok(res404.error.includes('HTTP 404'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('BinaryFetcher - validación de URLs y protección anti-SSRF en fetchBinaryResource', async () => {
  const r1 = await WebBrowser.fetchBinaryResource('file:///etc/shadow');
  assert.equal(r1.success, false);
  assert.ok(r1.error.includes('Protocolo no permitido'));

  const r2 = await WebBrowser.fetchBinaryResource('javascript:alert(1)');
  assert.equal(r2.success, false);

  const r3 = await WebBrowser.fetchBinaryResource('http://169.254.169.254/latest/meta-data/');
  assert.equal(r3.success, false);
  assert.ok(r3.error.includes('Acceso bloqueado') || r3.error.includes('SSRF'));

  const r4 = await WebBrowser.fetchBinaryResource('http://127.0.0.1/private.bin');
  assert.equal(r4.success, false);
  assert.ok(r4.error.includes('Acceso bloqueado') || r4.error.includes('SSRF'));
});

test('BinaryFetcher - límites de tamaño exactos en el borde (N y N+1), Content-Length y vacíos', async () => {
  const originalFetch = global.fetch;
  const boundaryLimit = 128; // N = 128 bytes

  try {
    // Caso 1: Borde exacto N (128 bytes) -> ACEPTADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      arrayBuffer: async () => new Uint8Array(boundaryLimit).buffer
    });

    const resN = await WebBrowser.fetchBinaryResource('https://example.com/doc.pdf', { maxBytes: boundaryLimit });
    assert.equal(resN.success, true);
    assert.equal(resN.byteSize, boundaryLimit);
    assert.equal(resN.status, 200);
    assert.equal(resN.contentType, 'application/pdf');
    assert.equal(resN.fileName, 'doc.pdf');
    assert.ok(resN.arrayBuffer instanceof ArrayBuffer);

    // Caso 2: Borde exacto N + 1 (129 bytes) -> RECHAZADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      arrayBuffer: async () => new Uint8Array(boundaryLimit + 1).buffer
    });

    const resNPlus1 = await WebBrowser.fetchBinaryResource('https://example.com/huge.pdf', { maxBytes: boundaryLimit });
    assert.equal(resNPlus1.success, false);
    assert.ok(resNPlus1.error.includes('exceeds the size limit'));

    // Caso 3: Recurso vacío (0 bytes) -> RECHAZADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf' }),
      arrayBuffer: async () => new Uint8Array(0).buffer
    });

    const resEmpty = await WebBrowser.fetchBinaryResource('https://example.com/empty.pdf', { maxBytes: boundaryLimit });
    assert.equal(resEmpty.success, false);
    assert.ok(resEmpty.error.includes('empty (0 bytes)'));

    // Caso 4: Content-Length sobrepasa el límite N antes de descargar el buffer -> RECHAZADO
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/pdf', 'content-length': String(boundaryLimit + 200) }),
      arrayBuffer: async () => { throw new Error('No debe descargar buffer si Content-Length excede'); }
    });

    const resHeaderOversize = await WebBrowser.fetchBinaryResource('https://example.com/oversized-header.pdf', { maxBytes: boundaryLimit });
    assert.equal(resHeaderOversize.success, false);
    assert.ok(resHeaderOversize.error.includes('exceeds the size limit'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('BinaryFetcher - terminación inmediata ante error de red o bloqueo CORS y ante timeout', async () => {
  const originalFetch = global.fetch;

  try {
    // Caso 1: Error de red / CORS directo -> termina de inmediato (<100ms)
    global.fetch = async () => {
      throw new TypeError('NetworkError when attempting to fetch resource');
    };

    const t0 = Date.now();
    const resCors = await WebBrowser.fetchBinaryResource('https://blocked.example.com/image.jpg');
    const elapsed = Date.now() - t0;

    assert.equal(resCors.success, false);
    assert.ok(resCors.error.includes('could not be downloaded') || resCors.error.includes('CORS'));
    assert.ok(elapsed < 1000, `Debe terminar de inmediato ante error de red o CORS, tardó ${elapsed}ms`);

    // Caso 2: Timeout por AbortError
    global.fetch = async () => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    };

    const resTimeout = await WebBrowser.fetchBinaryResource('https://slow.example.com/file.bin', { timeoutMs: 3000 });
    assert.equal(resTimeout.success, false);
    assert.ok(resTimeout.error.includes('timed out after 3000ms'));

    // Caso 3: Error HTTP 404 y 500 terminan de inmediato
    global.fetch = async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers()
    });

    const res404 = await WebBrowser.fetchBinaryResource('https://example.com/missing.bin');
    assert.equal(res404.success, false);
    assert.equal(res404.status, 404);
    assert.ok(res404.error.includes('HTTP 404'));
  } finally {
    global.fetch = originalFetch;
  }
});

