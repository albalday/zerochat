const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser, seedConnectionProfiles, getBundleUrl, getIndexUrl } = require('../helpers/browser-env.js');

describe('Browser UI - dialogs_notices', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - Internal notices queue safely above modals and restore focus', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, route => route.fulfill(route.request().resourceType() === 'eventsource'
      ? { status: 204, body: '' }
      : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', dialog => { errors.push('Native dialog: ' + dialog.type()); dialog.dismiss(); });
    await page.goto('file://' + path.resolve(__dirname, '../../zerochat.html'));
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

    // Cerrar cualquier modal abierto antes de proceder
    await page.evaluate(() => {
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    });

    // Abrir el sidebar y asegurar modo chat
    await page.evaluate(() => {
      const sidebar = document.getElementById('chat-sidebar');
      if (sidebar && sidebar.classList.contains('sidebar-hidden')) {
        document.getElementById('btn-toggle-sidebar')?.click();
      }
    });
    await page.waitForTimeout(300);

    // Abrir el modal de RAG en modo "manage" - hacer clic programático en btn-open-settings
    await page.evaluate(() => {
      document.getElementById('btn-open-settings')?.click();
    });
    await page.waitForTimeout(300);

    await page.waitForSelector('.sidebar-settings-item[data-section="rag-manage"]', { state: 'visible', timeout: 5000 });
    await page.click('.sidebar-settings-item[data-section="rag-manage"]');
    await page.waitForSelector('#rag-manage-modal[open]', { timeout: 5000 });
    await page.waitForSelector('#rag-import-input', { state: 'attached', timeout: 5000 });

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
  const browser = await createTestBrowser();
  try {
    for (const file of ['zerochat.html']) {
      const page = await browser.newPage();
      await page.route(/^https?:/, route => route.fulfill(route.request().resourceType() === 'eventsource'
        ? { status: 204, body: '' }
        : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('dialog', dialog => { errors.push('Native dialog'); dialog.dismiss(); });
      await page.goto('file://' + path.resolve(__dirname, '../..', file));
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
          for (let i = 0; i < 6; i++) {
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

test('Browser UI - Notices support custom button labels and optional checkbox', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, route => route.fulfill(route.request().resourceType() === 'eventsource'
      ? { status: 204, body: '' }
      : { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [], models: [] }) }));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(getIndexUrl());
    await page.waitForFunction(() => window.ChatState?.get('messages').length > 0);

    // Test askDuplicate with checkbox checked
    await page.evaluate(() => {
      window.duplicateResults = [];
      ChatDialogs.askDuplicate('Documento existente.txt', {
        title: 'Conflicto de archivo',
        acceptText: 'Reemplazar',
        cancelText: 'Ignorar',
        checkbox: 'Aplicar a todos'
      }).then(res => window.duplicateResults.push(res));
    });

    await page.waitForSelector('#notice-checkbox-container:not([hidden])');
    assert.equal(await page.locator('#notice-accept').textContent(), 'Reemplazar');
    assert.equal(await page.locator('#notice-cancel').textContent(), 'Ignorar');
    assert.equal(await page.locator('#notice-checkbox-text').textContent(), 'Aplicar a todos');
    assert.equal(await page.locator('#notice-checkbox').isChecked(), false);

    // Marcar checkbox y aceptar
    await page.locator('#notice-checkbox').check();
    await page.locator('#notice-accept').click();

    await page.waitForFunction(() => window.duplicateResults?.length === 1);
    const res1 = await page.evaluate(() => window.duplicateResults[0]);
    assert.equal(res1.accepted, true);
    assert.equal(res1.applyToAll, true);

    // Test reject without checking checkbox
    await page.evaluate(() => {
      ChatDialogs.askDuplicate('Otro.txt', {
        checkbox: 'Aplicar a todos'
      }).then(res => window.duplicateResults.push(res));
    });
    await page.waitForSelector('#notice-checkbox-container:not([hidden])');
    await page.locator('#notice-cancel').click();

    await page.waitForFunction(() => window.duplicateResults?.length === 2);
    const res2 = await page.evaluate(() => window.duplicateResults[1]);
    assert.equal(res2.accepted, false);
    assert.equal(res2.applyToAll, false);

    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
});
