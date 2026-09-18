const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

describe('Browser UI - webllm', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - WebLLM permite elegir si envía reasoning_effort none', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.evaluate(() => window.ChatConfig.updateRuntime({
      apiType: 'webllm', apiUrl: 'webllm://local', reasoningEffort: 'none', reasoningTransport: 'auto'
    }));
    await page.click('#btn-reasoning');
    await page.waitForSelector('[data-reasoning-transport="send-none"]');
    assert.equal(await page.locator('[data-reasoning-transport="omit"]').getAttribute('aria-checked'), 'true');
    await page.click('[data-reasoning-transport="send-none"]');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().reasoningTransport), 'send-none');
  } finally { await browser.close(); }
});

test('Browser UI - WebLLM muestra enlace de ayuda online y lo oculta en otros proveedores', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-general"]');
    await page.click('#btn-manage-profiles');
    await page.click('#profile-tab-settings');

    // Inicialmente con OpenAI el enlace de ayuda está oculto
    const initialLinkHidden = await page.$eval('#webllm-help-link', el => el.hidden);
    assert.equal(initialLinkHidden, true);

    // Cambiar a WebLLM muestra el enlace de ayuda con target=_blank y rel seguro
    await page.selectOption('#setting-api-type', 'webllm');
    const webllmLinkState = await page.$eval('#webllm-help-link', el => ({
      hidden: el.hidden,
      href: el.getAttribute('href'),
      target: el.getAttribute('target'),
      rel: el.getAttribute('rel')
    }));
    assert.equal(webllmLinkState.hidden, false);
    assert.equal(webllmLinkState.href, 'http://albalday.github.io/zerochat/help/webllm.html');
    assert.equal(webllmLinkState.target, '_blank');
    assert.ok(webllmLinkState.rel.includes('noopener'));

    // Cambiar de nuevo a OpenAI oculta el enlace
    await page.selectOption('#setting-api-type', 'openai');
    const finalLinkHidden = await page.$eval('#webllm-help-link', el => el.hidden);
    assert.equal(finalLinkHidden, true);
  } finally {
    await browser.close();
  }
});

test('Browser UI - WebLLM muestra engranaje de parámetros avanzados y conmuta panel', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-general"]');
    await page.click('#btn-manage-profiles');
    await page.click('#profile-tab-settings');

    // Inicialmente con OpenAI el botón de parámetros y el panel están ocultos
    assert.equal(await page.$eval('#btn-webllm-params', el => el.hidden), true);
    assert.equal(await page.$eval('#webllm-params-panel', el => el.hidden), true);

    // Cambiar a WebLLM muestra el botón de engranaje
    await page.selectOption('#setting-api-type', 'webllm');
    assert.equal(await page.$eval('#btn-webllm-params', el => el.hidden), false);
    assert.equal(await page.$eval('#webllm-params-panel', el => el.hidden), true);

    // Pulsar el botón abre el panel
    await page.click('#btn-webllm-params');
    assert.equal(await page.$eval('#webllm-params-panel', el => el.hidden), false);
    assert.equal(await page.$eval('#btn-webllm-params', el => el.classList.contains('active')), true);

    // Seleccionar valores en los desplegables
    await page.selectOption('#setting-webllm-context-window', '8192');
    await page.selectOption('#setting-webllm-prefill-chunk', '2048');
    assert.equal(await page.$eval('#setting-webllm-context-window', el => el.value), '8192');
    assert.equal(await page.$eval('#setting-webllm-prefill-chunk', el => el.value), '2048');

    // Pulsar el botón de nuevo lo oculta
    await page.click('#btn-webllm-params');
    assert.equal(await page.$eval('#webllm-params-panel', el => el.hidden), true);
    assert.equal(await page.$eval('#btn-webllm-params', el => el.classList.contains('active')), false);

    // Cambiar a OpenAI oculta tanto el botón como el panel
    await page.selectOption('#setting-api-type', 'openai');
    assert.equal(await page.$eval('#btn-webllm-params', el => el.hidden), true);
    assert.equal(await page.$eval('#webllm-params-panel', el => el.hidden), true);
  } finally {
    await browser.close();
  }
});

