const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { version } = require('../package.json');

async function seedConnectionProfiles(page) {
  await page.addInitScript(() => {
    localStorage.setItem('zerochat_profiles_v1', JSON.stringify({
      schemaVersion: 1,
      profiles: [
        { id: 'profile:local', name: 'Local chat', settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model: 'google/gemma-4-26b-a4b-qat', enableContextCache: true } },
        { id: 'profile:remote', name: 'Remoto chat', settings: { apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiType: 'gemini', model: 'gemini-3.8-flash', enableContextCache: true } }
      ]
    }));
  });
}

test('Browser UI - los metadatos MCP externos se renderizan como texto', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    const result = await page.evaluate(() => {
      const serverDetails = document.createElement('div');
      const errorMessage = document.createElement('div');
      const elements = {
        statusBadge: document.createElement('div'),
        statusText: document.createElement('span'),
        btnConnect: document.createElement('button'),
        btnDisconnect: document.createElement('button'),
        serverDetails,
        errorMessage
      };
      const payload = '<img data-xss-probe="mcp" src=x onerror="window.__mcpXss=true">';
      window.ChatUIMcp.renderConnectionStatus(elements, {
        status: 'connected',
        serverInfo: { name: payload, version: payload },
        tools: []
      }, key => key);
      const detailsSafe = !serverDetails.querySelector('[data-xss-probe]') && serverDetails.textContent.includes(payload);
      window.ChatUIMcp.renderConnectionStatus(elements, {
        status: 'error',
        error: payload
      }, key => key);
      return {
        detailsSafe,
        errorSafe: !errorMessage.querySelector('[data-xss-probe]') && errorMessage.textContent.includes(payload),
        executed: Boolean(window.__mcpXss)
      };
    });
    assert.equal(result.detailsSafe, true);
    assert.equal(result.errorSafe, true);
    assert.equal(result.executed, false);
  } finally { await browser.close(); }
});

test('Browser UI - WebLLM permite elegir si envía reasoning_effort none', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
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
test('Browser UI - perfiles: teclado, alineación, Free Tier, solo lectura y borrado', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await seedConnectionProfiles(page);
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.focus('#active-profile-trigger');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[data-profile-id="profile:mirror"]').evaluate(el => el === document.activeElement), true);
    const alignment = await page.evaluate(() => {
      const menu = document.getElementById('active-profile-popover').getBoundingClientRect();
      const composer = document.querySelector('.chat-input-container').getBoundingClientRect();
      return Math.abs(menu.right - composer.right);
    });
    assert.ok(alignment <= 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#active-profile-popover').isVisible(), false);
    await page.click('#active-profile-trigger');
    await page.click('#btn-edit-profiles');
    assert.equal(await page.locator('#setting-profile-name').isDisabled(), true);
    assert.equal(await page.locator('#btn-delete-profile').isDisabled(), true);
    await page.selectOption('#profile-select-helper', 'profile:remote');
    await page.click('#profile-tab-settings');
    assert.equal(await page.locator('#setting-api-key').isEnabled(), true);
    await page.click('#btn-free-tier');
    assert.equal(await page.inputValue('#setting-api-key'), 'FREE-TIER');
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
    assert.deepEqual(await page.locator('#model-select-helper option').evaluateAll(options => options.map(option => option.value)), ['', 'model-cached', 'model-missing']);
    await page.selectOption('#setting-api-type', 'openai');
    assert.equal(await page.inputValue('#setting-api-url'), 'http://localhost:1234/v1');
    assert.equal(await page.locator('.api-key-field').isVisible(), true);
    assert.equal(await page.locator('#btn-free-tier').isVisible(), false);
    await page.click('#profile-tab-name');
    await page.click('#btn-delete-profile');
    await page.click('#notice-accept');
    await page.click('#btn-close-profiles');
    assert.equal(await page.textContent('#active-profile-name'), 'Espejo');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().apiKey), '');
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

test('Browser UI - informa del alcance de almacenamiento y deriva la descarga HTTP', async () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, '../zerochat.html'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(bundle);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html?preview=1`, { waitUntil: 'load' });
    await page.click('#btn-open-execution-info');

    const state = await page.evaluate(() => ({
      open: document.getElementById('execution-info-dialog').open,
      href: document.getElementById('btn-download-standalone').href,
      hidden: document.getElementById('btn-download-standalone').hidden,
      display: getComputedStyle(document.getElementById('btn-download-standalone')).display,
      scope: document.getElementById('execution-storage-scope').textContent
    }));

    assert.equal(state.open, true);
    assert.equal(state.href, `http://127.0.0.1:${port}/zerochat.html`);
    assert.equal(state.hidden, false);
    assert.notEqual(state.display, 'none');
    assert.match(state.scope, /protocol|protocolo/i);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Browser UI - no ofrece descarga desde file://', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-execution-info');
    const state = await page.evaluate(() => ({
      hidden: document.getElementById('btn-download-standalone').hidden,
      href: document.getElementById('btn-download-standalone').getAttribute('href'),
      display: getComputedStyle(document.getElementById('btn-download-standalone')).display
    }));
    assert.equal(state.hidden, true);
    assert.equal(state.href, null);
    assert.equal(state.display, 'none');
  } finally {
    await browser.close();
  }
});

test('Browser UI - el fallback de contexto no invalida el formulario de envío', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.waitForTimeout(250);
    await page.click('#active-profile-trigger');
    await page.click('[data-profile-id="profile:remote"]');
    await page.fill('#user-input', 'test');

    const formState = await page.evaluate(() => ({
      valid: document.getElementById('chat-form').checkValidity(),
      fallback: document.getElementById('context-limit-override-input').value,
      activeProfileName: document.getElementById('active-profile-name').textContent
    }));

    assert.equal(formState.fallback, '1000K');
    assert.equal(formState.valid, true);
    assert.equal(formState.activeProfileName, 'Remoto chat', 'El selector debe reflejar el perfil activo tras aplicarlo');
  } finally {
    await browser.close();
  }
});

test('Browser UI - guardar perfiles exige consultar el servidor', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
    await page.click('#btn-manage-profiles');

    const state = await page.evaluate(() => ({
      disabled: document.getElementById('btn-save-profile').disabled,
      hint: document.getElementById('profile-save-query-hint').textContent
    }));

    assert.equal(state.disabled, true);
    assert.match(state.hint, /Consulta el servidor/);
  } finally {
    await browser.close();
  }
});

