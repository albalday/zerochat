const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTestApp, closeGlobalBrowser } = require('../helpers/browser-env.js');

// Consulta de modelos e inspector de conexión sobre el editor de perfiles real. La red se sustituye
// en ChatAPI (fetchServerModels, inspectProvider y las operaciones de WebLLM).

/**
 * Página con el editor de perfiles preparado. `window.appElements()` devuelve los elementos con id
 * en camelCase, como el mapa de elementos de app.js.
 */
async function withEditor({ apiType = 'openai', apiUrl = 'http://localhost:1234/v1', model = '' } = {}, fn) {
  await withTestApp(async page => {
    page.setDefaultTimeout(5000);
    await page.evaluate(({ apiType, apiUrl, model }) => {
      window.appElements = () => Object.fromEntries([...document.querySelectorAll('[id]')]
        .map(element => [element.id.replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase()), element]));
      const elements = window.appElements();
      elements.profilesDialog.showModal();
      elements.settingApiType.value = apiType;
      elements.settingApiUrl.value = apiUrl;
      elements.settingModel.value = model;
      window.stubModels = (models, extra = {}) => {
        window.queriedUrls = [];
        window.ChatAPI.fetchServerModels = async url => {
          window.queriedUrls.push(url);
          return { success: true, count: models.length, endpoint: `${url}/models`, models, ...extra };
        };
      };
      window.optionValues = select => [...select.querySelectorAll('option')].map(option => option.value);
    }, { apiType, apiUrl, model });
    await fn(page);
  });
}

