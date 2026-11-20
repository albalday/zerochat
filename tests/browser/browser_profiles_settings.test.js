const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - profiles_settings', { concurrency: 4 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - perfiles: teclado, alineación, solo lectura y borrado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedConnectionProfiles(page);
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await page.focus('#active-profile-trigger');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[data-profile-id="profile:mirror"]').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#active-profile-popover').isVisible(), false);
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:mirror"]) [data-profile-action="edit"]');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), true);
    await page.click('#btn-close-profiles');

    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:remote"]) [data-profile-action="edit"]');
    assert.equal(await page.locator('#setting-api-key').isEnabled(), true);
    await page.selectOption('#setting-api-type', 'webllm');
    assert.equal(await page.inputValue('#setting-api-url'), 'webllm://local');
    assert.equal(await page.locator('.api-key-field').isHidden(), true);
    await page.evaluate(() => {
      window.ChatAPI.fetchServerModels = async () => {
        // Una actualización concurrente de la conexión activa no puede
        // sobrescribir el borrador que se está validando en el editor.
        window.ChatConfig.updateRuntime({ modelContextLimit: 8192 });
        return {
          success: true,
          count: 2,
          endpoint: 'webllm://local',
          models: [
            { id: 'model-cached', details: { webllmCache: 'cached', webllmVramMB: 512 } },
            { id: 'model-missing', details: { webllmCache: 'missing', webllmVramMB: 768 } }
          ]
        };
      };
    });
    await page.click('#btn-query-server');
    await page.waitForSelector('#server-query-status.status-success');
    assert.equal(await page.inputValue('#setting-api-type'), 'webllm', 'Query no debe reaplicar el perfil activo sobre el editor');
    assert.equal(await page.inputValue('#setting-api-url'), 'webllm://local');
    assert.equal(await page.inputValue('#setting-model'), 'model-cached');
    assert.deepEqual(await page.locator('#model-select-helper option').evaluateAll(options => options.map(option => option.value)), ['', 'model-cached']);
    await page.selectOption('#setting-api-type', 'openai');
    assert.equal(await page.inputValue('#setting-api-url'), 'http://localhost:1234/v1');
    assert.equal(await page.locator('.api-key-field').isVisible(), true);
    await page.click('#btn-close-profiles');
    await page.click('#notice-accept');
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:remote"]) [data-profile-action="delete"]');
    await page.click('#notice-accept');
    assert.equal(await page.textContent('#active-profile-name'), 'Espejo');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().apiKey), undefined);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.textContent('#active-profile-name'), 'Espejo');
    await page.fill('#user-input', 'Mirror regression test');
    await page.click('#btn-send');
    await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
    const reply = await page.evaluate(() => window.ChatState.get('messages').findLast(message => message.role === 'assistant')?.content);
    const payload = JSON.parse(reply.match(/```json\n([^\n]+)\n```$/)[1]);
    assert.ok(payload.messages.some(message => message.content === 'Mirror regression test'));
    assert.ok(Array.isArray(payload.tools));
    assert.match(reply, /^# Bienvenido a ZeroChat/m);
    assert.match(reply, /WebLLM \(experimental\)/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - editor de perfiles: modelo libre, bloqueo, cierre con confirmación y perfil nuevo vacío', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await openProfilesPage(browser, [
      { id: 'profile:unlocked-test', name: 'Unlocked test', settings: { apiType: 'openai', model: 'test', apiKey: '' } },
      { id: 'profile:locked-test', name: 'Locked test', settings: { apiType: 'openai', model: 'test', apiKey: 'sk-locked', apiKeyLocked: true } }
    ]);

    // 1. Perfil nuevo abre vacío sin pedir nombre ni heredar clave; sin cambios no crea registro
    await openProfileEditor(page, 'profile:locked-test');
    assert.equal(await page.locator('#api-key-locked-status').isVisible(), true);
    assert.equal(await page.locator('#api-key-lock-control').isVisible(), false);
    for (const selector of ['#setting-profile-name', '#setting-api-url', '#setting-api-key', '#setting-model', '#setting-system-prompt', '#setting-temperature']) {
      assert.equal(await page.locator(selector).isDisabled(), true, `${selector} debe quedar bloqueado`);
    }
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);

    await page.click('#active-profile-trigger');
    await page.click('#btn-menu-new-profile');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    const emptyNew = await page.evaluate(() => ({
      notice: document.getElementById('notice-dialog').open,
      name: document.getElementById('setting-profile-name').value,
      description: document.getElementById('setting-profile-description').value,
      apiKey: document.getElementById('setting-api-key').value,
      locked: document.getElementById('setting-api-key-locked').checked,
      saveDisabled: document.getElementById('btn-save-profile').disabled
    }));
    assert.deepEqual(emptyNew, { notice: false, name: '', description: '', apiKey: '', locked: false, saveDisabled: false });
    const beforeCount = await page.evaluate(() => window.ChatProfileRepository.list().length);
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.evaluate(() => window.ChatProfileRepository.list().length), beforeCount);

    // 2. El borrador no bloquea antes de guardar y cerrar con cambios o consulta pide confirmación
    await openProfileEditor(page, 'profile:unlocked-test');
    await page.check('#setting-api-key-locked');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), false);
    await closeProfileEditor(page, { discard: true });

    await openProfileEditor(page, 'profile:local');
    await closeProfileEditor(page);
    assert.equal(await page.$eval('#notice-dialog', d => d.open), false);

    await openProfileEditor(page, 'profile:local');
    const initialModel = await page.locator('#setting-model').inputValue();
    await page.fill('#setting-model', 'modelo-personalizado');
    assert.equal(await page.textContent('#profile-save-query-hint'), 'Hay cambios pendientes. Guarda el perfil para conservarlos.');
    await page.fill('#setting-model', initialModel);
    assert.equal(await page.textContent('#profile-save-query-hint'), 'Hay cambios pendientes. Guarda el perfil para conservarlos.');
    assert.equal(await page.locator('#profile-chapter-behavior').evaluate(c => c.open), false);
    await page.click('#profile-chapter-behavior summary');
    await page.fill('#setting-system-prompt', 'Instrucción personalizada');
    await page.click('#profile-chapter-behavior summary');
    assert.match(await page.textContent('#profile-summary-behavior'), /^Prompt propio · temperatura /);

    await page.click('#btn-close-profiles');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', d => d.open), true);
    await closeProfileEditor(page, { discard: true });

    await openProfileEditor(page, 'profile:local');
    assert.equal(await page.inputValue('#setting-model'), 'google/gemma-4-26b-a4b-qat');
    await page.evaluate(() => {
      window.ChatAPI.fetchServerModels = async () => ({ success: true, count: 1, endpoint: 'http://localhost:1234/v1', models: [{ id: 'google/gemma-4-26b-a4b-qat' }] });
    });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => document.getElementById('profile-save-query-hint').textContent === 'Hay cambios pendientes. Guarda el perfil para conservarlos.');
    await page.mouse.click(10, 10);
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.match(await page.textContent('#notice-message'), /no se ha guardado/);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);

    // 3. Borrar un perfil bloqueado lo retira de lista y almacenamiento
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:locked-test"]) [data-profile-action="delete"]');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => window.ChatProfileRepository.get('profile:locked-test') === null);
  } finally {
    await browser.close();
  }
});

