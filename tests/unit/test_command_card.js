const test = require('node:test');
const assert = require('node:assert/strict');
const CommandCard = require('../../js/command-card.js');

const NOW = 1_800_000_000_000;
const useClock = t => t.mock.timers.enable({ apis: ['Date'], now: NOW });
const badge = state => CommandCard.getBadgeView(state).text;

test('CommandCard - parseResult solo acepta el JSON de run_command, en texto o en content', () => {
  const data = { status: 'exited', exit_code: 0 };
  assert.deepEqual(CommandCard.parseResult(JSON.stringify(data)), data);
  assert.deepEqual(CommandCard.parseResult({ content: JSON.stringify(data) }), data);
  for (const raw of ['', 'Permiso denegado', '{"exit_code":0}', 'null', { content: 3 }, null]) {
    assert.equal(CommandCard.parseResult(raw), null, JSON.stringify(raw));
  }
});

test('CommandCard - formatDuration usa décimas bajo 10 s, segundos bajo 1 min y después m:ss o h:mm:ss', () => {
  const cases = [[3.14, '3.1 s'], [-1, '0.0 s'], [42.7, '42 s'], [72, '1:12'], [3725, '1:02:05'], ['x', '0.0 s']];
  for (const [seconds, expected] of cases) assert.equal(CommandCard.formatDuration(seconds), expected, String(seconds));
});

test('CommandCard - un comando en marcha cuenta el tiempo desde que empezó y pasa a segundo plano al volver la herramienta', t => {
  useClock(t);
  const live = CommandCard.initialState();
  assert.equal(live.confirmed, false, 'La insignia no se toca hasta que el servidor conoce el comando');
  t.mock.timers.tick(5000);
  assert.equal(badge(live), 'Ejecutándose · 5.0 s');

  const background = CommandCard.withResult(live, { status: 'running', job_id: 7, elapsed_s: 2.5, output: 'linea 1\n' });
  assert.deepEqual(
    { id: background.id, startedAt: background.startedAt, output: background.output, toolReturned: background.toolReturned, confirmed: background.confirmed },
    { id: 7, startedAt: NOW + 5000 - 2500, output: 'linea 1', toolReturned: true, confirmed: true }
  );
  assert.deepEqual(CommandCard.getBadgeView(background), { className: 'status-loading', icon: 'spinner', text: 'En segundo plano · 2.5 s' });
});

test('CommandCard - el resultado final fija estado, código y duración; sin resultado legible el comando no se ejecutó', t => {
  useClock(t);
  const exited = CommandCard.withResult(CommandCard.initialState(), { status: 'exited', job_id: 8, exit_code: 2, duration_s: 3.1, output: 'error TS2304\n', error: 'Proceso terminado con código 2' });
  assert.deepEqual(CommandCard.getBadgeView(exited), { className: 'status-error', icon: 'x-circle', text: 'Código 2 · 3.1 s' });
  assert.equal(exited.output, 'error TS2304\n\nProceso terminado con código 2');

  const failed = CommandCard.withResult(CommandCard.initialState(), null, 'Permiso denegado');
  assert.deepEqual({ status: failed.status, output: failed.output, badge: badge(failed) }, { status: 'error', output: 'Permiso denegado', badge: 'No ejecutado' });
});

test('CommandCard - los detalles del servidor solo cambian los campos que traen', t => {
  useClock(t);
  const running = CommandCard.withResult(CommandCard.initialState(), { status: 'running', job_id: 11, elapsed_s: 1 });
  assert.equal(CommandCard.withDetails(running, null), running);
  assert.equal(CommandCard.withDetails(running, 'Comando no encontrado'), running);

  const finished = CommandCard.withDetails(running, { status: 'exited', exit_code: 0, elapsed_s: 42 });
  assert.deepEqual({ id: finished.id, startedAt: finished.startedAt, badge: badge(finished) }, { id: 11, startedAt: running.startedAt, badge: 'Terminado · 42 s' });

  // Confirma el comando que aún esperaba permiso, sin tocar lo que no llega.
  const confirmed = CommandCard.withDetails(CommandCard.initialState(), { id: 4, started_at: NOW - 3000 });
  assert.deepEqual({ id: confirmed.id, status: confirmed.status, exitCode: confirmed.exitCode, confirmed: confirmed.confirmed, badge: badge(confirmed) },
    { id: 4, status: 'running', exitCode: null, confirmed: true, badge: 'Ejecutándose · 3.0 s' });
});

