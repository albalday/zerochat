const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

// Envío de mensajes, estado de generación, telemetría, menú de razonamiento, panel de depuración y
// borrado de datos sobre la aplicación real. El proveedor se sustituye en ChatAPI.streamChatCompletion.

/** Sustituye la respuesta del proveedor por `respond` (una función que se evalúa en la página). */
function useProvider(page, respond) {
  return page.evaluate(source => {
    // eslint-disable-next-line no-new-func
    window.ChatAPI.streamChatCompletion = new Function(`return (${source});`)();
  }, respond.toString());
}

/** Escribe y envía un mensaje como el usuario y espera a que termine la generación. */
async function send(page, text) {
  await page.fill('#user-input', text);
  await page.click('#btn-send');
  await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
}

const lastAssistant = page => page.locator('#messages-list .message-wrapper.assistant').last();
const savedSessions = page => page.evaluate(async () => (await window.ChatStorage.getConversationsList()).length);

describe('Browser UI - generación, estado y paneles auxiliares', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - enviar responde, guarda la conversación, limpia el composer e ignora envíos vacíos', async () => {
    await withTestApp(async page => {
      await useProvider(page, async () => ({ accumulatedText: 'ok', toolCalls: null, stats: null }));
      await page.fill('#user-input', '   ');
      await page.click('#btn-send');
      assert.equal(await page.evaluate(() => window.ChatState.get('messages').length), 1, 'Un envío sin texto ni adjuntos se ignora');
      assert.equal(await savedSessions(page), 0);

      await send(page, 'Hola');
      assert.deepEqual(await page.evaluate(() => window.ChatState.get('messages').slice(1).map(message => message.role)), ['user', 'assistant']);
      assert.match(await lastAssistant(page).locator('.message-content').innerHTML(), /ok/);
      assert.equal(await lastAssistant(page).locator('.message-actions').isVisible(), true);
      assert.equal(await savedSessions(page), 1);
      assert.equal(await page.inputValue('#user-input'), '');
    });
  });

  test('Browser UI - sin modelo, un error del proveedor o un error en el streaming se muestran escapados en su tarjeta', async () => {
    await withTestApp(async page => {
      page.on('console', () => {});
      await page.evaluate(() => window.ChatConfig.updateRuntime({ model: '', apiUrl: 'http://x/<img src=x onerror="window.__probe=1">', apiType: 'openai', activeProfile: null }));
      await send(page, 'Hola');
      const noModel = lastAssistant(page);
      assert.equal(await noModel.locator('.message-row').evaluate(row => row.classList.contains('message-error')), true);
      assert.match(await noModel.textContent(), new RegExp(await page.evaluate(() => window.ChatI18n.t('err_no_model_title'))));
      assert.equal(await noModel.locator('.message-content img').count(), 0, 'apiUrl no debe interpretarse como HTML');
      assert.match(await noModel.locator('.message-error-card-hint').textContent(), /<img src=x onerror="window.__probe=1">/);
      assert.equal(await savedSessions(page), 1);

      await page.evaluate(() => window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1' }));
      await useProvider(page, async () => { throw new Error('<img src=x onerror="window.__probe=1">'); });
      await send(page, 'Question');
      assert.equal(await lastAssistant(page).locator('.message-content .message-error-card').count(), 1);
      assert.equal(await lastAssistant(page).locator('.message-content img').count(), 0);
      assert.equal(await lastAssistant(page).locator('.message-actions').isVisible(), true);

      // El proveedor real de Claude recibe un evento de error dentro del stream SSE: se recarga la
      // página para recuperar el ChatAPI.streamChatCompletion original.
      await page.route(/127\.0\.0\.1:9\/v1\/messages/, route => route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded <b>"}}\n\n'
      }));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready') && window.ChatState.get('messages').length > 0);
      await page.evaluate(() => {
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai', activeProfile: null });
        const real = window.ChatAPI.streamChatCompletion;
        window.ChatAPI.streamChatCompletion = params => real({ ...params, apiType: 'claude' });
      });
      await send(page, 'Question');
      const card = lastAssistant(page).locator('.message-error-card');
      assert.match(await card.textContent(), new RegExp(await page.evaluate(() => window.ChatI18n.t('err_server_stream_title'))));
      assert.match(await card.textContent(), /Overloaded <b>/);
      assert.equal(await card.locator('.message-error-card-hint').count(), 0, 'Un error del servidor no lleva la pista de conexión');
      assert.equal(await page.evaluate(() => Boolean(window.__probe)), false);
    });
  });

  test('Browser UI - una respuesta cortada conserva el texto y avisa, y parar a mitad conserva el mensaje del usuario', async () => {
    await withTestApp(async page => {
      await useProvider(page, async () => ({ accumulatedText: 'Parcial', toolCalls: null, stats: null, truncated: true }));
      await send(page, 'Hola');
      assert.match(await lastAssistant(page).locator('.message-content').textContent(), /Parcial/);
      assert.equal(await lastAssistant(page).locator('.message-notice').textContent(), await page.evaluate(() => window.ChatI18n.t('chat_response_truncated')));
      assert.equal(await page.evaluate(() => window.ChatState.get('messages').at(-1).content), 'Parcial');

      await page.click('#btn-sidebar-new-chat');
      await page.waitForFunction(() => window.ChatState.get('messages').length === 1);
      await useProvider(page, params => new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      await page.fill('#user-input', 'Detén la tarea');
      await page.click('#btn-send');
      await page.waitForFunction(() => window.ChatState.get('streaming').isGenerating);
      await page.click('#btn-stop-stream');
      await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
      assert.equal(await page.evaluate(() => window.ChatState.get('messages')[1].content), 'Detén la tarea');
      assert.equal(await page.evaluate(() => window.ChatState.isConversationBusy()), false);
      assert.equal(await savedSessions(page), 2);
    });
  });

  test('Browser UI - la nota de comandos terminados se guarda en el mensaje del usuario y se antepone al pedirlo al modelo', async () => {
    await withTestApp(async page => {
      await page.evaluate(() => {
        window.__seen = { notes: [], request: null };
        window.ChatMCP.manager.buildCommandNotes = async messages => {
          window.__seen.notes.push(messages.filter(message => message.role === 'user').map(message => message.content));
          return 'Background commands that finished since your last turn: ...';
        };
      });
      await useProvider(page, async params => {
        window.__seen.request = params.messages.find(message => message.role === 'user').content;
        return { accumulatedText: 'ok', toolCalls: null, stats: null };
      });
      await send(page, 'sigue');
      const result = await page.evaluate(() => ({ seen: window.__seen, user: window.ChatState.get('messages').find(message => message.role === 'user') }));
      assert.deepEqual(result.seen.notes, [['sigue']]);
      assert.equal(result.user.content, 'sigue', 'El texto visible no cambia');
      assert.equal(result.user.commandNotes, 'Background commands that finished since your last turn: ...');
      assert.match(result.seen.request, /^Background commands/);
    });
  });

  test('Browser UI - en pantallas táctiles no devuelve el foco al composer al terminar', async () => {
    await withTestApp({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, async page => {
      await useProvider(page, async () => ({ accumulatedText: 'ok', toolCalls: null, stats: null }));
      await page.fill('#user-input', 'Hola');
      await page.tap('#btn-send');
      await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating && window.ChatState.get('messages').length === 3);
      assert.equal(await page.evaluate(() => document.activeElement === document.getElementById('user-input')), false);
    });
  });

  test('Browser UI - el indicador de estado muestra texto y progreso y solo se activa durante una generación', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const Status = window.ChatUIGenerationStatus;
        const element = document.getElementById('generation-status');
        const text = element.querySelector('.generation-status-text');
        const progress = element.querySelector('.generation-status-progress');
        const out = {};
        Status.render(element, 'Analizando dependencias...');
        out.text = [element.hidden, text.textContent];
        Status.render(element, { text: 'Descargando paquete...', percent: 75 });
        out.progress = [text.textContent, progress.hidden, progress.value];
        Status.render(element, { phase: 'idle' });
        out.idleHidden = element.hidden;
        Status.setStatus(element, { phase: 'tool', text: 'Ejecutando herramienta...' });
        out.withoutGeneration = element.hidden;
        window.ChatState.set('streaming', { isGenerating: true });
        Status.setStatus(element, { phase: 'tool', text: 'Ejecutando herramienta...' });
        out.during = [element.hidden, element.dataset.phase, window.ChatState.get('ui').generationStatus.phase];
        Status.clearStatus(element);
        out.cleared = [element.hidden, window.ChatState.get('ui').generationStatus.phase];
        window.ChatState.set('streaming', { isGenerating: false });
        return out;
      });
      assert.deepEqual(result, {
        text: [false, 'Analizando dependencias...'],
        progress: ['Descargando paquete... · 75 %', false, 75],
        idleHidden: true,
        withoutGeneration: true,
        during: [false, 'tool', 'tool'],
        cleared: [true, 'idle']
      });
    });
  });

  test('Browser UI - el botón de contexto muestra uso, semáforo y caché, y su panel solo se rellena abierto', async () => {
    await withTestApp(async page => {
      const badge = await page.evaluate(() => {
        const UITelemetry = window.ChatUITelemetry;
        const byId = id => document.getElementById(id);
        const elements = {
          connectionTokensBadge: byId('connection-tokens-badge'), connectionTokensText: byId('connection-tokens-text'),
          contextHubCachePill: byId('context-hub-cache-pill'), contextHubCacheVal: byId('context-hub-cache-val'),
          contextHubPopover: byId('context-hub-popover'), contextMetricUsedVal: byId('context-metric-used-val')
        };
        const read = () => ({
          text: elements.connectionTokensText.textContent,
          warning: elements.connectionTokensBadge.classList.contains('status-warning'),
          critical: elements.connectionTokensBadge.classList.contains('status-critical'),
          hidden: elements.connectionTokensBadge.hidden,
          title: elements.connectionTokensBadge.title,
          pill: elements.contextHubCachePill.hidden ? null : elements.contextHubCacheVal.textContent
        });
        const all = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase()), element]));
        const used = elements.contextMetricUsedVal.textContent;
        UITelemetry.renderTelemetry(all, { badgeText: '90k / 128k', healthStatus: 'warning', cachedTokens: 2500, cachedFormatted: '2.5k', usedTokens: 999 });
        const warning = read();
        const hiddenPanelUntouched = elements.contextMetricUsedVal.textContent === used;
        UITelemetry.renderTelemetry(all, { badgeText: '120k / 128k', healthStatus: 'critical', cachedTokens: 0, cachedFormatted: '0' });
        return { warning, critical: read(), hiddenPanelUntouched, expectedTitle: window.ChatI18n.t('context_hub_btn_title') };
      });
      assert.deepEqual(badge.warning, { text: '90k / 128k', warning: true, critical: false, hidden: false, title: badge.expectedTitle, pill: '2.5k' });
      assert.deepEqual([badge.critical.warning, badge.critical.critical, badge.critical.pill], [false, true, null]);
      assert.equal(badge.hiddenPanelUntouched, true, 'No actualiza el panel oculto');

      // Al abrirlo, la aplicación lo rellena con la telemetría del estado y la capacidad del servidor.
      await page.evaluate(() => {
        window.ChatConfig.updateRuntime({ modelContextLimit: 128000, contextLimitOverride: null });
        window.ChatState.set('telemetry', { stats: { promptTokens: 10000 } });
      });
      await page.click('#connection-tokens-badge');
      const opened = await page.evaluate(() => ({
        popover: !document.getElementById('context-hub-popover').hidden,
        expanded: document.getElementById('connection-tokens-badge').getAttribute('aria-expanded'),
        used: document.getElementById('context-metric-used-val').textContent,
        expectedUsed: `${(10000).toLocaleString()} tok`,
        width: document.getElementById('context-progress-bar').style.width,
        overrideDisabled: document.getElementById('context-limit-override-input').disabled,
        status: document.getElementById('context-metric-status-val').textContent,
        expectedStatus: window.ChatI18n.t('context_status_ok')
      }));
      assert.deepEqual([opened.popover, opened.expanded, opened.used, opened.width, opened.overrideDisabled, opened.status],
        [true, 'true', opened.expectedUsed, '7.8%', true, opened.expectedStatus]);

      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#context-hub-popover').isHidden(), true);
      await page.click('#connection-tokens-badge');
      await page.mouse.click(5, 300);
      assert.equal(await page.locator('#context-hub-popover').isHidden(), true, 'Un clic fuera lo cierra');
    });
  });

  test('Browser UI - una conversación nueva deja la telemetría en su estado neutro', async () => {
    await withTestApp(async page => {
      await page.evaluate(() => window.ChatConfig.updateRuntime({ modelContextLimit: 128000, contextLimitOverride: null }));
      await useProvider(page, async params => {
        params.onChunk?.('ok', 'ok', { promptTokens: 5000, completionTokens: 10, cachedTokens: 3000 });
        return { accumulatedText: 'ok', toolCalls: null, stats: { promptTokens: 5000, completionTokens: 10, cachedTokens: 3000 } };
      });
      await send(page, 'Hola');
      await page.click('#btn-sidebar-new-chat');
      await page.waitForFunction(() => window.ChatState.get('messages').length === 1);
      // Sin telemetría del servidor, el botón estima el historial nuevo (el prompt de sistema).
      const neutral = await page.evaluate(() => ({
        text: document.getElementById('connection-tokens-text').textContent,
        pillHidden: document.getElementById('context-hub-cache-pill').hidden,
        turnPrompt: document.getElementById('context-metric-turn-prompt-val').textContent,
        stats: window.ChatState.get('telemetry').stats
      }));
      assert.match(neutral.text, /^~\d+ \/ 128k$/);
      assert.deepEqual([neutral.pillHidden, neutral.turnPrompt, neutral.stats], [true, '-', null]);
    });
  });

  test('Browser UI - el control de razonamiento elige el nivel y actualiza botón, etiqueta y aguja', async () => {
    await withTestApp(async page => {
      await page.click('#btn-reasoning');
      assert.equal(await page.locator('#reasoning-menu').isVisible(), true);
      await page.evaluate(() => window.ChatConfig.updateRuntime({ reasoningEffort: 'medium' }));
      await page.locator('#reasoning-intensity').fill('3');
      const high = await page.evaluate(() => ({
        effort: window.ChatConfig.getActive().reasoningEffort,
        label: document.getElementById('reasoning-label').textContent,
        expectedLabel: window.ChatI18n.t('reasoning_level_high'),
        activeHigh: document.getElementById('btn-reasoning').classList.contains('active-high'),
        intensity: document.getElementById('reasoning-intensity').style.getPropertyValue('--reasoning-intensity'),
        needle: document.querySelector('#btn-reasoning #reasoning-gauge-needle').getAttribute('transform')
      }));
      assert.deepEqual([high.effort, high.label, high.activeHigh, high.intensity, high.needle], ['high', high.expectedLabel, true, '75%', 'rotate(30 12 15)']);

      const unknownActive = await page.evaluate(() => {
        const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase()), element]));
        window.ChatUIReasoning.updateReasoningUI(elements, 'unknown');
        return elements.btnReasoning.classList.contains('active');
      });
      assert.equal(unknownActive, false, 'Un nivel desconocido cuenta como ninguno');

      await page.locator('#reasoning-intensity').focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#reasoning-menu').isHidden(), true);
      assert.equal(await page.getAttribute('#btn-reasoning', 'aria-expanded'), 'false');
    });
  });

  test('Browser UI - el panel del proyecto ofrece las acciones de cada estado, abrevia el directorio y marca el botón', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const UIReasoning = window.ChatUIReasoning;
        const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase()), element]));
        // Las acciones llegan a los manejadores que monta app.js: se registran sus efectos.
        const calls = [];
        window.ChatProjectContext.refresh = async () => { calls.push(['reload']); };
        window.ChatProjectContext.changeDirectory = async () => { calls.push(['changeDirectory']); return null; };
        const render = (project, options = {}) => UIReasoning.renderProjectPanel(elements, {
          config: { projectMode: options.projectMode ?? true },
          project,
          canInitialize: options.canInitialize ?? true,
          canChangeDirectory: options.canChangeDirectory ?? false,
          busy: false
        });
        const actions = () => [...elements.projectModePanel.querySelectorAll('.project-mode-actions [data-project-action]')].map(button => button.dataset.projectAction);
        const out = { actions: {} };
        render({ status: 'missing', cwd: '/home/u/app' });
        out.actions.missing = actions();
        render({ status: 'missing', cwd: '/home/u/app' }, { canInitialize: false });
        out.actions.missingReadOnly = actions();
        render({ status: 'declined', cwd: '/r' });
        out.actions.declined = actions();
        for (const status of ['ready', 'error', 'no_access']) {
          render({ status, cwd: '/r' });
          out.actions[status] = actions();
        }
        render({ status: 'unavailable', cwd: '/r' });
        out.actions.unavailable = actions();
        render({ status: 'ready', cwd: '/r' }, { projectMode: false });
        out.actions.disabled = actions();
        out.disabledStatus = elements.projectModePanel.querySelector('.project-mode-status').textContent === window.ChatI18n.t('project_status_disabled');

        render({ status: 'ready', cwd: '/home/u/my-repo/' }, { canChangeDirectory: true });
        elements.projectModePanel.querySelector('[data-project-action="reload"]').click();
        elements.projectModePanel.querySelector('[data-project-action="changeDirectory"]').click();
        elements.projectModePanel.querySelector('#chk-project-mode').click();
        calls.push(['toggle', window.ChatConfig.getActive().projectMode]);
        out.calls = calls;

        out.paths = {};
        for (const cwd of ['/home/u/vs/zerochat', '/home/u', '/Users/ana/app', '/data/data/com.termux/files/home/app', 'C:\\Users\\ana\\app', '/home/user2x/app', '/homes/u/app', '/srv/app']) {
          render({ status: 'ready', cwd });
          const path = elements.projectModePanel.querySelector('.project-mode-path');
          out.paths[cwd] = [path.textContent, path.title === cwd];
        }
        render({ status: 'ready', cwd: '' });
        out.noPath = elements.projectModePanel.querySelector('.project-mode-path') === null;

        const sync = (projectMode, status) => {
          UIReasoning.syncProjectIndicator(elements, { projectMode }, { status, cwd: '/home/u/zerochat' });
          return elements.btnReasoning.getAttribute('data-project-indicator');
        };
        out.indicator = {
          ready: sync(true, 'ready'),
          readyLabel: elements.reasoningProjectLabel.textContent,
          readyTitle: / · .*zerochat/.test(elements.btnReasoning.title),
          error: sync(true, 'error'),
          noAccess: sync(true, 'no_access'),
          others: ['missing', 'declined', 'unavailable'].map(status => sync(true, status)),
          off: sync(false, 'ready'),
          offLabel: elements.reasoningProjectLabel.textContent,
          offTitle: / · /.test(elements.btnReasoning.title)
        };
        return out;
      });
      assert.deepEqual(result.actions, {
        missing: ['initialize', 'decline'], missingReadOnly: ['decline'], declined: ['reactivate'],
        ready: ['reload'], error: ['reload'], no_access: ['reload'], unavailable: [], disabled: []
      });
      assert.equal(result.disabledStatus, true, 'Con el modo apagado el panel lo indica');
      // Cambiar el modo proyecto con el interruptor vuelve a consultar el proyecto antes de aplicarse.
      assert.deepEqual(result.calls, [['reload'], ['changeDirectory'], ['reload'], ['toggle', false]]);
      assert.deepEqual(result.paths, {
        '/home/u/vs/zerochat': ['~/vs/zerochat', true],
        '/home/u': ['~', true],
        '/Users/ana/app': ['~/app', true],
        '/data/data/com.termux/files/home/app': ['~/app', true],
        'C:\\Users\\ana\\app': ['~\\app', true],
        '/home/user2x/app': ['~/app', true],
        '/homes/u/app': ['/homes/u/app', true],
        '/srv/app': ['/srv/app', true]
      });
      assert.equal(result.noPath, true);
      assert.equal(result.indicator.ready, 'ready');
      assert.match(result.indicator.readyLabel, /zerochat/);
      assert.equal(result.indicator.readyTitle, true);
      assert.deepEqual([result.indicator.error, result.indicator.noAccess, result.indicator.others, result.indicator.off], ['warning', 'warning', [null, null, null], null]);
      assert.equal(result.indicator.offLabel, '');
      assert.equal(result.indicator.offTitle, false);
    });
  });

  test('Browser UI - el registro de depuración acumula el razonamiento, filtra por pestaña y muestra lo crudo solo en la suya', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(() => {
        const Debug = window.ChatDebug;
        const log = document.getElementById('debug-log-content');
        Debug.clearLogs();
        Debug.filterLogs('all');
        Debug.addLog('thinking', 'Pienso ');
        Debug.addLog('thinking', 'despacio');
        Debug.addLog('network', 'POST <url>');
        Debug.addLog('raw', '>>> payload');
        Debug.addLog('warning', 'Aviso de prueba');
        const entries = () => [...log.querySelectorAll('.debug-entry')];
        const [cleared, thinking, network, raw, warning] = entries();
        const out = {
          types: [cleared.dataset.type, warning.dataset.type],
          thinking: thinking.querySelector('.debug-msg').textContent,
          network: network.querySelector('.debug-msg').textContent,
          time: network.querySelector('.debug-time').textContent,
          raw: [raw.classList.contains('raw-outgoing'), raw.hidden],
          warningClass: warning.classList.contains('debug-entry-warning')
        };
        Debug.filterLogs('raw');
        out.rawFilter = entries().map(entry => entry.hidden);
        Debug.filterLogs('network');
        out.networkShowsWarning = !warning.hidden;
        Debug.filterLogs('thinking');
        out.thinkingHidesWarning = warning.hidden;
        Debug.filterLogs('all');
        Debug.setRawLogsEnabled(false);
        Debug.addLog('raw', 'ignorado');
        Debug.setRawLogsEnabled(true);
        out.count = entries().length;
        return out;
      });
      assert.deepEqual(result.types, ['system', 'warning']);
      assert.equal(result.thinking, 'Pienso despacio');
      assert.equal(result.network, 'POST <url>', 'Los mensajes se muestran como texto');
      assert.match(result.time, /^\[\d{1,2}:\d{2}:\d{2}\]$/);
      assert.deepEqual(result.raw, [true, true]);
      assert.equal(result.warningClass, true);
      assert.deepEqual(result.rawFilter, [true, true, true, false, true]);
      assert.equal(result.networkShowsWarning, true, 'El filtro de red incluye los avisos');
      assert.equal(result.thinkingHidesWarning, true);
      assert.equal(result.count, 5, 'Con lo crudo desactivado no se registra');
    });
  });

  test('Browser UI - el panel de depuración, su estado, el interceptor de mensajes y los errores globales', async () => {
    await withTestApp(async page => {
      const result = await page.evaluate(async () => {
        const Debug = window.ChatDebug;
        const byId = id => document.getElementById(id);
        const out = {};
        Debug.togglePanel(true);
        out.open = [byId('debug-panel').hidden, byId('btn-toggle-debug').getAttribute('aria-expanded')];
        Debug.togglePanel();
        out.closed = byId('debug-panel').hidden;
        Debug.setStatus('streaming');
        out.streaming = byId('debug-status-indicator').textContent === window.ChatI18n.t('debug_status_streaming');
        Debug.setStatus('error', 'Fallo');
        out.error = [byId('debug-status-indicator').className, byId('debug-status-indicator').textContent];

        let synced = null;
        const pending = Debug.openInterceptorModal({ endpoint: 'http://x/v1', payload: { a: 1 }, onSyncDebugState: value => { synced = value; } });
        out.interceptor = [byId('debug-interceptor-dialog').open, byId('debug-modal-endpoint-badge').textContent];
        byId('txt-debug-payload').value = '{ roto';
        byId('btn-debug-send').click();
        out.invalidJson = !byId('debug-json-error').hidden;
        byId('txt-debug-payload').value = '{"a":2}';
        byId('btn-debug-send-disable').click();
        out.sent = await pending;
        out.synced = synced;
        out.closedAfterSend = byId('debug-interceptor-dialog').open;
        const cancelled = Debug.openInterceptorModal({ endpoint: 'http://x/v1', payload: {}, onSyncDebugState() {} });
        byId('btn-close-debug-modal').click();
        out.cancelled = await cancelled;

        // La aplicación registra los errores globales: rechazos y errores de script, salvo cancelaciones.
        Debug.clearLogs();
        const rejection = Promise.reject(new Error('Promesa rechazada de prueba'));
        rejection.catch(() => {});
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: rejection, reason: new Error('Promesa rechazada de prueba') }));
        window.dispatchEvent(new ErrorEvent('error', { message: 'TypeError inesperado en script', filename: 'app.js', lineno: 42 }));
        const aborted = Promise.reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
        aborted.catch(() => {});
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: aborted, reason: Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }) }));
        out.globalErrors = [...byId('debug-log-content').querySelectorAll('.debug-entry[data-type="error"]')].map(entry => entry.textContent);
        return out;
      });
      assert.deepEqual(result.open, [false, 'true']);
      assert.equal(result.closed, true);
      assert.equal(result.streaming, true);
      assert.deepEqual(result.error, ['debug-status-indicator error', 'Fallo']);
      assert.deepEqual(result.interceptor, [true, 'POST http://x/v1']);
      assert.equal(result.invalidJson, true, 'Un JSON inválido no se envía');
      assert.deepEqual(result.sent, { cancel: false, modifiedPayload: { a: 2 } });
      assert.equal(result.synced, false);
      assert.equal(result.closedAfterSend, false);
      assert.deepEqual(result.cancelled, { cancel: true });
      assert.equal(result.globalErrors.length, 2, 'AbortError no se registra como error del sistema');
      assert.match(result.globalErrors[0], /Unhandled Promise[\s\S]*Promesa rechazada de prueba/);
      assert.match(result.globalErrors[1], /Runtime Error[\s\S]*TypeError inesperado en script at app\.js:42/);
    });
  });

  test('Browser UI - borrar todos los datos pide confirmación, detiene la generación, limpia y recarga; si falla avisa sin recargar', async () => {
    await withTestApp(async page => {
      await useProvider(page, async () => ({ accumulatedText: 'ok', toolCalls: null, stats: null }));
      await send(page, 'Conversación a borrar');
      assert.equal(await savedSessions(page), 1);
      await page.click('#btn-open-settings');

      // Cancelar no toca nada.
      await page.locator('#sidebar-view-settings #btn-clear-all-data').click();
      await page.waitForFunction(() => document.getElementById('notice-dialog').open);
      await page.click('#notice-cancel');
      await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
      assert.equal(await savedSessions(page), 1);

      // Si el borrado falla se avisa con el motivo y la página no se recarga.
      await page.evaluate(() => {
        window.__beforeReload = true;
        window.ChatStorage.clearAllStorage = async () => false;
        window.ChatStorage.getLastClearAllStorageError = () => 'IndexedDB blocked';
      });
      await page.locator('#sidebar-view-settings #btn-clear-all-data').click();
      await page.waitForFunction(() => document.getElementById('notice-dialog').open);
      await page.click('#notice-accept');
      await page.waitForFunction(() => document.getElementById('notice-dialog').open && /IndexedDB blocked/.test(document.getElementById('notice-message').textContent));
      assert.equal(await page.textContent('#notice-message'), await page.evaluate(() => window.ChatI18n.t('clear_all_data_failed_detail', { detail: 'IndexedDB blocked' })));
      await page.click('#notice-accept');
      assert.equal(await page.evaluate(() => window.__beforeReload), true, 'Sin recarga');

      // Con el almacenamiento real: detiene la generación en curso, borra y recarga.
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready') && window.ChatState.get('messages').length > 0);
      await useProvider(page, params => new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      await page.fill('#user-input', 'En curso');
      await page.click('#btn-send');
      await page.waitForFunction(() => window.ChatState.get('streaming').isGenerating);
      await page.click('#btn-open-settings');
      await page.locator('#sidebar-view-settings #btn-clear-all-data').evaluate(button => button.click());
      await page.waitForFunction(() => document.getElementById('notice-dialog').open);
      await Promise.all([page.waitForEvent('load'), page.click('#notice-accept')]);
      await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready') && window.ChatState.get('messages').length > 0);
      assert.equal(await savedSessions(page), 0, 'Las conversaciones se han borrado');
    });
  });
});