test('Browser UI - menú de perfiles: activar perfil, límite cacheado LM Studio y guardar Ajustes sin alterar conexión', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      localStorage.setItem('zerochat_cached_models', JSON.stringify({
        version: 1,
        connections: {
          'openai:http://localhost:1234/v1': [{
            id: 'google/gemma-4-26b-a4b-qat',
            details: { loaded_context_length: 90112, max_context_length: 262144 }
          }]
        }
      }));
    });
    await seedConnectionProfiles(page);
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.click('#active-profile-trigger');
    const mirror = page.locator('.header-profile-item:has([data-profile-id="profile:mirror"])');
    assert.equal(await mirror.evaluate(item => item.classList.contains('active')), true);
    assert.equal(await mirror.locator('[role="menuitemradio"]').getAttribute('aria-checked'), 'true');
    assert.deepEqual(
      await page.$$eval('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action]', b => b.map(x => x.dataset.profileAction)),
      ['inspect', 'edit', 'delete']
    );

    await page.click('[data-profile-id="profile:remote"]');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit), null);
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:local"]');
    assert.equal(await page.locator('#active-profile-popover').isHidden(), true);
    assert.equal(await page.textContent('#active-profile-name'), 'Local chat');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit), 90112);

    await openProfileEditor(page, 'profile:remote');
    await closeProfileEditor(page);
    await page.click('#btn-open-settings');
    await page.locator('#sidebar-settings-nav [data-section="model"]').evaluate(item => item.click());
    await page.waitForFunction(() => document.getElementById('settings-dialog').open);
    await page.fill('#setting-system-data-prompt', 'Datos propios');
    await page.click('#btn-save-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);
    assert.deepEqual(await page.evaluate(() => {
      const { activeProfile, apiType, apiUrl, model, systemDataPrompt } = window.ChatConfig.getActive();
      return { profile: activeProfile.id, apiType, apiUrl, model, systemDataPrompt };
    }), { profile: 'profile:local', apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: 'google/gemma-4-26b-a4b-qat', systemDataPrompt: 'Datos propios' });
  } finally {
    await browser.close();
  }
});