test('Browser UI - WebLLM con modelo descargado permite guardar sin consulta y muestra modelos descargados primero', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => {
      localStorage.setItem("zerochat_webllm_completed_models_v1", JSON.stringify(["test-downloaded-model"]));
      localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" }));
    });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
    await page.click('[data-section="tab-general"]');
    await page.click('#btn-manage-profiles');
    await page.click('#profile-tab-settings');

    // Cambiar a WebLLM
    await page.selectOption('#setting-api-type', 'webllm');

    // Verificar que el modelo descargado aparece en el helper
    const options = await page.$$eval('#model-select-helper option', opts => opts.map(o => o.value));
    assert.ok(options.includes('test-downloaded-model'), 'El modelo descargado debe figurar en las opciones');

    // Seleccionar el modelo descargado
    await page.selectOption('#model-select-helper', 'test-downloaded-model');

    // Comprobar que guardar se habilita sin necesidad de Query
    const saveState = await page.evaluate(() => ({
      disabled: document.getElementById('btn-save-profile').disabled,
      hint: document.getElementById('profile-save-query-hint').textContent
    }));
    assert.equal(saveState.disabled, false, 'El botón Guardar debe habilitarse con modelo descargado');
    assert.match(saveState.hint, /opcional/i, 'La pista debe indicar que la consulta es opcional');

    // Guardar el perfil y verificar que se guarda y se cierra
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), false);
  } finally {
    await browser.close();
  }
});

test('Browser UI - WebLLM sincroniza el límite de contexto del modelo y los parámetros avanzados', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('zerochat_profiles_v1', JSON.stringify({
        schemaVersion: 1,
        profiles: [
          {
            id: 'profile:webllm',
            name: 'WebLLM local',
            settings: {
              apiType: 'webllm',
              apiUrl: 'webllm://local',
              model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
              webllmConfig: { context_window_size: 'default', prefill_chunk_size: 'default' }
            }
          },
          {
            id: 'profile:webllm-8k',
            name: 'WebLLM 8K',
            settings: {
              apiType: 'webllm',
              apiUrl: 'webllm://local',
              model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
              webllmConfig: { context_window_size: '8192', prefill_chunk_size: 'default' }
            }
          }
        ]
      }));
      localStorage.setItem('zerochat_runtime_config_v2', JSON.stringify({
        activeProfile: { id: 'profile:webllm', name: 'WebLLM local' },
        apiType: 'webllm',
        apiUrl: 'webllm://local',
        model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        webllmConfig: { context_window_size: 'default', prefill_chunk_size: 'default' }
      }));
    });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. Con 'default', el límite publicado se sincroniza a 4096 y el badge muestra 4.1k (no 1M)
    const defaultContext = await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit);
    assert.equal(defaultContext, 4096);
    const badgeText = await page.$eval('#connection-tokens-text', el => el.textContent);
    assert.match(badgeText, /4(\.1)?k/i);
    assert.doesNotMatch(badgeText, /1M/);

    // 2. Al cambiar a perfil con parámetro avanzado 8192, el límite se actualiza a 8192 y badge a 8.2k
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:webllm-8k"]');
    const customContext = await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit);
    assert.equal(customContext, 8192);
    const updatedBadge = await page.$eval('#connection-tokens-text', el => el.textContent);
    assert.match(updatedBadge, /8(\.2)?k/i);
  } finally {
    await browser.close();
  }
});

test('Browser UI - WebLLM arranca Web Worker modular', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    const result = await page.evaluate(async () => {
      try {
        if (!window.ChatWebLLM) return { ok: false, error: 'ChatWebLLM no está definido' };
        let workerCreated = false;

        const fakeWebLLM = {
          CreateWebWorkerMLCEngine: async (worker, modelId, opts) => {
            workerCreated = true;
            return {
              unload: async () => {}
            };
          }
        };

        const handle = await window.ChatWebLLM.createWorkerEngine(fakeWebLLM, 'test-model', {}, () => {}, null);
        await handle.release();
        return { ok: true, workerCreated };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code };
      }
    });

    assert.equal(result.ok, true, `Worker modular debe arrancar sin fallar: ${result.error || ''}`);
    assert.equal(result.workerCreated, true);
  } finally {
    await browser.close();
  }
});
});
