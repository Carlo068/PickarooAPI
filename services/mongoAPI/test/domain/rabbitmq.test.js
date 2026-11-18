// Productor de RabbitMQ (src/infrastructure/rabbitmq.js): cola por omisión, espera exponencial,
// un solo aviso por caída, reconexión y fail-safe (publicar nunca lanza). Sin broker: el
// `connect` y los temporizadores se inyectan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_QUEUE, queueName, backoffDelay, createPublisher } from '../../src/infrastructure/rabbitmq.js';

const TIMEOUT_MS = 99999; // plazo de conexión: no cuenta como espera de reintento

// Temporizadores falsos: `fire()` ejecuta el pendiente; `delays` guarda las esperas pedidas.
function fakeTimers() {
  const pending = new Map();
  const delays = [];
  let next = 1;
  return {
    delays,
    setTimer: (fn, ms) => { const id = next++; pending.set(id, fn); if (ms !== TIMEOUT_MS) delays.push(ms); return id; },
    clearTimer: id => pending.delete(id),
    get pending() { return pending.size; },
    fire: () => { const [[id, fn]] = pending; pending.delete(id); fn(); },
  };
}

// Broker falso: cada connect() consume un resultado de `plan` (Error = falla, 'ok' = conecta).
function fakeBroker(plan) {
  const state = { connects: 0, sent: [], asserted: [], conns: [], failSend: false };
  state.connect = async () => {
    state.connects += 1;
    const step = plan.length ? plan.shift() : 'ok';
    if (step instanceof Error) throw step;
    const conn = new EventEmitter();
    conn.closed = false;
    conn.close = async () => { conn.closed = true; };
    conn.createChannel = async () => {
      const ch = new EventEmitter();
      ch.assertQueue = async (q, opts) => { state.asserted.push({ q, opts }); state.onAssert?.(conn, ch); };
      ch.sendToQueue = (q, buf, opts) => {
        if (state.failSend) throw new Error('Channel closed');
        state.sent.push({ q, body: JSON.parse(buf.toString()), opts });
        return state.sendResult ?? true;
      };
      conn.channel = ch;
      return ch;
    };
    state.conns.push(conn);
    return conn;
  };
  return state;
}

function setup(plan = [], extra = {}) {
  const timers = fakeTimers();
  const broker = fakeBroker(plan);
  const warnings = [];
  const logs = [];
  const clock = { t: 0 };
  const publisher = createPublisher({
    now: () => clock.t, url: 'amqp://test', queue: 'eventos-seguridad', connect: broker.connect, connectTimeoutMs: TIMEOUT_MS,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    warn: msg => warnings.push(msg), log: msg => logs.push(msg), ...extra,
  });
  return { timers, broker, warnings, logs, publisher, clock };
}

const refused = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

describe('nombre de la cola', () => {
  test('por omisión es eventos-seguridad', () => {
    assert.equal(DEFAULT_QUEUE, 'eventos-seguridad');
    assert.equal(queueName({}), 'eventos-seguridad');
  });

  test('RABBITMQ_QUEUE la cambia; vacío vuelve al valor por omisión', () => {
    assert.equal(queueName({ RABBITMQ_QUEUE: 'mi-cola' }), 'mi-cola');
    assert.equal(queueName({ RABBITMQ_QUEUE: '' }), 'eventos-seguridad');
  });
});

describe('espera exponencial', () => {
  test('1 s, 2 s, 4 s… con tope de 30 s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10].map(n => backoffDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test('los reintentos fallidos usan esa escala y el éxito la reinicia', async () => {
    const { timers, publisher, broker } = setup([refused(), refused(), refused(), 'ok']);
    await publisher.start();
    assert.deepEqual(timers.delays, [1000]);
    timers.fire(); await settle();
    timers.fire(); await settle();
    assert.deepEqual(timers.delays, [1000, 2000, 4000]);
    timers.fire(); await settle();
    assert.equal(publisher.isConnected(), true);
    assert.equal(timers.pending, 0);

    // se cae de nuevo: la espera vuelve a empezar en 1 s
    broker.conns.at(-1).emit('close');
    assert.equal(timers.delays.at(-1), 1000);
  });
});

