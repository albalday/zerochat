const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

// Tarjetas de herramientas, contenido Markdown interactivo, gráficos, chips de adjuntos y
// utilidades de DOM en el navegador real. Las pestañas nuevas se registran sustituyendo
// window.open, y los Blob que se abren, envolviendo URL.createObjectURL.


describe('Browser UI - tarjetas y contenido interactivo', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - render_chart dibuja el gráfico en la tarjeta en vivo y en el historial con el título escapado', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(async () => {
        const cards = window.ChatToolCards;
        const tool = window.ChatAgentCore.registry.getTool('render_chart');
        const args = { type: 'bar', title: '<img src=x onerror=alert(1)>', labels: ['Enero'], datasets: [{ label: '2026', data: [10] }] };
        const outcome = await tool.execute(args, {});
        const card = cards.createLiveToolCard('render_chart', args);
        cards.updateLiveToolCard(card, 'render_chart', args, outcome, 2);
        const history = cards.renderHistoricalToolCard({ function: { name: 'render_chart', arguments: JSON.stringify(args) } }, { content: tool.toModel(args, outcome) });
        return {
          svg: Boolean(card.querySelector('.chat-chart-card svg')),
          img: Boolean(card.querySelector('img')),
          collapsed: card.querySelector('.chat-chart-card').classList.contains('collapsed'),
          historySvg: Boolean(history.querySelector('.chat-chart-card svg'))
        };
      });
      assert.deepEqual(result, { svg: true, img: false, collapsed: false, historySvg: true });
    });
  });

  test('Browser UI - los argumentos del modelo no crean nodos ni atributos al pintar un gráfico', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const payload = '"/><img src=x onerror="window.__chartXss=1">';
        const render = spec => {
          const host = document.createElement('div');
          host.innerHTML = window.ChatCharts.renderChartCard(spec);
          return host;
        };
        const byType = {};
        for (const type of ['bar', 'line', 'pie']) {
          const host = render({ type, title: payload, labels: [payload, 'B'], datasets: [{ label: payload, data: [payload, 2], color: payload }, { label: 'ok', data: [1, 2], color: 'rgb(10, 20, 30)' }] });
          byType[type] = {
            img: Boolean(host.querySelector('img')),
            handlers: [...host.querySelectorAll('*')].flatMap(element => [...element.attributes].filter(attribute => attribute.name.startsWith('on')).map(attribute => attribute.name)),
            text: host.textContent.includes('onerror')
          };
        }
        const colors = render({ type: 'bar', labels: ['A'], datasets: [{ label: 'a', data: [1], color: '#ff0000' }, { label: 'b', data: [2], color: payload }] });
        const fills = [...colors.querySelectorAll('rect[fill]')].map(rect => rect.getAttribute('fill'));
        return { byType, validColor: fills.includes('#ff0000'), unsafeColor: fills.some(fill => fill.includes('<') || fill.includes('"')), xss: Boolean(window.__chartXss) };
      });
      for (const type of ['bar', 'line', 'pie']) assert.deepEqual(result.byType[type], { img: false, handlers: [], text: true }, type);
      assert.equal(result.validColor, true, 'Un color válido se respeta');
      assert.equal(result.unsafeColor, false);
      assert.equal(result.xss, false);
    });
  });

  test('Browser UI - las tarjetas de conocimiento, imágenes y búsqueda web muestran los datos externos como texto', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const cards = window.ChatToolCards;
        const out = {};
        const args = { query: '<b>margen</b>' };
        const search = cards.createLiveToolCard('search_knowledge_base', args);
        out.queryTitle = search.querySelector('.tool-card-title').textContent;
        cards.updateLiveToolCard(search, 'search_knowledge_base', args, { success: true, matchesCount: 2, appliedScope: 'corpus', text: 'Fragmento <script>' }, 7);
        out.searchBadge = search.querySelector('.tool-card-badge').textContent;
        out.searchText = search.querySelector('.tool-result-pre').textContent;
        out.searchScript = Boolean(search.querySelector('script'));

        // El historial guarda lo que recibió el modelo: aquí, el texto sin JSON.
        const list = cards.renderHistoricalToolCard({ function: { name: 'list_documents', arguments: '{}' } }, { content: 'Catálogo: informe.pdf' });
        out.listText = list.querySelector('.tool-result-pre').textContent;
        out.listCollapsed = list.querySelector('.tool-execution-card').classList.contains('collapsed');
        const failed = cards.renderHistoricalToolCard({ function: { name: 'read_knowledge_chunk', arguments: '{"chunkId":"x"}' } }, { content: JSON.stringify({ success: false, error: 'Chunk not found' }) });
        out.failedBadge = [failed.querySelector('.tool-card-badge').className, failed.querySelector('.tool-card-badge').textContent];

        const imageArgs = { imageRef: 'rag-image://doc<img src=x onerror=alert(1)>:img1' };
        const image = cards.createLiveToolCard('read_knowledge_image', imageArgs);
        out.imageImg = Boolean(image.querySelector('img'));
        cards.updateLiveToolCard(image, 'read_knowledge_image', imageArgs, { success: true, documentTitle: '<script>alert("xss")</script>' }, 0);
        out.imageTitle = image.querySelector('.rag-image-result').textContent;
        out.imageScript = Boolean(image.querySelector('script'));

        const web = cards.createLiveToolCard('search_web', { query: '<script>alert(1)</script>' });
        out.webQuery = web.querySelector('.query-badge strong').textContent;
        cards.updateLiveToolCard(web, 'search_web', {}, { success: true, results: [{ title: '<i>t</i>', url: 'javascript:alert(1)', snippet: 's' }] }, 1);
        const link = web.querySelector('.search-result-item a');
        out.webLink = [link.textContent.trim(), link.getAttribute('href')];
        return out;
      });
      assert.match(result.queryTitle, /<b>margen<\/b>/, 'La consulta se muestra como texto');
      assert.match(result.searchBadge, /2 coincidencias · corpus \(7ms\)/);
      assert.equal(result.searchText, 'Fragmento <script>');
      assert.equal(result.searchScript, false);
      assert.equal(result.listText, 'Catálogo: informe.pdf');
      assert.equal(result.listCollapsed, true);
      assert.equal(result.failedBadge[0], 'tool-card-badge status-error');
      assert.match(result.failedBadge[1], /Chunk not found/);
      assert.equal(result.imageImg, false);
      assert.equal(result.imageTitle, '<script>alert("xss")</script>');
      assert.equal(result.imageScript, false);
      assert.equal(result.webQuery, '<script>alert(1)</script>');
      assert.equal(result.webLink[0], '<i>t</i>');
      assert.doesNotMatch(result.webLink[1], /^javascript:/);
    });
  });

  test('Browser UI - la tarjeta de ask_user escapa la pregunta y las opciones, las pinta desactivadas y muestra el error', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const cards = window.ChatToolCards;
        const card = cards.createLiveToolCard('ask_user', {
          question: '<img src=x onerror=alert(1)>?',
          options: [{ label: '"><script>bad()</script>', description: '<b>x</b>' }, { label: 'Normal' }]
        });
        const options = [...card.querySelectorAll('.ask-user-option')];
        const invalidArgs = { question: '¿?', options: [] };
        const invalid = cards.createLiveToolCard('ask_user', invalidArgs);
        cards.updateLiveToolCard(invalid, 'ask_user', invalidArgs, { success: false, error: 'options must contain 2 to 4' }, 0);
        return {
          injected: Boolean(card.querySelector('img, script, b')),
          firstOption: options[0].dataset.askOption,
          allDisabled: options.every(option => option.disabled),
          error: invalid.querySelector('.ask-user-error').textContent
        };
      });
      assert.equal(result.injected, false);
      assert.equal(result.firstOption, '"><script>bad()</script>');
      assert.equal(result.allDisabled, true, 'Las opciones se pintan desactivadas hasta que la aplicación las habilita');
      assert.match(result.error, /options must contain 2 to 4/);
    });
  });

  test('Browser UI - la tarjeta de delegate_task escapa el encargo y el historial restaura el informe o el error', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const cards = window.ChatToolCards;
        const tool = window.ChatAgentCore.registry.getTool('delegate_task');
        const args = { task: '<img src=x onerror=alert(1)>' };
        const card = cards.createLiveToolCard('delegate_task', args);
        const delegateCall = { function: { name: 'delegate_task', arguments: JSON.stringify(args) } };
        const report = cards.renderHistoricalToolCard(delegateCall, { content: tool.toModel(args, { success: true, report: '**Informe**' }) });
        const failed = cards.renderHistoricalToolCard(delegateCall, { content: tool.toModel(args, { success: false, error: 'boom' }) });
        return {
          img: Boolean(card.querySelector('img')),
          task: card.querySelector('.subagent-task').textContent,
          steps: Boolean(card.querySelector('.subagent-steps')),
          report: report.querySelector('.subagent-report strong')?.textContent,
          error: failed.querySelector('.subagent-error')?.textContent
        };
      });
      assert.deepEqual(result, { img: false, task: '<img src=x onerror=alert(1)>', steps: true, report: 'Informe', error: 'boom' });
    });
  });

  test('Browser UI - la tarjeta de browser_action solo muestra capturas Base64 válidas de imagen', async () => {
    await withTestApp(async page => {
      const shots = await page.evaluate(async () => {
        const { McpToolProvider } = window.ChatMCP;
        const registry = window.ChatAgentCore.registry;
        const provider = new McpToolProvider({ id: 'mcp_proxy', name: 'ZeroChat', initialize: async () => ({ success: true }), listTools: async () => [{ name: 'browser_action' }] }, { id: 'mcp_prov_screenshot_test' });
        await provider.discoverTools();
        registry.registerProvider(provider);
        const screenshot = result => {
          const card = window.ChatToolCards.createLiveToolCard('browser_action', {});
          window.ChatToolCards.updateLiveToolCard(card, 'browser_action', {}, { success: true, content: 'ok', ...result }, 1);
          return card.querySelector('.mcp-screenshot-image')?.getAttribute('src') || null;
        };
        const out = [
          screenshot({ mime_type: 'image/png', image_base64: 'aGVsbG8=' }),
          screenshot({ mime_type: 'text/html', image_base64: 'aGVsbG8=' }),
          screenshot({ mime_type: 'image/png', image_base64: '<svg>' })
        ];
        registry.unregisterProvider('mcp_prov_screenshot_test');
        return out;
      });
      assert.deepEqual(shots, ['data:image/png;base64,aGVsbG8=', null, null]);
    });
  });

  test('Browser UI - abrir imágenes y documentos usa un visor Blob en una sola pestaña con noopener', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(async () => {
        const opened = [];
        const blobs = new Map();
        window.open = (url, target, features) => { opened.push({ url, target, features }); return null; };
        const createObjectURL = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => {
          const url = createObjectURL(blob);
          blobs.set(url, blob);
          return url;
        };
        const utils = window.ChatUtils;
        for (const unsafe of ['javascript:alert(1)', '', 'rag-image://doc:img']) utils.openImageInNewTab(unsafe);
        const rejected = opened.length;
        utils.openImageInNewTab('https://example.com/foto.jpg', 'Foto de prueba');
        utils.openImageInNewTab('blob:https://example.com/uuid');
        utils.openImageInNewTab('data:image/png;base64,iVBORw0KGgo=');
        const images = opened.splice(0);

        const emptyDocument = utils.openDocumentInNewTab('');
        const documentOpened = utils.openDocumentInNewTab('<h1>Folleto</h1>', 'text/html;charset=utf-8');
        const [doc] = opened;
        const blob = blobs.get(doc.url);
        return {
          rejected,
          images: images.map(({ url, target, features }) => [url.startsWith('blob:'), target, features]),
          emptyDocument,
          documentOpened,
          document: [doc.url.startsWith('blob:'), doc.target, doc.features, blob.type, await blob.text()]
        };
      });
      assert.equal(result.rejected, 0, 'Las URL no seguras no abren nada');
      assert.deepEqual(result.images, Array(3).fill([true, '_blank', 'noopener,noreferrer']), 'Cada imagen abre una sola pestaña aunque window.open devuelva null');
      assert.equal(result.emptyDocument, false, 'Contenido vacío no abre nada');
      assert.equal(result.documentOpened, true);
      assert.deepEqual(result.document, [true, '_blank', 'noopener,noreferrer', 'text/html;charset=utf-8', '<h1>Folleto</h1>']);
    });
  });

  test('Browser UI - write_file y edit_file muestran el botón de Diff y delegan la apertura en el backend', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(async () => {
        const registry = window.ChatAgentCore.registry;
        const fakeClient = {
          id: 'mcp_proxy',
          name: 'ZeroChat',
          initialize: async () => ({ success: true }),
          listTools: async () => [
            { name: 'write_file', description: 'Write file' },
            { name: 'edit_file', description: 'Edit file' },
            { name: 'read_file', description: 'Read file' }
          ],
          callTool: async () => ({ success: true, text: 'ok' })
        };
        const provider = new window.ChatMCP.McpToolProvider(fakeClient, { id: 'mcp_prov_diff_test' });
        await provider.discoverTools();
        registry.registerProvider(provider);

        const mcpManager = window.ChatMCP.manager;
        const diffCalls = [];
        const confirmCalls = [];
        const origOpenDiff = mcpManager.openFileDiff;
        const origIsProxy = mcpManager.isProxyConnected;
        const origConfirm = window.ChatDialogs.confirm;

        mcpManager.isProxyConnected = () => true;
        window.ChatDialogs.confirm = async (msg) => {
          confirmCalls.push(msg);
          return true;
        };
        mcpManager.openFileDiff = async (path, options) => {
          diffCalls.push({ path, options });
          if (options?.commitFallback) {
            return { success: true, has_diff: true, mode: 'commit' };
          }
          return { success: true, has_diff: false, has_commit_history: true };
        };

        const cards = window.ChatToolCards;
        const writeArgs = { path: '/home/user/project/file.js', content: 'console.log(1);' };
        const writeCard = cards.createLiveToolCard('write_file', writeArgs);
        cards.updateLiveToolCard(writeCard, 'write_file', writeArgs, { success: true }, 5);

        const editArgs = { path: '/home/user/project/file.js', old_str: '1', new_str: '2' };
        const editCard = cards.createLiveToolCard('edit_file', editArgs);
        cards.updateLiveToolCard(editCard, 'edit_file', editArgs, { success: true }, 5);

        const readArgs = { path: '/home/user/project/file.js' };
        const readCard = cards.createLiveToolCard('read_file', readArgs);
        cards.updateLiveToolCard(readCard, 'read_file', readArgs, { success: true }, 5);

        const writeDiffBtn = writeCard.querySelector('.btn-file-diff');
        const editDiffBtn = editCard.querySelector('.btn-file-diff');
        const readDiffBtn = readCard.querySelector('.btn-file-diff');

        writeDiffBtn?.click();
        await new Promise(resolve => setTimeout(resolve, 10));

        mcpManager.openFileDiff = origOpenDiff;
        mcpManager.isProxyConnected = origIsProxy;
        window.ChatDialogs.confirm = origConfirm;
        registry.unregisterProvider('mcp_prov_diff_test');

        return {
          hasWriteDiff: Boolean(writeDiffBtn),
          hasEditDiff: Boolean(editDiffBtn),
          hasReadDiff: Boolean(readDiffBtn),
          confirmCallsCount: confirmCalls.length,
          diffCalls
        };
      });
      assert.deepEqual(result, {
        hasWriteDiff: true,
        hasEditDiff: true,
        hasReadDiff: false,
        confirmCallsCount: 1,
        diffCalls: [
          { path: '/home/user/project/file.js', options: undefined },
          { path: '/home/user/project/file.js', options: { commitFallback: true } }
        ]
      });
    });
  });
});
