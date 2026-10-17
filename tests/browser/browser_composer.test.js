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

test('Browser UI - teclado del composer: Enter envía, Mayús+Enter salta de línea y ArrowUp recupera el último prompt', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);
    const input = page.locator('#user-input');
    const userPrompts = () => page.evaluate(() => window.ChatState.get('messages').filter(message => message.role === 'user').map(message => message.content));
    const pressPrevented = (key, init) => input.evaluate((element, { key, init }) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, { key, init });

    // Sin historial, ArrowUp no cambia nada.
    await input.focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await input.inputValue(), '');

    await input.fill('Primero');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating && window.ChatState.get('messages').some(message => message.role === 'user'));
    assert.deepEqual(await userPrompts(), ['Primero']);
    assert.equal(await input.inputValue(), '');

    await input.focus();
    await page.keyboard.type('a');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('b');
    assert.equal(await input.inputValue(), 'a\nb', 'Mayús+Enter inserta un salto de línea');
    assert.deepEqual(await userPrompts(), ['Primero'], 'Mayús+Enter no envía');

    await input.fill('');
    await page.keyboard.press('ArrowUp');
    assert.equal(await input.inputValue(), 'Primero');
    assert.equal(await input.evaluate(element => element.selectionStart), 'Primero'.length, 'El cursor queda al final');

    await input.fill('borrador');
    assert.equal(await pressPrevented('ArrowUp'), false, 'Con texto, ArrowUp conserva su comportamiento nativo');
    assert.equal(await input.inputValue(), 'borrador');
    await input.fill('');
    assert.equal(await pressPrevented('ArrowUp', { shiftKey: true }), false, 'Con modificadores no recupera el prompt');
    assert.equal(await pressPrevented('ArrowUp', { isComposing: true }), false, 'Durante la composición IME no recupera el prompt');
    assert.equal(await input.inputValue(), '');

    // Reutilizar un mensaje escribe su prompt y devuelve el foco al composer.
    await page.locator('#messages-list').focus().catch(() => {});
    await page.locator('.message-wrapper.user .message-actions button').first().click();
    assert.equal(await input.inputValue(), 'Primero');
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Browser UI - Parar sustituye a Enviar durante la generación, la detiene y Adjuntar abre el selector de archivos', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    // El proveedor no responde hasta que se cancela la petición.
    await page.evaluate(() => {
      window.__aborted = false;
      window.ChatAPI.streamChatCompletion = ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          window.__aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    await page.fill('#user-input', 'Espera');
    await page.click('#btn-send');
    await page.waitForFunction(() => window.ChatState.get('streaming').isGenerating);
    const during = await page.evaluate(() => ({
      sendDisabled: document.getElementById('btn-send').disabled,
      stopHidden: document.getElementById('btn-stop-stream').hidden,
      statusHidden: document.getElementById('generation-status').hidden
    }));
    assert.deepEqual(during, { sendDisabled: true, stopHidden: false, statusHidden: false });

    await page.click('#btn-stop-stream');
    await page.waitForFunction(() => !window.ChatState.get('streaming').isGenerating);
    const after = await page.evaluate(() => ({
      aborted: window.__aborted,
      sendDisabled: document.getElementById('btn-send').disabled,
      stopHidden: document.getElementById('btn-stop-stream').hidden,
      statusHidden: document.getElementById('generation-status').hidden,
      phase: window.ChatState.get('ui').generationStatus.phase
    }));
    assert.deepEqual(after, { aborted: true, sendDisabled: false, stopHidden: true, statusHidden: true, phase: 'idle' });

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btn-attach-file')]);
    assert.equal(chooser.isMultiple(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Browser UI - composer: estructura, autoexpansión, razonamiento, RAG y envío/parada', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    const structure = await page.evaluate(() => {
      const form = document.querySelector('#chat-form');
      const left = form.querySelector('.composer-bottom-row .composer-controls-left');
      const right = form.querySelector('.composer-bottom-row .composer-actions-right');
      const status = document.getElementById('generation-status');
      return {
        inputInTopRow: !!form.querySelector('.composer-top-row #user-input'),
        left: ['#btn-attach-file', '#btn-reasoning', '#btn-open-rag'].every(selector => !!left?.querySelector(selector)),
        right: ['#connection-tokens-badge', '#btn-stop-stream', '#btn-send'].every(selector => !!right?.querySelector(selector)),
        ragIcon: left?.querySelector('#btn-open-rag svg use')?.getAttribute('href'),
        legacyButtons: !!form.querySelector('#btn-composer-tools, #btn-composer-mcp'),
        idleStatusHidden: status.hidden && getComputedStyle(status).display === 'none'
      };
    });
    assert.deepEqual(structure, { inputInTopRow: true, left: true, right: true, ragIcon: '#icon-layers', legacyButtons: false, idleStatusHidden: true });

    const initialHeight = await page.$eval('#user-input', el => el.offsetHeight);
    await page.fill('#user-input', 'Línea 1\nLínea 2\nLínea 3\nLínea 4\nLínea 5');
    await page.dispatchEvent('#user-input', 'input');
    const expandedHeight = await page.$eval('#user-input', el => el.offsetHeight);
    assert.ok(expandedHeight > initialHeight, `La altura del textarea debe crecer con contenido multilínea (de ${initialHeight}px a ${expandedHeight}px)`);
    await page.fill('#user-input', '');
    await page.dispatchEvent('#user-input', 'input');
    assert.ok(await page.$eval('#user-input', el => el.offsetHeight) <= initialHeight, 'Al vaciar el texto debe volver a la altura mínima');

    await page.click('#btn-reasoning');
    const reasoningMenu = await page.evaluate(() => {
      const menu = document.getElementById('reasoning-menu');
      const intensity = document.getElementById('reasoning-intensity');
      const button = document.getElementById('btn-reasoning');
      return {
        display: getComputedStyle(menu).display,
        direction: getComputedStyle(menu).flexDirection,
        range: [intensity.min, intensity.max],
        popup: button.getAttribute('aria-haspopup'),
        expanded: button.getAttribute('aria-expanded')
      };
    });
    assert.deepEqual(reasoningMenu, { display: 'flex', direction: 'column', range: ['0', '4'], popup: 'dialog', expanded: 'true' });
    await page.locator('#reasoning-intensity').fill('3');
    assert.equal(await page.evaluate(() => window.ChatConfig.getActive().reasoningEffort), 'high');
    await page.click('#btn-close-reasoning');
    assert.equal(await page.locator('#reasoning-menu').evaluate(el => el.hidden), true);

    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);

    const sendVisibility = stopHidden => page.evaluate(hidden => {
      document.getElementById('btn-stop-stream').hidden = hidden;
      return getComputedStyle(document.getElementById('btn-send')).display !== 'none';
    }, stopHidden);
    assert.equal(await sendVisibility(false), false, 'Con el botón de detener visible, el de envío debe ocultarse');
    assert.equal(await sendVisibility(true), true, 'Al terminar el streaming, el botón de envío vuelve a ser visible');
  } finally {
    await browser.close();
  }
});