/** Página con los perfiles de prueba y, si se indican, perfiles editables guardados en el repositorio. */
async function openProfilesPage(browser, profiles = []) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await seedConnectionProfiles(page);
  await page.goto(getIndexUrl(), { waitUntil: 'load' });
  await waitForAppReady(page);
  if (profiles.length) {
    await page.evaluate(async profiles => {
      for (const profile of profiles) await window.ChatProfileRepository.saveEditable(profile);
    }, profiles);
  }
  return page;
}

async function openProfileEditor(page, profileId) {
  await page.click('#active-profile-trigger');
  await page.click(`.header-profile-item:has([data-profile-id="${profileId}"]) [data-profile-action="edit"]`);
  await page.waitForFunction(() => document.getElementById('profiles-dialog').open && !document.getElementById('btn-save-profile').disabled);
}

async function closeProfileEditor(page, { discard = false } = {}) {
  await page.click('#btn-close-profiles');
  if (discard) {
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
  }
  await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
}

test('Browser UI - el editor guarda con un único botón en ambos repositorios y unifica el panel de perfiles', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // Abrir modal de nuevo perfil
    await page.click('#active-profile-trigger');
    await page.click('#btn-menu-new-profile');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);

    assert.notEqual(await page.$('#btn-save-profile'), null);

    // Escribir datos del perfil
    await page.fill('#setting-profile-name', 'Mi Perfil Unificado');
    await page.fill('#setting-api-url', 'http://localhost:11434/v1');
    await page.fill('#setting-model', 'llama3');

    // Mockear saveServerProfile en el cliente MCP
    await page.evaluate(() => {
      window._savedServerProfiles = [];
      const mcp = window.ChatMCP.manager;
      mcp.isProxyConnected = () => true;
      mcp.saveServerProfile = async record => {
        window._savedServerProfiles.push(record);
        return record;
      };
    });

    // Un único botón Guardar persiste en navegador y servidor
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);

    const serverCalls = await page.evaluate(() => window._savedServerProfiles);
    assert.equal(serverCalls.length, 1);
    assert.equal(serverCalls[0].name, 'Mi Perfil Unificado');
    assert.equal(serverCalls[0].settings.model, 'llama3');
    assert.equal(serverCalls[0].id, 'profile:Mi%20Perfil%20Unificado');
    assert.ok(Number(serverCalls[0].updatedAt) > 0);

    assert.equal((await page.textContent('#active-profile-name')).trim(), 'Mi Perfil Unificado');
    const localProfile = await page.evaluate(() => window.ChatProfileRepository.get('profile:Mi%20Perfil%20Unificado'));
    assert.ok(localProfile);
    assert.equal(localProfile.synced, true);
    assert.equal(localProfile.updatedAt, serverCalls[0].updatedAt);
  } finally {
    await browser.close();
  }
});