describe('publicación', () => {
  test('conecta, declara la cola durable y publica persistente', async () => {
    const { publisher, broker } = setup();
    await publisher.start();
    assert.deepEqual(broker.asserted, [{ q: 'eventos-seguridad', opts: { durable: true } }]);
    assert.equal(publisher.publish({ type: 'LOGIN_FAILED' }), true);
    assert.deepEqual(broker.sent[0].body, { type: 'LOGIN_FAILED' });
    assert.equal(broker.sent[0].q, 'eventos-seguridad');
    assert.equal(broker.sent[0].opts.persistent, true);
  });

  test('sin conexión no lanza ni publica; initEvents/start tampoco lanza si el broker no está', async () => {
    const { publisher, warnings } = setup([refused()]);
    await assert.doesNotReject(publisher.start());
    assert.equal(publisher.isConnected(), false);
    assert.equal(publisher.publish({ type: 'X' }), false);
    assert.equal(warnings.length, 1);
  });
});

describe('un aviso por caída', () => {
  test('mil eventos con el broker caído dejan UN aviso (y los reintentos fallidos no añaden otros)', async () => {
    const { timers, publisher, warnings } = setup([refused(), refused(), refused()]);
    await publisher.start();
    for (let i = 0; i < 1000; i++) publisher.publish({ type: 'LOGIN_FAILED' });
    timers.fire(); await settle();
    timers.fire(); await settle();
    for (let i = 0; i < 1000; i++) publisher.publish({ type: 'LOGIN_FAILED' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /RabbitMQ no disponible/);
  });

  test('tras reconectar, una caída nueva vuelve a avisar una vez', async () => {
    const { timers, publisher, broker, warnings, logs } = setup([refused()]);
    await publisher.start();
    publisher.publish({ type: 'A' });
    assert.equal(warnings.length, 1);

    timers.fire(); await settle();
    assert.equal(publisher.isConnected(), true);
    assert.match(logs.at(-1), /reconectado/);

    broker.conns.at(-1).emit('close');
    publisher.publish({ type: 'B' });
    publisher.publish({ type: 'C' });
    assert.equal(warnings.length, 2);
  });

  test('si la conexión se cierra se reintenta sola y los eventos vuelven a salir', async () => {
    const { timers, publisher, broker } = setup();
    await publisher.start();
    broker.conns[0].emit('close');
    assert.equal(publisher.isConnected(), false);
    assert.equal(publisher.publish({ type: 'PERDIDO' }), false);
    assert.equal(timers.pending, 1);
    timers.fire(); await settle();
    assert.equal(broker.connects, 2);
    assert.equal(publisher.publish({ type: 'NUEVO' }), true);
    assert.deepEqual(broker.sent.map(s => s.body.type), ['NUEVO']);
  });

  test('si el canal se cierra (la conexión sigue) también reconecta, y un solo temporizador a la vez', async () => {
    const { timers, publisher, broker } = setup();
    await publisher.start();
    broker.conns[0].channel.emit('close');
    broker.conns[0].emit('close'); // el cierre de la conexión que sigue no duplica el temporizador
    assert.equal(timers.pending, 1);
    await settle();
    assert.equal(broker.conns[0].closed, true);
  });

  test('si sendToQueue lanza, publish no lanza, se da la conexión por caída y se reintenta', async () => {
    const { timers, publisher, broker, warnings } = setup();
    await publisher.start();
    broker.failSend = true;
    assert.doesNotThrow(() => publisher.publish({ type: 'X' }));
    assert.equal(publisher.isConnected(), false);
    assert.equal(timers.pending, 1);
    assert.equal(warnings.length, 1);
  });
});

describe('arranque', () => {
  test('un connect que nunca responde vence por tiempo y no retiene el arranque', async () => {
    const timers = fakeTimers();
    const publisher = createPublisher({
      connect: () => new Promise(() => {}), connectTimeoutMs: TIMEOUT_MS, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      warn: () => {}, log: () => {},
    });
    const started = publisher.start();
    timers.fire(); // vence el plazo de conexión
    await started;
    assert.equal(publisher.isConnected(), false);
    assert.equal(timers.pending, 1); // reintento programado
  });

  test('stop cancela el reintento y no vuelve a conectar', async () => {
    const { timers, publisher, broker } = setup([refused()]);
    await publisher.start();
    await publisher.stop();
    assert.equal(timers.pending, 0);
    assert.equal(broker.connects, 1);
  });
});

describe('presión de escritura y bloqueo del broker', () => {
  test('sendToQueue devuelve false: se deja de publicar, un solo aviso, y se reanuda con drain', async () => {
    const { publisher, broker, warnings } = setup();
    await publisher.start();
    broker.sendResult = false;
    assert.equal(publisher.publish({ type: 'A' }), false); // el buffer se llenó
    broker.sendResult = true;
    for (let i = 0; i < 100; i++) assert.equal(publisher.publish({ type: 'B' }), false);
    assert.equal(broker.sent.length, 1, 'solo salió el primero');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no da abasto/);

    broker.conns[0].channel.emit('drain');
    assert.equal(publisher.publish({ type: 'C' }), true);
    assert.equal(broker.sent.at(-1).body.type, 'C');
  });

  test('un segundo episodio de presión vuelve a avisar una vez', async () => {
    const { publisher, broker, warnings } = setup();
    await publisher.start();
    broker.sendResult = false;
    publisher.publish({ type: 'A' });
    broker.conns[0].channel.emit('drain');
    publisher.publish({ type: 'B' });
    publisher.publish({ type: 'C' });
    assert.equal(warnings.length, 2);
  });

  test('connection blocked: se descarta mientras dure, un aviso; unblocked reanuda', async () => {
    const { publisher, broker, warnings } = setup();
    await publisher.start();
    broker.conns[0].emit('blocked', 'low on memory');
    broker.conns[0].emit('blocked', 'low on memory');
    for (let i = 0; i < 50; i++) assert.equal(publisher.publish({ type: 'X' }), false);
    assert.equal(broker.sent.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /low on memory/);

    broker.conns[0].emit('unblocked');
    assert.equal(publisher.publish({ type: 'Y' }), true);
    assert.equal(broker.sent.length, 1);
  });
});

