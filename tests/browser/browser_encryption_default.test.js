const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTestBrowser, closeGlobalBrowser } = require('../helpers/browser-env.js');

after(async () => {
  await closeGlobalBrowser();
});

test('Browser UI - usar clave predeterminada informa cuando no hay API keys', { timeout: 10000 }, async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.goto(`file://${path.resolve(__dirname, '../../zerochat.html')}`, { waitUntil: 'load' });
    await page.locator('#btn-open-settings').evaluate(button => button.click());
    await page.waitForFunction(() => !document.getElementById('sidebar-view-settings').hidden);
    const dependencies = await page.evaluate(() => ({
      backup: Boolean(window.ChatProfileBackup),
      profiles: Boolean(window.ChatProfileRepository?.recipherApiKeys && window.ChatProfileRepository?.verifyApiKeyMaterial),
      dialogs: Boolean(window.ChatDialogs),
      handler: Boolean(window.ChatUIProfiles?.handleUseDefaultEncryptionKey)
    }));
    assert.deepEqual(dependencies, { backup: true, profiles: true, dialogs: true, handler: true });
    await page.locator('.sidebar-settings-item[data-section="encryption"]').evaluate(button => button.click());
    await page.waitForFunction(() => !document.getElementById('sidebar-encryption-nav').hidden);
    await page.locator('#btn-encryption-default').evaluate(button => button.click());
    await page.waitForFunction(() => document.getElementById('notice-dialog').open);
    await page.locator('#notice-accept').evaluate(button => button.click());
    await page.waitForTimeout(100);
    const notice = await page.evaluate(() => ({
      open: document.getElementById('notice-dialog').open,
      message: document.getElementById('notice-message').textContent,
      pending: window.ChatState.get('ui').notices
    }));
    assert.equal(notice.open, true);
    assert.match(notice.message, /No hay API keys guardadas/);
  } finally {
    await browser.close();
  }
});
