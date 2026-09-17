const path = require('node:path');
const { chromium } = require('playwright');

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = chromium.launch({ headless: true });
    return browserPromise;
  }
  return browser;
}

async function closeGlobalBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

async function createTestBrowser() {
  const realBrowser = await getBrowser();
  const contexts = [];
  return {
    async newContext(options) {
      const context = await realBrowser.newContext(options);
      contexts.push(context);
      return context;
    },
    async newPage(options) {
      const context = await realBrowser.newContext(options);
      contexts.push(context);
      return context.newPage();
    },
    async close() {
      await Promise.all(contexts.map(ctx => ctx.close().catch(() => {})));
    }
  };
}

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

function getBundleUrl() {
  return 'file://' + path.resolve(__dirname, '../../zerochat.html');
}

function getIndexUrl() {
  return 'file://' + path.resolve(__dirname, '../../zerochat.html');
}

module.exports = {
  getBrowser,
  closeGlobalBrowser,
  createTestBrowser,
  seedConnectionProfiles,
  getBundleUrl,
  getIndexUrl
};
