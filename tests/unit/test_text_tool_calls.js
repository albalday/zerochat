const { test } = require('node:test');
const assert = require('node:assert/strict');
const TextToolCalls = require('../../js/text-tool-calls.js');

const searchTool = {
  type: 'function',
  function: { name: 'search_web', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
};

test('TextToolCalls.extractToolCalls - extrae llamadas válidas y deja el texto restante', () => {
  const result = TextToolCalls.extractToolCalls('Busco.\n<tool_call>\n{"name": "search_web", "arguments": {"query": "webgpu"}}\n</tool_call>');
  assert.equal(result.text, 'Busco.');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].type, 'function');
  assert.match(result.toolCalls[0].id, /^call_text_/);
  assert.deepEqual(result.toolCalls[0].function, { name: 'search_web', arguments: '{"query":"webgpu"}' });
});

test('TextToolCalls.extractToolCalls - admite varias llamadas, bloque sin cerrar, vallas json y forma OpenAI', () => {
  const text = [
    '<tool_call>```json\n{"name": "search_web", "arguments": {"query": "a"}}\n```</tool_call>',
    '<tool_call>[{"function": {"name": "fetch_web_page", "arguments": "{\\"url\\":\\"https://x\\"}"}}]</tool_call>',
    '<tool_call>{"name": "render_chart", "parameters": {"title": "ok"}}'
  ].join('\n');
  const { text: rest, toolCalls } = TextToolCalls.extractToolCalls(text);
  assert.equal(rest, '');
  assert.deepEqual(toolCalls.map(call => call.function), [
    { name: 'search_web', arguments: '{"query":"a"}' },
    { name: 'fetch_web_page', arguments: '{"url":"https://x"}' },
    { name: 'render_chart', arguments: '{"title":"ok"}' }
  ]);
});

test('TextToolCalls.extractToolCalls - sin llamadas válidas conserva el texto intacto', () => {
  assert.deepEqual(TextToolCalls.extractToolCalls('Hola'), { text: 'Hola', toolCalls: null });
  const malformed = 'Texto <tool_call>{name: search_web}</tool_call>';
  assert.deepEqual(TextToolCalls.extractToolCalls(malformed), { text: malformed, toolCalls: null });
});

test('TextToolCalls.visibleText - oculta bloques completos, abiertos y prefijos parciales', () => {
  assert.equal(TextToolCalls.visibleText('Hola <tool_call>{"name":"a"}</tool_call> fin'), 'Hola  fin');
  assert.equal(TextToolCalls.visibleText('Hola <tool_call>{"name":'), 'Hola ');
  assert.equal(TextToolCalls.visibleText('Hola <tool_c'), 'Hola ');
  assert.equal(TextToolCalls.visibleText('a < b'), 'a < b');
});

test('TextToolCalls.toTextMessages - convierte tool_calls y agrupa resultados sin mutar la entrada', () => {
  const history = [
    { role: 'user', content: 'Busca' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_web', arguments: '{"query":"a"}' } },
      { id: 'c2', type: 'function', function: { name: 'search_web', arguments: '{"query":"b"}' } }
    ] },
    { role: 'tool', tool_call_id: 'c1', name: 'search_web', content: 'R1' },
    { role: 'tool', tool_call_id: 'c2', name: 'search_web', content: [{ type: 'text', text: 'R2' }] },
    { role: 'assistant', content: 'Listo' }
  ];
  const snapshot = JSON.parse(JSON.stringify(history));
  const converted = TextToolCalls.toTextMessages(history);
  assert.deepEqual(history, snapshot);
  assert.deepEqual(converted, [
    { role: 'user', content: 'Busca' },
    { role: 'assistant', content: '<tool_call>\n{"name":"search_web","arguments":{"query":"a"}}\n</tool_call>\n<tool_call>\n{"name":"search_web","arguments":{"query":"b"}}\n</tool_call>' },
    { role: 'user', content: '<tool_response>\nR1\n</tool_response>\n<tool_response>\nR2\n</tool_response>' },
    { role: 'assistant', content: 'Listo' }
  ]);
});

test('TextToolCalls.prepareMessages - añade las firmas al prompt de sistema inicial o lo crea', () => {
  const withSystem = TextToolCalls.prepareMessages([{ role: 'system', content: 'Base' }, { role: 'user', content: 'Hola' }], [searchTool]);
  assert.equal(withSystem.length, 2);
  assert.match(withSystem[0].content, /^Base\n\n# Tools/);
  assert.ok(withSystem[0].content.includes(JSON.stringify(searchTool)));
  assert.ok(withSystem[0].content.includes('<tool_call>'));

  const withoutSystem = TextToolCalls.prepareMessages([{ role: 'user', content: 'Hola' }], [searchTool]);
  assert.equal(withoutSystem[0].role, 'system');
  assert.match(withoutSystem[0].content, /^# Tools/);

  const withoutTools = TextToolCalls.prepareMessages([{ role: 'system', content: 'Base' }], []);
  assert.deepEqual(withoutTools, [{ role: 'system', content: 'Base' }]);
});
