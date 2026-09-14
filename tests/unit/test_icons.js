const test = require('node:test');
const assert = require('node:assert/strict');
const ChatIcons = require('../../js/icons.js');

test('ChatIcons - Módulo expone métodos get, has y list', () => {
  assert.equal(typeof ChatIcons.get, 'function');
  assert.equal(typeof ChatIcons.has, 'function');
  assert.equal(typeof ChatIcons.list, 'function');
  assert.ok(Array.isArray(ChatIcons.list()));
  assert.ok(ChatIcons.list().length >= 25, 'Debe contener al menos 25 glifos esenciales');
});

test('ChatIcons - has identifica correctamente iconos existentes e inexistentes', () => {
  assert.ok(ChatIcons.has('brain'));
  assert.ok(ChatIcons.has('search'));
  assert.ok(ChatIcons.has('plus'));
  assert.ok(ChatIcons.has('trash'));
  assert.ok(ChatIcons.has('zap'));
  assert.ok(ChatIcons.has('settings'));
  assert.equal(ChatIcons.has('icono_inventado_xyz'), false);
});

test('ChatIcons - get genera SVG válido con stroke="currentColor" y viewBox="0 0 24 24"', () => {
  const svg = ChatIcons.get('brain');
  assert.ok(svg.startsWith('<svg'), 'Debe abrir con <svg');
  assert.ok(svg.endsWith('</svg>'), 'Debe cerrar con </svg>');
  assert.ok(svg.includes('viewBox="0 0 24 24"'), 'Debe tener viewBox 0 0 24 24');
  assert.ok(svg.includes('stroke="currentColor"'), 'Debe heredar el color mediante stroke="currentColor"');
  assert.ok(svg.includes('fill="none"'), 'Debe tener fill="none"');
  assert.ok(svg.includes('class="ui-icon"'), 'Debe incluir la clase base .ui-icon');
  assert.ok(svg.includes('width="16"'), 'Por defecto debe tener width="16"');
  assert.ok(svg.includes('height="16"'), 'Por defecto debe tener height="16"');
});

test('ChatIcons - get respeta opciones de size, className, strokeWidth y title', () => {
  const customSvg = ChatIcons.get('search', {
    size: 24,
    className: 'custom-search-icon',
    strokeWidth: 1.5,
    title: 'Buscar contenido'
  });

  assert.ok(customSvg.includes('width="24"'));
  assert.ok(customSvg.includes('height="24"'));
  assert.ok(customSvg.includes('class="ui-icon custom-search-icon"'));
  assert.ok(customSvg.includes('stroke-width="1.5"'));
  assert.ok(customSvg.includes('<title>Buscar contenido</title>'));
});

test('ChatIcons - get maneja fallback sutil ante icono desconocido sin lanzar excepción', () => {
  let fallbackSvg = null;
  assert.doesNotThrow(() => {
    fallbackSvg = ChatIcons.get('icono_desconocido');
  });
  assert.ok(fallbackSvg.startsWith('<svg'));
  assert.ok(fallbackSvg.includes('<circle'));
});

