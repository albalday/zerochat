const test = require('node:test');
const assert = require('node:assert/strict');
const WebLLM = require('../../js/providers-webllm.js');

// Textos de progreso tal como los emite WebLLM 0.2.x en initProgressCallback.
const SHADERS = 'Loading GPU shader modules[12/80]: 15% completed, 2 secs elapsed.';
const CACHE = 'Loading model from cache[3/45]: 120MB loaded. 25% completed, 5.6 secs elapsed.';
const FETCH = 'Fetching param cache[3/45]: 120MB fetched. 25% completed, 10 secs elapsed. It can take a while when we first visit this page to populate the cache.';

test('WebLLM - normalizeProgress da la fase y el porcentaje acotado, con fracción o con el texto', () => {
  const cases = [
    [{ text: SHADERS, progress: 0.15 }, { phase: 'compiling', percent: 15 }],
    [{ text: CACHE }, { phase: 'loading', percent: 25 }],
    [{ text: FETCH, progress: 40 }, { phase: 'loading', percent: 40 }],
    [{ text: 'Finish loading on WebGPU - nvidia', progress: 1 }, { phase: 'ready', percent: 100 }],
    [{ text: 'Start to fetch params', progress: 150 }, { phase: 'loading', percent: 100 }],
    [{ text: 'Initializing', progress: -2 }, { phase: 'preparing', percent: 0 }],
    [{ text: 'Initializing', progress: null }, { phase: 'preparing', percent: null }]
  ];
  for (const [progress, expected] of cases) {
    const { phase, percent, detail } = WebLLM.normalizeProgress(progress);
    assert.deepEqual({ phase, percent }, expected, progress.text);
    assert.equal(detail, progress.text);
  }
});

test('WebLLM - parseProgressDetail extrae el paso con contador y los segundos transcurridos', () => {
  assert.deepEqual(WebLLM.parseProgressDetail(SHADERS), { step: { kind: 'shaders', current: 12, total: 80 }, elapsedSeconds: 2 });
  assert.deepEqual(WebLLM.parseProgressDetail(CACHE), { step: { kind: 'cache', current: 3, total: 45 }, elapsedSeconds: 6 });
  // La descarga de parámetros no tiene paso con contador propio: se describe por su fase.
  assert.deepEqual(WebLLM.parseProgressDetail(FETCH), { step: null, elapsedSeconds: 10 });
  assert.deepEqual(WebLLM.parseProgressDetail('Loading GPU shader modules[0/80]: 0 sec elapsed'), { step: { kind: 'shaders', current: 0, total: 80 }, elapsedSeconds: 0 });
  assert.deepEqual(WebLLM.parseProgressDetail(''), { step: null, elapsedSeconds: null });
});

test('WebLLM - errorMessage lee texto, objeto o causa y no devuelve [object Object]', () => {
  const cases = [
    ['Error: GPU allocation failed ', 'GPU allocation failed'],
    [new Error('Out of memory'), 'Out of memory'],
    [{ error: { message: 'Quota exceeded' } }, 'Quota exceeded'],
    [{ error: 'NS_ERROR_FILE_NO_DEVICE_SPACE' }, 'NS_ERROR_FILE_NO_DEVICE_SPACE'],
    [new Error('[object Object]', { cause: { error: { message: 'Device lost' } } }), 'Device lost'],
    [new Error('', { cause: new Error('', { cause: 'Error: nested' }) }), 'nested'],
    [{ error: { code: 3 } }, ''],
    [new Error('   '), ''],
    [null, '']
  ];
  for (const [error, expected] of cases) assert.equal(WebLLM.errorMessage(error), expected);
});
