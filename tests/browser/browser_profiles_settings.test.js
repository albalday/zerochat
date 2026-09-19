const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

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
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.focus('#active-profile-trigger');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[data-profile-id="profile:mirror"]').evaluate(el => el === document.activeElement), true);
    const alignment = await page.evaluate(() => {
      const menu = document.getElementById('active-profile-popover').getBoundingClientRect();
      const trigger = document.getElementById('active-profile-trigger').getBoundingClientRect();
      const triggerCenter = trigger.left + trigger.width / 2;
      const menuCenter = menu.left + menu.width / 2;
      return Math.abs(triggerCenter - menuCenter);
    });
    assert.ok(alignment <= 2, `El popover debe estar centrado respecto al trigger (desv: ${alignment}px)`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#active-profile-popover').isVisible(), false);
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), true);
    assert.equal(await page.locator('#btn-delete-profile').isDisabled(), true);
    assert.equal(await page.locator('#btn-clone-profile').count(), 0);
    await page.selectOption('#profile-select-helper', 'profile:remote');
    await page.click('#profile-tab-settings');
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
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.dataset.queryReady === 'true');
    assert.equal(await page.inputValue('#setting-api-type'), 'webllm', 'Query no debe reaplicar el perfil activo sobre el editor');
    assert.equal(await page.inputValue('#setting-api-url'), 'webllm://local');
    assert.equal(await page.inputValue('#setting-model'), 'model-cached');
    assert.deepEqual(await page.locator('#model-select-helper option').evaluateAll(options => options.map(option => option.value)), ['', 'model-cached']);
    await page.selectOption('#setting-api-type', 'openai');
    assert.equal(await page.inputValue('#setting-api-url'), 'http://localhost:1234/v1');
    assert.equal(await page.locator('.api-key-field').isVisible(), true);
    await page.click('#profile-tab-name');
    await page.click('#btn-delete-profile');
    await page.click('#notice-accept');
    await page.click('#btn-close-profiles');
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

test('Browser UI - guardar perfiles exige un cambio', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');

    const state = await page.evaluate(() => ({
      disabled: document.getElementById('btn-save-profile').disabled,
      hint: document.getElementById('profile-save-query-hint').textContent
    }));

    assert.equal(state.disabled, true);
    assert.match(state.hint, /Realiza algún cambio/);
  } finally {
    await browser.close();
  }
});

test('Browser UI - cualquier cambio del perfil habilita guardar, incluido un modelo libre', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem('zerochat_runtime_config_v2', JSON.stringify({
      activeProfile: { id: 'profile:local', name: 'Local chat' }, apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: 'google/gemma-4-26b-a4b-qat'
    })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.click('#profile-tab-settings');
    await page.waitForFunction(() => document.getElementById('setting-api-key')._loadedApiKey !== undefined);
    assert.equal(await page.locator('#btn-save-profile').isDisabled(), true, 'Sin cambios no debe guardarse');
    const initialModel = await page.locator('#setting-model').inputValue();
    await page.fill('#setting-model', 'modelo-personalizado');
    assert.equal(await page.locator('#btn-save-profile').isDisabled(), false, 'Un modelo escrito libremente habilita Guardar');
    await page.fill('#setting-model', initialModel);
    assert.equal(await page.locator('#btn-save-profile').isDisabled(), false, 'Al deshacer el cambio permanece habilitado');
    await page.click('#profile-tab-model');
    await page.fill('#setting-system-prompt', 'Instrucción personalizada');
    assert.equal(await page.locator('#btn-save-profile').isDisabled(), false, 'Un cambio en otra pestaña habilita Guardar');
  } finally {
    await browser.close();
  }
});

