const test = require('node:test');
const assert = require('node:assert/strict');

// Cargar módulos
const WebSearch = require('../../js/web-search.js');
const WebBrowser = require('../../js/web-browser.js');
const ChatMCP = require('../../js/mcp.js');

test('WebSearch - DuckDuckGo HTML: resultados con la URL real, sin repetidos, y errores del proxy', async t => {
  const html = `
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fgasolina&amp;rut=abc">Precio <b>gasolina</b></a>
    <a class="result__snippet" href="#">Hoy el precio medio es <b>1,60 €</b>.</a></div>
    <div class="result"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fgasolina">Repetido</a></div>
    <div class="result"><a class="result__a" href="https://other.example/page">Otra</a><div class="result__snippet">Fragmento</div></div>`;
  assert.deepEqual(WebSearch.parseHtmlResults(html), [
    { title: 'Precio gasolina', url: 'https://example.com/gasolina', snippet: 'Hoy el precio medio es 1,60 €.', source: 'DuckDuckGo' },
    { title: 'Otra', url: 'https://other.example/page', snippet: 'Fragmento', source: 'DuckDuckGo' }
  ]);

  // Sin backend la página de resultados llega por Jina Reader
  const requested = [];
  let reply = () => new Response(html, { status: 200 });
  t.mock.method(global, 'fetch', async url => { requested.push(String(url)); return reply(); });
  const ok = await WebSearch.search('  precio gasolina ');
  assert.deepEqual(requested, ['https://r.jina.ai/https://html.duckduckgo.com/html/?q=precio%20gasolina']);
  assert.equal(ok.success, true);
  assert.equal(ok.count, 2);
  assert.match(ok.markdown, /1\. \*\*\[Precio gasolina\]\(https:\/\/example\.com\/gasolina\)\*\*/);

  // Un bloqueo de Jina llega al modelo con su explicación
  reply = () => Response.json({ code: 403, message: 'Anonymous access to domain blocked' }, { status: 403 });
  const blocked = await WebSearch.search('gasolina');
  assert.equal(blocked.success, false);
  assert.equal(blocked.error, 'Jina Reader answered HTTP 403: Anonymous access to domain blocked');
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
  assert.deepEqual(pipeline.strategies.map(s => s.name), ['LocalDocumentExtractor', 'DirectFetch']);

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

    // Un bloqueo de Jina Reader llega al modelo con su explicación
    global.fetch = async () => Response.json({ message: 'Anonymous access to domain github.com blocked' }, { status: 403 });
    const blocked = await pipeline.fetch('https://github.com/albalday/zerochat');
    assert.equal(blocked.success, false);
    assert.match(blocked.error, /Jina Reader answered HTTP 403: Anonymous access to domain github\.com blocked/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ChatWebBrowser.webFetch - backend si está conectado; sin backend, Jina Reader para leer y fetch directo para descargar', async () => {
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

    // 4. Sin backend, leer va por Jina Reader, que devuelve el HTML de la página
    ChatMCP.manager.isProxyConnected = () => false;
    const sent = [];
    global.fetch = async (url, init) => {
      sent.push({ url: String(url), headers: init.headers });
      return new Response('ok', { status: 200 });
    };
    const read = await WebBrowser.webFetch('https://example.com/test?a=1', { accept: 'application/json' });
    assert.equal(await read.text(), 'ok');

    // 5. Sin backend, descargar es una petición directa con solo Accept: otra cabecera forzaría un preflight CORS
    const download = await WebBrowser.webFetch('https://example.com/file.pdf', { binary: true, accept: 'application/pdf' });
    assert.equal(download.truncated, false);
    assert.deepEqual(sent, [
      { url: 'https://r.jina.ai/https://example.com/test?a=1', headers: { Accept: 'text/html', 'X-Return-Format': 'html' } },
      { url: 'https://example.com/file.pdf', headers: { Accept: 'application/pdf' } }
    ]);
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


test('ChatWebBrowser.webFetch - valida la URL antes de cualquier petición, sea quien sea quien llama', async t => {
  const requested = [];
  t.mock.method(global, 'fetch', async url => { requested.push(String(url)); return new Response('ok', { status: 200 }); });
  t.mock.method(ChatMCP.manager, 'fetchWebResource', async url => { requested.push(`backend:${url}`); return { ok: true, status: 200, text: 'ok' }; });

  for (const connected of [true, false]) {
    t.mock.method(ChatMCP.manager, 'isProxyConnected', () => connected);
    for (const binary of [false, true]) {
      const blocked = await WebBrowser.webFetch('http://169.254.169.254/latest/meta-data/', { binary });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.status, 0);
      assert.match(blocked.error, /SSRF protection/);
      await assert.rejects(blocked.text(), /SSRF protection/);
    }
    assert.match((await WebBrowser.webFetch('file:///etc/passwd')).error, /file:/);
    assert.equal((await WebBrowser.webFetch('')).error, 'No valid URL was given.');
  }
  assert.deepEqual(requested, []);

  // Las herramientas ya no validan por su cuenta: el motivo del rechazo de webFetch llega al modelo
  const page = await WebBrowser.fetchPage('http://127.0.0.1/report.pdf');
  assert.equal(page.success, false);
  assert.match(page.error, /SSRF protection/);
  const image = await WebBrowser.fetchBinaryResource('http://0x7f000001/a.png');
  assert.equal(image.success, false);
  assert.match(image.error, /SSRF protection/);
  assert.deepEqual(requested, []);

  // Una URL sin esquema se pide con https:// y se informa normalizada
  const read = await WebBrowser.fetchPage(' example.com ');
  assert.equal(read.url, 'https://example.com/');
  assert.deepEqual(requested, ['https://r.jina.ai/https://example.com/']);
});
