const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIShell = require('../js/ui-shell.js');

test('UIShell - isHttpExecution detects http/https protocols correctly', () => {
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'http:' } }), true);
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'https:' } }), true);
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'file:' } }), false);
  assert.equal(UIShell.isHttpExecution({ location: { protocol: 'blob:' } }), false);
  assert.equal(UIShell.isHttpExecution(null), false);
});

test('UIShell - getStandaloneDownloadUrl returns null for file protocol and resolves bundle path for http', () => {
  assert.equal(UIShell.getStandaloneDownloadUrl({ location: { protocol: 'file:', href: 'file:///path/index.html' } }), null);

  const mockHttp = {
    location: {
      protocol: 'http:',
      href: 'http://localhost:8080/index.html',
      pathname: '/index.html'
    }
  };
  assert.equal(UIShell.getStandaloneDownloadUrl(mockHttp), 'http://localhost:8080/zerochat.html');

  const mockHttpSlash = {
    location: {
      protocol: 'http:',
      href: 'http://localhost:8080/subpath/',
      pathname: '/subpath/'
    }
  };
  assert.equal(UIShell.getStandaloneDownloadUrl(mockHttpSlash), 'http://localhost:8080/subpath/zerochat.html');
});

test('UIShell - updateViewportHeight sets CSS custom property --app-height', () => {
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
});

test('UIShell - openExecutionInfo and closeExecutionInfo handle dialog methods safely', () => {
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
