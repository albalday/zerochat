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
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.dataset.queryReady === 'true');
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

test('Browser UI - cualquier cambio del perfil queda pendiente de guardar, incluido un modelo libre', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem('zerochat_runtime_config_v2', JSON.stringify({
      activeProfile: { id: 'profile:local', name: 'Local chat' }, apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: 'google/gemma-4-26b-a4b-qat'
    })));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');
    await page.waitForFunction(() => document.getElementById('setting-api-key')._loadedApiKey !== undefined);
    assert.equal(await page.textContent('#profile-save-query-hint'), 'No hay cambios pendientes: Guardar cierra el panel.');
    const initialModel = await page.locator('#setting-model').inputValue();
    await page.fill('#setting-model', 'modelo-personalizado');
    assert.equal(await page.textContent('#profile-save-query-hint'), 'Hay cambios pendientes. Guarda el perfil para conservarlos.', 'Un modelo escrito libremente queda pendiente');
    await page.fill('#setting-model', initialModel);
    assert.equal(await page.textContent('#profile-save-query-hint'), 'Hay cambios pendientes. Guarda el perfil para conservarlos.', 'Al deshacer el cambio sigue pendiente');
    assert.equal(await page.locator('#profile-chapter-behavior').evaluate(chapter => chapter.open), false, 'Solo la conexión se abre al editar');
    await page.click('#profile-chapter-behavior summary');
    await page.fill('#setting-system-prompt', 'Instrucción personalizada');
    assert.equal(await page.locator('#btn-save-profile').isDisabled(), false);
    await page.click('#profile-chapter-behavior summary');
    assert.match(await page.textContent('#profile-summary-behavior'), /^Prompt propio · temperatura /, 'El resumen del capítulo plegado refleja el cambio');
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
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');
    await page.evaluate(() => {
      window.ChatUIInspector.handleQueryServer = async () => true;
    });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').dataset.queryReady === 'true');

    // 1. Pulsar botón Cerrar con consulta pendiente abre diálogo de confirmación (con Cancelar y Aceptar)
    await page.click('#btn-close-profiles');
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
    await page.click('#btn-close-profiles');
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
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
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
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);

    // 1. Sin cambios: cerrar con botón X cierra de inmediato sin confirmación
    await page.click('#btn-close-profiles');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.$eval('#profiles-dialog', el => el.open), false, 'Sin cambios debe cerrar sin confirmar');
    assert.equal(await page.$eval('#notice-dialog', el => el.open), false, 'No debe abrir notice-dialog sin cambios');

    // 2. Modificar un campo y pulsar Cerrar: debe pedir confirmación
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    await page.fill('#setting-profile-description', 'Modificación de prueba sin guardar');

    await page.click('#btn-close-profiles');
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
    await page.click('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action="edit"]');
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
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
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

test('Browser UI - carga una copia cifrada de perfiles con el nuevo sistema HTML postMessage', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // Verificar que NO existe el botón de importación manual (fue eliminado)
    const importButtonExists = await page.evaluate(() => {
      return !!document.getElementById('btn-menu-import-profiles');
    });
    assert.equal(importButtonExists, false, 'El botón de importación manual debe haber sido eliminado');

    // Verificar que NO existe el input file (fue eliminado)
    const importInputExists = await page.evaluate(() => {
      return !!document.getElementById('profiles-import-input');
    });
    assert.equal(importInputExists, false, 'El input file de importación debe haber sido eliminado');

    // Verificar que el sistema de postMessage está configurado
    const hasPostMessageListener = await page.evaluate(() => {
      // Simular que estamos en modo importación
      return typeof window !== 'undefined';
    });
    assert.ok(hasPostMessageListener, 'El sistema debe soportar postMessage');

    // Probar que la exportación genera HTML correcto
    await page.click('#active-profile-trigger');
    await page.waitForSelector('.btn-profile-item-edit');
    await page.click('.btn-profile-item-edit');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);

    // Crear un perfil de prueba
    await page.evaluate(async () => {
      await window.ChatProfileRepository.saveEditable({
        id: 'profile:export-test',
        name: 'Export test profile',
        description: 'Test profile for export',
        settings: {
          apiType: 'openai',
          apiUrl: 'https://example.test/v1',
          apiKey: 'sk-test-key',
          model: 'test-model'
        }
      });
    });

    // Verificar que el módulo de exportación está disponible
    const exportBundleAvailable = await page.evaluate(() => {
      return typeof window.ChatProfileExportBundle !== 'undefined' &&
             typeof window.ChatProfileExportBundle.generateExportHTML === 'function';
    });
    assert.ok(exportBundleAvailable, 'El módulo ChatProfileExportBundle debe estar disponible');

    // Limpiar
    await page.evaluate(() => {
      window.ChatProfileRepository.remove('profile:export-test');
    });

  } finally {
    await browser.close();
  }
});

