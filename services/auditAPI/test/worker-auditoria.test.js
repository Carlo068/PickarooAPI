// Worker de la cola (src/worker-auditoria.js y src/queue.js): línea de log sin inyección, prefetch por
// entorno y ack/nack manual. Sin RabbitMQ ni ScyllaDB: el canal y el guardado se simulan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  logSafe, eventLogLine, handleMessage, normalize, safeAck, safeNack, createConsumer, MAX_SAVE_ATTEMPTS,
} from '../src/worker-auditoria.js';
import { queueName, prefetchCount, DEFAULT_PREFETCH, DEFAULT_QUEUE } from '../src/queue.js';

describe('cola y prefetch', () => {
  test('la cola por omisión es eventos-seguridad y RABBITMQ_QUEUE la cambia', () => {
    assert.equal(DEFAULT_QUEUE, 'eventos-seguridad');
    assert.equal(queueName({}), 'eventos-seguridad');
    assert.equal(queueName({ RABBITMQ_QUEUE: 'x' }), 'x');
  });

  test('prefetch: 50 por omisión; RABBITMQ_PREFETCH lo cambia; un valor inválido vuelve a 50', () => {
    assert.equal(DEFAULT_PREFETCH, 50);
    assert.equal(prefetchCount({}), 50);
    assert.equal(prefetchCount({ RABBITMQ_PREFETCH: '10' }), 10);
    for (const bad of ['0', '-3', 'abc', '2.5', '70000', '1e2', '0x10', ' 5', '5 ', '+5', '5\n']) {
      const warnings = [];
      assert.equal(prefetchCount({ RABBITMQ_PREFETCH: bad }, w => warnings.push(w)), 50, JSON.stringify(bad));
      assert.equal(warnings.length, 1, `un aviso para ${JSON.stringify(bad)}`);
    }
  });

  test('prefetch: sin variable (o vacía) usa 50 sin avisar; 1 y 65535 valen', () => {
    const warnings = [];
    for (const ok of [undefined, '']) assert.equal(prefetchCount({ RABBITMQ_PREFETCH: ok }, w => warnings.push(w)), 50);
    assert.equal(prefetchCount({ RABBITMQ_PREFETCH: '1' }, w => warnings.push(w)), 1);
    assert.equal(prefetchCount({ RABBITMQ_PREFETCH: '65535' }, w => warnings.push(w)), 65535);
    assert.deepEqual(warnings, []);
  });
});

