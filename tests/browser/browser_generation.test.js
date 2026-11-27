const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

// Envío de mensajes, estado de generación y errores de proveedor sobre la aplicación real.
// El proveedor se sustituye en ChatAPI.streamChatCompletion.

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

  test('Browser UI - sin modelo, un error del proveedor o un error en el streaming se muestran escapados en su tarjeta', async () => {
    await withTestApp(async page => {
      page.on('console', () => {});
      await page.evaluate(() => window.ChatConfig.updateRuntime({ model: '', apiUrl: 'http://x/<img src=x onerror="window.__probe=1">', apiType: 'openai' }));
      await send(page, 'Hola');
      const noModel = lastAssistant(page);
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

      // Un fallo tras un paso con herramientas deja la tarjeta del paso y lo guarda en el historial.
      await useProvider(page, async params => {
        if (params.messages.some(message => message.role === 'tool')) throw new Error('Overloaded');
        const args = JSON.stringify({ type: 'bar', labels: ['A'], datasets: [{ label: 'a', data: [1] }] });
        return { accumulatedText: '', toolCalls: [{ id: 'call_chart', type: 'function', function: { name: 'render_chart', arguments: args } }], stats: null };
      });
      await send(page, 'Chart');
      assert.equal(await lastAssistant(page).locator('.message-content .tool-card-wrapper').count(), 1);
      assert.equal(await lastAssistant(page).locator('.message-content > .message-error-card').count(), 1);
      const saved = await page.evaluate(async () => {
        const id = window.ChatState.get('sessions').activeId;
        return (await window.ChatStorage.getConversation(id)).history.slice(-2).map(message => message.role);
      });
      assert.deepEqual(saved, ['assistant', 'tool']);

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
        window.ChatConfig.updateRuntime({ model: 'test-model', apiUrl: 'http://127.0.0.1:9/v1', apiType: 'openai' });
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

  test('Browser UI - con el modo proyecto, las normas y el estado se releen antes de cada turno', async () => {
    await withTestApp(async page => {
      await useProvider(page, async () => ({ accumulatedText: 'Hecho', toolCalls: null, stats: null }));
      await page.evaluate(() => {
        const context = window.ChatProjectContext;
        const original = context.refresh;
        window.__turnRefreshes = 0;
        context.refresh = (...args) => {
          // Solo cuenta las que llegan con el turno ya en marcha (no las del final de la respuesta).
          if (window.ChatState.get('streaming').isGenerating) window.__turnRefreshes += 1;
          return original(...args);
        };
      });
      for (const [projectMode, expected] of [[true, 1], [false, 0]]) {
        await page.evaluate(mode => { window.__turnRefreshes = 0; window.ChatConfig.updateRuntime({ projectMode: mode }); }, projectMode);
        await send(page, 'Hola');
        assert.equal(await page.evaluate(() => window.__turnRefreshes), expected, `projectMode=${projectMode}`);
      }
    });
  });

  test('Browser UI - cada paso con herramientas queda guardado antes de que termine el turno', async () => {
    await withTestApp(async page => {
      await page.evaluate(() => {
        window.ChatConfig.updateRuntime({ enabledTools: { ...window.ChatConfig.getActive().enabledTools, execute_javascript: true } });
        let step = 0;
        window.ChatAPI.streamChatCompletion = () => {
          step += 1;
          if (step === 1) {
            return Promise.resolve({ accumulatedText: '', stats: null,
              toolCalls: [{ id: 'call_js', type: 'function', function: { name: 'execute_javascript', arguments: JSON.stringify({ code: 'return 6 * 7;' }) } }] });
          }
          // El segundo paso no termina hasta que la prueba lo suelta: lo guardado es solo el primero.
          return new Promise(resolve => { window.__finishTurn = () => resolve({ accumulatedText: 'Son 42.', toolCalls: [], stats: null }); });
        };
      });
      await page.fill('#user-input', 'Calcula');
      await page.click('#btn-send');
      await page.waitForFunction(() => typeof window.__finishTurn === 'function');
      const saved = await page.waitForFunction(async () => {
        const id = window.ChatState.get('sessions').activeId;
        const history = (await window.ChatStorage.getConversation(id))?.history || [];
        return history.some(message => message.role === 'tool' && message.name === 'execute_javascript') && history.map(message => message.role);
      });
      assert.deepEqual(await saved.jsonValue(), ['system', 'user', 'assistant', 'tool']);
      assert.equal(await page.evaluate(() => window.ChatState.get('streaming').isGenerating), true);

      await page.evaluate(() => window.__finishTurn());
      await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
      const final = await page.evaluate(async () => (await window.ChatStorage.getConversation(window.ChatState.get('sessions').activeId)).history);
      assert.equal(final.at(-1).content, 'Son 42.');
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

  test('Browser UI - título y favicon avisan cuando un turno termina o pide permiso en segundo plano y se limpian al volver, y cuentan las conversaciones que necesitan atención', async () => {
    await withTestApp(async page => {
      const setHidden = hidden => page.evaluate(value => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
      const baseTitle = await page.title();
      const baseFavicon = await page.getAttribute('#app-favicon', 'href');
      assert.ok(baseFavicon.startsWith('data:image/svg+xml,'));
      assert.ok(!decodeURIComponent(baseFavicon).includes('<circle'));

      // 1. Fin de turno en segundo plano: cambia título y añade punto verde en el favicon.
      await page.evaluate(() => {
        window.ChatAPI.streamChatCompletion = () => new Promise(resolve => { window.__resolveTurn = resolve; });
      });
      await page.fill('#user-input', 'Segundo plano');
      await page.click('#btn-send');
      await page.waitForFunction(() => window.ChatState.get('streaming').isGenerating);

      await setHidden(true);
      await page.evaluate(() => window.__resolveTurn({ accumulatedText: 'Hecho', toolCalls: null, stats: null }));
      await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
      const expectedDoneTitle = await page.evaluate(title => window.ChatI18n.t('tab_alert_done', { title }), baseTitle);
      await page.waitForFunction(expected => document.title === expected, expectedDoneTitle);
      assert.equal(await page.title(), expectedDoneTitle);
      const doneFavicon = decodeURIComponent(await page.getAttribute('#app-favicon', 'href'));
      assert.ok(doneFavicon.includes('<circle'));

      // Al volver a la pestaña, título y favicon recuperan su estado base.
      await setHidden(false);
      assert.equal(await page.title(), baseTitle);
      assert.ok(!decodeURIComponent(await page.getAttribute('#app-favicon', 'href')).includes('<circle'));

      // 2. Cancelar en segundo plano no muestra aviso de turno terminado.
      await useProvider(page, params => new Promise((_resolve, reject) => {
        params.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      await page.fill('#user-input', 'Cancelar');
      await page.click('#btn-send');
      await page.waitForFunction(() => window.ChatState.get('streaming').isGenerating);
      await setHidden(true);
      await page.evaluate(() => window.ChatGenerationController.handleStopGeneration());
      await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
      assert.equal(await page.title(), baseTitle);

      // 3. Petición de permiso en segundo plano prevalece sobre "Listo" y se limpia al volver o al responder.
      await page.evaluate(() => {
        const card = window.ChatToolCards.createLiveToolCard('run_command', { command: 'ls' });
        document.getElementById('messages-list').appendChild(card);
        window.__authCard = card;
        window.__pendingAuth = window.ChatToolCards.promptToolAuthorization(card, { function: { name: 'run_command' } }, { args: { command: 'ls' } });
        window.ChatTabAlert.notifyDone();
      });
      assert.equal(await page.title(), await page.evaluate(title => window.ChatI18n.t('tab_alert_permission', { title }), baseTitle));
      assert.ok(decodeURIComponent(await page.getAttribute('#app-favicon', 'href')).includes('<circle'));

      await setHidden(false);
      assert.equal(await page.title(), baseTitle);
      assert.ok(!decodeURIComponent(await page.getAttribute('#app-favicon', 'href')).includes('<circle'));
      await page.evaluate(() => {
        window.__authCard.querySelector('.btn-auth-deny').click();
        return window.__pendingAuth;
      });

      // 4. Conversaciones de cualquier proyecto que necesitan atención: tarjeta sobre el compositor, número en el título
      // y punto en el favicon (rojo si alguna falló); con la pestaña oculta, si llega una nueva el título alterna con el
      // aviso hasta volver a ella.
      const tr = (key, params) => page.evaluate(([key, params]) => window.ChatI18n.t(key, params), [key, params]);
      const setRuns = runs => page.evaluate(runs => window.ChatState.set('mcp', { ...window.ChatState.get('mcp'), serverRuns: runs }), runs);
      await page.evaluate(() => {
        const sessions = window.ChatState.get('sessions');
        window.ChatState.set('sessions', { ...sessions, list: [...sessions.list,
          { id: 'at1', title: 'Espera', project: '/repo/otro', updatedAt: Date.now() },
          { id: 'at2', title: 'Informe', agent: 'informes.diario', updatedAt: Date.now() }] });
      });
      const waiting = { conversationId: 'at1', runId: 'r1', status: 'needs_input' };
      await setRuns([waiting]);
      const chatsDetail = await tr('attention_notice_chats', { detail: await tr('attention_notice_waiting', { count: 1 }) });
      assert.deepEqual(await page.$eval('#attention-notice', notice => [notice.hidden, notice.textContent.trim()]),
        [false, await tr('attention_notice', { groups: chatsDetail })]);
      assert.equal(await page.title(), `(1) ${baseTitle}`);
      // Cerrarlo oculta solo la tarjeta, hasta que aparezca algo que no estaba.
      await page.click('#btn-dismiss-attention');
      assert.equal(await page.isHidden('#attention-notice'), true);
      assert.equal(await page.title(), `(1) ${baseTitle}`);
      await setRuns([{ ...waiting }]);
      assert.equal(await page.isHidden('#attention-notice'), true);
      const danger = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--danger').trim());
      assert.ok(!decodeURIComponent(await page.getAttribute('#app-favicon', 'href')).includes(`fill="${danger}"`));

      await setHidden(true);
      await setRuns([waiting, { conversationId: 'at2', runId: 'r2', status: 'error' }]);
      assert.ok(decodeURIComponent(await page.getAttribute('#app-favicon', 'href')).includes(`fill="${danger}"`));
      assert.equal(await page.isHidden('#attention-notice'), false, 'Una conversación nueva vuelve a mostrar la tarjeta cerrada');
      const agentsDetail = await tr('attention_notice_agents', { detail: await tr('attention_notice_error', { count: 1 }) });
      assert.equal(await page.textContent('#attention-notice-text'), await tr('attention_notice', { groups: `${agentsDetail} · ${chatsDetail}` }));
      await page.waitForFunction(expected => document.title === expected, await tr('tab_alert_attention', { count: 2, title: baseTitle }));

      await setHidden(false);
      assert.equal(await page.title(), `(2) ${baseTitle}`);
      await setRuns([]);
      assert.equal(await page.title(), baseTitle);
      assert.equal(await page.isHidden('#attention-notice'), true);
      assert.ok(!decodeURIComponent(await page.getAttribute('#app-favicon', 'href')).includes('<circle'));
    });
  });
});
