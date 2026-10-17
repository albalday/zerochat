const { test } = require('node:test');
const assert = require('node:assert/strict');
const UIInspector = require('../../js/ui-inspector.js');

test('UIInspector - getModelContextLimit reconoce los formatos de contexto sin recortar por max_tokens', () => {
  const catalog = [
    { id: 'model-openrouter', details: { context_length: 128000 } },
    { id: 'model-vllm', details: { max_model_len: 65536 } },
    { id: 'model-window', details: { context_window: 16384 } },
    { id: 'gemma', details: { meta: { n_ctx: 128000, n_ctx_train: 262144 } } },
    { id: 'solo-train', details: { meta: { n_ctx_train: 262144 } } },
    { id: 'ambos', details: { context_length: 200000, meta: { n_ctx: 128000 } } },
    { id: 'con-max-tokens', details: { max_context_length: 131072, max_tokens: 4096 } },
    { id: 'solo-max-tokens', details: { max_tokens: 8192 } },
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', details: { webllmCache: 'cached' } }
  ];
  const expected = {
    'model-openrouter': 128000, 'model-vllm': 65536, 'model-window': 16384, gemma: 128000, 'solo-train': 262144,
    ambos: 128000, 'con-max-tokens': 131072, 'solo-max-tokens': 8192, 'Llama-3.2-1B-Instruct-q4f16_1-MLC': 4096, 'Other-Model-MLC': 4096, unknown: null
  };
  for (const [model, limit] of Object.entries(expected)) {
    assert.equal(UIInspector.getModelContextLimit(model, catalog), limit, model);
  }
});