describe('línea de log por evento', () => {
  const event = {
    category: 'SECURITY', type: 'LOGIN_FAILED', actorId: '64b000000000000000000001', actorRole: 'CUSTOMER',
    success: false, ip: '203.0.113.7', occurredAt: '2026-11-17T18:00:00.000Z',
    reason: 'Contraseña incorrecta', userAgent: 'ua-secreto', metadata: { email: 'ana@demo.mx', jti: 'j1' },
  };

  test('formato: categoría, tipo, actor, rol, éxito, ip y hora', () => {
    assert.equal(
      eventLogLine(event),
      '📥 [SECURITY] LOGIN_FAILED actor=64b000000000000000000001 role=CUSTOMER success=false ip=203.0.113.7 at=2026-11-17T18:00:00.000Z → ScyllaDB',
    );
  });

  test('no vuelca metadata, reason ni userAgent', () => {
    const line = eventLogLine(event);
    for (const hidden of ['ana@demo.mx', 'j1', 'Contraseña incorrecta', 'ua-secreto']) assert.ok(!line.includes(hidden));
  });

  test('actor y rol ausentes se muestran como "-"', () => {
    assert.match(eventLogLine({ ...event, actorId: null, actorRole: null }), /actor=- role=-/);
  });

  test('saltos de línea, tabuladores y otros caracteres de control no pueden falsificar líneas', () => {
    const hostile = eventLogLine({
      ...event, actorId: 'x\n📥 [SECURITY] LOGIN_SUCCESS actor=admin', actorRole: 'a\r\nb\tc\u0000d\u001b[31m', ip: '1.1.1.1\u2028falso',
    });
    assert.equal(hostile.split('\n').length, 1);
    assert.doesNotMatch(hostile, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });

  test('un campo larguísimo se recorta', () => {
    const line = logSafe('a'.repeat(5000));
    assert.equal(line.length, 81);
    assert.ok(line.endsWith('…'));
    assert.equal(logSafe(undefined), '-');
    assert.equal(logSafe(false), 'false');
  });
});

describe('ack y nack manual', () => {
  const channelOf = () => {
    const calls = [];
    return { calls, ack: m => calls.push(['ack', m]), nack: (m, all, requeue) => calls.push(['nack', m, all, requeue]) };
  };
  const msgOf = body => ({ content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  const quiet = { log: () => {}, warn: () => {}, error: () => {} };
  const valid = { eventId: '11111111-1111-4111-8111-111111111111', type: 'LOGIN_FAILED', category: 'SECURITY', actorId: 'ANONYMOUS', success: false, occurredAt: '2026-11-17T18:00:00.000Z' };

  test('ack después de guardar, y la línea se registra al confirmar', async () => {
    const ch = channelOf();
    const logs = [];
    const order = [];
    const msg = msgOf(valid);
    await handleMessage(ch, msg, { ...quiet, log: l => logs.push(l), save: async e => { order.push(`save:${e.type}`); } });
    assert.deepEqual(order, ['save:LOGIN_FAILED']);
    assert.deepEqual(ch.calls, [['ack', msg]]);
    assert.match(logs[0], /^📥 \[SECURITY\] LOGIN_FAILED /);
  });

  test('si guardar falla: sin ack, y nack con reencolado solo cuando pasa la pausa', async () => {
    const ch = channelOf();
    const timers = [];
    const msg = msgOf(valid);
    await handleMessage(ch, msg, {
      ...quiet, save: async () => { throw new Error('ScyllaDB caído'); }, retryMs: 5000,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
    });
    assert.deepEqual(ch.calls, []);
    assert.equal(timers[0].ms, 5000);
    timers[0].fn();
    assert.deepEqual(ch.calls, [['nack', msg, false, true]]);
  });

  test('un mensaje inválido se confirma y se descarta sin guardarse ni volcar su contenido', async () => {
    for (const body of ['no es json', '{"sin":"tipo"}', '[]']) {
      const ch = channelOf();
      const warnings = [];
      let saved = false;
      const msg = msgOf(body);
      await handleMessage(ch, msg, { ...quiet, warn: w => warnings.push(w), save: async () => { saved = true; } });
      assert.equal(saved, false);
      assert.deepEqual(ch.calls, [['ack', msg]]);
      assert.doesNotMatch(warnings[0], /no es json|sin/);
    }
  });

  test('un mensaje null (cancelación del consumidor) se ignora', async () => {
    const ch = channelOf();
    await handleMessage(ch, null, quiet);
    assert.deepEqual(ch.calls, []);
  });

  test('normalize sigue aceptando el sobre actual y el formato anterior', () => {
    assert.equal(normalize(valid, JSON.stringify(valid)).type, 'LOGIN_FAILED');
    const legacy = { event: 'ORDER_CREATED', payload: { orderId: 'o1', userId: 'u1' }, occurredAt: valid.occurredAt };
    const e = normalize(legacy, JSON.stringify(legacy));
    assert.deepEqual([e.category, e.targetId, e.actorId], ['ORDER', 'o1', 'u1']);
  });
});

describe('logSafe: caracteres invisibles', () => {
  test('marcas bidireccionales, de ancho cero y BOM se reemplazan', () => {
    const codes = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0x2028, 0x2029, 0x0085];
    for (const code of codes) {
      const out = logSafe(`a${String.fromCharCode(code)}b`);
      assert.equal(out, 'a b', `U+${code.toString(16)}`);
    }
  });

  test('el texto normal con acentos, ñ y emoji pasa igual', () => {
    assert.equal(logSafe('Contraseña ✓ 📥'), 'Contraseña ✓ 📥');
  });
});

describe('ack/nack seguros', () => {
  const closedChannel = () => ({ ack: () => { throw new Error('Channel closed'); }, nack: () => { throw new Error('Channel closed'); } });

  test('con el canal cerrado no lanzan', () => {
    assert.equal(safeAck(closedChannel(), {}), false);
    assert.equal(safeNack(closedChannel(), {}, true), false);
    const ok = { ack: () => {}, nack: () => {} };
    assert.equal(safeAck(ok, {}), true);
    assert.equal(safeNack(ok, {}, false), true);
  });

  test('handleMessage no lanza con el canal cerrado: ruta válida, inválida y temporizador del nack', async () => {
    const quiet = { log: () => {}, warn: () => {}, error: () => {} };
    const valid = { type: 'LOGIN_FAILED', category: 'SECURITY', eventId: '11111111-1111-4111-8111-111111111111' };
    const msgOf = body => ({ content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
    await assert.doesNotReject(handleMessage(closedChannel(), msgOf(valid), { ...quiet, save: async () => {} }));
    await assert.doesNotReject(handleMessage(closedChannel(), msgOf('basura'), quiet));
    const timers = [];
    await handleMessage(closedChannel(), msgOf(valid), { ...quiet, failures: new Map(), save: async () => { throw new Error('x'); }, setTimer: fn => timers.push(fn) });
    assert.doesNotThrow(() => timers[0]());
  });
});

describe('mensajes venenosos', () => {
  const quiet = { log: () => {}, warn: () => {} };
  const event = { type: 'LOGIN_FAILED', category: 'SECURITY', eventId: '22222222-2222-4222-8222-222222222222', metadata: { secreto: 'no-debe-salir' } };
  const msgOf = body => ({ content: Buffer.from(JSON.stringify(body)) });
  const channelOf = () => { const calls = []; return { calls, ack: m => calls.push(['ack', m]), nack: (m, all, requeue) => calls.push(['nack', m, all, requeue]) }; };

  test('a la 5.ª falla seguida se descarta (nack sin reencolar) con UNA línea de error y sin payload', async () => {
    const ch = channelOf();
    const failures = new Map();
    const errors = [];
    const timers = [];
    const opts = { ...quiet, failures, error: (...a) => errors.push(a.join(' ')), setTimer: fn => timers.push(fn), save: async () => { throw new Error('ScyllaDB caído'); } };
    const msg = msgOf(event);
    for (let i = 1; i < MAX_SAVE_ATTEMPTS; i++) await handleMessage(ch, msg, opts);
    assert.equal(timers.length, MAX_SAVE_ATTEMPTS - 1, 'las 4 primeras se reencolan tras la pausa');
    assert.deepEqual(ch.calls, []);
    await handleMessage(ch, msg, opts);
    assert.deepEqual(ch.calls, [['nack', msg, false, false]]);
    assert.equal(timers.length, MAX_SAVE_ATTEMPTS - 1, 'la 5.ª no programa otro reintento');
    const last = errors.at(-1);
    assert.match(last, /descartado tras 5 intentos/);
    assert.ok(!last.includes('no-debe-salir'));
    assert.equal(failures.size, 0);
  });

  test('un guardado correcto borra la cuenta de fallos de ese eventId', async () => {
    const ch = channelOf();
    const failures = new Map();
    const base = { ...quiet, error: () => {}, failures, setTimer: () => {} };
    await handleMessage(ch, msgOf(event), { ...base, save: async () => { throw new Error('x'); } });
    assert.equal(failures.get(event.eventId), 1);
    await handleMessage(ch, msgOf(event), { ...base, save: async () => {} });
    assert.equal(failures.has(event.eventId), false);
  });

  test('cada eventId lleva su cuenta y el mapa no crece sin límite', async () => {
    const ch = channelOf();
    const failures = new Map();
    const opts = { ...quiet, error: () => {}, failures, setTimer: () => {}, save: async () => { throw new Error('x'); } };
    for (let i = 0; i < 1500; i++) {
      await handleMessage(ch, msgOf({ ...event, eventId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }), opts);
    }
    assert.ok(failures.size <= 1000);
  });
});

describe('reconexión del worker', () => {
  function fakeWorld(plan = []) {
    const world = { connects: 0, conns: [], timers: [], logs: [], warns: [], errors: [], handled: [] };
    world.connect = async () => {
      world.connects += 1;
      const step = plan.length ? plan.shift() : 'ok';
      if (step instanceof Error) throw step;
      const conn = new EventEmitter();
      conn.closeCalls = 0;
      conn.close = async () => { conn.closeCalls += 1; };
      conn.createChannel = async () => {
        const ch = new EventEmitter();
        ch.assertQueue = async () => { if (step === 'assert-fails') throw new Error('assert falló'); };
        ch.prefetch = async n => { ch.prefetched = n; };
        ch.consume = async (q, fn) => { ch.queue = q; ch.deliver = fn; };
        conn.channel = ch;
        return ch;
      };
      world.conns.push(conn);
      return conn;
    };
    world.consumer = createConsumer({
      connect: world.connect, queue: 'eventos-seguridad', prefetch: 50, retryMs: 5000,
      setTimer: fn => { world.timers.push(fn); return world.timers.length; },
      handle: (ch, msg) => world.handled.push(msg),
      log: m => world.logs.push(m), warn: m => world.warns.push(m), error: m => world.errors.push(m),
    });
    return world;
  }
  const flush = () => new Promise(resolve => setImmediate(resolve));

  test('consume la cola con el prefetch indicado y entrega los mensajes al manejador', async () => {
    const w = fakeWorld();
    await w.consumer.start();
    const ch = w.conns[0].channel;
    assert.equal(ch.queue, 'eventos-seguridad');
    assert.equal(ch.prefetched, 50);
    ch.deliver({ id: 1 });
    assert.deepEqual(w.handled, [{ id: 1 }]);
    assert.match(w.logs[0], /eventos-seguridad.*prefetch 50/);
  });

  test('si el connect falla, un solo reintento programado', async () => {
    const w = fakeWorld([new Error('ECONNREFUSED')]);
    await w.consumer.start();
    await w.consumer.start(); // otro arranque con el reintento ya programado no lo duplica
    assert.equal(w.timers.length, 1);
    w.timers[0](); await flush();
    assert.equal(w.connects, 2);
    assert.equal(w.timers.length, 1);
  });

  test('si falla a medias (assertQueue), la conexión se cierra antes de reintentar', async () => {
    const w = fakeWorld(['assert-fails']);
    await w.consumer.start();
    await flush();
    assert.equal(w.conns[0].closeCalls, 1);
    assert.equal(w.timers.length, 1);
    assert.match(w.warns[0], /assert falló/);
  });

  test('el cierre de la conexión programa UN reintento, aunque se repita el evento o cierre también el canal', async () => {
    const w = fakeWorld();
    await w.consumer.start();
    const [conn] = w.conns;
    conn.emit('close');
    conn.emit('close');
    conn.channel.emit('close');
    assert.equal(w.timers.length, 1);
    w.timers[0](); await flush();
    assert.equal(w.connects, 2);
    assert.equal(w.conns[1].channel.queue, 'eventos-seguridad');
  });

  test('el cierre de la conexión vieja, ya reemplazada, no dispara otro bucle', async () => {
    const w = fakeWorld();
    await w.consumer.start();
    const [old] = w.conns;
    old.emit('close');
    w.timers[0](); await flush();
    assert.equal(w.timers.length, 1);
    old.emit('close'); // cierre tardío de la conexión descartada
    assert.equal(w.timers.length, 1);
    assert.equal(w.connects, 2);
  });

  test("el cierre del canal cierra la conexión y reintenta; 'error' del canal solo se registra", async () => {
    const w = fakeWorld();
    await w.consumer.start();
    const [conn] = w.conns;
    assert.doesNotThrow(() => conn.channel.emit('error', new Error('PRECONDITION_FAILED')));
    assert.match(w.errors[0], /canal/);
    conn.channel.emit('close');
    await flush();
    assert.equal(conn.closeCalls, 1);
    assert.equal(w.timers.length, 1);
  });

  test("'error' de la conexión tiene oyente (no tumba el proceso)", async () => {
    const w = fakeWorld();
    await w.consumer.start();
    assert.doesNotThrow(() => w.conns[0].emit('error', new Error('reset')));
  });
});
