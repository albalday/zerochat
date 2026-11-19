const test = require('node:test');
const assert = require('node:assert/strict');
const CommandCard = require('../../js/command-card.js');

const NOW = 1_800_000_000_000;
const useClock = t => t.mock.timers.enable({ apis: ['Date'], now: NOW });
const badge = state => CommandCard.getBadgeView(state).text;

test('CommandCard - parseResult y formatDuration normalizan resultados de run_command y duraciones', () => {
  const data = { status: 'exited', exit_code: 0 };
  assert.deepEqual(CommandCard.parseResult(JSON.stringify(data)), data);
  assert.deepEqual(CommandCard.parseResult({ content: JSON.stringify(data) }), data);
  for (const raw of ['', 'Permiso denegado', '{"exit_code":0}', 'null', { content: 3 }, null]) {
    assert.equal(CommandCard.parseResult(raw), null, JSON.stringify(raw));
  }
  for (const [seconds, expected] of [[3.14, '3.1 s'], [-1, '0.0 s'], [42.7, '42 s'], [72, '1:12'], [3725, '1:02:05'], ['x', '0.0 s']]) {
    assert.equal(CommandCard.formatDuration(seconds), expected, String(seconds));
  }
});

test('CommandCard - ciclo vivo, paso a segundo plano y mezcla selectiva con detalles del servidor', t => {
  useClock(t);
  const live = CommandCard.initialState();
  assert.equal(live.confirmed, false);
  t.mock.timers.tick(5000);
  assert.equal(badge(live), 'Ejecutándose · 5.0 s');

  const background = CommandCard.withResult(live, { status: 'running', job_id: 7, elapsed_s: 2.5, output: 'linea 1\n' });
  assert.deepEqual(
    { id: background.id, startedAt: background.startedAt, output: background.output, toolReturned: background.toolReturned, confirmed: background.confirmed },
    { id: 7, startedAt: NOW + 5000 - 2500, output: 'linea 1', toolReturned: true, confirmed: true }
  );
  assert.deepEqual(CommandCard.getBadgeView(background), { className: 'status-loading', icon: 'spinner', text: 'En segundo plano · 2.5 s' });

  const running = CommandCard.withResult(CommandCard.initialState(), { status: 'running', job_id: 11, elapsed_s: 1 });
  assert.equal(CommandCard.withDetails(running, null), running);
  assert.equal(CommandCard.withDetails(running, 'Comando no encontrado'), running);
  const finished = CommandCard.withDetails(running, { status: 'exited', exit_code: 0, elapsed_s: 42 });
  assert.deepEqual({ id: finished.id, startedAt: finished.startedAt, badge: badge(finished) }, { id: 11, startedAt: running.startedAt, badge: 'Terminado · 42 s' });

  const confirmed = CommandCard.withDetails(CommandCard.initialState(), { id: 4, started_at: NOW - 3000 });
  assert.deepEqual(
    { id: confirmed.id, status: confirmed.status, exitCode: confirmed.exitCode, confirmed: confirmed.confirmed, badge: badge(confirmed) },
    { id: 4, status: 'running', exitCode: null, confirmed: true, badge: 'Ejecutándose · 8.0 s' }
  );
});

test('CommandCard - el resultado final fija estado, código e insignia de cada final; sin resultado legible el comando no se ejecutó', t => {
  useClock(t);
  const exited = CommandCard.withResult(CommandCard.initialState(), { status: 'exited', job_id: 8, exit_code: 2, duration_s: 3.1, output: 'error TS2304\n', error: 'Proceso terminado con código 2' });
  assert.deepEqual(CommandCard.getBadgeView(exited), { className: 'status-error', icon: 'x-circle', text: 'Código 2 · 3.1 s' });
  assert.equal(exited.output, 'error TS2304\n\nProceso terminado con código 2');

  const failed = CommandCard.withResult(CommandCard.initialState(), null, 'Permiso denegado');
  assert.deepEqual({ status: failed.status, output: failed.output, badge: badge(failed) }, { status: 'error', output: 'Permiso denegado', badge: 'No ejecutado' });

  for (const [state, className, text] of [
    [{ status: 'exited', exitCode: 0, elapsed: 72 }, 'status-success', 'Terminado · 1:12'],
    [{ status: 'stopped', elapsed: 5 }, 'status-stopped', 'Detenido · 5.0 s'],
    [{ status: 'unavailable', elapsed: 5 }, 'status-stopped', 'Estado no disponible']
  ]) {
    assert.deepEqual([CommandCard.getBadgeView(state).className, badge(state)], [className, text], state.status);
  }
});