test('Browser UI - composer compacto en móvil mantiene placeholder y controles accesibles', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 }, isMobile: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    for (const language of ['es', 'en']) {
      const metrics = await page.evaluate(language => {
        window.ChatI18n.setLanguage(language);
        const input = document.getElementById('user-input');
        const controls = ['btn-attach-file', 'btn-reasoning', 'btn-open-rag'];
        const buttons = controls.map(id => document.getElementById(id));
        const rects = buttons.map(button => button.getBoundingClientRect());
        const inputStyle = getComputedStyle(input);
        const assistantRow = document.createElement('div');
        assistantRow.className = 'message-row assistant';
        const assistantContent = document.createElement('div');
        assistantContent.className = 'message-content';
        assistantRow.append(assistantContent);
        document.body.append(assistantRow);
        const assistantFontSize = parseFloat(getComputedStyle(assistantContent).fontSize);
        assistantRow.remove();

        const userRow = document.createElement('div');
        userRow.className = 'message-row user';
        const userContent = document.createElement('div');
        userContent.className = 'message-content';
        userRow.append(userContent);
        document.body.append(userRow);
        const userFontSize = parseFloat(getComputedStyle(userContent).fontSize);
        userRow.remove();

        return {
          placeholder: input.placeholder,
          inputHeight: input.getBoundingClientRect().height,
          inputFontSize: parseFloat(inputStyle.fontSize),
          lineHeight: parseFloat(inputStyle.lineHeight),
          hasIcons: buttons.every(button => !!button.querySelector('svg')),
          hasNames: buttons.every(button => !!(button.getAttribute('aria-label') || button.getAttribute('aria-labelledby'))),
          sameRow: rects.every(rect => Math.abs(rect.top - rects[0].top) < 1),
          withinViewport: rects.every(rect => rect.left >= 0 && rect.right <= innerWidth),
          touchTargets: rects.every(rect => rect.width >= 40 && rect.height >= 40),
          touchTargets44: rects.every(rect => rect.width >= 44 && rect.height >= 44),
          assistantFontSize,
          userFontSize
        };
      }, language);
      assert.equal(metrics.placeholder, language === 'es' ? 'Escribe un mensaje...' : 'Write a message...');
      assert.ok(metrics.inputHeight < metrics.lineHeight * 2, 'El placeholder debe caber en una línea');
      assert.equal(metrics.hasIcons, true);
      assert.equal(metrics.hasNames, true);
      assert.equal(metrics.sameRow, true);
      assert.equal(metrics.withinViewport, true);
      assert.equal(metrics.touchTargets, true);
      assert.equal(metrics.touchTargets44, true, 'Los botones del composer deben tener al menos 44px de área táctil en móvil');
      assert.ok(metrics.inputFontSize >= 16, 'El textarea debe usar al menos 16px en móvil para prevenir auto-zoom en iOS');
      assert.ok(metrics.assistantFontSize >= 17, 'La respuesta del asistente debe usar al menos 17px en móvil');
      assert.ok(metrics.userFontSize >= 16.5, 'El mensaje de usuario debe armonizarse con el asistente en móvil');
    }

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Browser UI - el panel de métricas se ancla al composer en escritorio y ocupa el área del chat en móvil', async () => {
  const browser = await createTestBrowser();
  try {
    for (const viewport of [{ width: 320, height: 700, isMobile: true }, { width: 1280, height: 800 }]) {
      const page = await browser.newPage({ viewport, isMobile: Boolean(viewport.isMobile) });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);

      await page.evaluate(() => { document.getElementById('connection-tokens-badge').hidden = false; });
      await page.click('#connection-tokens-badge');
      const layout = await page.evaluate(() => {
        const composerRect = document.getElementById('chat-form').getBoundingClientRect();
        const popoverRect = document.getElementById('context-hub-popover').getBoundingClientRect();
        return {
          popoverTop: popoverRect.top,
          popoverBottom: popoverRect.bottom,
          popoverLeft: popoverRect.left,
          popoverRight: popoverRect.right,
          composerTop: composerRect.top,
          composerLeft: composerRect.left,
          composerRight: composerRect.right,
          headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom,
          viewportWidth: innerWidth
        };
      });

      if (viewport.isMobile) {
        assert.equal(layout.popoverLeft, 0, 'En móvil el panel debe ocupar todo el ancho');
        assert.equal(layout.popoverRight, layout.viewportWidth, 'En móvil el panel debe ocupar todo el ancho');
        assert.ok(Math.abs(layout.popoverTop - layout.headerBottom) <= 1, 'En móvil el panel debe empezar bajo el header');
        assert.ok(Math.abs(layout.popoverBottom - layout.composerTop) <= 1, 'En móvil el panel debe llegar hasta el composer');
      } else {
        assert.ok(layout.popoverLeft >= layout.composerLeft - 1, 'El panel no debe salir por la izquierda del composer');
        assert.ok(layout.popoverRight <= layout.composerRight + 1, 'El panel no debe salir por la derecha del composer');
        assert.ok(layout.popoverRight <= layout.viewportWidth, 'El panel no debe salir del viewport');
      }
      await page.close();
    }
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

