const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIReasoning = require('../../js/ui-reasoning.js');
const I18n = require('../../js/i18n.js');
const { installDom, getAppElements } = require('../helpers/dom-env.js');

/** Menú de razonamiento real montado con manejadores que registran sus llamadas. */
function setup(t) {
  const dom = installDom({ app: true });
  const elements = getAppElements(document);
  const calls = [];
  const handlers = Object.fromEntries(['toggle', 'initialize', 'decline', 'reactivate', 'reload', 'changeDirectory']
    .map(name => [name, value => calls.push(value === undefined ? [name] : [name, value])]));
  UIReasoning.mount(elements, { onSelectLevel: level => calls.push(['level', level]), handlers });
  t.after(() => dom.restore());
  return { elements, calls };
}

const render = (elements, project, options = {}) => UIReasoning.renderProjectPanel(elements, {
  config: { projectMode: options.projectMode ?? true },
  project,
  canInitialize: options.canInitialize ?? true,
  canChangeDirectory: options.canChangeDirectory ?? false,
  busy: false
});
const actions = elements => [...elements.projectModePanel.querySelectorAll('.project-mode-actions [data-project-action]')].map(button => button.dataset.projectAction);

test('UIReasoning - el control deslizante elige el nivel y actualiza botón, etiqueta y aguja', t => {
  const { elements, calls } = setup(t);
  UIReasoning.toggleReasoningMenu(elements, { reasoningEffort: 'medium' });
  assert.equal(elements.reasoningMenu.hidden, false);
  assert.equal(elements.reasoningIntensity.value, '2');

  elements.reasoningIntensity.value = '3';
  elements.reasoningIntensity.dispatchEvent(new Event('input'));
  assert.deepEqual(calls, [['level', 'high']]);
  assert.equal(elements.reasoningLabel.textContent, I18n.t('reasoning_level_high'));
  assert.ok(elements.btnReasoning.classList.contains('active-high'));
  assert.equal(elements.reasoningIntensity.style.getPropertyValue('--reasoning-intensity'), '75%');
  assert.equal(elements.btnReasoning.querySelector('#reasoning-gauge-needle').getAttribute('transform'), 'rotate(30 12 15)');

  UIReasoning.updateReasoningUI(elements, 'unknown');
  assert.equal(elements.btnReasoning.classList.contains('active'), false, 'Un nivel desconocido cuenta como ninguno');

  elements.reasoningMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(elements.reasoningMenu.hidden, true);
  assert.equal(elements.btnReasoning.getAttribute('aria-expanded'), 'false');
});

test('UIReasoning - el panel del proyecto ofrece las acciones de cada estado y las delega', t => {
  const { elements, calls } = setup(t);
  render(elements, { status: 'missing', cwd: '/home/u/app' });
  assert.deepEqual(actions(elements), ['initialize', 'decline']);
  render(elements, { status: 'missing', cwd: '/home/u/app' }, { canInitialize: false });
  assert.deepEqual(actions(elements), ['decline']);
  render(elements, { status: 'declined', cwd: '/r' });
  assert.deepEqual(actions(elements), ['reactivate']);
  for (const status of ['ready', 'error', 'no_access']) {
    render(elements, { status, cwd: '/r' });
    assert.deepEqual(actions(elements), ['reload'], status);
  }
  render(elements, { status: 'unavailable', cwd: '/r' });
  assert.deepEqual(actions(elements), []);
  render(elements, { status: 'ready', cwd: '/r' }, { projectMode: false });
  assert.deepEqual(actions(elements), [], 'Con el modo apagado no hay acciones');
  assert.equal(elements.projectModePanel.querySelector('.project-mode-status').textContent, I18n.t('project_status_disabled'));

  render(elements, { status: 'ready', cwd: '/home/u/my-repo/' }, { canChangeDirectory: true });
  assert.match(elements.projectModePanel.querySelector('.project-mode-status').textContent, /my-repo/);
  elements.projectModePanel.querySelector('[data-project-action="reload"]').click();
  elements.projectModePanel.querySelector('[data-project-action="changeDirectory"]').click();
  const toggle = elements.projectModePanel.querySelector('#chk-project-mode');
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(calls, [['reload'], ['changeDirectory'], ['toggle', false]]);
});

test('UIReasoning - el directorio abrevia la carpeta personal con ~ sin tocar otras rutas', t => {
  const { elements } = setup(t);
  const cases = {
    '/home/u/vs/zerochat': '~/vs/zerochat',
    '/home/u': '~',
    '/Users/ana/app': '~/app',
    '/data/data/com.termux/files/home/app': '~/app',
    'C:\\Users\\ana\\app': '~\\app',
    '/home/user2x/app': '~/app',
    '/homes/u/app': '/homes/u/app',
    '/srv/app': '/srv/app'
  };
  for (const [cwd, shown] of Object.entries(cases)) {
    render(elements, { status: 'ready', cwd });
    const path = elements.projectModePanel.querySelector('.project-mode-path');
    assert.equal(path.textContent, shown, cwd);
    assert.equal(path.title, cwd);
  }
  render(elements, { status: 'ready', cwd: '' });
  assert.equal(elements.projectModePanel.querySelector('.project-mode-path'), null);
});

test('UIReasoning - el botón solo marca proyectos activos o con fallo', t => {
  const { elements } = setup(t);
  const sync = (projectMode, status) => {
    UIReasoning.syncProjectIndicator(elements, { projectMode }, { status, cwd: '/home/u/zerochat' });
    return elements.btnReasoning.getAttribute('data-project-indicator');
  };
  assert.equal(sync(true, 'ready'), 'ready');
  assert.match(elements.reasoningProjectLabel.textContent, /zerochat/);
  assert.match(elements.btnReasoning.title, / · .*zerochat/);
  assert.equal(sync(true, 'error'), 'warning');
  assert.equal(sync(true, 'no_access'), 'warning');
  for (const status of ['missing', 'declined', 'unavailable']) assert.equal(sync(true, status), null, status);
  assert.equal(sync(false, 'ready'), null);
  assert.equal(elements.reasoningProjectLabel.textContent, '');
  assert.doesNotMatch(elements.btnReasoning.title, / · /);
});
