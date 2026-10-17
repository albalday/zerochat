const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

// Tarjetas de herramientas, contenido Markdown interactivo, gráficos, chips de adjuntos y
// utilidades de DOM en el navegador real. Las pestañas nuevas se registran sustituyendo
// window.open, y los Blob que se abren, envolviendo URL.createObjectURL.

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

describe('Browser UI - tarjetas y contenido interactivo', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - las tarjetas usan la vista de la herramienta o una genérica y se pliegan salvo displayMode expanded', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(({ chartCall }) => {
        const cards = window.ChatToolCards;
        const { registry, Tool } = window.ChatAgentCore;
        const tool = new Tool({
          definition: { name: 'view_tool' },
          execute: async () => ({ success: true }),
          view: {
            createLiveCard: (_args, ui) => {
              const card = ui.createCardWrapper('own-view');
              card.innerHTML = cards.renderCardHtml({ titleHtml: 'Propia', badgeHtml: '<span class="tool-card-badge"></span>' });
              return card;
            },
            updateLiveCard: card => { card.querySelector('.tool-card-badge').textContent = 'hecho'; }
          }
        });
        registry.registerProvider({ id: 'test_provider_view_tool', getTools: () => [tool] });
        const own = cards.createLiveToolCard('view_tool', {});
        const ownClass = own.classList.contains('own-view');
        cards.updateLiveToolCard(own, 'view_tool', {}, { success: true }, 1);
        registry.unregisterProvider('test_provider_view_tool');

        const generic = cards.createLiveToolCard('unknown_tool', { a: 1 });
        const collapsed = card => card.querySelector('.tool-execution-card, .chat-chart-card').classList.contains('collapsed');
        const live = cards.createLiveToolCard('generic_tool', { param: 'val' });
        const liveBefore = collapsed(live);
        cards.updateLiveToolCard(live, 'generic_tool', { param: 'val' }, { success: true }, 50);
        const history = cards.renderHistoricalToolCard({ function: { name: 'generic_tool', arguments: '{"foo":"bar"}' } }, { content: '{"success":true}' });

        const chartArgs = JSON.parse(chartCall.function.arguments);
        const chart = cards.createLiveToolCard('render_chart', chartArgs);
        cards.updateLiveToolCard(chart, 'render_chart', chartArgs, { success: true }, 30, { displayMode: 'expanded' });
        const chartHistory = cards.renderHistoricalToolCard(chartCall, { content: '{"success":true}' });
        return {
          own: [ownClass, own.querySelector('.tool-card-badge').textContent],
          generic: [generic.querySelector('.tool-card-title').textContent, generic.querySelector('.tool-card-code').textContent],
          collapsed: { liveBefore, liveAfter: collapsed(live), history: collapsed(history), chart: collapsed(chart), chartHistory: collapsed(chartHistory) }
        };
      }, { chartCall: call('render_chart', { type: 'bar', title: 'Test', data: [{ label: 'A', value: 1 }] }) });
      assert.deepEqual(result.own, [true, 'hecho']);
      assert.match(result.generic[0], /unknown_tool/);
      assert.match(result.generic[1], /"a": 1/);
      assert.deepEqual(result.collapsed, { liveBefore: false, liveAfter: true, history: true, chart: false, chartHistory: false });
    });
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

  test('Browser UI - read_knowledge_image y download_image muestran una miniatura que abre la imagen, en vivo y en el historial', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const cards = window.ChatToolCards;
        const opened = [];
        window.ChatUtils.openImageInNewTab = url => opened.push(url);
        const cases = {
          read_knowledge_image: {
            args: { imageRef: 'rag-image://doc_1:img_1' },
            result: { success: true, documentTitle: 'Diagrama Técnico', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
            history: { content: 'Image retrieved: rag-image://doc_1:img_1', images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', imageRef: 'rag-image://doc_1:img_1', documentTitle: 'Diagrama Técnico' }] }
          },
          download_image: {
            args: { url: 'https://example.com/photo.jpg' },
            result: { success: true, url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg', byteSize: 1024, dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
            history: { content: 'Image retrieved: https://example.com/photo.jpg', images: [{ dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg', byteSize: 1024 }] }
          }
        };
        const out = {};
        for (const [name, { args, result, history }] of Object.entries(cases)) {
          const card = cards.createLiveToolCard(name, args);
          cards.updateLiveToolCard(card, name, args, result, 10);
          const thumb = card.querySelector('.rag-image-thumb');
          const before = opened.length;
          thumb.click();
          const historical = cards.renderHistoricalToolCard({ function: { name, arguments: JSON.stringify(args) } }, history);
          out[name] = { role: thumb.getAttribute('role'), tabIndex: thumb.tabIndex, opened: opened.slice(before), history: Boolean(historical.querySelector('.rag-image-thumb')) };
        }
        return out;
      });
      assert.deepEqual(result.read_knowledge_image, { role: 'button', tabIndex: 0, opened: ['data:image/png;base64,iVBORw0KGgo='], history: true });
      assert.deepEqual(result.download_image, { role: 'button', tabIndex: 0, opened: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='], history: true });
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

  test('Browser UI - reactivar la tarjeta de un comando en segundo plano la lleva al final del chat', async () => {
    await withTestApp(async page => {
      const scrolled = await page.evaluate(async () => {
        const messagesList = document.getElementById('messages-list');
        const view = window.ChatCommandCard.createView();
        const card = view.createLiveCard({ command: 'npm run test' }, {
          createCardWrapper() {
            return Object.assign(document.createElement('div'), { className: 'tool-card-wrapper command-card-wrapper' });
          }
        });
        messagesList.appendChild(card);
        let scrolled = false;
        const original = window.ChatUIConversation.scrollToBottom;
        window.ChatUIConversation.scrollToBottom = container => { if (container === messagesList) scrolled = true; };
        view.updateLiveCard(card, { command: 'npm run test' }, { content: JSON.stringify({ status: 'running', job_id: 10, output: 'ok' }) });
        await new Promise(resolve => setTimeout(resolve, 20));
        view.updateLiveCard(card, { command: 'npm run test' }, { content: JSON.stringify({ status: 'exited', exit_code: 0, output: 'ok' }) });
        window.ChatUIConversation.scrollToBottom = original;
        card.remove();
        return scrolled;
      });
      assert.equal(scrolled, true, 'reactivate lleva la tarjeta al final de messages-list');
    });
  });

  test('Browser UI - las imágenes del Markdown se abren con clic o Enter y las tablas se copian y descargan como CSV', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const opened = [];
        window.open = url => { opened.push(url); return null; };
        const image = document.createElement('div');
        image.innerHTML = window.ChatMarkdown.parseMarkdown('![Diagrama](https://example.test/img.png)');
        const img = image.querySelector('img.chat-embedded-image');
        const roleBefore = img.getAttribute('role');
        window.ChatMarkdown.attachContentListeners(image);
        img.click();
        img.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        const copied = [];
        const downloads = [];
        window.ChatUtils.copyToClipboard = text => { copied.push(text); };
        window.ChatExport.downloadFile = (content, filename, mimeType) => { downloads.push({ content, filename, mimeType }); return true; };
        const table = document.createElement('div');
        table.innerHTML = window.ChatMarkdown.parseMarkdown('| Nombre | Edad |\n|---|---|\n| Ana | 30 |\n| Bob | 25 |');
        window.ChatMarkdown.attachContentListeners(table);
        table.querySelector('.btn-copy-table-csv').click();
        table.querySelector('.btn-export-table-csv').click();
        return { roleBefore, role: img.getAttribute('role'), tabIndex: img.tabIndex, opened: opened.map(url => url.startsWith('blob:')), copied, downloads };
      });
      assert.equal(result.roleBefore, null);
      assert.equal(result.role, 'button');
      assert.equal(result.tabIndex, 0);
      assert.deepEqual(result.opened, [true, true], 'Clic y Enter abren la imagen en un visor Blob');
      assert.deepEqual(result.copied, ['Nombre,Edad\r\nAna,30\r\nBob,25']);
      assert.deepEqual(result.downloads, [{ content: 'Nombre,Edad\r\nAna,30\r\nBob,25', filename: 'tabla.csv', mimeType: 'text/csv;charset=utf-8' }]);
    });
  });

  test('Browser UI - tableToCsv convierte tablas HTML a CSV con escape RFC 4180', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML = `
          <table>
            <thead><tr><th>Producto</th><th>Precio</th><th>Notas</th></tr></thead>
            <tbody>
              <tr><td>Manzana</td><td>1.50</td><td>Fruta fresca</td></tr>
              <tr><td>Pera, conferencia</td><td>2.00</td><td>Con "piel" fina</td></tr>
              <tr><td>Naranja</td><td>1.80</td><td>Línea 1\nLínea 2</td></tr>
            </tbody>
          </table>`;
        return { csv: window.ChatMarkdown.tableToCsv(host.querySelector('table')), empty: window.ChatMarkdown.tableToCsv(null) };
      });
      assert.equal(result.csv, [
        'Producto,Precio,Notas',
        'Manzana,1.50,Fruta fresca',
        '"Pera, conferencia",2.00,"Con ""piel"" fina"',
        'Naranja,1.80,"Línea 1\nLínea 2"'
      ].join('\r\n'));
      assert.equal(result.empty, '');
    });
  });

  test('Browser UI - la vista previa de un bloque HTML abre su código en una pestaña', async () => {
    await withTestApp(async page => {
      const opened = await page.evaluate(() => {
        const opened = [];
        window.ChatUtils.openDocumentInNewTab = (content, mimeType) => { opened.push({ content, mimeType }); return true; };
        const host = document.createElement('div');
        host.innerHTML = window.ChatMarkdown.parseMarkdown('```html\n<div class="folleto"><h1>Hola</h1></div>\n```');
        window.ChatMarkdown.attachContentListeners(host);
        host.querySelector('.btn-preview-code').click();
        return opened;
      });
      assert.deepEqual(opened, [{ content: '<div class="folleto"><h1>Hola</h1></div>', mimeType: 'text/html;charset=utf-8' }]);
    });
  });

  test('Browser UI - los chips de adjuntos y las primitivas de DOM muestran los nombres externos como texto', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const chips = document.createElement('div');
        window.ChatAttachments.clearFiles();
        window.ChatAttachments.addFile({ name: "archivo<script>'\"&.pdf", size: 1024, type: 'pdf' });
        window.ChatAttachments.renderChips(chips);
        const name = chips.querySelector('.file-chip-name');
        const chip = { count: chips.children.length, text: name.textContent, title: name.title, script: Boolean(chips.querySelector('script')) };
        window.ChatAttachments.clearFiles();

        const parent = document.createElement('div');
        const child = window.ChatUtils.appendTextElement(parent, 'span', '<img src=x onerror=alert(1)>', { className: 'safe-text' });
        const text = { text: child.textContent, className: child.className, img: Boolean(parent.querySelector('img')), children: parent.children.length };
        window.ChatUtils.clearElement(parent);
        return { chip, text: { ...text, cleared: parent.children.length } };
      });
      assert.deepEqual(result.chip, { count: 1, text: "archivo<script>'\"&.pdf", title: "archivo<script>'\"&.pdf", script: false });
      assert.deepEqual(result.text, { text: '<img src=x onerror=alert(1)>', className: 'safe-text', img: false, children: 1, cleared: 0 });
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
});