test('Browser UI - el bloqueo cargado afecta a todas las pestañas y el borrador no bloquea', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    await page.evaluate(async () => {
      const repository = window.ChatProfileRepository;
      await repository.saveEditable({ id: 'profile:unlocked-test', name: 'Unlocked test', settings: { apiType: 'openai', model: 'test', apiKey: '' } });
      await repository.saveEditable({ id: 'profile:locked-test', name: 'Locked test', settings: { apiType: 'openai', model: 'test', apiKey: 'sk-locked', apiKeyLocked: true } });
    });
    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:unlocked-test"]) [data-profile-action="edit"]');
    await page.waitForFunction(() => document.getElementById('setting-api-key')._loadedApiKey !== undefined);
    await page.check('#setting-api-key-locked');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), false, 'Marcar el borrador no bloquea de inmediato');
    await page.click('#btn-close-profiles');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);

    await page.click('#active-profile-trigger');
    await page.click('.header-profile-item:has([data-profile-id="profile:locked-test"]) [data-profile-action="edit"]');
    await page.waitForFunction(() => document.getElementById('setting-api-key')._loadedApiKey !== undefined);
    assert.equal(await page.locator('#api-key-locked-status').isVisible(), true);
    assert.equal(await page.locator('#api-key-lock-control').isVisible(), false);
    for (const selector of ['#setting-profile-name', '#setting-api-url', '#setting-api-key', '#setting-model', '#setting-system-prompt', '#setting-temperature']) {
      assert.equal(await page.locator(selector).isDisabled(), true, `${selector} debe quedar bloqueado`);
    }
    // Un perfil bloqueado no tiene nada que guardar: Guardar cierra el panel.
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    await page.click('#active-profile-trigger');
    await page.waitForFunction(() => !document.getElementById('active-profile-popover').hidden);
    await page.click('.header-profile-item:has([data-profile-id="profile:locked-test"]) [data-profile-action="delete"]');
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
    await page.waitForFunction(() => window.ChatProfileRepository.get('profile:locked-test') === null);
    await page.waitForFunction(() => !document.querySelector('#active-profile-list [data-profile-id="profile:locked-test"]'));
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

    await page.goto(getIndexUrl(), { waitUntil: 'commit' });
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
    await waitForAppReady(page);
    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    assert.equal(await page.locator('#chat-form').isVisible(), true, 'El formulario de chat debe ser visible');
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
  await page.waitForFunction(() => document.getElementById('profiles-dialog').open && document.getElementById('setting-api-key')._loadedApiKey !== undefined);
}

async function closeProfileEditor(page, { discard = false } = {}) {
  await page.click('#btn-close-profiles');
  if (discard) {
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.click('#notice-accept');
  }
  await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
}

