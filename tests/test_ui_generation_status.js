const { test } = require('node:test');
const assert = require('node:assert/strict');
const Status = require('../js/ui-generation-status.js');

test('GenerationStatus - presenta progreso cuantificable y pensamiento sin contenido', () => {
  const loading = Status.getViewModel({ phase: 'loading', percent: 42 });
  assert.equal(loading.active, true);
  assert.equal(loading.percent, 42);
  assert.match(loading.text, /42/);

  const thinking = Status.getViewModel({ phase: 'thinking', startedAt: 1000 }, 19000);
  assert.equal(thinking.percent, null);
  assert.match(thinking.text, /18/);
  assert.equal(thinking.text.includes('secret reasoning'), false);
});

test('GenerationStatus - no presenta estado inactivo', () => {
  assert.equal(Status.getViewModel({ phase: 'idle' }).active, false);
});

test('GenerationStatus - infraestructura general acepta string simple de cualquier módulo', () => {
  const model = Status.getViewModel('Recuperando contexto semántico...');
  assert.equal(model.active, true);
  assert.equal(model.text, 'Recuperando contexto semántico...');
  assert.equal(model.phase, 'custom');
  assert.equal(model.percent, null);
});

test('GenerationStatus - infraestructura general acepta mensajes de herramientas y fases personalizadas', () => {
  const toolStatus = Status.getViewModel({ phase: 'tool', text: 'Ejecutando calculator...' });
  assert.equal(toolStatus.active, true);
  assert.equal(toolStatus.phase, 'tool');
  assert.equal(toolStatus.text, 'Ejecutando calculator...');

  const ragStatus = Status.getViewModel({ phase: 'rag' });
  assert.equal(ragStatus.active, true);
  assert.match(ragStatus.text, /RAG|documentos|context/i);

  const customStatus = Status.getViewModel({ message: 'Compilando código en sandbox...' });
  assert.equal(customStatus.active, true);
  assert.equal(customStatus.text, 'Compilando código en sandbox...');
});

test('GenerationStatus - oculta el elemento al finalizar el ciclo', () => {
  const text = { textContent: '' };
  const progress = { hidden: true, value: 0 };
  const element = {
    hidden: false,
    dataset: {},
    querySelector(selector) {
      return selector === '.generation-status-text' ? text : progress;
    }
  };

  Status.render(element, { phase: 'thinking', startedAt: Date.now() });
  assert.equal(element.hidden, false);
  Status.render(element, { phase: 'idle' });
  assert.equal(element.hidden, true);
});

test('GenerationStatus - renderiza texto arbitrario directamente de cualquier módulo', () => {
  const text = { textContent: '' };
  const progress = { hidden: true, value: 0 };
  const element = {
    hidden: true,
    dataset: {},
    querySelector(selector) {
      return selector === '.generation-status-text' ? text : progress;
    }
  };

  Status.render(element, 'Analizando dependencias...');
  assert.equal(element.hidden, false);
  assert.equal(text.textContent, 'Analizando dependencias...');

  Status.render(element, { text: 'Descargando paquete...', percent: 75 });
  assert.equal(element.hidden, false);
  assert.equal(text.textContent, 'Descargando paquete... · 75 %');
  assert.equal(progress.hidden, false);
  assert.equal(progress.value, 75);
});

test('GenerationStatus - integración con ChatState mutators', () => {
  const State = require('../js/state.js');
  const store = State.createStore();

  assert.equal(store.get('ui').generationStatus.phase, 'idle');

  // Actualización mediante string
  const s1 = store.setGenerationStatus('Cargando modelo local...');
  assert.equal(s1.phase, 'custom');
  assert.equal(s1.text, 'Cargando modelo local...');
  assert.equal(store.get('ui').generationStatus.text, 'Cargando modelo local...');

  // Actualización mediante objeto
  const s2 = store.setGenerationStatus({ phase: 'tool', text: 'Buscando en web...' });
  assert.equal(s2.phase, 'tool');
  assert.equal(s2.text, 'Buscando en web...');

  // Transición de herramienta a pensamiento: debe limpiar el texto de la herramienta
  const s3 = store.setGenerationStatus({ phase: 'thinking' });
  assert.equal(s3.phase, 'thinking');
  assert.equal(s3.text, '', 'El texto de la herramienta previa no debe heredarse');
  assert.equal(store.get('ui').generationStatus.text, '');
  assert.ok(s3.startedAt, 'Debe registrar la marca de tiempo de inicio de pensamiento');

  // getViewModel debe formatear 'Pensando' / 'Thinking' con el tiempo transcurrido sin residuos del tool
  const vmThinking = Status.getViewModel(s3, s3.startedAt + 5000);
  assert.equal(vmThinking.phase, 'thinking');
  assert.match(vmThinking.text, /Pensando|Thinking/i);
  assert.match(vmThinking.text, /5\s*s/);
  assert.equal(vmThinking.text.includes('Buscando'), false, 'No debe mostrar el texto del tool previo');

  // Transición de pensamiento a generación: debe mostrar generando y no conservar el estado de pensamiento
  const s4 = store.setGenerationStatus({ phase: 'generating' });
  assert.equal(s4.phase, 'generating');
  assert.equal(s4.text, '');
  const vmGenerating = Status.getViewModel(s4);
  assert.equal(vmGenerating.phase, 'generating');
  assert.match(vmGenerating.text, /Generando|Generating/i);

  // Limpieza
  const cleared = store.clearGenerationStatus();
  assert.equal(cleared.phase, 'idle');
  assert.equal(cleared.text, '');
  assert.equal(store.get('ui').generationStatus.phase, 'idle');
});
