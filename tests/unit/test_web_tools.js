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

test('fetchPage - límite de longitud de contenido y error de Jina Reader', async t => {
  const fetchMock = t.mock.method(global, 'fetch', async () => new Response('A'.repeat(70000), { status: 200, headers: { 'content-type': 'text/html' } }));
  const res = await WebBrowser.fetchPage('https://example.com/large-page');
  assert.equal(res.success, true);
  assert.ok(res.content.length <= 60100, 'El contenido debe truncarse cerca de MAX_CONTENT_LENGTH');
  assert.ok(res.content.includes('[... Content truncated at the size limit ...]'));

  // Un bloqueo de Jina Reader llega al modelo con su explicación
  fetchMock.mock.mockImplementation(async () => Response.json({ message: 'Anonymous access to domain github.com blocked' }, { status: 403 }));
  const blocked = await WebBrowser.fetchPage('https://github.com/albalday/zerochat');
  assert.equal(blocked.success, false);
  assert.match(blocked.error, /Jina Reader answered HTTP 403: Anonymous access to domain github\.com blocked/);
});

test('ChatWebBrowser.webFetch - backend si está conectado; sin backend, Jina Reader para leer y fetch directo para descargar', async t => {
  // 1. Con backend, la petición va por él con las opciones de un solo nombre
  const connected = t.mock.method(ChatMCP.manager, 'isProxyConnected', () => true);
  const backend = t.mock.method(ChatMCP.manager, 'fetchWebResource', async () => (
    { ok: true, status: 200, content_type: 'text/html; charset=utf-8', text: '<p>Contenido Backend</p>', byte_size: 24, truncated: true }
  ));
  const res = await WebBrowser.webFetch('https://example.com/test', { timeoutMs: 3000, maxBytes: 4096, accept: 'text/html' });
  assert.deepEqual(backend.mock.calls[0].arguments, ['https://example.com/test', { accept: 'text/html', timeoutMs: 3000, maxBytes: 4096, binary: false }]);
  assert.equal(res.ok, true);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.byteSize, 24);
  assert.equal(res.truncated, true);
  assert.equal(await res.text(), '<p>Contenido Backend</p>');
  assert.equal(new TextDecoder().decode(await res.arrayBuffer()), '<p>Contenido Backend</p>');

  // 2. El cuerpo en base64 (tipo no textual) se lee como binario y como texto
  backend.mock.mockImplementation(async () => ({ ok: true, status: 200, content_type: 'application/pdf', base64: Buffer.from('%PDF-1.7').toString('base64') }));
  const binary = await WebBrowser.webFetch('https://example.com/pdf/1');
  assert.equal(Buffer.from(await binary.arrayBuffer()).toString(), '%PDF-1.7');
  assert.equal(await binary.text(), '%PDF-1.7');

  // 3. Si el backend falla, no hay fallback al navegador
  backend.mock.mockImplementation(async () => ({ ok: false, status: 502, error: 'Bad Gateway' }));
  const failRes = await WebBrowser.webFetch('https://example.com/test');
  assert.deepEqual([failRes.ok, failRes.status, failRes.error], [false, 502, 'Bad Gateway']);

  // 4. Sin backend, leer va por Jina Reader, que devuelve el HTML de la página
  connected.mock.mockImplementation(() => false);
  const sent = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    sent.push({ url: String(url), headers: init.headers });
    return new Response('ok', { status: 200 });
  });
  const read = await WebBrowser.webFetch('https://example.com/test?a=1', { accept: 'application/json' });
  assert.equal(await read.text(), 'ok');

  // 5. Sin backend, descargar es una petición directa con solo Accept: otra cabecera forzaría un preflight CORS
  const download = await WebBrowser.webFetch('https://example.com/file.pdf', { binary: true, accept: 'application/pdf' });
  assert.equal(download.truncated, false);
  assert.deepEqual(sent, [
    { url: 'https://r.jina.ai/https://example.com/test?a=1', headers: { Accept: 'text/html', 'X-Return-Format': 'html' } },
    { url: 'https://example.com/file.pdf', headers: { Accept: 'application/pdf' } }
  ]);
});

