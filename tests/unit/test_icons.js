const test = require('node:test');
const assert = require('node:assert/strict');
const ChatIcons = require('../../js/icons.js');

test('ChatIcons - el catálogo identifica iconos existentes e inexistentes', () => {
  assert.ok(ChatIcons.list().length >= 25, 'Debe contener al menos 25 glifos esenciales');
  for (const name of ['brain', 'search', 'plus', 'trash', 'zap', 'settings']) {
    assert.ok(ChatIcons.has(name), name);
  }
  assert.equal(ChatIcons.has('icono_inventado_xyz'), false);
});

test('ChatIcons - get genera SVG heredando el color, respeta opciones y usa un fallback ante iconos desconocidos', () => {
  const svg = ChatIcons.get('brain');
  for (const fragment of ['viewBox="0 0 24 24"', 'stroke="currentColor"', 'fill="none"', 'class="ui-icon"', 'width="16"', 'height="16"']) {
    assert.ok(svg.includes(fragment), fragment);
  }
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));

  const customSvg = ChatIcons.get('search', { size: 24, className: 'custom-search-icon', strokeWidth: 1.5, title: 'Buscar contenido' });
  for (const fragment of ['width="24"', 'height="24"', 'class="ui-icon custom-search-icon"', 'stroke-width="1.5"', '<title>Buscar contenido</title>']) {
    assert.ok(customSvg.includes(fragment), fragment);
  }

  const fallbackSvg = ChatIcons.get('icono_desconocido');
  assert.ok(fallbackSvg.startsWith('<svg') && fallbackSvg.includes('<circle'));
});