describe('Browser UI - consulta de modelos e inspector', { concurrency: 2 }, () => {
  after(async () => {
    await closeGlobalBrowser();
  });

  test('Browser UI - consultar el servidor rellena la lista, elige el primero y usa el endpoint por defecto', async () => {
    await withEditor({ apiUrl: '' }, async page => {
      const result = await page.evaluate(async () => {
        window.stubModels([{ id: 'gpt-4o' }, { id: 'claude-3-7-sonnet' }]);
        const elements = window.appElements();
        const ok = await window.ChatUIInspector.handleQueryServer(elements, {});
        return {
          ok,
          urls: window.queriedUrls,
          apiUrl: elements.settingApiUrl.value,
          datalist: window.optionValues(elements.modelDatalist),
          helper: window.optionValues(elements.modelSelectHelper),
          model: elements.settingModel.value,
          status: elements.serverQueryStatus.className,
          buttonDisabled: elements.btnQueryServer.disabled
        };
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.urls, ['http://localhost:1234/v1']);
      assert.equal(result.apiUrl, 'http://localhost:1234/v1');
      assert.deepEqual(result.datalist, ['gpt-4o', 'claude-3-7-sonnet']);
      assert.deepEqual(result.helper, ['', 'gpt-4o', 'claude-3-7-sonnet']);
      assert.equal(result.model, 'gpt-4o');
      assert.match(result.status, /status-success/);
      assert.equal(result.buttonDisabled, false);
    });
  });

  test('Browser UI - un bloqueo CORS de Ollama muestra cómo permitir el origen', async () => {
    await withEditor({ apiType: 'ollama', apiUrl: 'http://localhost:11434' }, async page => {
      const result = await page.evaluate(async () => {
        window.ChatAPI.fetchServerModels = async () => ({ success: false, error: 'NetworkError when attempting to fetch resource.' });
        const elements = window.appElements();
        const ollama = [await window.ChatUIInspector.handleQueryServer(elements, {}), elements.serverQueryStatus.textContent];
        elements.settingApiType.value = 'openai';
        const openai = [await window.ChatUIInspector.handleQueryServer(elements, {}), elements.serverQueryStatus.textContent];
        return { ollama, openai };
      });
      assert.equal(result.ollama[0], false);
      assert.match(result.ollama[1], /OLLAMA_ORIGINS=\*/);
      assert.equal(result.openai[0], false);
      assert.doesNotMatch(result.openai[1], /OLLAMA_ORIGINS/);
    });
  });

  test('Browser UI - la caché de modelos es propia de cada conexión y conserva el contexto cargado', async () => {
    await withEditor({}, async page => {
      const limits = await page.evaluate(async () => {
        window.stubModels([{ id: 'same-model', details: { max_context_length: 262144, loaded_context_length: 90112 } }]);
        const elements = window.appElements();
        await window.ChatUIInspector.handleQueryServer(elements, {});
        window.ChatUIInspector.loadCachedModels(elements, { apiType: 'openai', apiUrl: 'https://api.example.test/v1' });
        const remote = window.ChatUIInspector.getModelContextLimit('same-model');
        window.ChatUIInspector.loadCachedModels(elements, { apiType: 'openai', apiUrl: 'http://localhost:1234/v1' });
        return { remote, local: window.ChatUIInspector.getModelContextLimit('same-model') };
      });
      assert.deepEqual(limits, { remote: null, local: 90112 }, 'El contexto cargado manda sobre el nominal');
    });
  });

  test('Browser UI - el inspector localiza el modelo por id, sin prefijo models/ ni :latest y por ruta', async () => {
    await withEditor({}, async page => {
      const result = await page.evaluate(async () => {
        window.stubModels([{ id: 'google/gemma-4-26b-a4b-qat' }, { id: 'llama3.2:latest' }, { id: 'models/gemini-2.5-flash' }, { id: 'Qwen/Qwen2.5-Coder-7B' }]);
        window.ChatAPI.inspectProvider = async () => ({ success: true, capabilities: {} });
        const elements = window.appElements();
        const run = model => window.ChatUIInspector.handleRunInspector(elements, {}, { settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', model } });
        const found = {};
        for (const requested of ['llama3.2', 'gemini-2.5-flash', 'qwen/qwen2.5-coder-7b', 'gemma-4-26b-a4b-qat']) {
          found[requested] = [await run(requested), elements.inspectorResults.querySelector('.inspector-model-title strong').textContent];
        }
        const missing = [await run('inexistente'), elements.inspectorResults.querySelector('.status-error').textContent];
        return { found, missing };
      });
      assert.deepEqual(result.found, {
        'llama3.2': [true, 'llama3.2:latest'],
        'gemini-2.5-flash': [true, 'models/gemini-2.5-flash'],
        'qwen/qwen2.5-coder-7b': [true, 'Qwen/Qwen2.5-Coder-7B'],
        'gemma-4-26b-a4b-qat': [true, 'google/gemma-4-26b-a4b-qat']
      });
      assert.equal(result.missing[0], false);
      assert.match(result.missing[1], /inexistente/);
    });
  });

  test('Browser UI - el inspector usa la conexión indicada y muestra contexto, razonamiento y capacidades como texto', async () => {
    await withEditor({ apiUrl: 'http://editor.invalid/v1' }, async page => {
      const result = await page.evaluate(async () => {
        window.stubModels([{ id: 'qwen2.5-coder-32b', details: { context_length: 32768 } }]);
        let received = null;
        window.ChatAPI.inspectProvider = async config => {
          received = config;
          return {
            success: true,
            provider: { id: 'openai', label: 'Custom & Provider' },
            endpoint: { normalized: config.apiUrl },
            model: { selected: 'Model & <Name>', totalDiscovered: 0 },
            capabilities: { streaming: { status: 'confirmed', detail: 'SSE verified' }, tools: { status: 'odd' } },
            inspectionTimeMs: 42
          };
        };
        const elements = window.appElements();
        const ok = await window.ChatUIInspector.handleRunInspector(elements, {}, {
          settings: { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', apiKey: 'profile-key', model: 'qwen2.5-coder-32b', reasoningEffort: 'high' }
        });
        const results = elements.inspectorResults;
        return {
          ok,
          received,
          values: [...results.querySelectorAll('.inspector-model-section .meta-value')].map(value => value.textContent),
          provider: results.querySelector('.inspector-header-meta .meta-value').textContent,
          text: results.textContent,
          confirmed: Boolean(results.querySelector('.cap-badge-confirmed')),
          unknown: results.querySelectorAll('.inspector-cap-card .cap-badge-unknown').length,
          context: (32768).toLocaleString()
        };
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.received, { apiUrl: 'http://localhost:1234/v1', apiType: 'openai', apiKey: 'profile-key', model: 'qwen2.5-coder-32b' });
      assert.ok(result.values[0].includes(`${result.context} tokens`));
      assert.match(result.values[1], /Alto/);
      assert.equal(result.provider, 'Custom & Provider');
      assert.ok(result.text.includes('Model & <Name>'), 'Los datos del informe se muestran como texto');
      assert.ok(result.text.includes('42 ms'));
      assert.equal(result.confirmed, true);
      assert.equal(result.unknown, 7, 'Un estado desconocido o ausente cuenta como desconocido');
    });
  });

  test('Browser UI - el inspector informa de un modelo ausente, una consulta fallida o un endpoint que no responde', async () => {
    await withEditor({}, async page => {
      const result = await page.evaluate(async () => {
        const elements = window.appElements();
        const run = model => window.ChatUIInspector.handleRunInspector(elements, {}, { settings: { apiUrl: 'http://localhost:9999/v1', apiType: 'openai', model } });
        const error = () => elements.inspectorResults.querySelector('.status-error')?.textContent || null;
        const empty = [await run(''), error()];
        window.ChatAPI.fetchServerModels = async () => ({ success: false, error: 'ECONNREFUSED: Server is offline' });
        const offline = [await run('llama3'), error()];
        window.stubModels([{ id: 'llama3' }]);
        window.ChatAPI.inspectProvider = async () => ({ success: false, connected: false, error: 'Endpoint unreachable' });
        const unreachable = [await run('llama3'), error(), Boolean(elements.inspectorResults.querySelector('.inspector-model-section')), Boolean(elements.inspectorResults.querySelector('.inspector-cap-grid'))];
        return { empty, offline, unreachable };
      });
      assert.equal(result.empty[0], false);
      assert.ok(result.empty[1] !== null);
      assert.equal(result.offline[0], false);
      assert.match(result.offline[1], /ECONNREFUSED/);
      assert.deepEqual([result.unreachable[0], result.unreachable[2], result.unreachable[3]], [true, true, false]);
      assert.match(result.unreachable[1], /Endpoint unreachable/);
    });
  });
});
