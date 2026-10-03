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
        display: menu.style.display,
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
    assert.equal(await page.locator('#reasoning-menu').evaluate(el => el.style.display), 'none');

    await page.click('#btn-open-rag');
    await page.waitForFunction(() => document.getElementById('rag-modal')?.open);
    await page.click('#btn-close-rag');
    await page.waitForFunction(() => !document.getElementById('rag-modal')?.open);

    const sendVisibility = stopDisplay => page.evaluate(display => {
      document.getElementById('btn-stop-stream').style.display = display;
      return getComputedStyle(document.getElementById('btn-send')).display !== 'none';
    }, stopDisplay);
    assert.equal(await sendVisibility('inline-flex'), false, 'Con el botón de detener visible, el de envío debe ocultarse');
    assert.equal(await sendVisibility('none'), true, 'Al terminar el streaming, el botón de envío vuelve a ser visible');
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
        window.ChatI18n.setLanguage(language, false);
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

test('Browser UI - el panel de métricas se ancla al borde derecho del composer', async () => {
  const browser = await createTestBrowser();
  try {
    for (const viewport of [{ width: 320, height: 700, isMobile: true }, { width: 1280, height: 800 }]) {
      const page = await browser.newPage({ viewport, isMobile: Boolean(viewport.isMobile) });
      await page.goto(getIndexUrl(), { waitUntil: 'load' });
      await waitForAppReady(page);

      const layout = await page.evaluate(() => {
        const composer = document.getElementById('chat-form');
        const badge = document.getElementById('connection-tokens-badge');
        const popover = document.getElementById('context-hub-popover');
        badge.style.display = 'inline-flex';
        popover.style.display = 'flex';
        const composerRect = composer.getBoundingClientRect();
        const popoverRect = popover.getBoundingClientRect();
        return {
          popoverLeft: popoverRect.left,
          popoverRight: popoverRect.right,
          composerLeft: composerRect.left,
          composerRight: composerRect.right,
          viewportWidth: innerWidth
        };
      });

      assert.ok(layout.popoverLeft >= layout.composerLeft - 1, 'El panel no debe salir por la izquierda del composer');
      assert.ok(layout.popoverRight <= layout.composerRight + 1, 'El panel no debe salir por la derecha del composer');
      assert.ok(layout.popoverRight <= layout.viewportWidth, 'El panel no debe salir del viewport');
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
      sidebar.style.display = 'inline-flex';
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
});