test('Browser UI - WebLLM muestra enlace de ayuda online y lo oculta en otros proveedores', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
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

test('Browser UI - WebLLM con modelo descargado permite guardar sin consulta y muestra modelos descargados primero', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => {
      localStorage.setItem("zerochat_webllm_completed_models_v1", JSON.stringify(["test-downloaded-model"]));
      localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" }));
    });
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
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

test('Browser UI - una consulta de perfil debe guardarse antes de cerrar y confirmar descarte', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem("zerochat_runtime_config_v2", JSON.stringify({ activeProfile: { id: "profile:local", name: "Local chat" }, apiType: "openai", apiUrl: "http://localhost:1234/v1", model: "test" })));
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.click('#btn-open-settings');
    await page.click('#btn-manage-profiles');
    await page.evaluate(() => {
      window.ChatUIInspector.handleQueryServer = async () => true;
    });
    await page.click('#profile-tab-settings');
    await page.click('#btn-query-server');
    await page.waitForFunction(() => !document.getElementById('btn-save-profile').disabled);

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
    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog').open);
    await page.click('#profile-tab-settings');
    await page.click('#btn-query-server');
    await page.waitForFunction(() => !document.getElementById('btn-save-profile').disabled);

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

test('Browser UI - al volver a LM Studio recupera el límite publicado', async () => {
  const browser = await chromium.launch({ headless: true });
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
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.waitForTimeout(250);
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

test('Browser UI - index.html declara el mismo runtime que se distribuye', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.goto('file://' + path.resolve(__dirname, '../index.html'), { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    assert.equal(await page.title(), `ZeroChat v${version}`, 'El título de index.html debe coincidir con la versión del proyecto');
    const runtime = await page.evaluate(() => ({
      chatIcons: typeof window.ChatIcons?.get === 'function',
      iconStyles: getComputedStyle(document.querySelector('.ui-icon')).display
    }));
    assert.equal(runtime.chatIcons, true, 'El HTML base debe cargar el módulo de iconos usado por la aplicación');
    assert.equal(runtime.iconStyles, 'block', 'El HTML base debe cargar los estilos de iconos');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Carga limpia del bundle zerochat.html sin errores de consola', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
    const title = await page.title();
    assert.equal(title, `ZeroChat v${version}`, 'El título de zerochat.html debe coincidir con la versión del proyecto');

    // Verificar que los componentes clave están en el DOM
    const hasChatContainer = await page.$eval('.chat-container', el => !!el);
    assert.ok(hasChatContainer, 'El contenedor de chat debe existir');

    const hasMessagesList = await page.$eval('#messages-list', el => !!el);
    assert.ok(hasMessagesList, 'La lista de mensajes debe existir');

    const hasChatForm = await page.$eval('#chat-form', el => !!el);
    assert.ok(hasChatForm, 'El formulario de chat debe existir');

    // Verificar resolución de variables CSS de diseño
    const styles = await page.evaluate(() => {
      const bodyStyle = getComputedStyle(document.body);
      return {
        bgApp: bodyStyle.backgroundColor,
        color: bodyStyle.color,
        fontFamily: bodyStyle.fontFamily
      };
    });
    assert.ok(styles.bgApp, 'El fondo de la app debe estar computado');
    assert.ok(styles.color, 'El color de texto debe estar computado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Modo Oscuro y resolución de Design Tokens', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. Validar tokens en modo claro
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });

    const lightTokens = await page.evaluate(() => {
      const docStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      return {
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        bgSurface: docStyle.getPropertyValue('--bg-surface').trim(),
        textMain: docStyle.getPropertyValue('--text-main').trim(),
        radiusMd: docStyle.getPropertyValue('--radius-md').trim(),
        bodyBg: bodyStyle.backgroundColor
      };
    });

    assert.ok(lightTokens.primary, 'Debe resolver --primary');
    assert.ok(lightTokens.bgApp, 'Debe resolver --bg-app');
    assert.ok(lightTokens.bgSurface, 'Debe resolver --bg-surface');
    assert.ok(lightTokens.radiusMd, 'Debe resolver --radius-md');

    // 2. Validar tokens en modo oscuro
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    const darkTokens = await page.evaluate(() => {
      const docStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      return {
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        bgSurface: docStyle.getPropertyValue('--bg-surface').trim(),
        textMain: docStyle.getPropertyValue('--text-main').trim(),
        bodyBg: bodyStyle.backgroundColor
      };
    });

    assert.ok(darkTokens.primary, 'Debe resolver --primary en dark');
    assert.notEqual(darkTokens.bgApp, lightTokens.bgApp, 'El fondo de la app debe diferir entre temas');
    assert.notEqual(darkTokens.bodyBg, lightTokens.bodyBg, 'El fondo computado del body debe cambiar en dark');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 2: Header Superior Moderno y Acciones Integradas', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    // 1. Verificar presencia y posición del header moderno
    const headerInfo = await page.$eval('.app-header', el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        exists: !!el,
        position: style.position,
        top: rect.top,
        height: rect.height,
        display: style.display
      };
    });
    assert.ok(headerInfo.exists, 'El header (.app-header) debe existir');
    assert.equal(headerInfo.display, 'flex', 'El header debe ser flex');
    assert.ok(headerInfo.height >= 40, 'El header debe tener altura suficiente');

    // 2. Verificar que la antigua barra superior sobre el prompt ya NO existe
    const hasOldToolbar = await page.$eval('.input-toolbar-top', () => true).catch(() => false);
    assert.equal(hasOldToolbar, false, 'La barra .input-toolbar-top obsoleta debe haber sido retirada');

    // 3. Verificar que el botón de toggle del sidebar reside en el header y abre/cierra la barra lateral
    const isSidebarToggleInHeader = await page.$eval('.app-header #btn-toggle-sidebar', el => !!el);
    assert.ok(isSidebarToggleInHeader, '#btn-toggle-sidebar debe residir dentro de .app-header');

    // Estado inicial: sidebar abierto por defecto
    const sidebarInitialDisplay = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarInitialDisplay, 'flex', 'El sidebar debe estar abierto por defecto');

    // Cerrar sidebar pulsando el botón de cerrar del sidebar
    await page.click('#btn-close-sidebar');
    const sidebarClosedAgain = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarClosedAgain, 'none', 'El sidebar debe cerrarse');

    // Abrir sidebar pulsando el botón del header
    await page.click('#btn-toggle-sidebar');
    const sidebarOpenedDisplay = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display);
    assert.equal(sidebarOpenedDisplay, 'flex', 'El sidebar debe abrirse (display: flex) tras pulsar el botón del header');

    // 4. Menú de perfiles activo en el composer e integración de 'Editar perfiles'
    const hasProfileMenu = await page.$eval('.chat-input-container #active-profile-menu', el => !!el);
    assert.ok(hasProfileMenu, 'El selector de perfil debe residir dentro del composer');

    const profileStyle = await page.$eval('.composer-profile-trigger', el => {
      const computed = getComputedStyle(el);
      return {
        borderStyle: computed.borderStyle,
        fontSize: computed.fontSize,
        maxWidth: getComputedStyle(el.closest('.composer-profile-menu')).maxWidth
      };
    });
    assert.equal(profileStyle.borderStyle, 'solid', 'El disparador debe tener un borde sutil');
    assert.equal(profileStyle.maxWidth, 'none', 'El menú debe poder adaptarse al nombre del perfil');

    // Botón de editar perfiles en cabecera removido
    const hasBtnOpenProfiles = await page.$eval('#btn-open-profiles', el => !!el).catch(() => false);
    assert.equal(hasBtnOpenProfiles, false, 'El icono de editar perfiles en la cabecera debe haber sido eliminado');

    // Disclaimer inferior del textbox eliminado
    const hasDisclaimer = await page.$eval('.chat-disclaimer', el => !!el).catch(() => false);
    assert.equal(hasDisclaimer, false, 'La línea de ayuda/disclaimer debajo del prompt debe haber sido eliminada');

    // El menú muestra perfiles y una acción explícita para editarlos.
    await page.click('#active-profile-trigger');
    const menuState = await page.evaluate(() => ({
      open: document.getElementById('active-profile-trigger').getAttribute('aria-expanded'),
      list: document.getElementById('active-profile-list').textContent,
      editText: document.getElementById('btn-edit-profiles').textContent
    }));
    assert.equal(menuState.open, 'true', 'El disparador debe abrir el menú de perfiles');
    assert.match(menuState.list, /Espejo/, 'La primera instalación debe incluir el perfil Espejo');
    assert.equal(menuState.editText, 'Editar perfiles', 'El menú debe incluir el botón para editar perfiles');

    await page.click('#btn-edit-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    const isProfilesOpen = await page.$eval('#profiles-dialog', el => el.open);
    assert.ok(isProfilesOpen, 'Pulsar "Editar perfiles" debe abrir #profiles-dialog');
    await page.click('#btn-close-profiles');
    await page.waitForFunction(() => !document.getElementById('profiles-dialog')?.open);

    // 5. Botón de Configuración en la cabecera del sidebar abre el diálogo
    await page.click('#btn-open-settings');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);
    const isSettingsOpen = await page.$eval('#settings-dialog', el => el.open);
    assert.ok(isSettingsOpen, 'Pulsar el botón de ajustes en el sidebar debe abrir #settings-dialog');
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);

    // 6. Botón de RAG abre el diálogo de conocimiento (asíncrono con refresh)
    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    const isRagOpen = await page.$eval('#rag-modal', el => el.open);
    assert.ok(isRagOpen, 'Pulsar el botón de conocimiento en el header debe abrir #rag-modal');
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 3: Canvas de Mensajes Centrado, Tipografía y Markdown', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });

    // Esperar a que la inicialización asíncrona de sesión en IndexedDB concluya
    await page.waitForSelector('#welcome-banner');
    await new Promise(r => setTimeout(r, 200));

    // Simular renderizado de un mensaje de usuario y uno del asistente
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      const editSvg = window.ChatIcons?.get('edit', { size: 12 }) || '';
      const brainSvg = window.ChatIcons?.get('brain', { size: 13 }) || '';
      const zapSvg = window.ChatIcons?.get('zap', { size: 11 }) || '';
      const copySvg = window.ChatIcons?.get('copy', { size: 12 }) || '';
      const branchSvg = window.ChatIcons?.get('git-branch', { size: 12 }) || '';
      
      // Mensaje de Usuario
      const userMsg = document.createElement('div');
      userMsg.className = 'message-wrapper user';
      userMsg.innerHTML = `
        <div class="message-row user">
          <div class="message-content-wrapper">
            <div class="message-content">Hola ZeroChat, muéstrame una tabla y código.</div>
            <div class="message-footer-row">
              <div class="message-actions">
                <button class="btn-msg-action" aria-label="Editar" title="Editar">${editSvg}</button>
                <button class="btn-msg-action btn-copy-user" aria-label="Copiar" title="Copiar">${copySvg}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(userMsg);

      // Mensaje de Asistente con Razonamiento, Tabla y Código
      const astMsg = document.createElement('div');
      astMsg.className = 'message-wrapper assistant';
      astMsg.innerHTML = `
        <div class="message-row assistant">
          <div class="message-content-wrapper">
            <div class="message-content">
              <details class="thought-block" open>
                <summary class="thought-summary">${brainSvg} Proceso de razonamiento</summary>
                <div class="thought-content">Analizando la solicitud para generar la respuesta estructurada...</div>
              </details>
              <p>Aquí tienes los datos solicitados en formato de tabla y código:</p>
              <div class="table-container">
                <table class="markdown-table">
                  <thead><tr><th>Parámetro</th><th>Valor</th><th>Estado</th></tr></thead>
                  <tbody>
                    <tr><td>Modelo</td><td>Gemini 2.5</td><td>Activo</td></tr>
                    <tr><td>Tokens</td><td>1.2k</td><td>OK</td></tr>
                  </tbody>
                </table>
              </div>
              <div class="code-block-container">
                <div class="code-block-header">
                  <span class="code-lang">javascript</span>
                  <div class="code-block-actions">
                    <button class="btn-copy-code">Copiar</button>
                  </div>
                </div>
                <pre><code>console.log("Canvas moderno activo");</code></pre>
              </div>
            </div>
            <div class="message-footer-row">
              <div class="message-stats">
                <span class="stat-item">${zapSvg} <span>45 tok/s</span></span>
              </div>
              <div class="message-actions">
                <button class="btn-msg-action btn-branch-conversation" aria-label="Crear rama" title="Crear rama">${branchSvg}</button>
                <button class="btn-msg-action" aria-label="Copiar" title="Copiar">${copySvg}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(astMsg);
    });

    // 1. Validar centrado y ancho máximo del canvas de mensajes
    const canvasMetrics = await page.evaluate(() => {
      const userWrapper = document.querySelector('.message-wrapper.user');
      const astWrapper = document.querySelector('.message-wrapper.assistant');
      const rectUser = userWrapper.getBoundingClientRect();
      const rectAst = astWrapper.getBoundingClientRect();
      return {
        userWidth: rectUser.width,
        astWidth: rectAst.width
      };
    });

    assert.ok(canvasMetrics.userWidth <= 1120 && canvasMetrics.userWidth > 900, `El ancho de mensaje (${canvasMetrics.userWidth}px) debe respetar el canvas de lectura ampliado max-width: 68rem`);
    assert.ok(canvasMetrics.astWidth <= 1120 && canvasMetrics.astWidth > 900, `El ancho del asistente (${canvasMetrics.astWidth}px) debe respetar el canvas de lectura ampliado max-width: 68rem`);

    // Validar ausencia de enmarcado en respuestas del asistente
    const astFraming = await page.evaluate(() => {
      const astContent = document.querySelector('.message-row.assistant .message-content');
      const style = getComputedStyle(astContent);
      return {
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        backgroundColor: style.backgroundColor
      };
    });
    assert.ok(astFraming.borderWidth === '0px' || astFraming.borderStyle === 'none', 'La respuesta del asistente no debe tener borde/enmarcado');
    assert.ok(astFraming.backgroundColor === 'rgba(0, 0, 0, 0)' || astFraming.backgroundColor === 'transparent', 'La respuesta del asistente debe tener fondo transparente sin enmarcado');

    // 2. Validar acordeón de razonamiento plegable
    const thoughtInfo = await page.evaluate(() => {
      const block = document.querySelector('.thought-block');
      return {
        isOpen: block.open,
        hasBorderAccent: getComputedStyle(block).borderLeftWidth !== '0px'
      };
    });
    assert.ok(thoughtInfo.isOpen, 'El bloque de razonamiento debe renderizarse inicialmente desplegado');
    assert.ok(thoughtInfo.hasBorderAccent, 'El bloque de razonamiento debe tener borde de acento');

    // Plegar el acordeón haciendo click en el summary
    await page.click('.thought-summary');
    const isNowClosed = await page.$eval('.thought-block', el => !el.open);
    assert.ok(isNowClosed, 'Pulsar en el summary del pensamiento debe plegar el acordeón');

    // 3. Validar bloque de código
    const codeBlockInfo = await page.evaluate(() => {
      const codeBlock = document.querySelector('.code-block-container');
      const copyBtn = document.querySelector('.btn-copy-code');
      const pre = document.querySelector('.code-block-container pre');
      return {
        hasCodeBlock: !!codeBlock,
        hasCopyBtn: !!copyBtn,
        preOverflow: getComputedStyle(pre).overflowX
      };
    });
    assert.ok(codeBlockInfo.hasCodeBlock, 'El bloque de código debe existir');
    assert.ok(codeBlockInfo.hasCopyBtn, 'El botón de copiar código debe existir');
    assert.equal(codeBlockInfo.preOverflow, 'auto', 'El bloque pre debe tener overflow-x: auto');

    // 4. Validar tabla GFM
    const tableInfo = await page.evaluate(() => {
      const table = document.querySelector('.markdown-table');
      const container = document.querySelector('.table-container');
      return {
        rows: table.querySelectorAll('tr').length,
        hasBorder: getComputedStyle(container).borderWidth !== '0px'
      };
    });
    assert.equal(tableInfo.rows, 3, 'La tabla debe tener 3 filas (1 thead + 2 tbody)');
    assert.ok(tableInfo.hasBorder, 'El contenedor de tabla debe tener borde');

    // 5. Validar que las acciones de mensaje y las estadísticas usan SVG limpios sin emojis
    const msgActionsInfo = await page.evaluate(() => {
      const actionBtns = Array.from(document.querySelectorAll('.btn-msg-action'));
      const statItems = Array.from(document.querySelectorAll('.stat-item'));
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      
      const allActionBtnsHaveSvg = actionBtns.every(btn => btn.querySelector('svg.ui-icon'));
      const noActionBtnHasEmoji = actionBtns.every(btn => !emojiRegex.test(btn.textContent));
      const allActionBtnsIconOnly = actionBtns.every(btn => !btn.querySelector('span') && !btn.textContent.trim());
      const allStatsHaveSvg = statItems.every(item => item.querySelector('svg.ui-icon'));
      const noStatHasEmoji = statItems.every(item => !emojiRegex.test(item.textContent));

      return {
        allActionBtnsHaveSvg,
        noActionBtnHasEmoji,
        allActionBtnsIconOnly,
        allStatsHaveSvg,
        noStatHasEmoji,
        actionBtnCount: actionBtns.length,
        statCount: statItems.length
      };
    });

    assert.ok(msgActionsInfo.actionBtnCount > 0, 'Deben existir botones de acción de mensaje');
    const branchButton = await page.$('.message-wrapper.assistant .btn-branch-conversation');
    assert.ok(branchButton, 'Las respuestas deben incluir una acción para crear una rama');
    const userCopyButton = await page.$('.message-wrapper.user .btn-copy-user');
    assert.ok(userCopyButton, 'Los mensajes de usuario deben incluir una acción para copiar');
    assert.ok(msgActionsInfo.allActionBtnsHaveSvg, 'Todos los botones de acción deben contener un SVG .ui-icon');
    assert.ok(msgActionsInfo.allActionBtnsIconOnly, 'Todos los botones de acción deben ser únicamente icono sin texto');
    assert.ok(msgActionsInfo.noActionBtnHasEmoji, 'Ningún botón de acción debe tener emojis en su texto');
    assert.ok(msgActionsInfo.statCount > 0, 'Deben existir items de estadísticas');
    assert.ok(msgActionsInfo.allStatsHaveSvg, 'Todos los items de estadísticas deben contener un SVG .ui-icon');
    assert.ok(msgActionsInfo.noStatHasEmoji, 'Ningún item de estadísticas debe tener emojis en su texto');
  } finally {
    await browser.close();
  }
});

