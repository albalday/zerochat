const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - composer', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
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
    assert.equal(await page.locator('#reasoning-modal').evaluate(el => el.open), true, 'El diálogo modal se abre con showModal');
    assert.equal(await page.locator('#chk-project-mode').isChecked(), true, 'Activo por defecto');
    await page.waitForFunction(() => window.ChatState.get('project').status === 'unavailable');
    assert.equal(await page.locator('.project-mode-status').getAttribute('data-project-status'), 'unavailable');
    assert.equal(await page.locator('[data-project-action]').count(), 0);
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-project-indicator'), null, 'Sin servidor no hay indicador');

    await page.click('#btn-close-reasoning');
    assert.equal(await page.locator('#reasoning-modal').evaluate(el => el.open), false, 'Cerrar modal oculta el diálogo');
    await page.click('#btn-reasoning');
    assert.equal(await page.locator('#reasoning-modal').evaluate(el => el.open), true);

    await page.evaluate(() => window.ChatState.setProjectContext({ status: 'ready', cwd: '/home/u/zerochat', rules: { content: 'r' } }));
    const indicator = await page.evaluate(() => {
      const button = document.getElementById('btn-reasoning');
      return { value: button.getAttribute('data-project-indicator'), title: button.title, label: document.getElementById('reasoning-project-label').textContent };
    });
    assert.equal(indicator.value, 'ready');
    assert.match(indicator.title, /zerochat/);
    assert.match(indicator.label, /zerochat/);
    // La página del chat vacío dice en qué proyecto se está y si el modo proyecto está activado.
    const welcome = () => page.evaluate(() => ({ text: document.getElementById('welcome-project-text').textContent, title: document.getElementById('welcome-project').title }));
    const expectedWelcome = (place, mode) => page.evaluate(([place, mode]) => `${window.ChatI18n.t(place, { name: 'zerochat' })} · ${window.ChatI18n.t(mode)}`, [place, mode]);
    assert.deepEqual(await welcome(), { text: await expectedWelcome('welcome_project', 'welcome_project_mode_on'), title: '/home/u/zerochat' });

    await page.locator('#project-mode-panel .switch').click();
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().projectMode), false);
    await page.waitForFunction(() => window.ChatState.get('project').status === 'disabled');
    assert.equal(await page.locator('#btn-reasoning').getAttribute('data-project-indicator'), null, 'Desactivado no hay indicador');
    // Sin servidor, al recalcular ya no hay carpeta.
    assert.equal((await welcome()).text, await expectedWelcome('welcome_no_project', 'welcome_project_mode_off'));
    await page.locator('#project-mode-panel .switch').click();
    await page.waitForFunction(() => window.ChatState.get('project').status === 'unavailable');

    await page.evaluate(() => window.ChatState.setProjectContext({ status: 'missing', cwd: '/home/u/repo' }));
    const missing = await page.evaluate(() => ({
      text: document.querySelector('.project-mode-status').textContent,
      actions: [...document.querySelectorAll('[data-project-action]')].map(button => button.dataset.projectAction)
    }));
    assert.match(missing.text, /repo/);
    assert.deepEqual(missing.actions, [], 'Sin herramientas de escritura no se ofrece inicializar');

    await page.reload({ waitUntil: 'load' });
    await waitForAppReady(page);
    await page.click('#btn-reasoning');
    assert.equal(await page.locator('#chk-project-mode').isChecked(), true, 'El modo proyecto persiste tras recargar');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

  test('Browser UI - el panel muestra la carpeta de trabajo y la cambia con el selector de carpetas', async () => {
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
          manager.applyLiveState({ cwd: path });
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
      assert.equal(await changeButton.locator('svg.ui-icon').count(), 1, 'El botón es el icono de carpeta');
      assert.equal((await changeButton.textContent()).trim(), '');
      await page.evaluate(() => window.ChatState.setProjectContext({ status: 'ready', cwd: '/home/u/repo', rules: { content: 'r' } }));
      assert.match(await page.locator('[data-project-action="reload"]').getAttribute('title'), /AGENTS\.md/);
      await page.evaluate(() => {
        const { Tool, registry } = window.ChatAgentCore;
        ['read_file', 'write_file'].forEach(name => {
          registry.registerTool(new Tool({
            definition: { name, description: name },
            category: 'native',
            isAvailable: () => true,
            execute: async () => ({ success: true })
          }));
        });
      });
      await page.click('#btn-close-reasoning');
      await page.click('#btn-reasoning');
      assert.equal(await page.locator('[data-project-action="compact"]').count(), 1, 'Ofrece compactar memoria cuando hay herramientas de escritura');
      assert.match(await page.locator('[data-project-action="compact"]').getAttribute('title'), /plan\.md/);

      // Con el modo proyecto apagado el directorio sigue visible.
      await page.locator('#project-mode-panel .switch').click();
      await page.waitForFunction(() => window.ChatState.get('project').status === 'disabled');
      assert.equal(await page.locator('.project-mode-path').textContent(), '~/repo');

      await page.evaluate(() => window.ChatState.set('streaming', { isGenerating: true }));
      assert.equal(await page.locator('[data-project-action="changeDirectory"]').isDisabled(), true, 'Desactivado durante la generación');
      await page.evaluate(() => window.ChatState.set('streaming', { isGenerating: false }));
      assert.equal(await page.locator('[data-project-action="changeDirectory"]').isDisabled(), false);

      // El icono abre el selector de carpetas en la actual, con general fija en los recientes.
      await page.evaluate(() => {
        const dirs = { '/home/u/repo': ['src'], '/home/u': ['other', 'repo'], '/home/u/other': [], '/home/u/repo/src': [] };
        window.ChatState.set('mcp', { serverInfo: { ...window.ChatState.get('mcp').serverInfo, noProjectDir: '/home/u/zerochat/general' } });
        window.ChatState.set('sessions', { ...window.ChatState.get('sessions'), list: [{ id: 'l1', title: 'L', project: '/home/u/lib' }, { id: 'g1', title: 'G' }] });
        window.ChatMCP.manager.requestExternalControl = async (method, params) => {
          if (method === 'zerochat/project/browse') {
            if (!(params.path in dirs)) throw new Error(`Error MCP (-32602): '${params.path}' no existe o no es un directorio.`);
            return { path: params.path, parent: params.path.slice(0, params.path.lastIndexOf('/')) || '/', directories: dirs[params.path], total: dirs[params.path].length, truncated: false };
          }
          if (method === 'zerochat/project/create_directory') {
            const path = `${params.parent}/${params.name}`;
            dirs[path] = [];
            return { path };
          }
          return {};
        };
      });
      const listed = selector => page.$$eval(`${selector} .folder-picker-item`, items => items.map(item => item.textContent));
      const current = () => page.textContent('#folder-picker-current');
      await page.click('[data-project-action="changeDirectory"]');
      await page.waitForFunction(() => document.getElementById('folder-picker-current').textContent === '/home/u/repo');
      assert.equal(await page.locator('#reasoning-modal').isHidden(), true, 'El panel se cierra al abrir el selector');
      assert.deepEqual(await listed('#folder-picker-list'), ['..', 'src']);
      assert.deepEqual(await listed('#folder-picker-recent'), [await page.evaluate(() => window.ChatI18n.t('folder_picker_general', { name: 'general' })), 'lib']);

      await page.click('#folder-picker-list .folder-picker-item:has-text("..")');
      await page.waitForFunction(() => document.getElementById('folder-picker-current').textContent === '/home/u');
      assert.deepEqual(await listed('#folder-picker-list'), ['..', 'other', 'repo']);
      await page.click('#folder-picker-list .folder-picker-item:has-text("other")');
      await page.waitForFunction(() => document.getElementById('folder-picker-current').textContent === '/home/u/other');
      assert.equal(await page.textContent('#folder-picker-list .label-hint'), await page.evaluate(() => window.ChatI18n.t('folder_picker_empty')));

      // Una ruta escrita que no existe avisa sin el prefijo técnico y se queda en la carpeta que se veía.
      await page.fill('#folder-picker-path', '/nope');
      await page.press('#folder-picker-path', 'Enter');
      await page.waitForFunction(() => /'\/nope' no existe/.test(document.getElementById('folder-picker-error').textContent));
      assert.doesNotMatch(await page.textContent('#folder-picker-error'), /Error MCP/);
      assert.equal(await current(), '/home/u/other');

      // Una carpeta nueva se crea en la que se ve y se entra en ella; «Usar» la elige.
      await page.click('#folder-picker-new-toggle');
      await page.fill('#folder-picker-new-name', 'nuevo');
      await page.press('#folder-picker-new-name', 'Enter');
      await page.waitForFunction(() => document.getElementById('folder-picker-current').textContent === '/home/u/other/nuevo');
      assert.equal(await page.textContent('#folder-picker-error'), '');
      const initialSessionId = await page.evaluate(() => window.ChatState.get('sessions').activeId);
      await page.click('#folder-picker-use');
      await page.waitForFunction(() => window.__directoryCalls.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__directoryCalls), ['/home/u/other/nuevo']);
      await page.waitForFunction(() => window.ChatState.get('project').cwd === '/home/u/other/nuevo');
      await page.waitForFunction(prevId => window.ChatState.get('sessions').activeId !== prevId, initialSessionId);
      assert.equal(await page.locator('#folder-picker-dialog').isVisible(), false);

      // Un reciente se elige con un toque; si el servidor la rechaza, se avisa sin el prefijo técnico.
      await page.evaluate(() => { window.__directoryError = "Error MCP (-32602): '/home/u/zerochat/general' no existe o no es un directorio."; });
      await page.click('#btn-reasoning');
      await page.click('[data-project-action="changeDirectory"]');
      await page.click('#folder-picker-recent .folder-picker-item[data-path="/home/u/zerochat/general"]');
      await page.waitForFunction(() => /no existe/.test(document.getElementById('notice-message').textContent));
      assert.deepEqual(await page.evaluate(() => window.__directoryCalls), ['/home/u/other/nuevo', '/home/u/zerochat/general']);
      assert.doesNotMatch(await page.locator('#notice-message').textContent(), /Error MCP/);
      await page.locator('#notice-accept').click();

      // Cancelar no cambia nada.
      await page.click('#btn-reasoning');
      await page.click('[data-project-action="changeDirectory"]');
      await page.click('#folder-picker-cancel');
      assert.equal(await page.evaluate(() => window.__directoryCalls.length), 2);
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
      await page.evaluate(() => window.ChatMCP.manager.applyLiveState({ jobs: window.__running, exit_on_close: true }));
      let beforeUnload = null;
      const dialogSeen = new Promise(resolve => {
        page.once('dialog', async dialog => { beforeUnload = dialog.type(); await dialog.dismiss(); resolve(); });
      });
      await page.evaluate(() => { location.href = 'about:blank#salir'; });
      await dialogSeen;
      assert.equal(beforeUnload, 'beforeunload');

      // Un comando que termina con el turno ya acabado: su línea pasa a su final, con sus últimas líneas.
      await page.evaluate(() => {
        window.__getCalls = [];
        window.ChatMCP.manager.requestExternalControl = async (method, params) => {
          window.__listCalls++;
          if (method === 'zerochat/jobs/get') {
            window.__getCalls.push(params.id);
            return { id: params.id, status: 'exited', exit_code: 1, elapsed_s: 70, tail: 'uno\ndos\ntres\ncuatro\n\ncinco\nERROR: 2 tests failed\n' };
          }
          return { jobs: window.__running };
        };
        window.ChatMCP.manager.applyLiveState({ jobs: window.__running.filter(job => job.id !== 2) });
      });
      await page.waitForFunction(() => document.querySelector('.command-jobs-card li[data-job-id="2"] .command-jobs-tail'));
      const finished = await notice.evaluate(el => ({
        title: el.querySelector('.command-jobs-card-title').textContent.trim(),
        finishedTime: el.querySelector('li[data-job-id="2"] .command-jobs-time').textContent,
        tail: el.querySelector('li[data-job-id="2"] .command-jobs-tail').textContent,
        runningTime: el.querySelector('li[data-job-id="1"] .command-jobs-time').textContent,
        runningTail: Boolean(el.querySelector('li[data-job-id="1"] .command-jobs-tail')),
        hintShown: !el.querySelector('.command-jobs-hint').hidden
      }));
      assert.deepEqual(finished, {
        title: 'Comandos en segundo plano en marcha: 1',
        finishedTime: 'Código 1 · 1:10',
        tail: 'dos\ntres\ncuatro\ncinco\nERROR: 2 tests failed',
        runningTime: shown.items[0][1],
        runningTail: false,
        hintShown: true
      });
      assert.deepEqual(await page.evaluate(() => window.__getCalls), [2], 'Solo pregunta por el que ha terminado, una vez');

      // Cuando terminan todos, el título lo dice y la indicación de que siguen en marcha desaparece.
      await page.evaluate(() => window.ChatMCP.manager.applyLiveState({ jobs: [] }));
      await page.waitForFunction(() => document.querySelector('.command-jobs-card li[data-job-id="1"] .command-jobs-tail'));
      const allDone = await notice.evaluate(el => ({
        title: el.querySelector('.command-jobs-card-title').textContent.trim(),
        hintShown: !el.querySelector('.command-jobs-hint').hidden
      }));
      assert.deepEqual(allDone, { title: 'Comandos en segundo plano terminados: 2', hintShown: false });

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
