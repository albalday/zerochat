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
    const alignment = await page.evaluate(() => {
      const menu = document.getElementById('active-profile-popover').getBoundingClientRect();
      const trigger = document.getElementById('active-profile-trigger').getBoundingClientRect();
      const header = document.querySelector('.app-header').getBoundingClientRect();
      const messagesList = document.getElementById('messages-list').getBoundingClientRect();
      const triggerCenter = trigger.left + trigger.width / 2;
      const menuCenter = menu.left + menu.width / 2;
      const headerCenter = header.left + header.width / 2;
      return {
        popoverOffset: Math.abs(triggerCenter - menuCenter),
        headerOffset: Math.abs(headerCenter - triggerCenter),
        headerBottom: header.bottom,
        messagesTop: messagesList.top
      };
    });
    assert.ok(alignment.popoverOffset <= 2, `El popover debe estar centrado respecto al trigger (desv: ${alignment.popoverOffset}px)`);
    assert.ok(alignment.headerOffset <= 2, `El selector de perfiles debe estar centrado en el panel superior (desv: ${alignment.headerOffset}px)`);
    assert.ok(alignment.messagesTop >= alignment.headerBottom - 1, 'El chat (#messages-list) no debe pasar por encima del panel superior');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#active-profile-popover').isVisible(), false);
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:mirror"]) [data-profile-action="edit"]');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), true);
    assert.equal(await page.locator('#btn-delete-profile').count(), 0);
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

test('Browser UI - el capítulo Navegador del perfil exige Playwright MCP con un navegador instalado y lo reinicia si usa otro sin cambiar si queda recordado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await openProfilesPage(browser, [{ id: 'profile:web', name: 'Web', settings: { apiType: 'openai', model: 'test', apiKey: 'sk-test' } }]);
    // Playwright MCP en marcha con el Chromium propio; instalados Chromium y WebKit, en el sistema Edge y Chromium.
    await page.evaluate(() => {
      window.ChatState.set('mcp', { status: 'connected', externalServers: [
        { id: 'playwright', displayName: { es: 'Playwright MCP' }, status: 'running', enabled: true, browser: { mode: 'own', engine: 'chromium' } }
      ] });
      window.__actions = [];
      const setStatus = status => window.ChatState.set('mcp', state => ({ ...state, externalServers: state.externalServers.map(server => ({ ...server, status })) }));
      window.ChatMCP.manager.requestExternalControl = async () => ({
        available: true, systemBrowsers: { chrome: false, msedge: true, chromium: true }, extensions: {},
        engines: [{ id: 'chromium', installed: true }, { id: 'firefox', installed: false }, { id: 'webkit', installed: true }]
      });
      window.ChatMCP.manager.stopExternalServer = async serverId => { window.__actions.push({ stop: serverId }); setStatus('stopped'); };
      window.ChatMCP.manager.startExternalServer = async (serverId, onWait, options) => { window.__actions.push({ start: serverId, ...options }); setStatus('running'); };
    });
    await openProfileEditor(page, 'profile:web');
    assert.equal(await page.textContent('#profile-summary-browser'), 'El de Ajustes', 'Sin exigir nada usa lo de Ajustes');
    await page.click('#profile-chapter-browser summary');
    await page.check('input[name="profile-browser-required"]');
    const options = () => page.locator('#profile-browser-name option').evaluateAll(items => items.map(item => item.textContent));
    assert.deepEqual(await options(), ['Chromium', 'WebKit'], 'Solo los motores instalados');
    // Con el navegador propio puede pedir almacenamiento persistente y la ventana visible, que se conservan al cambiar de motor.
    await page.fill('#profile-browser-storage', '  trabajo_1  ');
    await page.check('input[name="profile-browser-show-window"]');
    await page.selectOption('#profile-browser-name', 'webkit');
    assert.equal(await page.isChecked('input[name="profile-browser-show-window"]'), true);
    assert.equal(await page.inputValue('#profile-browser-storage'), 'trabajo_1');
    assert.equal(await page.textContent('#profile-summary-browser'), 'Playwright MCP · WebKit propio (trabajo_1) con ventana');
    await page.check('input[name="profile-browser-mode"][value="user"]');
    assert.deepEqual(await options(), ['Microsoft Edge', 'Chromium'], 'Solo los navegadores detectados');
    await page.selectOption('#profile-browser-name', 'chromium');
    assert.equal(await page.textContent('#profile-summary-browser'), 'Playwright MCP · tu Chromium');
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    const required = { mode: 'user', userBrowser: 'chromium' };
    assert.deepEqual(await page.evaluate(() => window.ChatProfileRepository.get('profile:web').settings.playwrightBrowser), required);
    // Al activarse, Playwright MCP en marcha con otro navegador se reinicia en silencio con el del perfil
    // y sigue recordado para la siguiente sesión, como estaba (detenerlo lo desmarca).
    await page.waitForFunction(() => window.__actions.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__actions), [{ stop: 'playwright' }, { start: 'playwright', remember: true, browser: required }]);
    assert.equal(await page.evaluate(() => document.getElementById('notice-dialog').open), false);

    // Ajustes › Navegador avisa de que el perfil activo manda sobre su herramienta.
    if (await page.locator('#sidebar-view-settings').isHidden()) await page.click('#btn-open-settings');
    await page.locator('#sidebar-settings-nav [data-section="browser"]').evaluate(item => item.click());
    await page.waitForFunction(() => document.getElementById('settings-dialog').open);
    assert.match(await page.textContent('#settings-browser .browser-notice'), /El perfil activo «Web» necesita Playwright MCP con tu Chromium/);
  } finally {
    await browser.close();
  }
});

