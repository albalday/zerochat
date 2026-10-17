const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestBrowser, closeGlobalBrowser, getIndexUrl, waitForAppReady } = require('../helpers/browser-env.js');

describe('Browser UI - a11y_theme', { concurrency: 3 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

test('Browser UI - temas claro/oscuro, foco visible y contraste AA en exportación', async () => {
  const browser = await createTestBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(getIndexUrl(), { waitUntil: 'load' });
    await waitForAppReady(page);

    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    const focusedOutline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(focusedOutline, 'none', 'El elemento enfocado por teclado debe tener un indicador visual outline');

    const readTheme = theme => page.evaluate(theme => {
      document.getElementById(`btn-theme-${theme}`).click();
      const docStyle = getComputedStyle(document.documentElement);
      return {
        dataTheme: document.documentElement.getAttribute('data-theme'),
        primary: docStyle.getPropertyValue('--primary').trim(),
        bgApp: docStyle.getPropertyValue('--bg-app').trim(),
        radiusMd: docStyle.getPropertyValue('--radius-md').trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        iconStroke: document.querySelector('.app-header svg.ui-icon')?.getAttribute('stroke')
      };
    }, theme);
    const light = await readTheme('light');
    const dark = await readTheme('dark');
    assert.ok([null, 'light'].includes(light.dataTheme), 'El tema claro no debe dejar activo el oscuro');
    assert.equal(dark.dataTheme, 'dark');
    assert.ok(light.primary && light.bgApp && light.radiusMd && dark.primary, 'Los design tokens deben resolverse en ambos temas');
    assert.notEqual(dark.bgApp, light.bgApp, 'El fondo de la app debe diferir entre temas');
    assert.notEqual(dark.bodyBg, light.bodyBg, 'El fondo computado del body debe cambiar en dark');
    assert.equal(dark.iconStroke, 'currentColor', 'Los iconos deben heredar el color del tema');

    const exportDarkContrast = await page.evaluate(() => {
      document.getElementById('export-modal').showModal();
      const parseColor = color => (color.match(/\d+/g) || []).slice(0, 3).map(Number);
      const luminance = color => {
        const channels = parseColor(color).map(value => {
          const normalized = value / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const contrast = (foreground, background) => {
        const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (high + 0.05) / (low + 0.05);
      };
      const card = document.querySelector('#export-modal .export-card-btn');
      const background = getComputedStyle(card).backgroundColor;
      const close = getComputedStyle(document.getElementById('btn-close-export'));
      return {
        title: contrast(getComputedStyle(card.querySelector('strong')).color, background),
        description: contrast(getComputedStyle(card.querySelector('.export-card-info span')).color, background),
        closeDistinct: close.color !== close.backgroundColor
      };
    });
    assert.ok(exportDarkContrast.title >= 4.5, 'El título de cada tarjeta de exportación debe tener contraste AA en oscuro');
    assert.ok(exportDarkContrast.description >= 4.5, 'La descripción de cada tarjeta de exportación debe tener contraste AA en oscuro');
    assert.equal(exportDarkContrast.closeDistinct, true, 'El cierre de exportación debe usar colores semánticos en oscuro');
  } finally {
    await browser.close();
  }
});

});
