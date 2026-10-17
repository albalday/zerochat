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
