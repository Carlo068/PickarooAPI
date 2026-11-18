// Comportamiento de parada y código de salida del supervisor, con procesos simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { supervise } from './supervisor.js';

// Proceso simulado: kill() lo termina (salvo `stubborn`, que ignora SIGTERM).
function stubSpawn({ stubborn = [] } = {}) {
  const made = [];
  const spawn = (_exe, args) => {
    const child = Object.assign(new EventEmitter(), { args, exitCode: null, signalCode: null, kills: [] });
    child.kill = signal => {
      child.kills.push(signal);
      if (child.stubborn && signal === 'SIGTERM') return;
      child.signalCode = signal;
      setImmediate(() => child.emit('exit', null, signal));
    };
    child.stubborn = stubborn.includes(made.length);
    made.push(child);
    return child;
  };
  return { spawn, made };
}

const plan = [{ name: 'api', args: ['a'] }, { name: 'audit', args: ['b'] }, { name: 'gateway', args: ['c'] }];
const setup = (opts = {}) => {
  const { spawn, made } = stubSpawn(opts);
  const exits = [];
  const done = new Promise(resolve => {
    supervise(plan, { spawn, exit: code => { exits.push(code); resolve(); }, log: () => {}, forceMs: 30 });
  });
  return { made, exits, done };
};

test('si un proceso muere con código, detiene a los demás y sale con 1', async () => {
  const { made, exits, done } = setup();
  made[1].exitCode = 3;
  made[1].emit('exit', 3, null);
  await done;
  assert.deepEqual(made[0].kills, ['SIGTERM']);
  assert.deepEqual(made[2].kills, ['SIGTERM']);
  assert.deepEqual(made[1].kills, []);
  assert.deepEqual(exits, [1]);
});

test('un proceso muerto por señal (exitCode null, signalCode puesto) cuenta como muerto', async () => {
  const { made, exits, done } = setup();
  made[0].signalCode = 'SIGKILL';
  made[0].emit('exit', null, 'SIGKILL');
  await done;
  assert.deepEqual(made[0].kills, []);
  assert.deepEqual(exits, [1]);
});

test('un error al arrancar detiene a los demás y sale con 1 sin esperar al proceso fallido', async () => {
  const { made, exits, done } = setup();
  made[2].emit('error', new Error('spawn ENOENT'));
  await done;
  assert.deepEqual(made[0].kills, ['SIGTERM']);
  assert.deepEqual(made[1].kills, ['SIGTERM']);
  assert.deepEqual(made[2].kills, []);
  assert.deepEqual(exits, [1]);
});

test('una parada pedida (SIGTERM de Render) sale con 0 y solo una vez', async () => {
  const { spawn, made } = stubSpawn();
  const exits = [];
  const done = new Promise(resolve => {
    const { stop } = supervise(plan, { spawn, exit: code => { exits.push(code); resolve(); }, log: () => {}, forceMs: 30 });
    stop(0);
    stop(0);
  });
  await done;
  assert.deepEqual(made.map(c => c.kills), [['SIGTERM'], ['SIGTERM'], ['SIGTERM']]);
  assert.deepEqual(exits, [0]);
});

test('un proceso que ignora SIGTERM se mata con SIGKILL pasado el plazo y se sale igual', async () => {
  const { made, exits, done } = setup({ stubborn: [0] });
  made[2].exitCode = 1;
  made[2].emit('exit', 1, null);
  await done;
  assert.deepEqual(made[0].kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(exits, [1]);
});
