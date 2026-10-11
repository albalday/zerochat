const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIShell = require('../../js/ui-shell.js');
const { installDom } = require('../helpers/dom-env.js');

test('UIShell - ajusta --app-height al montar y avisa de cada cambio de viewport', t => {
  const dom = installDom({ app: true });
  t.after(() => dom.restore());
  let changes = 0;
  UIShell.mount({ elements: { userInput: document.getElementById('user-input') }, onViewportChange: () => { changes++; }, onDismissProfiles() {} });

  assert.equal(document.documentElement.style.getPropertyValue('--app-height'), `${window.innerHeight}px`);
  window.dispatchEvent(new Event('resize'));
  assert.equal(changes, 1);

  // Montar de nuevo sustituye los oyentes anteriores en lugar de duplicarlos.
  UIShell.mount({ elements: { userInput: document.getElementById('user-input') }, onViewportChange: () => { changes++; }, onDismissProfiles() {} });
  window.dispatchEvent(new Event('resize'));
  assert.equal(changes, 2);
});