test('CommandCard - localiza el comando por clave/id para parar y detecta fin en segundo plano', t => {
  useClock(t);
  const pending = CommandCard.initialState();
  assert.equal(CommandCard.jobRef(pending, undefined), null);
  assert.deepEqual(CommandCard.jobRef(pending, 'inv-1'), { key: 'inv-1' });
  const known = CommandCard.withDetails(pending, { id: 8 });
  assert.deepEqual(CommandCard.jobRef(known, 'inv-1'), { id: 8 });
  assert.equal(CommandCard.canStop(pending, undefined), false);
  assert.equal(CommandCard.canStop(pending, 'inv-1'), true);
  assert.equal(CommandCard.canStop(CommandCard.withDetails(known, { status: 'stopped' }), 'inv-1'), false);

  const background = CommandCard.withResult(CommandCard.initialState(), { status: 'running', job_id: 11 });
  assert.equal(CommandCard.hasLeftRunning(background, new Set([11])), false);
  assert.equal(CommandCard.hasLeftRunning(background, new Set([12])), true);
  assert.equal(CommandCard.hasLeftRunning(CommandCard.withDetails(CommandCard.initialState(), { id: 11 }), new Set()), false);
  assert.equal(CommandCard.hasLeftRunning(CommandCard.withResult(CommandCard.initialState(), { status: 'running' }), new Set()), false);
});

test('CommandCard - retiene 64 Ki caracteres, muestra últimas 40 líneas de terminal y recurre al fallback', t => {
  useClock(t);
  const MAX = 64 * 1024;
  const log = 'a'.repeat(MAX - 1);
  assert.deepEqual(CommandCard.appendLog(log, 'b'), { text: `${log}b`, trimmed: false });
  assert.deepEqual(CommandCard.appendLog(log, 'bc'), { text: `${log.slice(1)}bc`, trimmed: true });

  const lines = n => Array.from({ length: n }, (_, i) => `linea ${i + 1}`).join('\n') + '\n';
  assert.equal(CommandCard.terminalTail(lines(40)), lines(40).trimEnd());
  assert.equal(CommandCard.terminalTail(lines(41)), `[… salida anterior omitida …]\n${lines(41).trimEnd().split('\n').slice(1).join('\n')}`);
  assert.equal(CommandCard.terminalTail('fin\n', true), '[… salida anterior omitida …]\nfin');
  assert.equal(CommandCard.terminalTail(' 10%|█ | 2/20\r 15%|█▌ | 3/20\r\nhecho\n'), ' 15%|█▌ | 3/20\nhecho');
  assert.equal(CommandCard.terminalTail('linea\r\n'), 'linea');

  assert.equal(CommandCard.fallbackLog(CommandCard.initialState()), null);
  assert.equal(CommandCard.fallbackLog(CommandCard.withResult(CommandCard.initialState(), { status: 'exited', exit_code: 0, output: '5 passed\n' })), '5 passed');
  assert.equal(CommandCard.fallbackLog(CommandCard.withResult(CommandCard.initialState(), { status: 'exited', exit_code: 0, output: '' })),
    'El log ya no está disponible: ZeroChat se ha reiniciado o el comando se ha descartado.');
});

test('CommandCard - check_command: solicitud de espera, insignia y motivo de retorno', t => {
  useClock(t);
  for (const [args, expected] of [
    [{ wait_seconds: 120 }, { jobId: null, seconds: 120, pattern: '', stop: false, waits: true }],
    [{ job_id: 7, wait_seconds: 30, pattern: 'error' }, { jobId: 7, seconds: 30, pattern: 'error', stop: false, waits: true }],
    [{ job_id: 7, pattern: 'error' }, { jobId: 7, seconds: 0, pattern: 'error', stop: false, waits: true }],
    [{ job_id: 7 }, { jobId: 7, seconds: 0, pattern: '', stop: false, waits: false }],
    [{ job_id: 7, wait_seconds: 30, stop: true }, { jobId: 7, seconds: 30, pattern: '', stop: true, waits: false }]
  ]) {
    assert.deepEqual(CommandCard.waitRequest(args), expected, JSON.stringify(args));
  }

  const request = CommandCard.waitRequest({ job_id: 7, wait_seconds: 300, pattern: 'listening' });
  const view = state => {
    const result = CommandCard.getWaitBadgeView({ request, startedAt: NOW - 45_000, elapsed: 45, returned: true, ...state });
    return [result.className, result.text];
  };
  assert.deepEqual(view({ returned: false }), ['status-loading', 'Esperando · 45 s de 5:00']);
  for (const [reason, className, text] of [
    ['pattern_matched', 'status-success', 'Encontrado · 12 s'],
    ['command_finished', 'status-success', 'El comando terminó · 12 s'],
    ['wait_elapsed', 'status-stopped', 'Espera completa · 12 s'],
    ['wait_ended_by_user', 'status-stopped', 'Espera cortada · 12 s']
  ]) {
    assert.deepEqual(view({ result: { success: true, returned_because: reason, waited_s: 12 } }), [className, text], reason);
  }
  assert.deepEqual(view({ result: { success: false, error: 'Unknown job_id 7.' } }), ['status-error', 'Error']);
  assert.deepEqual(view({ result: null }), ['status-error', 'Error']);
  assert.equal(CommandCard.parseWaitResult('{"success":true,"returned_because":"wait_elapsed"}').returned_because, 'wait_elapsed');
  assert.equal(CommandCard.parseWaitResult('no es json'), null);
});