test('Browser UI - el capítulo MCP del perfil avisa de los servicios no configurados y guarda lo elegido', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await openProfilesPage(browser, [{ id: 'profile:mcp', name: 'Con MCP', settings: { apiType: 'openai', model: 'test', apiKey: 'sk-test', mcpServers: ['ghost'] } }]);
    // Servidor local conectado: Memoria está parada y Playwright ya en marcha. El arranque se
    // sustituye para registrar qué servicios arranca el perfil.
    await page.evaluate(() => {
      window.ChatState.set('mcp', { status: 'connected', externalServers: [
        { id: 'memory', displayName: { es: 'Memoria', en: 'Memory' }, status: 'stopped' },
        { id: 'playwright', displayName: { es: 'Playwright MCP' }, status: 'running' }
      ] });
      window.__started = [];
      window.ChatMCP.manager.startExternalServer = async (serverId, onWait, options) => {
        window.__started.push({ serverId, ...options });
        window.ChatState.set('mcp', state => ({ ...state, externalServers: state.externalServers.map(server => (server.id === serverId ? { ...server, status: 'running' } : server)) }));
      };
    });
    await openProfileEditor(page, 'profile:mcp');
    const rows = () => page.locator('.profile-mcp-server').evaluateAll(labels => labels.map(label => ({
      name: label.querySelector('.profile-mcp-name').textContent,
      checked: label.querySelector('input').checked,
      missing: label.classList.contains('is-missing')
    })));
    assert.deepEqual(await rows(), [{ name: 'Memoria', checked: false, missing: false }, { name: 'ghost', checked: true, missing: true }], 'Playwright se elige en Ajustes › Navegador');
    assert.equal(await page.textContent('#profile-summary-mcp'), 'ghost');
    assert.equal(await page.textContent('#profile-summary-mcp-warning'), '1 no configurado(s)', 'El aviso se ve con el capítulo plegado');

    await page.click('#profile-chapter-mcp summary');
    await page.check('.profile-mcp-checkbox[value="memory"]');
    await page.uncheck('.profile-mcp-checkbox[value="ghost"]');
    assert.equal(await page.textContent('#profile-summary-mcp'), 'Memoria');
    assert.equal(await page.locator('#profile-summary-mcp-warning').isVisible(), false);
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.deepEqual(await page.evaluate(() => window.ChatProfileRepository.get('profile:mcp').settings.mcpServers), ['memory']);
    // Solo arranca lo que estaba parado, sin recordarlo y sin mostrar diálogo de éxito.
    await page.waitForFunction(() => window.__started.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__started), [{ serverId: 'memory', remember: false }]);
    assert.equal(await page.evaluate(() => document.getElementById('notice-dialog').open), false);
  } finally {
    await browser.close();
  }
});

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

    // Solo existe un botón Guardar (no hay botón separado para servidor)
    assert.equal(await page.$('#setting-profile-scope'), null);
    assert.equal(await page.$('#btn-save-server-profile'), null);
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

test('Browser UI - el selector de perfiles en móvil (< 640px) se muestra a pantalla completa y se cierra correctamente', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // Abrir menú de perfiles
    await page.click('#active-profile-trigger');
    await page.waitForFunction(() => !document.getElementById('active-profile-popover').hidden);

    // En móvil el popover pasa a position: fixed (pantalla completa)
    const position = await page.$eval('#active-profile-popover', el => window.getComputedStyle(el).position);
    assert.equal(position, 'fixed');
    const dimensions = await page.evaluate(() => {
      const rect = document.getElementById('active-profile-popover').getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        windowWidth: window.innerWidth
      };
    });
    assert.equal(dimensions.left, 0);
    assert.equal(dimensions.top, 0);
    assert.ok(Math.abs(dimensions.width - dimensions.windowWidth) <= 1, 'El panel debe ocupar el 100% del ancho de la pantalla');

    // Cerrar menú con el botón de cierre
    await page.click('#btn-menu-close-profiles');
    await page.waitForFunction(() => document.getElementById('active-profile-popover').hidden);
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
    assert.equal(await page.$('#btn-menu-server-run'), null);
    assert.equal(await page.$('#btn-menu-server-manage'), null);
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

test('Browser UI - cambiar de serverId con perfiles previos pregunta antes de fusionar y por defecto usa los del servidor', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // Simular perfiles previamente sincronizados con srv-A y conectar ahora a srv-B sin mezclar.
    const resultPromise = page.evaluate(async () => {
      const repo = window.ChatProfileRepository;
      await repo.syncWithBackend({
        serverId: 'srv-A',
        listRemote: async () => [{ id: 'profile:a', name: 'De A', hasApiKey: false, updatedAt: 1000, settings: { apiType: 'openai', model: 'm-a' } }],
        saveRemote: async p => p,
        deleteRemote: async () => true
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
      window._uploadedOnChange = [];
      mcp.saveServerProfile = async p => {
        window._uploadedOnChange.push(p);
        return p;
      };
      return mcp.syncProfiles('srv-B', { onServerChange: window.ChatUIProfiles.confirmServerProfileSync });
    });

    // Debe abrirse el diálogo con la opción por defecto (cancel = Usar los de este servidor).
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-cancel');

    const syncResult = await resultPromise;
    assert.equal(syncResult.replaced, true);
    assert.deepEqual(await page.evaluate(() => window._uploadedOnChange), []);
    assert.equal(await page.evaluate(() => window.ChatProfileRepository.get('profile:a')), null);
    assert.ok(await page.evaluate(() => window.ChatProfileRepository.get('profile:b')));
  } finally {
    await browser.close();
  }
});

});