test('Browser UI - una consulta de perfil debe guardarse antes de cerrar y confirmar descarte', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.evaluate(() => {
      window.ChatUIInspector.handleQueryServer = async () => true;
    });
    await page.click('#profile-tab-settings');
    await page.click('#btn-query-server');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').dataset.queryReady === 'true');

    // 1. Pulsar botón Cerrar con consulta pendiente abre diálogo de confirmación (con Cancelar y Aceptar)
    await page.click('#btn-cancel-profiles');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);

    const stateNotice = await page.evaluate(() => ({
      profilesOpen: document.getElementById('profiles-dialog').open,
      notice: document.getElementById('notice-message').textContent,
      cancelVisible: !document.getElementById('notice-cancel').hidden
    }));
    assert.equal(stateNotice.profilesOpen, true, 'El modal de perfiles no debe cerrarse al mostrar la confirmación');
    assert.match(stateNotice.notice, /no se ha guardado/);
    assert.equal(stateNotice.cancelVisible, true, 'La confirmación debe ofrecer botón Cancelar');

    // 2. Pulsar Cancelar en el diálogo mantiene el modal de perfiles abierto y el estado queryReady
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    const stateAfterCancel = await page.evaluate(() => ({
      profilesOpen: document.getElementById('profiles-dialog').open,
      queryReady: document.getElementById('profiles-dialog').dataset.queryReady
    }));
    assert.equal(stateAfterCancel.profilesOpen, true, 'Pulsar Cancelar debe mantener el modal de perfiles abierto');
    assert.equal(stateAfterCancel.queryReady, 'true', 'queryReady debe conservarse para permitir guardar');

    // 3. Pulsar Cerrar y luego Aceptar descarta la consulta y cierra el modal
    await page.click('#btn-cancel-profiles');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    const stateAfterAccept = await page.evaluate(() => ({
      profilesOpen: document.getElementById('profiles-dialog').open,
      queryReady: document.getElementById('profiles-dialog').dataset.queryReady
    }));
    assert.equal(stateAfterAccept.profilesOpen, false, 'Pulsar Aceptar debe cerrar el modal de perfiles');
    assert.equal(stateAfterAccept.queryReady, 'false', 'queryReady debe resetearse a false al descartar');

    // 4. Probar clic fuera (backdrop) con consulta pendiente: no debe cerrar prematuramente
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    await page.click('#profile-tab-settings');
    await page.click('#btn-query-server');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').dataset.queryReady === 'true');

    // Clic en el backdrop
    await page.mouse.click(10, 10);
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), true, 'Clic en el backdrop no debe cerrar profiles-dialog antes de confirmar');

    // Cancelar en backdrop confirm
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), true, 'Cancelar confirmación de backdrop debe mantener abierto el modal');

    // Clic en backdrop de nuevo y Aceptar descarte
    await page.mouse.click(10, 10);
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), false, 'Aceptar confirmación de backdrop debe cerrar el modal');
  } finally {
    await browser.close();
  }
});

test('Browser UI - cambios sin guardar en el perfil deben solicitar confirmación antes de cerrar', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);

    // 1. Sin cambios: cerrar con botón Cancelar cierra de inmediato sin confirmación
    await page.click('#btn-cancel-profiles');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), false, 'Sin cambios debe cerrar sin confirmar');
    assert.equal(await page.$eval('#notice-dialog', el => el.open), false, 'No debe abrir notice-dialog sin cambios');

    // 2. Modificar un campo y pulsar Cerrar: debe pedir confirmación
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    await page.fill('#setting-profile-description', 'Modificación de prueba sin guardar');

    await page.click('#btn-cancel-profiles');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);

    const stateNotice = await page.evaluate(() => ({
      profilesOpen: document.getElementById('profiles-dialog').open,
      notice: document.getElementById('notice-message').textContent,
      cancelVisible: !document.getElementById('notice-cancel').hidden
    }));
    assert.equal(stateNotice.profilesOpen, true, 'El modal de perfiles debe seguir abierto mientras se confirma');
    assert.match(stateNotice.notice, /cambios sin guardar/i, 'El mensaje debe advertir de cambios sin guardar');
    assert.equal(stateNotice.cancelVisible, true, 'Debe mostrar botón Cancelar');

    // 3. Cancelar en el diálogo: el modal de perfiles permanece abierto
    await page.click('#notice-cancel');
    await page.waitForFunction(() => !document.getElementById('notice-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), true, 'Cancelar confirmación debe mantener el modal abierto');

    // 4. Probar con el botón X de cabecera (#btn-close-profiles) y aceptar descarte
    await page.click('#btn-close-profiles');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), false, 'Aceptar confirmación debe cerrar el modal de perfiles');

    // 5. Reabrir y verificar que los cambios no guardados fueron descartados
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    const reloadedDesc = await page.$eval('#setting-profile-description', el => el.value);
    assert.notEqual(reloadedDesc, 'Modificación de prueba sin guardar', 'Los cambios descartados no deben persistir');
  } finally {
    await browser.close();
  }
});

