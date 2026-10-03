const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIShell = require('../../js/ui-shell.js');

test('UIShell - detecta HTTP, ajusta --app-height y abre/cierra la información de ejecución', () => {
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'http:' } }), true);
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'https:' } }), true);
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'file:' } }), false);
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'blob:' } }), false);
  assert.equal(UIShell.isHttpExecution(null), false);

  let propertyName = '';
  let propertyValue = '';
  const mockDoc = {
    documentElement: {
      style: {
        setProperty: (name, val) => {
          propertyName = name;
          propertyValue = val;
        }
      }
    }
  };
  const mockWin = {
    innerHeight: 800,
    visualViewport: { height: 750 }
  };

  UIShell.updateViewportHeight(mockDoc, mockWin);
  assert.equal(propertyName, '--app-height');
  assert.equal(propertyValue, '750px');

  // Fallback to innerHeight when visualViewport is not available
  UIShell.updateViewportHeight(mockDoc, { innerHeight: 900 });
  assert.equal(propertyValue, '900px');

  let shown = false;
  let closed = false;
  let textScope = '';
  let downloadHidden = false;

  const mockElements = {
    executionInfoDialog: {
      open: false,
      showModal: () => { shown = true; mockElements.executionInfoDialog.open = true; },
      close: () => { closed = true; mockElements.executionInfoDialog.open = false; }
    },
    executionStorageScope: {
      set textContent(v) { textScope = v; },
      get textContent() { return textScope; }
    },
    btnDownloadStandalone: {
      hidden: false,
      removeAttribute: () => {}
    }
  };

  UIShell.openExecutionInfo(mockElements);
  assert.equal(shown, true);

  UIShell.closeExecutionInfo(mockElements);
  assert.equal(closed, true);
});