test('fetchBinaryResource - límites en el borde (N y N+1), Content-Length, vacíos, plazo y errores, por el backend y directo', async t => {
  const N = 128;
  const bytes = length => new Uint8Array(length);
  // Por el backend: se le pide el límite exacto y corta en N marcando truncated.
  const viaBackend = reply => {
    t.mock.method(ChatMCP.manager, 'isProxyConnected', () => true);
    t.mock.method(ChatMCP.manager, 'fetchWebResource', async (_url, options) => {
      assert.equal(options.maxBytes, N);
      return { ok: true, status: 200, content_type: 'application/pdf', ...reply };
    });
  };
  // Directo (sin backend): el navegador entrega el cuerpo entero y se mide después.
  const direct = reply => {
    t.mock.method(ChatMCP.manager, 'isProxyConnected', () => false);
    t.mock.method(global, 'fetch', reply);
  };
  const ok = (length, headers = {}) => async () => new Response(bytes(length), { status: 200, headers: { 'content-type': 'image/png', ...headers } });
  const rows = [
    ['backend N', () => viaBackend({ base64: Buffer.from(bytes(N)).toString('base64') }), { success: true, byteSize: N }],
    ['backend N+1 truncado', () => viaBackend({ base64: Buffer.from(bytes(N)).toString('base64'), truncated: true }), /Image exceeds the size limit of 128 B\./],
    ['backend vacío', () => viaBackend({ base64: '' }), /The image is empty \(0 bytes\)/],
    ['directo N', () => direct(ok(N)), { success: true, byteSize: N }],
    ['directo N+1', () => direct(ok(N + 1)), /Image exceeds the size limit of 128 B\./],
    ['directo Content-Length', () => direct(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(N + 1) }), arrayBuffer: async () => assert.fail('No debe leer el cuerpo') })), /reported/],
    ['directo vacío', () => direct(ok(0)), /The image is empty \(0 bytes\)/],
    ['directo HTTP 404', () => direct(async () => new Response('', { status: 404, statusText: 'Not Found' })), /HTTP 404/],
    ['directo plazo', () => direct(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }), /timed out after 3000ms/],
    ['directo CORS', () => direct(async () => { throw new TypeError('NetworkError'); }), /could not be downloaded \(NetworkError\)\. Without the local ZeroChat server, only sites that allow CORS can be downloaded\./]
  ];
  for (const [name, arrange, expected] of rows) {
    arrange();
    const result = await WebBrowser.fetchBinaryResource('https://example.com/a.png', { maxBytes: N, timeoutMs: 3000, resourceKind: 'image' });
    if (expected instanceof RegExp) {
      assert.equal(result.success, false, name);
      assert.match(result.error, expected, name);
    } else {
      assert.deepEqual({ success: result.success, byteSize: result.byteSize }, expected, name);
      assert.ok(result.arrayBuffer instanceof ArrayBuffer, name);
    }
    t.mock.restoreAll();
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

test('ImageFetcher - validación de tipos MIME y conversión base64 dataUrl', async t => {
  const sampleBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header bytes
  const fetchMock = t.mock.method(global, 'fetch', async () => new Response(sampleBytes, { status: 200, headers: { 'content-type': 'image/png' } }));
  const res = await WebBrowser.fetchImage('https://example.com/sample.png');
  assert.equal(res.success, true);
  assert.equal(res.mimeType, 'image/png');
  assert.equal(res.byteSize, sampleBytes.byteLength);
  assert.equal(res.dataUrl, 'data:image/png;base64,iVBORw0KGgo=');

  // Rechazo de formato no admitido (SVG)
  fetchMock.mock.mockImplementation(async () => new Response('<svg></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
  const resSvg = await WebBrowser.fetchImage('https://example.com/vector.svg');
  assert.equal(resSvg.success, false);
  assert.ok(resSvg.error.includes('Unsupported image format'));
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