test('Browser UI - al volver a LM Studio recupera el límite publicado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
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
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:remote"]');
    const remoteContext = await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit);
    assert.equal(remoteContext, null);
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:local"]');

    const context = await page.evaluate(() => window.ChatConfig.getActive().modelContextLimit);
    assert.equal(context, 90112);
  } finally {
    await browser.close();
  }
});

test('Browser UI - Los campos select/combo no presentan remarcado azul al recibir el foco', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. Probar combos del modal de configuración
    await page.evaluate(() => {
      document.getElementById('settings-dialog').showModal();
    });

    const settingsComboIds = ['setting-api-type', 'profile-select-helper', 'model-select-helper'];
    for (const id of settingsComboIds) {
      await page.focus('#' + id);
      const style = await page.evaluate((elId) => {
        const s = getComputedStyle(document.getElementById(elId));
        return {
          outlineStyle: s.outlineStyle,
          borderColor: s.borderColor,
          boxShadow: s.boxShadow
        };
      }, id);
      assert.equal(style.outlineStyle, 'none', `El combo #${id} no debe tener outline en foco`);
      assert.notEqual(style.borderColor, 'rgb(37, 99, 235)', `El combo #${id} no debe tener borde azul primario`);
      assert.notEqual(style.borderColor, 'rgb(96, 165, 250)', `El combo #${id} no debe tener borde azul claro`);
      assert.equal(style.boxShadow, 'none', `El combo #${id} no debe tener box-shadow`);
    }

    // 2. Probar input de puerto MCP en mcp-setup-dialog
    await page.evaluate(() => {
      document.getElementById('settings-dialog').close();
      document.getElementById('mcp-setup-dialog').showModal();
    });
    await page.focus('#mcp-port-input');
    const mcpStyle = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('mcp-port-input'));
      return {
        outlineStyle: s.outlineStyle,
        borderColor: s.borderColor,
        boxShadow: s.boxShadow
      };
    });
    assert.equal(mcpStyle.outlineStyle, 'none', 'El input #mcp-port-input no debe tener outline en foco');
    assert.notEqual(mcpStyle.borderColor, 'rgb(37, 99, 235)', 'El input #mcp-port-input no debe tener borde azul primario');
  } finally {
    await browser.close();
  }
});

test('Browser UI - carga una copia cifrada de perfiles tras confirmación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    const encrypted = await page.evaluate(async () => window.ChatProfileBackup.encryptProfiles([{
      id: 'profile:imported-browser', name: 'Imported browser profile', description: 'Imported test',
      settings: { apiType: 'openai', apiUrl: 'https://example.test/v1', apiKey: await window.ChatProfileBackup.encryptApiKey('sk-browser-import'), model: 'test-model' }
    }]));
    await page.locator('#profiles-import-input').setInputFiles({
      name: 'profiles.zcp', mimeType: 'application/json', buffer: Buffer.from(encrypted)
    });
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.match(await page.locator('#notice-message').textContent(), /1 perfil/i);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !!window.ChatProfileRepository.get('profile:imported-browser'));
    const imported = await page.evaluate(() => window.ChatProfileRepository.get('profile:imported-browser'));
    assert.notEqual(typeof imported.settings.apiKey, 'string');
    assert.equal(await page.evaluate(async () => (await window.ChatProfileRepository.load('profile:imported-browser')).settings.apiKey), 'sk-browser-import');
    assert.equal(await page.locator('#profiles-import-input').inputValue(), '');
  } finally {
    await browser.close();
  }
});