test('Browser UI - el selector único incluye switch superior de ejecución en segundo plano y lo bloquea para Espejo y WebLLM', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.evaluate(async () => {
      const repo = window.ChatProfileRepository;
      await repo.saveEditable({ id: 'profile:claude', name: 'Claude', settings: { apiType: 'claude', model: 'claude-3-5-sonnet', apiKey: 'sk-1' } });
      await repo.saveEditable({ id: 'profile:webgpu', name: 'WebGPU', settings: { apiType: 'webllm', model: 'Phi-3', apiKey: '' } });
      const mcp = window.ChatMCP.manager;
      mcp.isProxyConnected = () => true;
      mcp.deleteServerProfile = async id => {
        window.deletedServerProfileId = id;
        return true;
      };
      window.ChatState.set('mcp', { status: 'connected' });
      window.ChatDialogs.confirm = async () => true;
    });

    // Con Espejo activo, el switch superior está deshabilitado
    await page.click('#active-profile-trigger');
    await page.waitForFunction(() => !document.getElementById('active-profile-popover').hidden);
    assert.equal(await page.isDisabled('#toggle-background-run'), true);

    // Elegir perfil Claude habilita el switch de segundo plano
    await page.click('[data-profile-id="profile:claude"]');
    await page.click('#active-profile-trigger');
    await page.waitForFunction(() => !document.getElementById('active-profile-popover').hidden);
    assert.equal(await page.isDisabled('#toggle-background-run'), false);

    // Activar switch de ejecución en segundo plano
    await page.click('.profile-background-bar .switch');
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), true);
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);
    assert.equal((await page.textContent('#active-profile-name')).trim(), 'Claude');

    // Al abrir un nuevo chat se conserva el switch activo
    await page.click('#btn-menu-close-profiles');
    await page.click('#btn-sidebar-new-chat');
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), true);
    assert.equal(await page.locator('#active-profile-trigger.server-mode').count(), 1);

    // Cambiar a un perfil WebLLM apaga y deshabilita el switch
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:webgpu"]');
    assert.equal(await page.evaluate(() => window.ChatUIProfiles.isServerMode()), false);
    await page.click('#active-profile-trigger');
    assert.equal(await page.isDisabled('#toggle-background-run'), true);

    // Borrar el perfil Claude conectado también llama a deleteServerProfile
    await page.click('.header-profile-item:has([data-profile-id="profile:claude"]) [data-profile-action="delete"]');
    await page.waitForFunction(() => window.deletedServerProfileId === 'profile:claude');
    assert.equal(await page.evaluate(() => window.ChatProfileRepository.get('profile:claude')), null);
  } finally {
    await browser.close();
  }
});

test('Browser UI - cambiar de serverId con perfiles previos pregunta antes de fusionar y cancelar conserva los locales', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // Simular perfiles previamente sincronizados con srv-A y conectar ahora a srv-B.
    const resultPromise = page.evaluate(async () => {
      const repo = window.ChatProfileRepository;
      await repo.syncWithBackend({
        serverId: 'srv-A',
        listRemote: async () => [{ id: 'profile:a', name: 'De A', hasApiKey: false, updatedAt: 1000, settings: { apiType: 'openai', model: 'm-a' } }],
        saveRemote: async p => p
      });
      const mcp = window.ChatMCP.manager;
      mcp.clients.set('mcp_proxy', {
        request: async method => {
          if (method === 'zerochat/profiles/list') {
            return { profiles: [{ id: 'profile:b', name: 'De B', hasApiKey: false, updatedAt: 2000, settings: { apiType: 'ollama', model: 'm-b' } }] };
          }
          return {};
        }
      });
      return mcp.syncProfiles('srv-B', { onServerChange: window.ChatUIProfiles.confirmServerProfileSync });
    });

    // Debe abrirse el diálogo; al cancelar, no sincroniza ni borra los perfiles locales.
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-cancel');

    const syncResult = await resultPromise;
    assert.equal(syncResult.cancelled, true);
    const localIds = await page.evaluate(() => window.ChatProfileRepository.list().map(p => p.id));
    assert.ok(localIds.includes('profile:a'));
  } finally {
    await browser.close();
  }
});

});