describe('carreras al conectar', () => {
  test('una conexión cerrada durante assertQueue nunca se da por conectada, y se reintenta', async () => {
    const { timers, publisher, broker } = setup();
    broker.onAssert = conn => { broker.onAssert = null; conn.emit('close'); };
    await publisher.start();
    assert.equal(publisher.isConnected(), false);
    assert.equal(publisher.publish({ type: 'X' }), false);
    assert.equal(broker.sent.length, 0);
    assert.equal(timers.pending, 1);
    timers.fire(); await settle();
    assert.equal(publisher.isConnected(), true);
  });

  test('un canal cerrado durante assertQueue tampoco', async () => {
    const { timers, publisher, broker } = setup();
    broker.onAssert = (conn, ch) => { broker.onAssert = null; ch.emit('close'); };
    await publisher.start();
    assert.equal(publisher.isConnected(), false);
    assert.equal(timers.pending, 1);
  });

  test("'error' tiene oyente desde que connect resuelve, también si el intento ya venció", async () => {
    const timers = fakeTimers();
    let resolveConnect;
    const conn = new EventEmitter();
    conn.close = async () => { throw new Error('ya cerrada'); };
    const publisher = createPublisher({
      connect: () => new Promise(resolve => { resolveConnect = resolve; }), connectTimeoutMs: TIMEOUT_MS,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, warn: () => {}, log: () => {},
    });
    const started = publisher.start();
    timers.fire(); // vence el plazo
    await started;
    resolveConnect(conn); // conecta tarde
    await settle();
    assert.ok(conn.listenerCount('error') >= 1);
    assert.doesNotThrow(() => conn.emit('error', new Error('socket reset')));
    assert.equal(publisher.isConnected(), false);
  });
});

describe('registro de reintentos fallidos', () => {
  test('el motivo se repite como mucho una vez por minuto', async () => {
    const { timers, publisher, warnings, clock } = setup([refused(), refused(), refused(), refused(), refused()]);
    await publisher.start();
    assert.equal(warnings.length, 1);
    clock.t = 30_000; timers.fire(); await settle();
    assert.equal(warnings.length, 1, 'menos de un minuto: nada nuevo');
    clock.t = 61_000; timers.fire(); await settle();
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /sigue sin responder \(connect ECONNREFUSED\)/);
    clock.t = 70_000; timers.fire(); await settle();
    assert.equal(warnings.length, 2);
    clock.t = 125_000; timers.fire(); await settle();
    assert.equal(warnings.length, 3);
  });
});

// Deja correr las promesas pendientes (el connect falso resuelve en microtareas).
const settle = () => new Promise(resolve => setImmediate(resolve));