test('CommandCard - la insignia de cada final', () => {
  const cases = [
    [{ status: 'exited', exitCode: 0, elapsed: 72 }, 'status-success', 'Terminado · 1:12'],
    [{ status: 'timeout', elapsed: 600 }, 'status-error', 'Plazo agotado · 10:00'],
    [{ status: 'stopped', elapsed: 5 }, 'status-stopped', 'Detenido · 5.0 s'],
    [{ status: 'unavailable', elapsed: 5 }, 'status-stopped', 'Estado no disponible']
  ];
  for (const [state, className, text] of cases) {
    assert.deepEqual([CommandCard.getBadgeView(state).className, badge(state)], [className, text], state.status);
  }
});

test('CommandCard - el servidor localiza el comando por la clave de la invocación hasta conocer su id', t => {
  useClock(t);
  const pending = CommandCard.initialState();
  assert.equal(CommandCard.jobRef(pending, undefined), null);
  assert.deepEqual(CommandCard.jobRef(pending, 'inv-1'), { key: 'inv-1' });
  const known = CommandCard.withDetails(pending, { id: 8 });
  assert.deepEqual(CommandCard.jobRef(known, 'inv-1'), { id: 8 });

  // Detener exige un comando en marcha que el servidor sepa localizar.
  assert.equal(CommandCard.canStop(pending, undefined), false);
  assert.equal(CommandCard.canStop(pending, 'inv-1'), true);
  assert.equal(CommandCard.canStop(CommandCard.withDetails(known, { status: 'stopped' }), 'inv-1'), false);
});

test('CommandCard - solo un comando devuelto en segundo plano que deja de figurar en marcha ha terminado', t => {
  useClock(t);
  const background = CommandCard.withResult(CommandCard.initialState(), { status: 'running', job_id: 11 });
  assert.equal(CommandCard.hasLeftRunning(background, new Set([11])), false);
  assert.equal(CommandCard.hasLeftRunning(background, new Set([12])), true);
  // Mientras la herramienta no vuelve, o sin id, el latido no basta para darlo por terminado.
  assert.equal(CommandCard.hasLeftRunning(CommandCard.withDetails(CommandCard.initialState(), { id: 11 }), new Set()), false);
  assert.equal(CommandCard.hasLeftRunning(CommandCard.withResult(CommandCard.initialState(), { status: 'running' }), new Set()), false);
});

test('CommandCard - la primera página del log empieza en sus últimos 256 KiB y avisa de lo omitido', () => {
  const PAGE = 256 * 1024;
  assert.deepEqual(CommandCard.firstLogPage(undefined), { offset: 0, text: '' });
  assert.deepEqual(CommandCard.firstLogPage(PAGE), { offset: 0, text: '' });
  assert.deepEqual(CommandCard.firstLogPage(PAGE + 1), { offset: 1, text: '[… 1 B anteriores omitidos …]\n' });
});

test('CommandCard - el log mostrado conserva sus últimos 512 Ki caracteres', () => {
  const MAX = 512 * 1024;
  const log = 'a'.repeat(MAX - 1);
  assert.equal(CommandCard.appendLog(log, 'b'), `${log}b`);
  assert.equal(CommandCard.appendLog(log, 'bc'), `${log.slice(1)}bc`);
});

test('CommandCard - sin log en el servidor queda la salida que vio el modelo, una vez devuelta la herramienta', t => {
  useClock(t);
  assert.equal(CommandCard.fallbackLog(CommandCard.initialState()), null);
  assert.equal(CommandCard.fallbackLog(CommandCard.withResult(CommandCard.initialState(), { status: 'exited', exit_code: 0, output: '5 passed\n' })), '5 passed');
  assert.equal(CommandCard.fallbackLog(CommandCard.withResult(CommandCard.initialState(), { status: 'exited', exit_code: 0, output: '' })),
    'El log ya no está disponible: ZeroChat se ha reiniciado o el comando se ha descartado.');
});