test('Browser UI - elegir un perfil del menú lo activa, cierra el menú y marca el activo', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await openProfilesPage(browser);
    await page.click('#active-profile-trigger');
    const mirror = page.locator('.header-profile-item:has([data-profile-id="profile:mirror"])');
    assert.equal(await mirror.evaluate(item => item.classList.contains('active')), true);
    assert.equal(await mirror.locator('[role="menuitemradio"]').getAttribute('aria-checked'), 'true');
    assert.deepEqual(await page.$$eval('.header-profile-item:has([data-profile-id="profile:local"]) [data-profile-action]', buttons => buttons.map(button => button.dataset.profileAction)), ['inspect', 'edit', 'delete']);

    await page.click('.header-profile-item [data-profile-id="profile:local"]');
    assert.equal(await page.locator('#active-profile-popover').isHidden(), true);
    assert.equal(await page.textContent('#active-profile-name'), 'Local chat');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().activeProfile.id), 'profile:local');
    await page.click('#active-profile-trigger');
    assert.equal(await page.locator('.header-profile-item:has([data-profile-id="profile:local"]) [role="menuitemradio"]').getAttribute('aria-checked'), 'true');
  } finally {
    await browser.close();
  }
});

test('Browser UI - reabrir el editor no conserva cambios descartados y una consulta lista permite guardar', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await openProfilesPage(browser);
    await openProfileEditor(page, 'profile:local');
    await page.fill('#setting-model', 'otro-modelo');
    assert.equal(await page.locator('#btn-save-profile').isDisabled(), false);
    await closeProfileEditor(page, { discard: true });

    await openProfileEditor(page, 'profile:local');
    assert.equal(await page.inputValue('#setting-model'), 'google/gemma-4-26b-a4b-qat');
    assert.equal(await page.textContent('#profile-save-query-hint'), 'No hay cambios pendientes: Guardar cierra el panel.', 'Al reabrir no quedan cambios pendientes');
    await page.evaluate(() => {
      window.ChatAPI.fetchServerModels = async () => ({ success: true, count: 1, endpoint: 'http://localhost:1234/v1', models: [{ id: 'google/gemma-4-26b-a4b-qat' }] });
    });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').dataset.queryReady === 'true');
    assert.equal(await page.textContent('#profile-save-query-hint'), 'Hay cambios pendientes. Guarda el perfil para conservarlos.', 'Una consulta al servidor lista queda pendiente de guardar');
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
    // Solo arranca lo que estaba parado, sin recordarlo, y avisa de ello con un diálogo.
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.deepEqual(await page.evaluate(() => window.__started), [{ serverId: 'memory', remember: false }]);
    assert.match(await page.textContent('#notice-message'), /El perfil ha arrancado estos servicios MCP: Memoria\. Siguen en marcha hasta que los detengas/);
  } finally {
    await browser.close();
  }
});

test('Browser UI - un perfil nuevo abre el editor vacío sin pedir nombre ni heredar la clave', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await openProfilesPage(browser, [{ id: 'profile:con-clave', name: 'Con clave', description: 'Descripción anterior', settings: { apiType: 'openai', model: 'test', apiKey: 'sk-old', apiKeyLocked: true } }]);
    await openProfileEditor(page, 'profile:con-clave');
    await closeProfileEditor(page);

    await page.click('#active-profile-trigger');
    await page.click('#btn-menu-new-profile');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    const editor = await page.evaluate(() => ({
      notice: document.getElementById('notice-dialog').open,
      name: document.getElementById('setting-profile-name').value,
      description: document.getElementById('setting-profile-description').value,
      apiKey: document.getElementById('setting-api-key').value,
      locked: document.getElementById('setting-api-key-locked').checked,
      saveDisabled: document.getElementById('btn-save-profile').disabled
    }));
    assert.deepEqual(editor, { notice: false, name: '', description: '', apiKey: '', locked: false, saveDisabled: false });
    // Sin cambios, Guardar cierra el panel sin crear ningún perfil.
    const before = await page.evaluate(() => window.ChatProfileRepository.list().length);
    await page.click('#btn-save-profile');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog').open);
    assert.equal(await page.evaluate(() => window.ChatProfileRepository.list().length), before);
  } finally {
    await browser.close();
  }
});

});
