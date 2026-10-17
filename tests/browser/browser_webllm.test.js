const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - webllm', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
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
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');

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
              webllmConfig: { context_window_size: '32768', prefill_chunk_size: 'default' }
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
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // 1. El valor heredado 'default' pasa a 16K y el badge muestra 16.4k (no 1M)
    const defaultContext = await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit);
    assert.equal(defaultContext, 16384);
    const badgeText = await page.$eval('#connection-tokens-text', el => el.textContent);
    assert.match(badgeText, /16(\.4)?k/i);
    assert.doesNotMatch(badgeText, /1M/);

    // 2. Al cambiar a perfil con parámetro avanzado 32768, el límite se actualiza a 32768 y badge a 32.8k
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:webllm-8k"]');
    const customContext = await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit);
    assert.equal(customContext, 32768);
    const updatedBadge = await page.$eval('#connection-tokens-text', el => el.textContent);
    assert.match(updatedBadge, /32(\.8)?k/i);
  } finally {
    await browser.close();
  }
});

test('Browser UI - WebLLM arranca Web Worker modular', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const filePath = getIndexUrl();
    await page.goto(filePath, { waitUntil: 'load' });
    await waitForAppReady(page);

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