test('Browser UI - en móvil los pies de respuesta y confirmación permanecen en una fila', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 700 }, isMobile: true });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    const responseLayout = await page.evaluate(() => {
      const wrapper = document.createElement('div');
      wrapper.className = 'message-wrapper assistant';
      const footer = document.createElement('div');
      footer.className = 'message-footer-row';
      const stats = document.createElement('div');
      stats.className = 'message-stats';
      stats.innerHTML = '<span class="stat-item stat-item-speed">Speed</span><span class="stat-sep">•</span><span class="stat-item stat-item-total">Total</span>';
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      actions.innerHTML = '<button class="btn-msg-action"></button><button class="btn-msg-action"></button><button class="btn-msg-action"></button>';
      footer.append(stats, actions);
      wrapper.append(footer);
      document.getElementById('messages-list').append(wrapper);
      const statsRect = stats.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const result = {
        sameRow: Math.abs((statsRect.top + statsRect.height / 2) - (actionsRect.top + actionsRect.height / 2)) < 1,
        totalHidden: getComputedStyle(stats.querySelector('.stat-item-total')).display === 'none'
      };
      wrapper.remove();
      return result;
    });
    assert.equal(responseLayout.sameRow, true);
    assert.equal(responseLayout.totalHidden, true);

    await page.evaluate(() => { window.mobileConfirm = ChatDialogs.confirm('Delete?'); });
    const confirmationLayout = await page.evaluate(() => {
      const cancel = document.getElementById('notice-cancel').getBoundingClientRect();
      const accept = document.getElementById('notice-accept').getBoundingClientRect();
      return Math.abs((cancel.top + cancel.height / 2) - (accept.top + accept.height / 2)) < 1;
    });
    assert.equal(confirmationLayout, true);
    await page.locator('#notice-cancel').click();

    const typographyAndHeader = await page.evaluate(() => {
      const sidebar = document.getElementById('btn-toggle-sidebar');
      sidebar.hidden = false;
      const debug = document.getElementById('btn-toggle-debug');
      const profile = document.getElementById('active-profile-trigger');
      return {
        textarea: parseFloat(getComputedStyle(document.getElementById('user-input')).fontSize),
        profile: parseFloat(getComputedStyle(profile).fontSize),
        sidebarLeft: sidebar.getBoundingClientRect().left,
        debugRight: debug.getBoundingClientRect().right
      };
    });
    assert.ok(typographyAndHeader.textarea >= 17);
    assert.ok(typographyAndHeader.profile >= 14);
    assert.equal(typographyAndHeader.sidebarLeft, 0);
    assert.equal(typographyAndHeader.debugRight, 320);
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

      // No se actualiza: el tiempo queda como estaba.
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
      page.once('dialog', async dialog => { beforeUnload = dialog.type(); await dialog.dismiss(); });
      await page.evaluate(() => { location.href = 'about:blank#salir'; });
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(300);
      assert.equal(secondDialog, null, 'Sin comandos en marcha no se pide confirmación al salir');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