test('Browser UI - el bloqueo cargado afecta a todas las pestañas y el borrador no bloquea', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.evaluate(async () => {
      const repository = window.ChatProfileRepository;
      await repository.saveEditable({ id: 'profile:unlocked-test', name: 'Unlocked test', settings: { apiType: 'openai', model: 'test', apiKey: '' } });
      await repository.saveEditable({ id: 'profile:locked-test', name: 'Locked test', settings: { apiType: 'openai', model: 'test', apiKey: 'sk-locked', apiKeyLocked: true } });
    });
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.selectOption('#profile-select-helper', 'profile:unlocked-test');
    await page.waitForFunction(() => document.getElementById('setting-api-key')._loadedApiKey !== undefined);
    await page.check('#setting-api-key-locked');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), false, 'Marcar el borrador no bloquea de inmediato');
    await page.selectOption('#profile-select-helper', 'profile:locked-test');
    await page.waitForFunction(() => document.getElementById('setting-api-key')._loadedApiKey !== undefined);
    assert.equal(await page.locator('#api-key-locked-status').isVisible(), true);
    assert.equal(await page.locator('#api-key-lock-control').isVisible(), false);
    for (const selector of ['#setting-profile-name', '#setting-api-url', '#setting-api-key', '#setting-model', '#setting-system-prompt', '#setting-temperature']) {
      assert.equal(await page.locator(selector).isDisabled(), true, `${selector} debe quedar bloqueado`);
    }
    assert.equal(await page.locator('#profile-select-helper').isDisabled(), false);
  } finally {
    await browser.close();
  }
});

test('Browser UI - inicia sin bloquearse cuando existen perfiles heredados de la version 6.7.0', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon') && !msg.text().includes('ERR_CONNECTION_REFUSED')) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'commit' });
    await page.evaluate(() => {
      localStorage.setItem('zerochat_profiles_v1', JSON.stringify({
        schemaVersion: 1,
        profiles: [
          {
            id: 'profile:mirror',
            name: 'Espejo',
            description: 'Muestra la petición OpenAI sin enviarla.',
            schemaVersion: 1,
            version: 1,
            updatedAt: 1789320000000,
            settings: {
              apiUrl: 'mirror://local',
              apiType: 'mirror',
              apiKey: '',
              model: 'mirror'
            }
          }
        ]
      }));
    });

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    assert.equal(await page.locator('#chat-form').isVisible(), true, 'El formulario de chat debe ser visible');
  } finally {
    await browser.close();
  }
});

test('Browser UI - nuevo perfil permite query inmediato con el conector por defecto', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedConnectionProfiles(page);
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'), { waitUntil: 'load' });

    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);

    await page.evaluate(() => {
      window.ChatDialogs.prompt = async () => 'Perfil OpenAI Test';
      window.ChatAPI.fetchServerModels = async () => ({
        success: true,
        count: 1,
        endpoint: 'http://localhost:1234/v1',
        models: [{ id: 'test-openai-model' }]
      });
    });

    await page.click('#btn-new-profile');
    await page.click('#profile-tab-settings');

    assert.equal(await page.inputValue('#setting-api-type'), 'openai');
    assert.equal(await page.inputValue('#setting-api-url'), 'http://localhost:1234/v1');

    await page.click('#btn-query-server');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.dataset.queryReady === 'true');
    assert.equal(await page.inputValue('#setting-model'), 'test-openai-model');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
});