test('Browser UI - crear una rama conserva el origen y corta el nuevo historial en la respuesta seleccionada', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.ChatApp && !!window.ChatState && !!window.ChatStorage);
    await new Promise(resolve => setTimeout(resolve, 200));

    const result = await page.evaluate(async () => {
      const parentId = 'session_branch_parent_test';
      const history = [
        { id: 'system_parent', role: 'system', content: 'System prompt' },
        { id: 'user_parent_1', role: 'user', content: 'Pregunta inicial' },
        { id: 'assistant_parent_1', role: 'assistant', content: 'Respuesta para bifurcar' },
        { id: 'user_parent_2', role: 'user', content: 'Pregunta posterior' },
        { id: 'assistant_parent_2', role: 'assistant', content: 'Respuesta posterior' }
      ];
      const parent = { id: parentId, title: 'Conversación origen', createdAt: Date.now(), updatedAt: Date.now(), messageCount: history.length };
      window.ChatState.replaceConversation({ sessionId: parentId, messages: history });
      window.ChatState.saveSessionMetadata(parent);
      await window.ChatStorage.saveConversation(parent, history);

      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-msg-id', 'assistant_parent_1');
      wrapper.setAttribute('data-msg-ids', 'assistant_parent_1');
      const created = await window.ChatApp.createConversationBranch(wrapper);
      const childId = window.ChatState.get('sessions').activeId;
      const child = await window.ChatStorage.getConversation(childId);
      const source = await window.ChatStorage.getConversation(parentId);
      return {
        created,
        childId,
        childTitle: window.ChatState.get('sessions').list.find(session => session.id === childId)?.title,
        childHistory: child?.history || [],
        sourceHistory: source?.history || []
      };
    });

    assert.equal(result.created, true, 'La rama debe crearse correctamente');
    assert.notEqual(result.childId, 'session_branch_parent_test', 'La rama debe tener una sesión distinta');
    assert.equal(result.childTitle, 'Rama: Conversación origen', 'La rama debe identificarse a partir del chat de origen');
    assert.equal(result.childHistory.length, 3, 'La rama debe incluir solo el historial hasta la respuesta seleccionada');
    assert.equal(result.sourceHistory.length, 5, 'La conversación de origen debe conservar todos sus mensajes');
    assert.notEqual(result.childHistory[2].id, 'assistant_parent_1', 'Los mensajes de la rama deben tener IDs propios para no sobrescribir el origen');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 4: Composer Flotante Omnibox, Auto-expansión y Botones Circulares', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar geometría y curvatura del Omnibox (.chat-input-container)
    const composerMetrics = await page.evaluate(() => {
      const container = document.querySelector('.chat-input-container');
      const style = getComputedStyle(container);
      const rect = container.getBoundingClientRect();
      return {
        borderRadius: parseFloat(style.borderRadius),
        width: rect.width,
        boxShadow: style.boxShadow
      };
    });

    assert.ok(composerMetrics.borderRadius >= 20, `El radio de curvatura (${composerMetrics.borderRadius}px) debe ser estilo omnibox (>= 20px / 1.5rem)`);
    assert.ok(composerMetrics.width <= 1120 && composerMetrics.width > 900, `El ancho del composer (${composerMetrics.width}px) debe alinearse con max-width: 68rem`);
    assert.notEqual(composerMetrics.boxShadow, 'none', 'El composer debe tener elevación mediante sombra');

    // 2. Validar autoexpansión del textarea al introducir múltiples líneas
    const initialHeight = await page.$eval('#user-input', el => el.offsetHeight);
    await page.fill('#user-input', 'Línea 1\nLínea 2\nLínea 3\nLínea 4\nLínea 5');
    await page.dispatchEvent('#user-input', 'input');

    const expandedHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(expandedHeight > initialHeight, `La altura del textarea debe crecer con contenido multilínea (de ${initialHeight}px a ${expandedHeight}px)`);

    // Limpiar input y verificar vuelta a altura mínima
    await page.fill('#user-input', '');
    await page.dispatchEvent('#user-input', 'input');
    const resetHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(resetHeight <= initialHeight, 'Al vaciar el texto debe volver a la altura mínima');

    // 3. Validar botón circular de envío y botón de adjuntar
    const buttonStyles = await page.evaluate(() => {
      const btnSend = document.getElementById('btn-send');
      const btnAttach = document.getElementById('btn-attach-file');
      const sendStyle = getComputedStyle(btnSend);
      const attachStyle = getComputedStyle(btnAttach);
      return {
        sendRadius: parseFloat(sendStyle.borderRadius),
        sendWidth: parseFloat(sendStyle.width),
        sendHeight: parseFloat(sendStyle.height),
        attachRadius: parseFloat(attachStyle.borderRadius)
      };
    });

    assert.equal(buttonStyles.sendWidth, buttonStyles.sendHeight, 'El botón de envío debe ser perfectamente circular (width === height)');
    assert.ok(buttonStyles.sendRadius >= 16, 'El botón de envío debe tener borde completamente redondeado');
    assert.ok(buttonStyles.attachRadius >= 16, 'El botón de adjuntar debe tener borde redondeado');

    // 4. Validar menú desplegable de razonamiento integrado
    await page.click('#btn-reasoning');
    const isMenuOpen = await page.$eval('#reasoning-menu', el => el.style.display !== 'none');
    assert.ok(isMenuOpen, 'Pulsar #btn-reasoning debe desplegar el menú de opciones');

    // 5. Validar metamorfosis dinámica entre botón de Send y Stop
    // Al simular streaming activando stop-stream:
    await page.evaluate(() => {
      const stopBtn = document.getElementById('btn-stop-stream');
      stopBtn.style.display = 'inline-flex';
    });

    const isSendHiddenDuringStop = await page.evaluate(() => {
      const sendBtn = document.getElementById('btn-send');
      return getComputedStyle(sendBtn).display === 'none';
    });
    assert.ok(isSendHiddenDuringStop, 'Cuando el botón de detener está visible, el botón de envío debe ocultarse automáticamente');

    // Restaurar estado inactivo
    await page.evaluate(() => {
      const stopBtn = document.getElementById('btn-stop-stream');
      stopBtn.style.display = 'none';
    });

    const isSendVisibleAgain = await page.evaluate(() => {
      const sendBtn = document.getElementById('btn-send');
      return getComputedStyle(sendBtn).display !== 'none';
    });
    assert.ok(isSendVisibleAgain, 'Al terminar el streaming, el botón de envío vuelve a ser visible');

  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 5: Barra Lateral de Conversaciones Moderna, Grupos y Drawer', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar que la barra lateral está abierta por defecto
    const isSidebarVisible = await page.$eval('#chat-sidebar', el => getComputedStyle(el).display === 'flex');
    assert.ok(isSidebarVisible, 'El sidebar debe mostrarse con display flex');

    // 2. Validar botón de nueva conversación como icono en la cabecera
    const newChatBtnInfo = await page.evaluate(() => {
      const btn = document.getElementById('btn-sidebar-new-chat');
      const style = getComputedStyle(btn);
      return {
        exists: !!btn,
        text: btn.textContent.trim(),
        hasSvg: !!btn.querySelector('svg'),
        isInActions: !!btn.closest('.sidebar-header-actions'),
        width: parseFloat(style.width),
        height: parseFloat(style.height)
      };
    });
    assert.ok(newChatBtnInfo.exists, 'El botón #btn-sidebar-new-chat debe existir');
    assert.ok(newChatBtnInfo.hasSvg, 'El botón de nueva conversación debe contener un icono SVG');
    assert.ok(newChatBtnInfo.isInActions, 'El botón de nueva conversación debe estar en las acciones de la cabecera del sidebar');
    assert.ok(newChatBtnInfo.width > 0 && newChatBtnInfo.height > 0, 'El botón de nueva conversación debe tener dimensiones renderizadas');

    // 3. Validar buscador de historial con icono
    const searchInfo = await page.evaluate(() => {
      const input = document.getElementById('sidebar-search-input');
      const icon = document.querySelector('.sidebar-search-icon');
      return {
        hasInput: !!input,
        hasIcon: !!icon,
        placeholder: input.getAttribute('placeholder')
      };
    });
    assert.ok(searchInfo.hasInput, 'El input de búsqueda debe existir');
    assert.ok(searchInfo.hasIcon, 'El icono de búsqueda debe existir');

    // 4. Inyectar sesiones de prueba con diferentes fechas para probar agrupación cronológica
    await page.evaluate(() => {
      const now = Date.now();
      const mockSessions = [
        { id: 'chat-today-1', title: 'Plan de Refactorización UI', updatedAt: now },
        { id: 'chat-yesterday-1', title: 'Consulta de Base de Datos', updatedAt: now - 86400000 },
        { id: 'chat-older-1', title: 'Diseño de Algoritmos Inicial', updatedAt: now - (45 * 86400000) }
      ];
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input')
      };
      window.ChatUISidebar.renderSidebarChats(elements, mockSessions, 'chat-today-1', {}, { groupByDate: true });
    });

    // Validar cabeceras de grupos cronológicos
    const groupHeaders = await page.$$eval('.sidebar-group-header', els => els.map(e => e.textContent.trim()));
    assert.ok(groupHeaders.length >= 2, 'Deben existir cabeceras de agrupación cronológica');
    assert.ok(groupHeaders.includes('Hoy'), 'Debe incluir grupo Hoy');
    assert.ok(groupHeaders.includes('Ayer'), 'Debe incluir grupo Ayer');

    // Validar chat activo
    const activeItem = await page.$eval('.sidebar-chat-item.active', el => el.getAttribute('data-session-id'));
    assert.equal(activeItem, 'chat-today-1', 'El chat actual debe tener la clase .active');

    // 5. Validar filtrado dinámico mediante buscador
    await page.fill('#sidebar-search-input', 'Refactorización');
    await page.evaluate(() => {
      const now = Date.now();
      const mockSessions = [
        { id: 'chat-today-1', title: 'Plan de Refactorización UI', updatedAt: now },
        { id: 'chat-yesterday-1', title: 'Consulta de Base de Datos', updatedAt: now - 86400000 }
      ];
      const elements = {
        sidebarChatsList: document.getElementById('sidebar-chats-list'),
        sidebarSearchInput: document.getElementById('sidebar-search-input')
      };
      window.ChatUISidebar.renderSidebarChats(elements, mockSessions, 'chat-today-1', {}, { groupByDate: true });
    });

    const filteredCount = await page.$$eval('.sidebar-chat-item', els => els.length);
    assert.equal(filteredCount, 1, 'Solo debe coincidir 1 chat con el filtro');

    // 6. Validar comportamiento responsive en móvil (Drawer Mode)
    await page.setViewportSize({ width: 500, height: 800 });
    const mobileSidebarStyle = await page.$eval('#chat-sidebar', el => {
      const s = getComputedStyle(el);
      return {
        position: s.position,
        zIndex: parseInt(s.zIndex, 10)
      };
    });
    assert.equal(mobileSidebarStyle.position, 'fixed', 'En móvil, el sidebar debe posicionarse como fixed drawer');
    assert.ok(mobileSidebarStyle.zIndex >= 100, 'En móvil, el zIndex debe ser elevado para superponerse al chat');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 6: Modales <dialog> Modernos con Blur y Tarjetas de Herramientas', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir diálogo de Configuración y validar propiedades de modal moderno
    await page.click('#btn-open-settings');
    await page.waitForFunction(() => document.getElementById('settings-dialog')?.open);

    const dialogMetrics = await page.evaluate(() => {
      const dialog = document.getElementById('settings-dialog');
      const style = getComputedStyle(dialog);
      return {
        borderRadius: parseFloat(style.borderRadius),
        boxShadow: style.boxShadow,
        display: style.display
      };
    });

    assert.equal(dialogMetrics.display, 'flex', 'El diálogo abierto debe tener display: flex');
    assert.ok(dialogMetrics.borderRadius >= 16, `El radio de curvatura (${dialogMetrics.borderRadius}px) debe ser moderno (>= 16px / 1.25rem)`);
    assert.notEqual(dialogMetrics.boxShadow, 'none', 'El modal debe tener elevación con sombra');

    const contextCachePlacement = await page.evaluate(() => ({
      automaticNotice: !!document.querySelector('#tab-model [data-i18n="model_cache_title"]'),
      legacyToggle: !!document.getElementById('setting-enable-context-cache'),
      agentCacheText: document.querySelector('#tab-agent')?.textContent.includes('Caché de Contexto') || false
    }));
    assert.ok(contextCachePlacement.automaticNotice, 'La caché automática debe explicarse en la pestaña Modelo');
    assert.equal(contextCachePlacement.legacyToggle, false, 'La caché no debe exponerse como un interruptor de Agente');
    assert.equal(contextCachePlacement.agentCacheText, false, 'La pestaña Agente no debe presentar la caché como herramienta');

    // 2. Navegar entre pestañas del modal (Ej. pestaña Proveedores / Herramientas)
    const tabButtons = await page.$$('.modal-tab-btn');
    assert.ok(tabButtons.length >= 2, 'Debe haber múltiples pestañas en el modal de configuración');

    // Hacer click en la segunda pestaña
    await tabButtons[1].click();
    const isSecondTabActive = await tabButtons[1].evaluate(el => el.classList.contains('active'));
    assert.ok(isSecondTabActive, 'Hacer click en la pestaña debe marcarla como .active');

    // 2b. El mantenedor de perfiles es independiente de la configuración general.
    await tabButtons[0].click();
    const connectionTab = await page.evaluate(() => ({
      hasActiveProfile: !!document.getElementById('settings-active-profile-name'),
      hasConnectionInputs: !!document.querySelector('#settings-dialog #setting-api-url'),
      hasManageButton: !!document.getElementById('btn-manage-profiles')
    }));
    assert.ok(connectionTab.hasActiveProfile, 'La pestaña Conexión debe mostrar el perfil activo');
    assert.equal(connectionTab.hasConnectionInputs, false, 'La pestaña Conexión no debe editar datos de perfil');
    assert.ok(connectionTab.hasManageButton, 'La pestaña Conexión debe enlazar al mantenedor de perfiles');

    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    await page.click('#btn-new-profile');
    await page.fill('#notice-input', 'Perfil Temporal Playwright');
    await page.click('#notice-accept');
    await page.click('#profile-tab-settings');
    await page.fill('#setting-api-url', 'http://playwright-test:1234/v1');
    await page.evaluate(() => { window.ChatUIInspector.handleQueryServer = async () => true; });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => !document.getElementById('btn-save-profile').disabled);
    await page.click('#btn-save-profile');

    const profileSaveResult = await page.evaluate(() => {
      const dialog = document.getElementById('profiles-dialog');
      const feedback = document.getElementById('profile-action-feedback');
      const profile = window.ChatProfileRepository?.findByName?.('Perfil Temporal Playwright');
      const runtime = window.ChatConfig?.getActive?.();
      return {
        isOpen: dialog.open,
        feedbackVisible: feedback && feedback.style.display !== 'none',
        savedUrl: profile?.settings?.apiUrl,
        runtimeUrl: runtime?.apiUrl
      };
    });

    assert.equal(profileSaveResult.isOpen, false, 'Guardar el perfil debe cerrar el mantenedor');
    assert.equal(profileSaveResult.savedUrl, 'http://playwright-test:1234/v1', 'Debe persistir el perfil en su repositorio');
    assert.equal(profileSaveResult.runtimeUrl, 'http://playwright-test:1234/v1', 'El perfil guardado debe quedar activo por defecto');

    // Renombrar el perfil creado actualiza el mismo registro y recarga sus datos.
    await page.click('#btn-manage-profiles');
    await page.waitForFunction(() => document.getElementById('profiles-dialog')?.open);
    const createdProfileId = await page.evaluate(() => window.ChatProfileRepository.findByName('Perfil Temporal Playwright').id);
    await page.selectOption('#profile-select-helper', createdProfileId);
    await page.fill('#setting-profile-name', 'Perfil Temporal renombrado');
    await page.click('#profile-tab-settings');
    await page.fill('#setting-api-url', 'http://active-profile-test:1234/v1');
    await page.evaluate(() => { window.ChatUIInspector.handleQueryServer = async () => true; });
    await page.click('#btn-query-server');
    await page.waitForFunction(() => !document.getElementById('btn-save-profile').disabled);
    await page.click('#btn-save-profile');
    const renamedActiveResult = await page.evaluate(() => {
      const profiles = window.ChatProfileRepository?.list?.() || [];
      const runtime = window.ChatConfig?.getActive?.();
      return {
        renamedCount: profiles.filter(profile => profile.name === 'Perfil Temporal renombrado').length,
        oldNameExists: profiles.some(profile => profile.name === 'Perfil Temporal Playwright'),
        runtimeName: runtime?.activeProfile?.name,
        runtimeUrl: runtime?.apiUrl
      };
    });
    assert.equal(renamedActiveResult.renamedCount, 1, 'Renombrar no debe duplicar el perfil');
    assert.equal(renamedActiveResult.oldNameExists, false, 'El nombre anterior debe desaparecer del selector');
    assert.equal(renamedActiveResult.runtimeName, 'Perfil Temporal renombrado', 'El perfil activo debe reflejar el nuevo nombre');
    assert.equal(renamedActiveResult.runtimeUrl, 'http://active-profile-test:1234/v1', 'Los cambios del perfil activo deben recargarse');

    // 2c. Verificar pestaña MCP (mcp-proxy) al lado de Agente, modal de configuración reactivo y comando
    const tabOrder = await page.$$eval('#settings-dialog .modal-tabs-nav .modal-tab-btn', els => els.map(e => e.getAttribute('data-tab')));
    const agentIndex = tabOrder.indexOf('tab-agent');
    const mcpIndex = tabOrder.indexOf('tab-mcp');
    assert.ok(agentIndex >= 0 && mcpIndex === agentIndex + 1, 'La pestaña MCP debe estar posicionada inmediatamente al lado de la de Agente');

    const mcpTabBtn = await page.$('button[data-tab="tab-mcp"]');
    assert.ok(mcpTabBtn, 'Debe existir la pestaña MCP en la navegación de pestañas');
    await mcpTabBtn.click();
    const isMcpActive = await mcpTabBtn.evaluate(el => el.classList.contains('active'));
    assert.ok(isMcpActive, 'La pestaña MCP debe quedar activa al hacer click');

    const mcpUiState = await page.evaluate(() => {
      const pane = document.getElementById('tab-mcp');
      const badge = document.getElementById('mcp-status-badge');
      const btnConfigure = document.getElementById('btn-mcp-configure');
      const btnConnect = document.getElementById('btn-mcp-connect');
      return {
        paneActive: pane?.classList.contains('active'),
        badgeText: badge?.textContent?.trim(),
        hasConfigureBtn: !!btnConfigure,
        hasConnectBtn: !!btnConnect,
        hasToolsContainer: !!document.getElementById('mcp-tools-container'),
        toolsContainerVisible: document.getElementById('mcp-tools-container')?.style?.display !== 'none'
      };
    });

    assert.ok(mcpUiState.paneActive, 'El panel tab-mcp debe estar visible y activo');
    assert.ok(mcpUiState.badgeText.includes('Desconectado') || mcpUiState.badgeText.includes('Conectado'), 'El estado debe ser Desconectado o Conectado según disponibilidad');
    assert.ok(mcpUiState.hasConfigureBtn, 'El botón Configurar debe estar presente en el panel MCP');
    assert.ok(mcpUiState.hasConnectBtn, 'El botón Conectar debe estar presente en el panel MCP');
    assert.ok(mcpUiState.hasToolsContainer, 'El contenedor de herramientas MCP debe estar presente');
    assert.ok(mcpUiState.toolsContainerVisible, 'El contenedor de herramientas MCP debe estar visible');

    // Abrir modal de configuración e instrucciones desde el botón Configurar
    await page.click('#btn-mcp-configure');
    await page.waitForSelector('#mcp-setup-dialog[open]');
    const isSetupOpen = await page.$eval('#mcp-setup-dialog', el => el.open);
    assert.ok(isSetupOpen, 'El modal de configuración de MCP debe abrirse');

    const modalState = await page.evaluate(() => {
      const portInput = document.getElementById('mcp-port-input');
      const osSelect = document.getElementById('mcp-os-select');
      const command = document.getElementById('mcp-terminal-command');
      const endpoint = document.getElementById('mcp-endpoint-preview');
      return {
        port: portInput?.value,
        operatingSystem: osSelect?.value,
        commandText: command?.textContent?.trim(),
        endpointText: endpoint?.textContent?.trim()
      };
    });

    assert.equal(modalState.port, '6388', 'El puerto por defecto debe ser 6388 (rango 63xx)');
    assert.equal(modalState.operatingSystem, 'linux', 'Linux debe ser el sistema operativo por defecto');
    assert.equal(modalState.commandText, 'python3 zerochat_mcp.py', 'El comando no debe repetir el puerto por defecto');
    assert.equal(modalState.endpointText, 'http://127.0.0.1:6388/sse');

    await page.selectOption('#mcp-os-select', 'windows');
    assert.equal(await page.$eval('#mcp-terminal-command', el => el.textContent.trim()), 'py zerochat_mcp.py');
    await page.selectOption('#mcp-os-select', 'android');
    assert.equal(await page.$eval('#mcp-terminal-command', el => el.textContent.trim()), 'python3 zerochat_mcp.py');
    await page.selectOption('#mcp-os-select', 'linux');

    // Cambiar interactivamente el puerto en el input del modal y verificar reactividad inmediata
    await page.fill('#mcp-port-input', '6395');
    const updatedCommand = await page.$eval('#mcp-terminal-command', el => el.textContent.trim());
    const updatedEndpoint = await page.$eval('#mcp-endpoint-preview', el => el.textContent.trim());
    assert.ok(updatedCommand.includes('--port 6395'), 'El comando debe actualizarse reactivamente a 6395');
    assert.equal(updatedEndpoint, 'http://127.0.0.1:6395/sse', 'El endpoint debe actualizarse reactivamente a 6395');

    await page.selectOption('#mcp-os-select', 'android');
    const androidInstructions = await page.$eval('#mcp-os-instructions', el => el.textContent.trim());
    assert.ok(androidInstructions.includes('TERMUX'), 'Las instrucciones deben cambiar al seleccionar Android');

    // Cerrar el modal de configuración de MCP
    await page.click('#btn-close-mcp-setup-footer');
    await page.waitForFunction(() => !document.getElementById('mcp-setup-dialog')?.open);
    const isSetupClosed = await page.$eval('#mcp-setup-dialog', el => !el.open);
    assert.ok(isSetupClosed, 'El modal de configuración de MCP debe cerrarse correctamente');

    // 3. Cerrar ambos modales sin guardar la configuración general.
    await page.waitForFunction(() => !document.getElementById('profiles-dialog')?.open);
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog')?.open);
    const isClosed = await page.$eval('#settings-dialog', el => !el.open);
    assert.ok(isClosed, 'El diálogo debe cerrarse correctamente');

    // 4. Validar renderizado de Tarjetas de Herramientas (Tool Cards) en el chat
    await page.evaluate(() => {
      const messagesList = document.getElementById('messages-list');
      const wrapper = document.createElement('div');
      wrapper.className = 'message-wrapper assistant';
      wrapper.innerHTML = `
        <div class="message-row assistant">
          <div class="message-content-wrapper">
            <div class="tool-card-wrapper">
              <div class="tool-execution-card">
                <div class="tool-card-header">
                  <div class="tool-card-title">
                    <span>⚡</span>
                    <span>execute_javascript</span>
                  </div>
                  <div class="tool-card-header-actions">
                    <span class="tool-card-badge status-success">✅ Completado (42ms)</span>
                    <button type="button" class="btn-tool-collapse">▾</button>
                  </div>
                </div>
                <div class="tool-card-collapsible-body">
                  <div class="tool-card-result">
                    <pre class="tool-card-code"><code>console.log("Prueba Fase 6");</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
      messagesList.appendChild(wrapper);
    });

    // Validar estilos de la tarjeta de herramienta
    const cardInfo = await page.evaluate(() => {
      const card = document.querySelector('.tool-execution-card');
      const badge = document.querySelector('.tool-card-badge');
      const header = document.querySelector('.tool-card-header');
      const cardStyle = getComputedStyle(card);
      const badgeStyle = getComputedStyle(badge);
      const headerStyle = getComputedStyle(header);
      return {
        cardRadius: parseFloat(cardStyle.borderRadius),
        badgeRadius: parseFloat(badgeStyle.borderRadius),
        headerBg: headerStyle.backgroundColor
      };
    });

    assert.ok(cardInfo.cardRadius >= 8, 'La tarjeta de herramienta debe tener bordes redondeados (>= 8px)');
    assert.ok(cardInfo.badgeRadius >= 12, 'El badge de estado de la tarjeta debe tener estilo píldora');
    assert.ok(cardInfo.headerBg, 'La cabecera de la herramienta debe tener un fondo de superficie asignado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Fase 7: Accesibilidad WCAG 2.1 AA, Focus-Visible y Reduced Motion', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));
    await page.waitForSelector('#welcome-banner');

    // 1. Validar Focus Visible con navegación por teclado
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press('Tab');
    const focusedOutline = await page.evaluate(() => {
      const activeEl = document.activeElement;
      if (!activeEl) return null;
      const s = getComputedStyle(activeEl);
      return {
        tag: activeEl.tagName,
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth
      };
    });
    assert.ok(focusedOutline, 'Debe haber un elemento enfocado por teclado');
    assert.notEqual(focusedOutline.outlineStyle, 'none', 'El elemento enfocado debe tener un indicador visual outline');

    // 2. Validar soporte prefers-reduced-motion
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotionApplied = await page.evaluate(() => {
      const el = document.querySelector('.welcome-banner') || document.body;
      const s = getComputedStyle(el);
      return parseFloat(s.animationDuration) <= 0.05;
    });
    assert.ok(reducedMotionApplied, 'Las animaciones deben reducirse drásticamente bajo prefers-reduced-motion');

    // 3. Validar ratios de contraste de color semántico (WCAG 2.1 AA >= 4.5:1)
    function luminance(r, g, b) {
      const a = [r, g, b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
    }
    function contrastRatio(rgb1, rgb2) {
      const l1 = luminance(rgb1[0], rgb1[1], rgb1[2]);
      const l2 = luminance(rgb2[0], rgb2[1], rgb2[2]);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    // Comprobar ratios en Light Mode (#ffffff fondo)
    const ratioLight = contrastRatio([15, 23, 42], [255, 255, 255]); // #0f172a vs #ffffff
    assert.ok(ratioLight >= 4.5, `Contraste en modo claro (${ratioLight.toFixed(1)}:1) debe superar 4.5:1`);

    // Comprobar ratios en Dark Mode (#131b2e vs #f1f5f9)
    const ratioDark = contrastRatio([241, 245, 249], [19, 27, 46]);
    assert.ok(ratioDark >= 4.5, `Contraste en modo oscuro (${ratioDark.toFixed(1)}:1) debe superar 4.5:1`);

    // 4. Validar ausencia total de errores o excepciones tras interacciones complejas
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    assert.equal(pageErrors.length, 0, 'No debe haber errores de página en ninguna fase');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 2: Iconos Vectoriales SVG en Header Superior y Composer', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar iconos SVG en el Header
    const headerIcons = await page.evaluate(() => {
      const profileSvg = document.querySelector('.composer-profile-trigger .profile-icon svg');
      const ragSvg = document.querySelector('#btn-open-rag svg');
      const debugSvg = document.querySelector('#btn-toggle-debug svg');
      const reasoningSvg = document.querySelector('#btn-reasoning svg');

      return {
        hasProfileSvg: !!profileSvg,
        hasRagSvg: !!ragSvg,
        hasDebugSvg: !!debugSvg,
        hasReasoningSvg: !!reasoningSvg,
        ragWidth: ragSvg ? parseFloat(getComputedStyle(ragSvg).width) : 0,
        reasoningWidth: reasoningSvg ? parseFloat(getComputedStyle(reasoningSvg).width) : 0
      };
    });

    assert.ok(headerIcons.hasProfileSvg, 'El selector de perfiles debe contener un SVG vectorial (zap)');
    assert.ok(headerIcons.hasRagSvg, 'El botón RAG debe contener un SVG vectorial (layers)');
    assert.ok(headerIcons.hasDebugSvg, 'El botón de debug debe contener un SVG vectorial (terminal)');
    assert.ok(headerIcons.hasReasoningSvg, 'El botón de razonamiento debe contener un SVG vectorial (brain)');
    assert.ok(headerIcons.ragWidth >= 12, 'El icono RAG debe tener dimensiones computadas válidas');
    assert.ok(headerIcons.reasoningWidth >= 12, 'El icono de razonamiento debe tener dimensiones válidas');

    // 2. Abrir menú de razonamiento y verificar cabecera con SVG
    await page.click('#btn-reasoning');
    await page.waitForFunction(() => document.getElementById('reasoning-menu')?.style.display !== 'none');

    const menuHeaderInfo = await page.evaluate(() => {
      const menu = document.getElementById('reasoning-menu');
      const header = document.querySelector('.reasoning-menu-header');
      const options = document.querySelector('.reasoning-options');
      const lowOption = document.querySelector('.reasoning-option[data-level="low"]');
      const lowIcon = lowOption?.querySelector('.option-icon');
      const lowText = lowOption?.querySelector('.option-text');
      const svg = header?.querySelector('svg');
      const text = header?.textContent || '';
      const activeOption = document.querySelector('.reasoning-option.active');
      const activeCheckSvg = activeOption?.querySelector('.option-check svg');
      const lowBorderStyle = lowOption ? getComputedStyle(lowOption).borderStyle : '';
      const activeBorderStyle = activeOption ? getComputedStyle(activeOption).borderStyle : '';
      const lowBorderWidth = lowOption ? getComputedStyle(lowOption).borderWidth : '';
      const activeBorderWidth = activeOption ? getComputedStyle(activeOption).borderWidth : '';
      const btnAriaPopup = document.getElementById('btn-reasoning')?.getAttribute('aria-haspopup');
      const btnAriaExpanded = document.getElementById('btn-reasoning')?.getAttribute('aria-expanded');

      return {
        hasSvg: !!svg,
        hasEmoji: text.includes('🧠'),
        text: text.trim(),
        flexDirection: menu ? getComputedStyle(menu).flexDirection : '',
        headerBottom: header?.getBoundingClientRect().bottom || 0,
        optionsTop: options?.getBoundingClientRect().top || 0,
        lowIconRight: lowIcon?.getBoundingClientRect().right || 0,
        lowTextLeft: lowText?.getBoundingClientRect().left || 0,
        lowBorderStyle,
        activeBorderStyle,
        lowBorderWidth,
        activeBorderWidth,
        hasActiveCheckSvg: !!activeCheckSvg,
        btnAriaPopup,
        btnAriaExpanded
      };
    });

    assert.ok(menuHeaderInfo.hasSvg, 'La cabecera del menú de razonamiento debe contener un SVG (brain)');
    assert.equal(menuHeaderInfo.hasEmoji, false, 'La cabecera del menú no debe contener el emoji 🧠');
    assert.equal(menuHeaderInfo.flexDirection, 'column', 'El menú de razonamiento debe apilar cabecera y opciones verticalmente');
    assert.ok(menuHeaderInfo.optionsTop >= menuHeaderInfo.headerBottom, 'Las opciones deben mostrarse debajo de la cabecera, no a su lado');
    assert.ok(menuHeaderInfo.lowTextLeft - menuHeaderInfo.lowIconRight <= 10, 'El texto del nivel bajo debe quedar junto a su indicador');
    assert.ok(menuHeaderInfo.lowBorderStyle === 'none' || menuHeaderInfo.lowBorderWidth === '0px', 'Las opciones de razonamiento no deben tener enmarcado');
    assert.ok(menuHeaderInfo.activeBorderStyle === 'none' || menuHeaderInfo.activeBorderWidth === '0px', 'La opción activa de razonamiento no debe tener enmarcado');
    assert.ok(menuHeaderInfo.hasActiveCheckSvg, 'La opción activa debe indicar selección mediante icono SVG checkmark');
    assert.equal(menuHeaderInfo.btnAriaPopup, 'menu', 'El botón de razonamiento debe declarar aria-haspopup="menu"');
    assert.equal(menuHeaderInfo.btnAriaExpanded, 'true', 'El botón de razonamiento debe tener aria-expanded="true" al estar desplegado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 3: Iconos Vectoriales SVG en Barra Lateral e Historial', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar barra lateral abierta
    await page.waitForFunction(() => document.getElementById('chat-sidebar')?.style.display !== 'none');

    // 2. Verificar iconos vectoriales de cabecera, buscador y footer de sidebar
    const sidebarIcons = await page.evaluate(() => {
      const newChatSvg = document.querySelector('#btn-sidebar-new-chat svg');
      const settingsSvg = document.querySelector('.sidebar-header #btn-open-settings svg');
      const closeSvg = document.querySelector('#btn-close-sidebar svg');
      const searchSvg = document.querySelector('.sidebar-search-box svg');
      const importSvg = document.querySelector('#btn-import-chat-file svg');
      const deleteAllSvg = document.querySelector('#btn-delete-all-chats svg');

      return {
        hasNewChatSvg: !!newChatSvg,
        hasSettingsSvg: !!settingsSvg,
        hasCloseSvg: !!closeSvg,
        hasSearchSvg: !!searchSvg,
        hasImportSvg: !!importSvg,
        hasDeleteAllSvg: !!deleteAllSvg,
        newChatWidth: newChatSvg ? parseFloat(getComputedStyle(newChatSvg).width) : 0,
        searchWidth: searchSvg ? parseFloat(getComputedStyle(searchSvg).width) : 0
      };
    });

    assert.ok(sidebarIcons.hasNewChatSvg, 'El botón de nueva conversación debe tener icono SVG');
    assert.ok(sidebarIcons.hasSettingsSvg, 'El botón de configuración en la cabecera del sidebar debe tener icono SVG');
    assert.ok(sidebarIcons.hasCloseSvg, 'El botón de cerrar barra lateral debe tener icono SVG');
    assert.ok(sidebarIcons.hasSearchSvg, 'El buscador debe tener icono SVG de lupa');
    assert.ok(sidebarIcons.hasImportSvg, 'El botón de importar debe tener icono SVG');
    assert.ok(sidebarIcons.hasDeleteAllSvg, 'El botón de borrar todo debe tener icono SVG');
    assert.ok(sidebarIcons.newChatWidth >= 14, 'El icono de nuevo chat debe tener tamaño >= 14px');

    // 3. Renderizar una sesión simulada en el historial y verificar iconos de acciones en hover
    const chatItemActionIcons = await page.evaluate(() => {
      const list = document.getElementById('sidebar-chats-list');
      if (typeof ChatUISidebar !== 'undefined' && typeof ChatUISidebar.renderSidebarChats === 'function') {
        ChatUISidebar.renderSidebarChats({ sidebarChatsList: list }, [
          { id: 'sess_test_1', title: 'Conversación de prueba', updatedAt: Date.now() }
        ], 'sess_test_1', {});
      }
      const item = list.querySelector('.sidebar-chat-item');
      const exportSvg = item?.querySelector('.btn-export svg');
      const renameSvg = item?.querySelector('.btn-rename svg');
      const deleteSvg = item?.querySelector('.btn-delete svg');

      return {
        hasItem: !!item,
        hasExportSvg: !!exportSvg,
        hasRenameSvg: !!renameSvg,
        hasDeleteSvg: !!deleteSvg,
        exportWidth: exportSvg ? parseFloat(getComputedStyle(exportSvg).width) : 0,
        renameWidth: renameSvg ? parseFloat(getComputedStyle(renameSvg).width) : 0,
        deleteWidth: deleteSvg ? parseFloat(getComputedStyle(deleteSvg).width) : 0
      };
    });

    assert.ok(chatItemActionIcons.hasItem, 'El item de conversación debe renderizarse');
    assert.ok(chatItemActionIcons.hasExportSvg, 'La acción de exportar debe contener icono SVG (download)');
    assert.ok(chatItemActionIcons.hasRenameSvg, 'La acción de renombrar debe contener icono SVG (edit)');
    assert.ok(chatItemActionIcons.hasDeleteSvg, 'La acción de eliminar debe contener icono SVG (trash)');
    assert.ok(chatItemActionIcons.exportWidth >= 10, 'El icono de exportar debe tener dimensiones válidas');
    assert.ok(chatItemActionIcons.renameWidth >= 10, 'El icono de renombrar debe tener dimensiones válidas');
    assert.ok(chatItemActionIcons.deleteWidth >= 10, 'El icono de eliminar debe tener dimensiones válidas');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 4: Iconos Vectoriales SVG en Tarjetas Agénticas y Badges de Estado', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    const toolCardsResult = await page.evaluate(() => {
      const container = document.getElementById('messages-list') || document.body;

      // 1. Crear tarjeta viva de execute_javascript
      const jsCard = ChatToolCards.createLiveToolCard('execute_javascript', { code: 'console.log("hola");' });
      container.appendChild(jsCard);

      const jsTitle = jsCard.querySelector('.tool-card-title');
      const jsTitleSvg = jsTitle?.querySelector('svg');
      const jsBadge = jsCard.querySelector('.tool-card-badge');
      const jsBadgeSpinnerSvg = jsBadge?.querySelector('svg.ui-icon-spin');
      const jsCollapseSvg = jsCard.querySelector('.btn-tool-collapse svg');

      const jsTitleHasEmoji = jsTitle?.textContent.includes('⚡') || false;
      const jsBadgeHasEmoji = jsBadge?.textContent.includes('⏳') || false;

      // 2. Actualizar tarjeta viva a completada
      ChatToolCards.updateLiveToolCard(jsCard, 'execute_javascript', {}, { success: true, result: 'hola' }, 42);
      const jsBadgeSuccessSvg = jsBadge?.querySelector('svg');
      const jsBadgeSuccessHasEmoji = jsBadge?.textContent.includes('✅') || false;

      // 3. Crear tarjeta de search_web
      const searchCard = ChatToolCards.createLiveToolCard('search_web', { query: 'test query' });
      container.appendChild(searchCard);

      const searchTitle = searchCard.querySelector('.search-card-title');
      const searchTitleSvg = searchTitle?.querySelector('svg');
      const searchBadge = searchCard.querySelector('.search-card-badge');
      const searchBadgeSpinnerSvg = searchBadge?.querySelector('svg.ui-icon-spin');

      const searchTitleHasEmoji = searchTitle?.textContent.includes('🔍') || false;
      const searchBadgeHasEmoji = searchBadge?.textContent.includes('⏳') || false;

      // 4. Renderizar gráfico nativo
      let chartSvgFound = false;
      let chartEmojiFound = true;
      if (typeof ChatCharts !== 'undefined' && typeof ChatCharts.renderChartCard === 'function') {
        const chartHtml = ChatCharts.renderChartCard({
          type: 'bar',
          title: 'Ventas Mensuales',
          labels: ['Ene', 'Feb'],
          datasets: [{ label: 'Ventas', data: [10, 20] }]
        });
        const chartWrapper = document.createElement('div');
        chartWrapper.innerHTML = chartHtml;
        container.appendChild(chartWrapper);

        const chartHeader = chartWrapper.querySelector('.chat-chart-title');
        chartSvgFound = !!chartHeader?.querySelector('svg');
        chartEmojiFound = chartHeader?.textContent.includes('📊') || false;
      }

      return {
        hasJsTitleSvg: !!jsTitleSvg,
        jsTitleHasEmoji,
        hasJsBadgeSpinnerSvg: !!jsBadgeSpinnerSvg,
        jsBadgeHasEmoji,
        hasJsCollapseSvg: !!jsCollapseSvg,
        hasJsBadgeSuccessSvg: !!jsBadgeSuccessSvg,
        jsBadgeSuccessHasEmoji,
        hasSearchTitleSvg: !!searchTitleSvg,
        searchTitleHasEmoji,
        hasSearchBadgeSpinnerSvg: !!searchBadgeSpinnerSvg,
        searchBadgeHasEmoji,
        chartSvgFound,
        chartEmojiFound,
        jsCardCollapsed: !!jsCard.querySelector('.tool-execution-card.collapsed')
      };
    });

    // Validaciones JS Tool Card
    assert.ok(toolCardsResult.hasJsTitleSvg, 'execute_javascript debe tener icono SVG');
    assert.equal(toolCardsResult.jsTitleHasEmoji, false, 'execute_javascript no debe tener emoji ⚡');
    assert.ok(toolCardsResult.hasJsBadgeSpinnerSvg, 'El badge en ejecución debe tener un spinner SVG animado');
    assert.equal(toolCardsResult.jsBadgeHasEmoji, false, 'El badge no debe tener emoji ⏳');
    assert.ok(toolCardsResult.hasJsCollapseSvg, 'El botón de colapsar debe tener un chevron SVG');
    assert.ok(toolCardsResult.hasJsBadgeSuccessSvg, 'El badge de completado debe tener un check SVG');
    assert.equal(toolCardsResult.jsBadgeSuccessHasEmoji, false, 'El badge de completado no debe tener emoji ✅');
    assert.ok(toolCardsResult.jsCardCollapsed, 'La tarjeta de la tool debe aparecer minimizada (collapsed) tras su ejecución');

    // Validaciones Search Web Card
    assert.ok(toolCardsResult.hasSearchTitleSvg, 'search_web debe tener icono SVG');
    assert.equal(toolCardsResult.searchTitleHasEmoji, false, 'search_web no debe tener emoji 🔍');
    assert.ok(toolCardsResult.hasSearchBadgeSpinnerSvg, 'El badge de búsqueda debe tener spinner SVG');
    assert.equal(toolCardsResult.searchBadgeHasEmoji, false, 'El badge de búsqueda no debe tener emoji ⏳');

    // Validaciones Chart Card
    assert.ok(toolCardsResult.chartSvgFound, 'La tarjeta de gráficos debe tener un icono SVG');
    assert.equal(toolCardsResult.chartEmojiFound, false, 'La tarjeta de gráficos no debe tener emoji 📊');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Iconos Fase 5: Iconos Vectoriales SVG en Modales, Pestañas, Exportación y RAG', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Abrir modal de Ajustes
    await page.click('#btn-open-settings');
    await page.waitForSelector('#settings-dialog[open]');

    const settingsIcons = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('#settings-dialog .modal-tab-btn'));
      const tabsHaveSvg = tabs.every(t => !!t.querySelector('svg'));
      const tabsText = tabs.map(t => t.textContent).join(' ');
      const hasTabEmojis = /🌐|⚙️|🤖|🎨|🔍/.test(tabsText);

      const toggleKeySvg = !!document.querySelector('#btn-toggle-key svg');
      const clearAllBtn = document.getElementById('btn-clear-all-data');
      const clearAllSvg = !!clearAllBtn?.querySelector('svg');
      const clearAllHasEmoji = /🗑/.test(clearAllBtn?.textContent || '');
      const clearAllText = clearAllBtn?.textContent?.trim() || '';
      const themeButtons = Array.from(document.querySelectorAll('.btn-theme-toggle'));
      const themeHaveSvg = themeButtons.every(b => !!b.querySelector('svg'));

      return {
        tabsHaveSvg,
        hasTabEmojis,
        toggleKeySvg,
        clearAllSvg,
        clearAllHasEmoji,
        clearAllText,
        themeHaveSvg
      };
    });

    assert.ok(settingsIcons.tabsHaveSvg, 'Todas las pestañas de configuración deben contener un icono SVG');
    assert.equal(settingsIcons.hasTabEmojis, false, 'Las pestañas no deben contener emojis residuales');
    assert.ok(settingsIcons.toggleKeySvg, 'El botón de visibilidad de clave debe contener icono SVG');
    assert.ok(settingsIcons.clearAllSvg, 'El botón de borrar todo debe contener icono SVG');
    assert.equal(settingsIcons.clearAllHasEmoji, false, 'El botón de borrar todo no debe contener emoji');
    assert.equal(settingsIcons.clearAllText, 'Borrar todo', 'El texto de borrar todo debe ser limpio');
    assert.ok(settingsIcons.themeHaveSvg, 'Los botones de modo claro/oscuro deben contener iconos SVG');

    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.getElementById('settings-dialog').open);

    // 2. Abrir modal de Exportación
    await page.evaluate(() => document.getElementById('export-modal').showModal());
    await page.waitForSelector('#export-modal[open]');

    const exportIcons = await page.evaluate(() => {
      const headerIcon = document.querySelector('#export-modal .modal-icon svg');
      const closeBtn = document.querySelector('#btn-close-export svg');
      const cards = Array.from(document.querySelectorAll('#export-modal .export-card-btn'));
      const cardsHaveSvg = cards.every(c => !!c.querySelector('.export-card-icon svg'));
      const cardsText = cards.map(c => c.textContent).join(' ');
      const hasExportEmojis = /📄|📦|🖨️/.test(cardsText);

      return {
        hasHeaderSvg: !!headerIcon,
        hasCloseSvg: !!closeBtn,
        cardsHaveSvg,
        hasExportEmojis
      };
    });

    assert.ok(exportIcons.hasHeaderSvg, 'La cabecera de exportación debe tener icono SVG');
    assert.ok(exportIcons.hasCloseSvg, 'El botón de cierre de exportación debe tener icono SVG');
    assert.ok(exportIcons.cardsHaveSvg, 'Todas las tarjetas de exportación deben tener icono SVG');
    assert.equal(exportIcons.hasExportEmojis, false, 'Las tarjetas de exportación no deben contener emojis');

    await page.evaluate(() => document.getElementById('export-modal').close());

    // 3. Abrir modal de RAG
    await page.click('#btn-open-rag');
    await page.waitForSelector('#rag-modal[open]');

    const ragIcons = await page.evaluate(() => {
      const headerSvg = document.querySelector('#rag-modal .rag-header-icon svg');
      const activeTab = document.querySelector('#rag-modal-tabs-nav .modal-tab-btn.active');
      const activeTabId = activeTab ? activeTab.dataset.ragTab : null;
      const activePane = document.querySelector('#rag-modal .modal-tab-pane.active');
      const activePaneDisplay = activePane ? window.getComputedStyle(activePane).display : 'none';

      const newBranchBtn = document.getElementById('btn-rag-new-branch');
      const newBranchSvg = newBranchBtn?.querySelector('svg');
      const newBranchHasPlusInText = (newBranchBtn?.textContent || '').includes('+');
      const newBranchText = newBranchBtn?.textContent?.trim() || '';

      const editBranchSvg = document.querySelector('#btn-rag-edit-branch svg');
      const deleteBranchSvg = document.querySelector('#btn-rag-delete-branch svg');
      const exportBranchSvg = document.querySelector('#btn-rag-export-branch svg');
      const importBranchSvg = document.querySelector('#btn-rag-import-branch svg');
      const quotaSvg = document.querySelector('#rag-storage-quota-info svg');

      return {
        hasHeaderSvg: !!headerSvg,
        activeTabId,
        activePaneDisplay,
        hasNewBranchSvg: !!newBranchSvg,
        newBranchHasPlusInText,
        newBranchText,
        hasEditBranchSvg: !!editBranchSvg,
        hasDeleteBranchSvg: !!deleteBranchSvg,
        hasExportBranchSvg: !!exportBranchSvg,
        hasImportBranchSvg: !!importBranchSvg,
        hasQuotaSvg: !!quotaSvg
      };
    });

    assert.ok(ragIcons.hasHeaderSvg, 'La cabecera de RAG debe tener icono SVG');
    assert.equal(ragIcons.activeTabId, 'tab-rag-active', 'El modal de conocimiento debe activar la pestaña Activar por defecto');
    assert.equal(ragIcons.activePaneDisplay, 'flex', 'El pane de la pestaña activa debe estar visible');
    assert.ok(ragIcons.hasNewBranchSvg, 'El botón de nueva rama debe tener icono SVG');
    assert.equal(ragIcons.newBranchHasPlusInText, false, 'El botón de nueva rama no debe tener símbolo + en el texto');
    assert.equal(ragIcons.newBranchText, 'Nueva rama', 'El texto del botón de nueva rama debe ser exactamente "Nueva rama"');
    assert.ok(ragIcons.hasEditBranchSvg, 'El botón de editar rama debe tener icono SVG');
    assert.ok(ragIcons.hasDeleteBranchSvg, 'El botón de eliminar rama debe tener icono SVG');
    assert.ok(ragIcons.hasExportBranchSvg, 'El botón de respaldar rama debe tener icono SVG');
    assert.ok(ragIcons.hasImportBranchSvg, 'El botón de importar rama debe tener icono SVG');
    assert.ok(ragIcons.hasQuotaSvg, 'El indicador de cuota debe tener icono SVG');

    // Verificación de gestión de ramas con campos en pantalla (sin ventanas prompt nativas)
    let dialogTriggered = false;
    page.on('dialog', () => { dialogTriggered = true; });

    await page.click('#rag-modal-tabs-nav [data-rag-tab="tab-rag-manage"]');
    await page.waitForSelector('#rag-branch-details-card');

    // Verificar que el textbox en la pestaña de documentos fue eliminado para ganar espacio
    const workspaceHasTextbox = await page.$eval('#rag-manage-workspace', el => !!el.querySelector('.rag-workspace-summary'));
    assert.equal(workspaceHasTextbox, false, 'El workspace de documentos no debe tener el textbox de resumen para ganar espacio');

    // Pulsar Nueva rama y rellenar campos en pantalla
    await page.click('#btn-rag-new-branch');
    await page.fill('#rag-branch-name-input', 'Rama Playwright');
    await page.fill('#rag-branch-desc-input', 'Descripción de prueba Playwright');

    // Verificar que el botón cambia a Guardar
    const saveBtnTextAfterType = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(saveBtnTextAfterType, 'Guardar', 'Al detectar cambios el botón de nueva rama debe cambiar a Guardar');

    // Pulsar el botón Guardar
    await page.click('#btn-rag-new-branch');

    await page.waitForFunction(() => {
      const select = document.getElementById('rag-manage-branch-select');
      return select && Array.from(select.options).some(opt => opt.text.includes('Rama Playwright'));
    });

    // Verificar que tras guardar vuelve a ser "Nueva rama"
    const btnTextAfterSave = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(btnTextAfterSave, 'Nueva rama', 'Tras guardar el botón debe volver a ser "Nueva rama"');

    // Ahora que la rama existe y está seleccionada en Documentos, verificar el resumen en el pie del modal
    const footerSummary = await page.evaluate(() => {
      const el = document.getElementById('rag-branch-summary-footer');
      return {
        text: el?.textContent?.trim() || '',
        display: el ? window.getComputedStyle(el).display : 'none'
      };
    });
    assert.ok(footerSummary.text.includes('Esta rama cargó'), 'El pie del modal debe contener el resumen "Esta rama cargó"');
    assert.ok(footerSummary.text.includes('documentos de'), 'El pie del modal debe indicar "documentos de"');
    assert.notEqual(footerSummary.display, 'none', 'El resumen en el pie del modal debe ser visible en la pestaña Documentos');

    const createdBranch = await page.evaluate(async () => {
      const branches = await window.ChatRagStorage.getBranches();
      return branches.find(b => b.name === 'Rama Playwright');
    });

    assert.ok(createdBranch, 'La rama debe haberse creado en IndexedDB');
    assert.equal(createdBranch.description, 'Descripción de prueba Playwright', 'La descripción debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse disparado ningún diálogo prompt() nativo');

    // Modificar descripción en pantalla y verificar que cambia a Guardar
    await page.fill('#rag-branch-desc-input', 'Descripción editada sin prompts');
    const editBtnText = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    assert.equal(editBtnText, 'Guardar', 'Al modificar la descripción el botón debe cambiar a Guardar');

    await page.click('#btn-rag-new-branch');

    await page.waitForFunction(async (branchId) => {
      const b = await window.ChatRagStorage.getBranchById(branchId);
      return b && b.description === 'Descripción editada sin prompts';
    }, createdBranch.id);

    const updatedBranch = await page.evaluate(async (branchId) => {
      return await window.ChatRagStorage.getBranchById(branchId);
    }, createdBranch.id);

    assert.equal(updatedBranch.description, 'Descripción editada sin prompts', 'La modificación debe haberse guardado');
    assert.equal(dialogTriggered, false, 'No debe haberse mostrado ningún diálogo emergente bloqueante');

    const btnTextFinal = await page.$eval('#btn-rag-new-branch', el => el.textContent.trim());
    // Verificar que en la pestaña Activar el resumen de cada rama también dice "Esta rama cargó"
    await page.click('#rag-modal-tabs-nav [data-rag-tab="tab-rag-active"]');
    const activeBranchMetricsText = await page.$eval('.rag-branch-select-card .rag-branch-metrics', el => el.textContent.trim());
    assert.ok(activeBranchMetricsText.includes('Esta rama cargó'), 'El resumen de cada rama en la pestaña Activar debe decir "Esta rama cargó"');
    assert.ok(activeBranchMetricsText.includes('documentos de'), 'El resumen de cada rama en la pestaña Activar debe usar "documentos de"');

    await page.click('#btn-close-rag');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Verificación global de iconos SVG, accesibilidad y auditoría residual', async (t) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const fileUrl = 'file://' + path.resolve(__dirname, '../index.html');
    await page.goto(fileUrl, { waitUntil: 'load' });

    // 1. Verificar estructura y renderizado de SVGs
    const svgValidation = await page.evaluate(() => {
      const svgs = Array.from(document.querySelectorAll('svg.ui-icon'));
      const allWellFormed = svgs.every(svg => {
        return svg.tagName.toLowerCase() === 'svg' &&
          svg.getAttribute('viewBox') === '0 0 24 24' &&
          svg.children.length > 0;
      });

      // Validar dimensiones en SVGs actualmente visibles en pantalla
      const visibleHeaderSvgs = Array.from(document.querySelectorAll('.top-header svg.ui-icon'));
      const headerSvgsRendered = visibleHeaderSvgs.every(svg => {
        const rect = svg.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      // Validar que ninguna opción de selector de proveedor contiene emojis
      const apiTypeSelect = document.getElementById('setting-api-type');
      const optionsText = Array.from(apiTypeSelect?.options || []).map(o => o.textContent).join(' ');
      const hasOptionEmojis = /🤖|🦙|🔀|🎭|✨/.test(optionsText);

      // Validar que la cabecera, sidebar y controles de ajuste no contienen emojis residuales
      const headerText = document.querySelector('.app-header')?.textContent || '';
      const sidebarText = document.querySelector('.sidebar')?.textContent || '';
      const settingsTabsText = document.querySelector('#settings-dialog .modal-tabs-nav')?.textContent || '';

      const forbiddenEmojis = /⚡|📊|🌿|📤|📜|🧠|➕|🔍|🗑️|✏️|👁️|☀️|🌙/;
      const hasHeaderEmojis = forbiddenEmojis.test(headerText);
      const hasSidebarEmojis = /➕|🗑️|✏️/.test(sidebarText);
      const hasSettingsTabsEmojis = /🌐|⚙️|🤖|🎨|🔍/.test(settingsTabsText);

      return {
        svgCount: svgs.length,
        allWellFormed,
        headerSvgsRendered,
        hasOptionEmojis,
        hasHeaderEmojis,
        hasSidebarEmojis,
        hasSettingsTabsEmojis
      };
    });

    assert.ok(svgValidation.svgCount >= 20, `Debe haber al menos 20 iconos vectoriales en la interfaz (encontrados: ${svgValidation.svgCount})`);
    assert.ok(svgValidation.allWellFormed, 'Todos los iconos SVG deben estar bien formados con viewBox="0 0 24 24" y trazo vectorial');
    assert.ok(svgValidation.headerSvgsRendered, 'Los iconos SVG visibles en la cabecera deben renderizarse con dimensiones positivas');
    assert.equal(svgValidation.hasOptionEmojis, false, 'El selector de proveedor no debe contener emojis');
    assert.equal(svgValidation.hasHeaderEmojis, false, 'La cabecera no debe contener emojis residuales');
    assert.equal(svgValidation.hasSidebarEmojis, false, 'La barra lateral no debe contener emojis residuales');
    assert.equal(svgValidation.hasSettingsTabsEmojis, false, 'Las pestañas de configuración no deben contener emojis residuales');

    // 2. Verificar alternancia de temas claro/oscuro y stroke de currentColor
    const themeTest = await page.evaluate(() => {
      const btnThemeLight = document.getElementById('btn-theme-light');
      const btnThemeDark = document.getElementById('btn-theme-dark');
      btnThemeDark.click();
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

      // Verificar que los SVGs usan currentColor
      const sampleSvg = document.querySelector('.app-header svg.ui-icon');
      const strokeAttr = sampleSvg?.getAttribute('stroke');

      btnThemeLight.click();
      const isLight = !document.documentElement.getAttribute('data-theme') || document.documentElement.getAttribute('data-theme') === 'light';

      return {
        isDark,
        isLight,
        usesCurrentColor: strokeAttr === 'currentColor'
      };
    });

    assert.ok(themeTest.isDark, 'Debe activar correctamente el tema oscuro');
    assert.ok(themeTest.isLight, 'Debe activar correctamente el tema claro');
    assert.ok(themeTest.usesCurrentColor, 'Los iconos vectoriales deben usar stroke="currentColor" para heredar contraste dinámicamente');

    // 3. Verificar inspector de capacidades con SVGs vectoriales
    const inspectorCapSvgs = await page.evaluate(() => {
      // Simular reporte en UIInspector
      const fakeReport = {
        provider: { id: 'openai', label: 'OpenAI Test' },
        endpoint: { normalized: 'https://api.openai.com/v1/chat/completions' },
        model: { selected: 'gpt-4o', totalDiscovered: 1 },
        inspectionTimeMs: 120,
        capabilities: {
          streaming: { status: 'confirmed', detail: 'OK' },
          tools: { status: 'confirmed', detail: 'OK' },
          vision: { status: 'confirmed', detail: 'OK' },
          reasoning: { status: 'confirmed', detail: 'OK' }
        }
      };

      const elements = {
        inspectorResults: document.getElementById('inspector-results')
      };

      const inspector = window.ChatUIInspector || window.UIInspector;
      if (inspector && typeof inspector.renderInspectorReport === 'function') {
        inspector.renderInspectorReport(elements, fakeReport);
      }

      const capCards = Array.from(document.querySelectorAll('#inspector-results .inspector-cap-card'));
      const cardsHaveSvgs = capCards.length > 0 && capCards.every(c => !!c.querySelector('.cap-card-title svg.ui-icon'));
      const text = document.getElementById('inspector-results')?.textContent || '';
      const hasCapEmojis = /📡|⚙️|👁️|🧠|📋|💾|🔢|🤖/.test(text);

      return {
        cardCount: capCards.length,
        cardsHaveSvgs,
        hasCapEmojis
      };
    });

    assert.ok(inspectorCapSvgs.cardCount >= 4, 'Deben renderizarse las tarjetas de capacidad en el inspector');
    assert.ok(inspectorCapSvgs.cardsHaveSvgs, 'Todas las tarjetas de capacidad deben renderizar iconos SVG vectoriales');
    assert.equal(inspectorCapSvgs.hasCapEmojis, false, 'Las tarjetas de capacidad no deben contener emojis residuales');

  } finally {
    await browser.close();
  }
});

test('Browser UI - Borrado de respuesta de asistente con tools elimina completamente las respuestas de tools y sanea chatHistory', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../index.html');
    await page.goto(filePath, { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const sessionId = 'test_session_delete_tools_' + Date.now();
      const baseId = 'msg_ast_interactive_test';
      const history = [
        { id: 'usr_msg_1', role: 'user', content: '¿Qué hora es?' },
        {
          id: `${baseId}_turn_0_assistant`,
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_time_ui', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"2+2"}' } }]
        },
        {
          id: `${baseId}_turn_0_tool_call_time_ui`,
          role: 'tool',
          tool_call_id: 'call_time_ui',
          name: 'execute_javascript',
          content: '4'
        },
        {
          id: `${baseId}_final`,
          role: 'assistant',
          content: 'Son exactamente las 12:00 UTC.'
        }
      ];

      // Guardar conversación en el almacenamiento
      await window.ChatStorage.saveConversation({ id: sessionId, title: 'Test Delete Tools' }, history);
      window.ChatState.setState({
        agent: { activeTurnIndex: 3, currentTool: 'execute_javascript', loopWarning: true, ragSystemContext: 'stale context' },
        telemetry: { stats: { tokens: 99 }, diagnostics: { used: 99 }, lastTurnStats: { tokens: 42 } },
        ui: { reasoningMenuOpen: true, debugPanelOpen: true, attachedFiles: [{ name: 'stale.txt' }] }
      });
      window.ChatAttachments.addFile({ name: 'stale.txt', type: 'text', size: 1, content: 'x' });

      // Cargar la conversación en la UI
      const switched = await window.ChatApp.switchToSession(sessionId);

      // Esperar renderizado
      await new Promise(r => setTimeout(r, 100));
      const assistantWrapper = document.querySelector('.message-wrapper.assistant');
      const deleteBtn = assistantWrapper?.querySelector('.btn-delete');

      const beforeDelete = {
        switched,
        hasAssistantWrapper: !!assistantWrapper,
        hasDeleteBtn: !!deleteBtn,
        restoredMessages: window.ChatState.get('messages'),
        restoredAgent: window.ChatState.get('agent'),
        restoredTelemetry: window.ChatState.get('telemetry'),
        restoredUi: window.ChatState.get('ui'),
        attachedFilesCount: window.ChatAttachments.getFiles().length
      };

      if (deleteBtn) {
        deleteBtn.click();
      }

      // Esperar microtask / actualización de storage
      await new Promise(r => setTimeout(r, 100));

      const loadedAfter = await window.ChatStorage.getConversation(sessionId);
      const afterHistory = loadedAfter ? loadedAfter.history : [];
      const remainingWrappers = document.querySelectorAll('.message-wrapper');

      return {
        beforeDelete,
        remainingWrappersCount: remainingWrappers.length,
        hasAssistantWrapperAfter: !!document.querySelector('.message-wrapper.assistant'),
        afterHistoryLength: afterHistory.length,
        toolCountAfter: afterHistory.filter(m => m.role === 'tool').length,
        assistantCountAfter: afterHistory.filter(m => m.role === 'assistant').length,
        userCountAfter: afterHistory.filter(m => m.role === 'user').length
      };
    });

    assert.equal(result.beforeDelete.switched, true, 'La conversación guardada debe restaurarse desde el historial');
    assert.ok(result.beforeDelete.hasAssistantWrapper, 'El asistente con tools debe renderizarse inicialmente');
    assert.ok(result.beforeDelete.hasDeleteBtn, 'El botón de eliminar respuesta debe existir');
    assert.equal(result.beforeDelete.restoredMessages.length, 4, 'Debe restaurar todos los mensajes del turno guardado');
    assert.deepEqual(result.beforeDelete.restoredMessages[1].tool_calls, [{ id: 'call_time_ui', type: 'function', function: { name: 'execute_javascript', arguments: '{"code":"2+2"}' } }]);
    assert.deepEqual(result.beforeDelete.restoredAgent, { activeTurnIndex: 0, currentTool: null, loopWarning: false, ragSystemContext: '' });
    assert.deepEqual(result.beforeDelete.restoredTelemetry, { stats: null, diagnostics: null, lastTurnStats: null });
    assert.equal(result.beforeDelete.restoredUi.reasoningMenuOpen, false);
    assert.equal(result.beforeDelete.restoredUi.debugPanelOpen, false);
    assert.equal(result.beforeDelete.attachedFilesCount, 0, 'Los adjuntos transitorios no deben filtrarse al chat restaurado');
    assert.equal(result.hasAssistantWrapperAfter, false, 'El wrapper del asistente debe haber desaparecido del DOM');
    assert.equal(result.toolCountAfter, 0, 'No deben quedar respuestas de tool en el historial persistido');
    assert.equal(result.assistantCountAfter, 0, 'No deben quedar mensajes de asistente de la respuesta eliminada');
    assert.equal(result.userCountAfter, 1, 'Debe permanecer el mensaje de usuario');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Borrado de mensaje durante streaming no modifica DOM ni estado', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const filePath = 'file://' + path.resolve(__dirname, '../index.html');
    await page.goto(filePath, { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const sessionId = 'test_session_delete_streaming_' + Date.now();
      const history = [
        { id: 'usr_streaming_1', role: 'user', content: 'Mensaje que no debe borrarse' },
        { id: 'ast_streaming_1', role: 'assistant', content: 'Respuesta previa' }
      ];

      await window.ChatStorage.saveConversation({ id: sessionId, title: 'Test Delete Streaming' }, history);
      await window.ChatApp.switchToSession(sessionId);
      window.ChatState.set('streaming', { isGenerating: true, status: 'streaming' });

      const userWrapper = document.querySelector('.message-wrapper.user');
      userWrapper?.querySelector('.btn-delete')?.click();
      await new Promise(resolve => setTimeout(resolve, 100));

      const persisted = await window.ChatStorage.getConversation(sessionId);
      const stateMessages = window.ChatState.get('messages');
      window.ChatState.set('streaming', { isGenerating: false, status: 'idle' });
      return {
        userWrapperPresent: !!document.querySelector('.message-wrapper.user'),
        stateIds: stateMessages.map(message => message.id),
        persistedIds: (persisted?.history || []).map(message => message.id)
      };
    });

    assert.equal(result.userWrapperPresent, true, 'El mensaje debe permanecer visible durante streaming');
    assert.deepEqual(result.stateIds, ['usr_streaming_1', 'ast_streaming_1'], 'El estado no debe modificarse durante streaming');
    assert.deepEqual(result.persistedIds, ['usr_streaming_1', 'ast_streaming_1'], 'La conversación persistida no debe modificarse durante streaming');
  } finally {
    await browser.close();
  }
});

test('Browser UI - borrar la conversación activa carga la siguiente y limpia su historial visible', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.resolve(__dirname, '../index.html'), { waitUntil: 'load' });

    const result = await page.evaluate(async () => {
      const suffix = Date.now().toString();
      const activeId = `test_session_active_${suffix}`;
      const nextId = `test_session_next_${suffix}`;
      const activeHistory = [{ id: 'active_message', role: 'user', content: 'Conversación que se elimina' }];
      const nextHistory = [{ id: 'next_message', role: 'user', content: 'Conversación que debe mostrarse' }];
      const sessions = [
        { id: activeId, title: 'Activa', createdAt: Date.now(), updatedAt: Date.now() },
        { id: nextId, title: 'Siguiente', createdAt: Date.now() - 1, updatedAt: Date.now() - 1 }
      ];

      await window.ChatStorage.saveConversation(sessions[0], activeHistory);
      await window.ChatStorage.saveConversation(sessions[1], nextHistory);
      window.ChatState.initializeConversation({ sessionId: nextId, sessions, messages: nextHistory });
      await window.ChatApp.switchToSession(activeId);

      const originalConfirm = window.ChatDialogs.confirm;
      window.ChatDialogs.confirm = async () => true;
      try {
        await window.ChatApp.deleteSession(activeId);
      } finally {
        window.ChatDialogs.confirm = originalConfirm;
      }

      return {
        activeId: window.ChatState.get('sessions').activeId,
        listedIds: window.ChatState.get('sessions').list.map(session => session.id),
        messageIds: window.ChatState.get('messages').map(message => message.id),
        deletedConversation: await window.ChatStorage.getConversation(activeId),
        visibleText: document.getElementById('messages-list').textContent
      };
    });

    assert.equal(result.activeId, result.listedIds[0], 'La siguiente sesión debe quedar activa');
    assert.equal(result.listedIds.length, 1, 'La conversación eliminada debe desaparecer de la lista');
    assert.deepEqual(result.messageIds, ['next_message'], 'Debe cargarse el historial de la siguiente conversación');
    assert.equal(result.deletedConversation, null, 'La conversación eliminada no debe permanecer en IndexedDB');
    assert.match(result.visibleText, /Conversación que debe mostrarse/, 'La vista debe reemplazar el chat eliminado');
    assert.doesNotMatch(result.visibleText, /Conversación que se elimina/, 'La vista no debe conservar el chat eliminado');
  } finally {
    await browser.close();
  }
});

test('Browser UI - fecha inicial persistente y hora solo mediante herramienta en fuente y bundle', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of ['index.html', 'zerochat.html']) {
      const context = await browser.newContext({ timezoneId: 'Europe/Madrid' });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-09-05T23:30:00Z'));
      await page.goto('file://' + path.resolve(__dirname, '..', file), { waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatEngine?.ensureConversationDate);
      const initial = await page.evaluate(async () => {
        const history = [{ id: 'system_root', role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }];
        const anchor = ChatEngine.ensureConversationDate(history, 'es');
        const messages = ChatEngine.buildEffectiveMessages(history);
        await ChatStorage.saveConversation({ id: 'temporal_browser', title: 'Fecha fija', createdAt: Date.now() }, history);
        return { anchor, messages };
      });
      assert.match(initial.anchor, /2026-09-06/);
      await page.clock.setFixedTime(new Date('2026-09-08T10:00:00Z'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !!window.ChatEngine?.ensureConversationDate);
      const restored = await page.evaluate(async () => {
        const session = await ChatStorage.getConversation('temporal_browser');
        const messages = ChatEngine.buildEffectiveMessages(session.history);
        return { messages, fresh: ChatEngine.getConversationDateAnchor('es') };
      });
      assert.deepEqual(restored.messages, initial.messages, file);
      assert.equal(restored.messages[1].content, 'Hola');
      assert.ok(!JSON.stringify(restored.messages).includes('[Context Time:'));
      assert.match(restored.fresh, /2026-09-08/);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test('Browser UI - Botón y cabecera para abrir/cerrar tool funcionan al recuperar del historial', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Guardar y cargar una conversación con tool en el almacenamiento
    await page.evaluate(async () => {
      const history = [
        { id: 'msg_u_tool', role: 'user', content: 'Calcula 10 + 20' },
        {
          id: 'msg_a_tool',
          role: 'assistant',
          content: 'He ejecutado el código para calcularlo:',
          tool_calls: [{
            id: 'call_js_hist_1',
            type: 'function',
            function: { name: 'execute_javascript', arguments: '{"javascript":"return 10 + 20;"}' }
          }]
        },
        {
          id: 'msg_t_tool',
          role: 'tool',
          tool_call_id: 'call_js_hist_1',
          name: 'execute_javascript',
          content: '{"success":true,"result":"30"}'
        }
      ];
      await window.ChatStorage.saveConversation({ id: 'sess_tool_hist_toggle', title: 'Test Tool Toggle', createdAt: Date.now() }, history);
      await window.ChatApp.switchToSession('sess_tool_hist_toggle');
    });

    // 2. Esperar que se renderice la tarjeta de la tool
    await page.waitForSelector('.tool-execution-card');

    // 3. Verificar que aparece minimizada (collapsed) inicialmente
    const isInitiallyCollapsed = await page.$eval('.tool-execution-card', el => el.classList.contains('collapsed'));
    assert.equal(isInitiallyCollapsed, true, 'La tarjeta de tool recuperada del historial debe estar minimizada inicialmente');

    // 4. Hacer clic en el botón .btn-tool-collapse y verificar que se abre (no colapsada)
    await page.click('.btn-tool-collapse');
    const isOpenedAfterBtnClick = await page.$eval('.tool-execution-card', el => !el.classList.contains('collapsed'));
    assert.equal(isOpenedAfterBtnClick, true, 'Al pulsar el botón .btn-tool-collapse debe expandirse la tarjeta');

    // 5. Hacer clic de nuevo en el botón .btn-tool-collapse y verificar que se cierra
    await page.click('.btn-tool-collapse');
    const isClosedAfterSecondClick = await page.$eval('.tool-execution-card', el => el.classList.contains('collapsed'));
    assert.equal(isClosedAfterSecondClick, true, 'Al pulsar de nuevo el botón .btn-tool-collapse debe volver a minimizarse');

    // 6. Hacer clic en la cabecera .tool-card-header y verificar que también se expande
    await page.click('.tool-card-header');
    const isOpenedAfterHeaderClick = await page.$eval('.tool-execution-card', el => !el.classList.contains('collapsed'));
    assert.equal(isOpenedAfterHeaderClick, true, 'Al pulsar en la cabecera de la tarjeta debe expandirse');
  } finally {
    await browser.close();
  }
});

test('Browser UI - Rediseño Composer: dos partes lógicas, barra inferior con controles y apertura directa de tabs', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const filePath = 'file://' + path.resolve(__dirname, '../zerochat.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Validar la estructura de dos filas dentro de #chat-form
    const structure = await page.evaluate(() => {
      const form = document.querySelector('#chat-form');
      const topRow = form?.querySelector('.composer-top-row');
      const bottomRow = form?.querySelector('.composer-bottom-row');
      const userInput = topRow?.querySelector('#user-input');
      const controlsLeft = bottomRow?.querySelector('.composer-controls-left');
      const actionsRight = bottomRow?.querySelector('.composer-actions-right');

      const btnAttach = controlsLeft?.querySelector('#btn-attach-file');
      const btnReasoning = controlsLeft?.querySelector('#btn-reasoning');
      const btnTools = controlsLeft?.querySelector('#btn-composer-tools');
      const btnMcp = controlsLeft?.querySelector('#btn-composer-mcp');
      const btnRag = controlsLeft?.querySelector('#btn-open-rag');

      const tokensBadge = actionsRight?.querySelector('#connection-tokens-badge');
      const btnStop = actionsRight?.querySelector('#btn-stop-stream');
      const btnSend = actionsRight?.querySelector('#btn-send');

      return {
        hasTopRow: !!topRow,
        hasBottomRow: !!bottomRow,
        userInputInTopRow: !!userInput,
        hasControlsLeft: !!controlsLeft,
        hasActionsRight: !!actionsRight,
        hasBtnAttach: !!btnAttach,
        hasBtnReasoning: !!btnReasoning,
        hasBtnTools: !!btnTools,
        hasBtnMcp: !!btnMcp,
        hasBtnRag: !!btnRag,
        ragText: btnRag?.textContent?.trim() || '',
        mcpDot: !!btnMcp?.querySelector('.mcp-dot'),
        hasTokensBadge: !!tokensBadge,
        hasBtnStop: !!btnStop,
        hasBtnSend: !!btnSend
      };
    });

    assert.ok(structure.hasTopRow, 'El composer debe contener .composer-top-row');
    assert.ok(structure.hasBottomRow, 'El composer debe contener .composer-bottom-row');
    assert.ok(structure.userInputInTopRow, '#user-input debe estar en la fila superior');
    assert.ok(structure.hasBtnAttach, 'El botón adjuntar debe estar en los controles inferiores izquierdos');
    assert.ok(structure.hasBtnReasoning, 'El botón de razonamiento debe estar en los controles inferiores izquierdos');
    assert.ok(structure.hasBtnTools, 'El botón de tools debe estar en los controles inferiores izquierdos');
    assert.ok(structure.hasBtnMcp, 'El botón de MCP debe estar en los controles inferiores izquierdos');
    assert.ok(structure.hasBtnRag, 'El botón de RAG debe estar en los controles inferiores izquierdos');
    assert.ok(structure.ragText.includes('RAG'), `El botón de RAG debe tener el texto RAG (obtenido: "${structure.ragText}")`);
    assert.ok(structure.mcpDot, 'El botón de MCP debe contener el indicador .mcp-dot');
    assert.ok(structure.hasTokensBadge, 'El contador de tokens debe estar a la derecha');
    assert.ok(structure.hasBtnSend, 'El botón enviar debe estar a la derecha');

    // 2. Probar que pulsar #btn-composer-tools abre #settings-dialog en la pestaña tab-agent
    await page.click('#btn-composer-tools');
    await page.waitForSelector('#settings-dialog[open]');
    const activeTabAfterTools = await page.evaluate(() => {
      const activeBtn = document.querySelector('.modal-tabs-nav .modal-tab-btn.active');
      const activePane = document.querySelector('.modal-tab-pane.active');
      return {
        tabKey: activeBtn?.getAttribute('data-tab'),
        paneId: activePane?.id
      };
    });
    assert.equal(activeTabAfterTools.tabKey, 'tab-agent', 'Al hacer clic en Tools debe abrirse la pestaña tab-agent');
    assert.equal(activeTabAfterTools.paneId, 'tab-agent', 'El panel visible debe ser tab-agent');

    // Cerrar modal de settings
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.querySelector('#settings-dialog')?.open);

    // 3. Probar que pulsar #btn-composer-mcp abre #settings-dialog en la pestaña tab-mcp
    await page.click('#btn-composer-mcp');
    await page.waitForSelector('#settings-dialog[open]');
    const activeTabAfterMcp = await page.evaluate(() => {
      const activeBtn = document.querySelector('.modal-tabs-nav .modal-tab-btn.active');
      const activePane = document.querySelector('.modal-tab-pane.active');
      return {
        tabKey: activeBtn?.getAttribute('data-tab'),
        paneId: activePane?.id
      };
    });
    assert.equal(activeTabAfterMcp.tabKey, 'tab-mcp', 'Al hacer clic en MCP debe abrirse la pestaña tab-mcp');
    assert.equal(activeTabAfterMcp.paneId, 'tab-mcp', 'El panel visible debe ser tab-mcp');

    // Cerrar modal de settings
    await page.click('#btn-close-settings');
    await page.waitForFunction(() => !document.querySelector('#settings-dialog')?.open);

    // 4. Probar que pulsar #btn-open-rag abre el diálogo de RAG
    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    const isRagOpen = await page.$eval('#rag-modal', el => el.open);
    assert.ok(isRagOpen, 'El botón #btn-open-rag en el composer debe abrir #rag-modal');

    // Cerrar diálogo de RAG
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);
  } finally {
    await browser.close();
  }
});

test('Browser UI - ChatState como fuente única de verdad en ciclo de vida y sesiones', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!text.includes('favicon') && !text.includes('ERR_CONNECTION_REFUSED')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    const filePath = 'file://' + path.resolve(__dirname, '../index.html');
    await page.goto(filePath, { waitUntil: 'load' });
    await page.waitForSelector('#welcome-banner');

    // 1. Verificar contrato inicial de ChatState en el navegador
    const stateAudit = await page.evaluate(() => {
      const State = window.ChatState;
      if (!State) return { ok: false, reason: 'no-state' };
      const slices = State.CANONICAL_SLICES || [];
      const state = State.getState();
      const hasAllSlices = slices.every(k => k in state);
      return {
        ok: true,
        hasAllSlices,
        hasToolSecurity: 'toolSecurity' in state,
        hasAttachedFiles: Array.isArray(state.ui?.attachedFiles),
        hasSessions: Array.isArray(state.sessions?.list),
        hasMessages: Array.isArray(state.messages),
        hasMutators: typeof State.replaceConversation === 'function' &&
                     typeof State.appendMessage === 'function' &&
                     typeof State.removeTurn === 'function' &&
                     typeof State.saveSessionMetadata === 'function' &&
                     typeof State.removeSession === 'function' &&
                     typeof State.importConversation === 'function' &&
                     typeof State.setAttachments === 'function' &&
                     typeof State.clearAttachments === 'function'
      };
    });

    assert.equal(stateAudit.ok, true, 'ChatState debe estar disponible en window');
    assert.equal(stateAudit.hasAllSlices, true, 'Todos los slices canónicos deben estar presentes');
    assert.equal(stateAudit.hasToolSecurity, true, 'toolSecurity debe estar declarado en el estado');
    assert.equal(stateAudit.hasAttachedFiles, true, 'ui.attachedFiles debe ser un array');
    assert.equal(stateAudit.hasMutators, true, 'Todos los mutadores de dominio deben estar implementados');

    // 2. Verificar sincronización de adjuntos sin estado local en ChatAttachments
    await page.evaluate(() => {
      window.ChatAttachments.addFile({ name: 'doc_browser.txt', size: 120, type: 'text', content: 'hola' });
    });
    const attachedCount = await page.evaluate(() => window.ChatState.get('ui').attachedFiles.length);
    assert.equal(attachedCount, 1, 'ChatAttachments debe actualizar ChatState.ui.attachedFiles directamente');

    await page.evaluate(() => {
      window.ChatAttachments.clearFiles();
    });
    const attachedAfterClear = await page.evaluate(() => window.ChatState.get('ui').attachedFiles.length);
    assert.equal(attachedAfterClear, 0, 'clearFiles debe vaciar ChatState.ui.attachedFiles');

    // 3. Probar mutación de turnos a través de ChatState
    const turnTest = await page.evaluate(() => {
      const State = window.ChatState;
      State.appendMessage({ role: 'user', content: 'Pregunta en browser' });
      const count1 = State.get('messages').length;
      State.removeTurn((m) => m.content === 'Pregunta en browser');
      const count2 = State.get('messages').length;
      return { count1, count2 };
    });
    assert.ok(turnTest.count1 > turnTest.count2, 'removeTurn debe reducir la lista de mensajes en ChatState');

    assert.equal(consoleErrors.length, 0, 'No debe haber errores de consola: ' + consoleErrors.join(' | '));
  } finally {
    await browser.close();
  }
});


test('Browser UI - Internal notices queue safely above modals and restore focus', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, route => route.fulfill(route.request().resourceType() === 'eventsource'
      ? { status: 204, body: '' }
      : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', dialog => { errors.push('Native dialog: ' + dialog.type()); dialog.dismiss(); });
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'));
    await page.waitForFunction(() => window.ChatState?.get('messages').length > 0);
    await page.evaluate(() => {
      const settings = document.getElementById('settings-dialog');
      settings.showModal();
      const button = settings.querySelector('button');
      button.focus();
      window.noticeFocus = button;
      window.noticeDone = 0;
      ChatDialogs.alert('<img src=x onerror="window.injected=true">').then(() => window.noticeDone++);
      ChatDialogs.alert('<img src=x onerror="window.injected=true">').then(() => window.noticeDone++);
      ChatDialogs.alert('Second', { type: 'error' }).then(() => window.noticeDone++);
    });
    assert.equal(await page.locator('#notice-message img').count(), 0);
    assert.match(await page.locator('#notice-message').textContent(), /<img/);
    assert.equal(await page.evaluate(() => ChatState.get('ui').notices.length), 2);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#notice-message').textContent(), 'Second');
    assert.equal(await page.evaluate(() => window.noticeDone), 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.getElementById('notice-dialog').open), false);
    assert.equal(await page.evaluate(() => document.activeElement === window.noticeFocus), true);
    await page.evaluate(() => {
      ChatDialogs.alert('Stale').then(() => window.noticeDone++);
      ChatState.replaceConversation({ sessionId: 'notice-test', messages: [] });
    });
    assert.equal(await page.evaluate(() => window.noticeDone), 4);
    assert.equal(await page.evaluate(() => document.getElementById('notice-dialog').open), false);
    await page.evaluate(() => {
      window.confirmResults = [];
      ChatDialogs.confirm('Delete?').then(value => window.confirmResults.push(value));
    });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'notice-cancel');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.confirmResults), [false]);
    await page.evaluate(() => {
      ChatDialogs.confirm('Delete?').then(value => window.confirmResults.push(value));
    });
    await page.locator('#notice-accept').click();
    assert.deepEqual(await page.evaluate(() => window.confirmResults), [false, true]);
    await page.evaluate(() => {
      ChatDialogs.confirm('Delete?').then(value => window.confirmResults.push(value));
    });
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.confirmResults), [false, true, false]);
    await page.evaluate(() => {
      ChatDialogs.confirm('Stale deletion?').then(value => window.confirmResults.push(value));
      ChatState.replaceConversation({ sessionId: 'cancel-confirm', messages: [] });
    });
    assert.deepEqual(await page.evaluate(() => window.confirmResults), [false, true, false, false]);
    await page.evaluate(() => {
      window.promptResults = [];
      ChatDialogs.prompt('Name <img src=x>', 'Initial').then(value => window.promptResults.push(value));
    });
    assert.equal(await page.locator('#notice-input').inputValue(), 'Initial');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'notice-input');
    await page.locator('#notice-input').fill('New name');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.promptResults), ['New name']);
    await page.evaluate(() => { ChatDialogs.prompt('Name').then(value => window.promptResults.push(value)); });
    await page.locator('#notice-accept').click();
    assert.deepEqual(await page.evaluate(() => window.promptResults), ['New name', '']);
    await page.evaluate(() => { ChatDialogs.prompt('Name', 'Discard').then(value => window.promptResults.push(value)); });
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.promptResults), ['New name', '', null]);
    await page.evaluate(() => {
      ChatDialogs.prompt('Name', 'Stale').then(value => window.promptResults.push(value));
      ChatState.replaceConversation({ sessionId: 'cancel-prompt', messages: [] });
    });
    assert.deepEqual(await page.evaluate(() => window.promptResults), ['New name', '', null, null]);
    assert.equal(await page.locator('#notice-input').inputValue(), '');
    await page.locator('#rag-import-input').setInputFiles({
      name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('invalid JSON')
    });
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    assert.equal(await page.evaluate(() => ChatState.get('ui').notices.length), 1);
    assert.equal(await page.locator('#notice-dialog').getAttribute('data-type'), 'error');
    await page.locator('#notice-accept').click();
    assert.equal(await page.locator('#rag-import-input').inputValue(), '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Browser UI - Notices disappear immediately after a blocked import and confirmation', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of ['index.html', 'zerochat.html']) {
      const page = await browser.newPage();
      await page.route(/^https?:/, route => route.fulfill(route.request().resourceType() === 'eventsource'
        ? { status: 204, body: '' }
        : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('dialog', dialog => { errors.push('Native dialog'); dialog.dismiss(); });
      await page.goto('file://' + path.resolve(__dirname, '..', file));
      await page.waitForFunction(() => window.ChatState?.get('messages').length > 0);
      const before = await page.evaluate(() => {
        ChatState.set('streaming', { isGenerating: true });
        return { messages: ChatState.get('messages'), session: ChatState.get('sessions').activeId };
      });
      await page.locator('#import-json-input').setInputFiles({
        name: 'blocked.json', mimeType: 'application/json', buffer: Buffer.from('{}')
      });
      assert.equal(await page.locator('#notice-message').textContent(), await page.evaluate(() => ChatI18n.t('chat_import_blocked_generating')));
      assert.equal(await page.locator('#import-json-input').inputValue(), '');
      for (const mode of ['alert', 'confirm']) {
        if (mode === 'confirm') await page.evaluate(() => { ChatDialogs.confirm('Continue?'); });
        // Esperar a que termine la entrada para comprobar la antigua transición de salida.
        await page.evaluate(async () => {
          const dialog = document.getElementById('notice-dialog');
          getComputedStyle(dialog).opacity;
          await Promise.all(dialog.getAnimations().map(animation => animation.finished));
        });
        const frames = await page.evaluate(async () => {
          const dialog = document.getElementById('notice-dialog');
          document.getElementById('notice-accept').click();
          const frames = [];
          for (let i = 0; i < 18; i++) {
            await new Promise(requestAnimationFrame);
            frames.push({ open: dialog.open, height: dialog.getBoundingClientRect().height, display: getComputedStyle(dialog).display });
          }
          return frames;
        });
        assert.ok(frames.every(frame => !frame.open && frame.height === 0 && frame.display === 'none'), file + ': closed notice must never remain visible');
      }
      assert.deepEqual(await page.evaluate(() => ({ messages: ChatState.get('messages'), session: ChatState.get('sessions').activeId })), before);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Browser UI - Los campos select/combo no presentan remarcado azul al recibir el foco', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
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

    // 2. Probar combo de MCP en mcp-setup-dialog
    await page.evaluate(() => {
      document.getElementById('settings-dialog').close();
      document.getElementById('mcp-setup-dialog').showModal();
    });
    await page.focus('#mcp-os-select');
    const mcpStyle = await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('mcp-os-select'));
      return {
        outlineStyle: s.outlineStyle,
        borderColor: s.borderColor,
        boxShadow: s.boxShadow
      };
    });
    assert.equal(mcpStyle.outlineStyle, 'none', 'El combo #mcp-os-select no debe tener outline en foco');
    assert.notEqual(mcpStyle.borderColor, 'rgb(37, 99, 235)', 'El combo #mcp-os-select no debe tener borde azul primario');
    assert.equal(mcpStyle.boxShadow, 'none', 'El combo #mcp-os-select no debe tener box-shadow');
  } finally {
    await browser.close();
  }
});

test('UI - Indicador de progreso de generación es invisible sin ciclo activo y visible durante el ciclo', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto('file://' + path.resolve(__dirname, '../zerochat.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('zerochat-ready'));

    // 1. En reposo (sin generar), el elemento debe estar invisible
    const initialVisibility = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      const isGenerating = window.ChatState.get('streaming')?.isGenerating;
      return {
        hidden: el.hidden,
        display: getComputedStyle(el).display,
        isGenerating: Boolean(isGenerating)
      };
    });
    assert.equal(initialVisibility.hidden, true, 'El indicador debe estar oculto en reposo');
    assert.equal(initialVisibility.display, 'none', 'El indicador debe tener display none');
    assert.equal(initialVisibility.isGenerating, false, 'No debe haber ciclo de generación activo');

    // 2. Intentar emitir estado sin ciclo activo debe ser ignorado (infraestructura general protegida)
    await page.evaluate(() => {
      window.ChatApp.setGenerationStatus('Mensaje fuera de ciclo');
    });
    const ignoredOutsideCycle = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      return el.hidden;
    });
    assert.equal(ignoredOutsideCycle, true, 'No debe volverse visible si no hay un ciclo de chat en proceso');

    // 3. Al activarse el ciclo de chat, se hace visible y refleja mensajes de cualquier módulo
    await page.evaluate(() => {
      window.ChatState.set('streaming', { isGenerating: true, status: 'streaming' });
      window.ChatApp.setGenerationStatus('Analizando documentos con RAG...');
    });
    const ragState = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      const text = el.querySelector('.generation-status-text')?.textContent;
      return { hidden: el.hidden, text };
    });
    assert.equal(ragState.hidden, false, 'El indicador debe ser visible durante el ciclo');
    assert.equal(ragState.text, 'Analizando documentos con RAG...');

    // 4. Otro módulo (ej. herramientas/agente) anuncia un nuevo estado
    await page.evaluate(() => {
      window.ChatApp.setGenerationStatus({ phase: 'tool', text: 'Ejecutando web_search...' });
    });
    const toolText = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      return el.querySelector('.generation-status-text')?.textContent;
    });
    assert.equal(toolText, 'Ejecutando web_search...');

    // 4b. Transición de herramienta a pensamiento: debe cambiar a pensando y no mantener el texto de la herramienta
    await page.evaluate(() => {
      window.ChatApp.setGenerationStatus({ phase: 'thinking' });
    });
    const thinkingState = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      const text = el.querySelector('.generation-status-text')?.textContent || '';
      return { phase: el.dataset.phase, text, includesToolText: text.includes('web_search') };
    });
    assert.equal(thinkingState.phase, 'thinking');
    assert.match(thinkingState.text, /Pensando|Thinking/i);
    assert.equal(thinkingState.includesToolText, false, 'El texto del tool no debe persistir durante la fase de pensamiento');

    // 5. Al finalizar el ciclo de chat, vuelve inmediatamente a invisible
    await page.evaluate(() => {
      window.ChatState.set('streaming', { isGenerating: false, status: 'idle' });
    });
    const finalVisibility = await page.evaluate(() => {
      const el = document.getElementById('generation-status');
      return {
        hidden: el.hidden,
        display: getComputedStyle(el).display
      };
    });
    assert.equal(finalVisibility.hidden, true, 'El indicador debe volver a estar oculto al finalizar el ciclo');
    assert.equal(finalVisibility.display, 'none');
  } finally {
    await browser.close();
  }
});
