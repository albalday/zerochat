const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - composer', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - el fallback de contexto no invalida el formulario de envío', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await seedConnectionProfiles(page);
    await page.addInitScript(() => localStorage.setItem('zerochat_runtime_config_v2', JSON.stringify({
      activeProfile: { id: 'profile:local', name: 'Local chat' }, apiType: 'openai', apiUrl: 'http://localhost:1234/v1', model: 'google/gemma-4-26b-a4b-qat'
    })));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
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

test('Browser UI - en móvil la telemetría con caché no saca el botón de enviar del composer', async () => {
  const browser = await createTestBrowser();
  try {
    for (const width of [320, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 700 }, isMobile: true });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);
      const layout = await page.evaluate(() => {
        document.getElementById('connection-tokens-badge').hidden = false;
        document.getElementById('connection-tokens-text').textContent = '~12.3k / 128k';
        document.getElementById('context-hub-cache-pill').hidden = false;
        document.getElementById('context-hub-cache-val').textContent = '10.2k';
        const form = document.getElementById('chat-form').getBoundingClientRect();
        const send = document.getElementById('btn-send').getBoundingClientRect();
        return { formRight: form.right, sendRight: send.right, sendWidth: send.width };
      });
      assert.ok(layout.sendRight <= layout.formRight, `En ${width}px el botón de enviar debe quedar dentro del composer`);
      assert.ok(layout.sendWidth >= 40, 'El botón de enviar no debe encogerse');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('Browser UI - el modo proyecto se activa desde el panel de razonamiento, persiste y ofrece acciones por estado', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.click('#btn-reasoning');
    assert.equal(await page.locator('#chk-project-mode').isChecked(), true, 'Activo por defecto');
    await page.waitForFunction(() => window.ChatState.get('project').status === 'unavailable');
    assert.equal(await page.locator('.project-mode-status').getAttribute('data-project-status'), 'unavailable');
    assert.equal(await page.locator('[data-project-action]').count(), 0);
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-project-indicator'), null, 'Sin servidor no hay indicador');

    await page.evaluate(() => window.ChatState.setProjectContext({ status: 'ready', cwd: '/home/u/zerochat', rules: { content: 'r' } }));
    const indicator = await page.evaluate(() => {
      const button = document.getElementById('btn-reasoning');
      const dot = getComputedStyle(button, '::after');
      return { value: button.getAttribute('data-project-indicator'), dot: dot.content !== 'none' && dot.width === '7px', title: button.title, label: document.getElementById('reasoning-project-label').textContent };
    });
    assert.equal(indicator.value, 'ready');
    assert.equal(indicator.dot, true);
    assert.match(indicator.title, /zerochat/);
    assert.match(indicator.label, /zerochat/);

    await page.locator('#project-mode-panel .switch').click();
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().projectMode), false);
    await page.waitForFunction(() => window.ChatState.get('project').status === 'disabled');
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-project-indicator'), null, 'Desactivado no hay indicador');
    await page.locator('#project-mode-panel .switch').click();
    await page.waitForFunction(() => window.ChatState.get('project').status === 'unavailable');

    await page.evaluate(() => window.ChatState.setProjectContext({ status: 'missing', cwd: '/home/u/repo' }));
    const missing = await page.evaluate(() => ({
      text: document.querySelector('.project-mode-status').textContent,
      actions: [...document.querySelectorAll('[data-project-action]')].map(button => button.dataset.projectAction)
    }));
    assert.match(missing.text, /repo/);
    assert.deepEqual(missing.actions, ['decline'], 'Sin herramientas de escritura no se ofrece inicializar');

    await page.click('[data-project-action="decline"]');
    await page.locator('#notice-accept').click();
    await page.waitForFunction(() => window.ChatConfig.getActive().projectDeclined.includes('/home/u/repo'));

    await page.reload({ waitUntil: 'load' });
    await waitForAppReady(page);
    await page.click('#btn-reasoning');
    assert.equal(await page.locator('#chk-project-mode').isChecked(), true, 'El modo proyecto persiste tras recargar');
    assert.deepEqual(await page.evaluate(() => window.ChatConfig.getActive().projectDeclined), ['/home/u/repo']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

  test('Browser UI - el panel del proyecto muestra el directorio y lo cambia con «Cambiar…»', async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/Project directory change failed/.test(message.text())) errors.push(message.text()); });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);
      await page.evaluate(() => {
        window.__directoryCalls = [];
        window.__directoryError = '';
        const manager = window.ChatMCP.manager;
        manager.setProjectDirectory = async path => {
          window.__directoryCalls.push(path);
          if (window.__directoryError) throw new Error(window.__directoryError);
          manager.syncProjectDirectory(path);
          return { cwd: path };
        };
        window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/home/u/repo' }, tools: [] });
      });
      await page.click('#btn-reasoning');
      const path = page.locator('.project-mode-path');
      await path.waitFor();
      assert.equal(await path.textContent(), '~/repo');
      assert.equal(await path.getAttribute('title'), '/home/u/repo');
      const changeButton = page.locator('[data-project-action="changeDirectory"]');
      assert.equal(await changeButton.getAttribute('aria-label'), await changeButton.getAttribute('title'));
      assert.ok((await changeButton.getAttribute('aria-label')).length > 0);
      assert.equal(await changeButton.locator('svg.ui-icon').count(), 1, 'El botón es el icono de editar');
      assert.equal((await changeButton.textContent()).trim(), '');
      await page.evaluate(() => window.ChatState.setProjectContext({ status: 'ready', cwd: '/home/u/repo', rules: { content: 'r' } }));
      assert.match(await page.locator('[data-project-action="reload"]').getAttribute('title'), /AGENTS\.md/);

      // Con el modo proyecto apagado el directorio sigue visible.
      await page.locator('#project-mode-panel .switch').click();
      await page.waitForFunction(() => window.ChatState.get('project').status === 'disabled');
      assert.equal(await page.locator('.project-mode-path').textContent(), '~/repo');

      await page.evaluate(() => window.ChatState.set('streaming', { isGenerating: true }));
      assert.equal(await page.locator('[data-project-action="changeDirectory"]').isDisabled(), true, 'Desactivado durante la generación');
      await page.evaluate(() => window.ChatState.set('streaming', { isGenerating: false }));
      assert.equal(await page.locator('[data-project-action="changeDirectory"]').isDisabled(), false);

      await page.click('[data-project-action="changeDirectory"]');
      assert.equal(await page.locator('#notice-input').inputValue(), '/home/u/repo');
      await page.locator('#notice-input').fill('/home/u/other');
      await page.locator('#notice-accept').click();
      await page.waitForFunction(() => window.__directoryCalls.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__directoryCalls), ['/home/u/other']);
      await page.waitForFunction(() => window.ChatState.get('project').cwd === '/home/u/other');

      await page.evaluate(() => { window.__directoryError = "Error MCP (-32602): '/nope' no existe o no es un directorio."; });
      // Aceptar el diálogo cuenta como clic fuera y cierra el menú, como en las demás acciones.
      await page.click('#btn-reasoning');
      await page.click('[data-project-action="changeDirectory"]');
      await page.locator('#notice-input').fill('/nope');
      await page.locator('#notice-accept').click();
      await page.waitForFunction(() => /'\/nope' no existe/.test(document.getElementById('notice-message').textContent));
      assert.doesNotMatch(await page.locator('#notice-message').textContent(), /Error MCP/);
      await page.locator('#notice-accept').click();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

  test('Browser UI - al terminar un turno con comandos en segundo plano se añade un aviso estático y plegado al final del chat', { timeout: 30000 }, async () => {
    const browser = await createTestBrowser();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);

      await page.evaluate(() => {
        // La tarjeta del comando 1 está en esta conversación, archivada en un grupo cerrado.
        const details = document.createElement('details');
        details.className = 'tool-call-group-history';
        details.innerHTML = '<div class="tool-card-wrapper command-card-wrapper" data-job-id="1"><div class="tool-execution-card collapsed"></div></div>';
        document.getElementById('messages-list').appendChild(details);
        window.__running = [
          { id: 1, command: 'npm run dev', status: 'running', started_at: Date.now() - 65000, background: true },
          { id: 2, command: 'pytest -x', status: 'running', started_at: Date.now() - 5000, background: true },
          // Un comando esperado no cuenta: ya se ve en su tarjeta.
          { id: 9, command: 'npm run build', status: 'running', started_at: Date.now() - 3000, background: false }
        ];
        window.__listCalls = 0;
        window.ChatMCP.manager.requestExternalControl = async () => { window.__listCalls++; return { jobs: window.__running }; };
        window.ChatState.set('mcp', { status: 'connected', serverInfo: { name: 'ZeroChat', cwd: '/tmp' }, tools: [] });
        window.__endTurn = () => {
          window.ChatState.set('streaming', { isGenerating: true });
          window.ChatState.set('streaming', { isGenerating: false });
        };
        window.__endTurn();
      });

      const notice = page.locator('#messages-list .command-jobs-card');
      await notice.waitFor({ state: 'visible' });
      const shown = await notice.evaluate(el => ({
        open: el.open,
        last: el === el.parentElement.lastElementChild,
        title: el.querySelector('.command-jobs-card-title').textContent.trim(),
        items: Array.from(el.querySelectorAll('li'), item => [item.querySelector('code').textContent, item.querySelector('.command-jobs-time').textContent, item.querySelector('.command-jobs-link').tagName]),
        buttons: el.querySelectorAll('button').length,
        svg: Boolean(el.querySelector('.command-jobs-card-title svg'))
      }));
      assert.equal(shown.open, false, 'El aviso aparece plegado');
      assert.equal(shown.last, true, 'El aviso se añade al final del chat');
      assert.equal(shown.title, 'Comandos en segundo plano en marcha: 2');
      assert.deepEqual(shown.items.map(([command, , tag]) => [command, tag]), [['npm run dev', 'BUTTON'], ['pytest -x', 'SPAN']]);
      assert.match(shown.items[0][1], /^1:0[5-6]$/);
      assert.equal(shown.buttons, 1, 'Sin botones de detener: solo el enlace a la tarjeta que está a la vista');
      assert.equal(shown.svg, true);
      assert.equal(await page.locator('#command-jobs-bar').count(), 0, 'Ya no hay franja fija sobre el composer');

      // No se actualiza: el tiempo queda como estaba (aserción negativa: la espera fija es a propósito).
      const timeBefore = shown.items[1][1];
      await page.waitForTimeout(400);
      assert.equal(await notice.locator('li').nth(1).locator('.command-jobs-time').textContent(), timeBefore);

      // Desplegado, el enlace abre el grupo, despliega la tarjeta y la resalta.
      await notice.locator('summary').click();
      assert.equal(await notice.evaluate(el => el.open), true);
      await notice.locator('button.command-jobs-link').click();
      const opened = await page.evaluate(() => {
        const card = document.querySelector('[data-job-id="1"]');
        return { open: card.closest('details').open, collapsed: card.querySelector('.tool-execution-card').classList.contains('collapsed'), highlighted: card.classList.contains('command-card-highlight') };
      });
      assert.deepEqual(opened, { open: true, collapsed: false, highlighted: true });

      // Cerrar la pestaña detendría el servidor y los comandos: el navegador pide confirmación.
      await page.evaluate(() => window.ChatMCP.manager.syncCommandJobs(window.__running, { exitOnClose: true }));
      let beforeUnload = null;
      const dialogSeen = new Promise(resolve => {
        page.once('dialog', async dialog => { beforeUnload = dialog.type(); await dialog.dismiss(); resolve(); });
      });
      await page.evaluate(() => { location.href = 'about:blank#salir'; });
      await dialogSeen;
      assert.equal(beforeUnload, 'beforeunload');

      // El turno siguiente sustituye el aviso; sin comandos en marcha, no queda ninguno.
      await page.evaluate(() => {
        window.__running = window.__running.filter(job => job.id !== 2);
        window.__endTurn();
      });
      await page.waitForFunction(() => document.querySelector('.command-jobs-card .command-jobs-card-title')?.textContent.includes(': 1'));
      assert.equal(await page.locator('.command-jobs-card').count(), 1);
      await page.evaluate(() => {
        window.__running = [];
        window.__endTurn();
      });
      await page.waitForFunction(() => document.querySelectorAll('.command-jobs-card').length === 0);

      let secondDialog = null;
      page.once('dialog', async dialog => { secondDialog = dialog.type(); await dialog.dismiss(); });
      await page.evaluate(() => { location.href = 'about:blank#salir'; });
      // Aserción negativa: la espera fija es a propósito para confirmar que el diálogo no aparece.
      await page.waitForTimeout(300);
      assert.equal(secondDialog, null, 'Sin comandos en marcha no se pide confirmación al salir');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
