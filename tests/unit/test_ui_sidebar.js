// Antes de cualquier fecha: zona con cambio de hora, donde un día natural no siempre dura 24 h.
process.env.TZ = 'Europe/Madrid';

const test = require('node:test');
const assert = require('node:assert/strict');
const ChatUISidebar = require('../../js/ui-sidebar.js');

const at = text => new Date(text).getTime();

test('ChatUISidebar - los grupos por fecha empiezan en la medianoche local de cada día natural', t => {
  // Lunes tras el cambio al horario de verano (29-03-2026): el domingo duró 23 h.
  t.mock.timers.enable({ apis: ['Date'], now: at('2026-03-30T10:00:00+02:00') });
  const cases = [
    ['2026-03-30T00:00:00+02:00', 'today'],
    ['2026-03-29T23:59:59.999+02:00', 'yesterday'],
    ['2026-03-29T00:00:00+01:00', 'yesterday'],
    // 24 h antes de la medianoche de hoy cae aún en el sábado.
    ['2026-03-28T23:30:00+01:00', 'last7days'],
    ['2026-03-23T00:00:00+01:00', 'last7days'],
    ['2026-03-22T23:59:59.999+01:00', 'last30days'],
    ['2026-02-28T00:00:00+01:00', 'last30days'],
    ['2026-02-27T23:59:59.999+01:00', 'older']
  ];
  for (const [date, expected] of cases) assert.equal(ChatUISidebar.getChronologicalCategory(date), expected, date);
});
