// Ubicación del repartidor (PIC-77, src/domain/driver-location.js y
// src/infrastructure/location-store.js): validación de coordenadas, estado de la
// orden, el punto guardado y su vista, y el almacén ante un Redis caído.
// Sin bases de datos: el almacén se prueba con un cliente falso. Los scripts Lua
// contra un Redis real están en test/integration/driver-location.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATION_KEY_PREFIX, locationKey, DEFAULT_LOCATION_TTL_SECONDS, MAX_LOCATION_TTL_SECONDS, locationTtlSeconds,
  MIN_REPORT_INTERVAL_MS, FUTURE_TOLERANCE_MS,
  invalidLocationField, assertValidLocation, isTrackable, assertTrackable,
  newLocationRecord, parseLocationRecord, shouldReplaceLocation, locationView,
} from '../../src/domain/driver-location.js';
import { createLocationStore, locationUnavailable, WRITE_LOCATION_SCRIPT, READ_LOCATION_SCRIPT } from '../../src/infrastructure/location-store.js';
import { DomainError, ERROR_CODES } from '../../src/domain/errors.js';

// Lanza un DomainError con ese código y esas extensions (exactas).
const expectError = (fn, code, extensions = {}) => assert.throws(fn, e => {
  assert.ok(e instanceof DomainError, `debe ser DomainError, fue ${e?.name}: ${e?.message}`);
  assert.deepEqual(e.extensions, { ...extensions, code });
  return true;
});

describe('catálogo de errores de la ubicación', () => {
  test('INVALID_LOCATION declara field e INVALID_ORDER_STATE declara status y mode', () => {
    assert.deepEqual(ERROR_CODES.INVALID_LOCATION.fields, ['field']);
    assert.deepEqual(ERROR_CODES.INVALID_ORDER_STATE.fields, ['status', 'mode']);
  });
});

describe('clave y TTL', () => {
  test('driver:loc:<orderId>', () => {
    assert.equal(LOCATION_KEY_PREFIX, 'driver:loc:');
    assert.equal(locationKey('64b2f0c8e4b0a1b2c3d4e5f6'), 'driver:loc:64b2f0c8e4b0a1b2c3d4e5f6');
  });
  test('TTL: 600 s por omisión; DRIVER_LOCATION_TTL_SECONDS válido lo cambia', () => {
    assert.equal(DEFAULT_LOCATION_TTL_SECONDS, 600);
    assert.equal(MAX_LOCATION_TTL_SECONDS, 86_400);
    assert.equal(locationTtlSeconds(undefined), 600);
    assert.equal(locationTtlSeconds('120'), 120);
    assert.equal(locationTtlSeconds(' 90 '), 90);
    assert.equal(locationTtlSeconds(30), 30);
    assert.equal(locationTtlSeconds('1'), 1);
    assert.equal(locationTtlSeconds('86400'), 86_400); // el máximo
    assert.equal(locationTtlSeconds(86_400), 86_400);
  });
  test('un valor ausente, no numérico, no entero o no positivo usa el de 600', () => {
    for (const bad of ['', '   ', 'abc', '120abc', '0', '-5', '1.5', 1.5, 0, -1, null, NaN, true, {}, []]) {
      assert.equal(locationTtlSeconds(bad), 600, JSON.stringify(bad) ?? String(bad));
    }
  });
  test('un valor enorme o por encima del máximo usa el de 600 (no se recorta): Redis rechazaría "1e+23" en SET EX', () => {
    for (const bad of ['1e23', 1e23, '100000000000000000000000', '86401', 86_401, '9007199254740992', 2 ** 53, 'Infinity', Infinity]) {
      assert.equal(locationTtlSeconds(bad), 600, String(bad));
    }
    // Todo lo que se acepta se escribe como entero decimal: lo que SET ... EX necesita.
    for (const ok of ['1', '600', '86400']) assert.match(String(locationTtlSeconds(ok)), /^[1-9]\d*$/);
  });
});

describe('invalidLocationField / assertValidLocation', () => {
  test('coordenadas válidas, incluidos los extremos y un solo cero', () => {
    for (const [lat, lng] of [[28.6353, -106.0889], [90, 180], [-90, -180], [0, 1], [1, 0], [0.000001, 0], [-0.5, 0]]) {
      assert.equal(invalidLocationField(lat, lng), null, `${lat},${lng}`);
      assert.equal(assertValidLocation(lat, lng), true);
    }
  });
  test('lat fuera de [-90, 90]', () => {
    for (const lat of [90.000001, -90.000001, 91, -200, 1e9]) assert.equal(invalidLocationField(lat, 10), 'lat', String(lat));
  });
  test('lng fuera de [-180, 180]', () => {
    for (const lng of [180.000001, -180.000001, 181, -360, 1e9]) assert.equal(invalidLocationField(10, lng), 'lng', String(lng));
  });
  test('NaN e Infinity se rechazan (y lo que no es un número)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.equal(invalidLocationField(bad, 10), 'lat', String(bad));
      assert.equal(invalidLocationField(10, bad), 'lng', String(bad));
    }
    for (const bad of [null, undefined, '10', '', {}, [], true]) {
      assert.equal(invalidLocationField(bad, 10), 'lat', String(bad));
      assert.equal(invalidLocationField(10, bad), 'lng', String(bad));
    }
  });
  test('(0, 0) es el centinela "sin posición": el campo es location (también -0)', () => {
    assert.equal(invalidLocationField(0, 0), 'location');
    assert.equal(invalidLocationField(-0, 0), 'location');
    assert.equal(invalidLocationField(0, -0), 'location');
  });
  test('cuando falla lat y lng, se reporta lat primero', () => {
    assert.equal(invalidLocationField(100, 200), 'lat');
  });
  test('assertValidLocation lanza INVALID_LOCATION con el campo', () => {
    expectError(() => assertValidLocation(91, 10), 'INVALID_LOCATION', { field: 'lat' });
    expectError(() => assertValidLocation(10, -181), 'INVALID_LOCATION', { field: 'lng' });
    expectError(() => assertValidLocation(NaN, 10), 'INVALID_LOCATION', { field: 'lat' });
    expectError(() => assertValidLocation(10, Infinity), 'INVALID_LOCATION', { field: 'lng' });
    expectError(() => assertValidLocation(0, 0), 'INVALID_LOCATION', { field: 'location' });
  });
});

describe('estado de la orden: solo DELIVERY en IN_DELIVERY', () => {
  test('isTrackable', () => {
    assert.equal(isTrackable({ mode: 'DELIVERY', status: 'IN_DELIVERY' }), true);
    for (const status of ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED']) {
      assert.equal(isTrackable({ mode: 'DELIVERY', status }), false, status);
    }
    assert.equal(isTrackable({ mode: 'PICKUP', status: 'IN_DELIVERY' }), false);
    assert.equal(isTrackable(null), false);
    assert.equal(isTrackable(undefined), false);
  });
  test('assertTrackable lanza INVALID_ORDER_STATE con status y mode', () => {
    assert.equal(assertTrackable({ mode: 'DELIVERY', status: 'IN_DELIVERY' }), true);
    expectError(() => assertTrackable({ mode: 'DELIVERY', status: 'READY' }), 'INVALID_ORDER_STATE', { status: 'READY', mode: 'DELIVERY' });
    expectError(() => assertTrackable({ mode: 'DELIVERY', status: 'DELIVERED' }), 'INVALID_ORDER_STATE', { status: 'DELIVERED', mode: 'DELIVERY' });
    expectError(() => assertTrackable({ mode: 'PICKUP', status: 'READY' }), 'INVALID_ORDER_STATE', { status: 'READY', mode: 'PICKUP' });
    expectError(() => assertTrackable({}), 'INVALID_ORDER_STATE', { status: null, mode: null });
  });
});

describe('punto guardado', () => {
  const nowMs = Date.parse('2026-11-17T18:00:00.250Z');

  test('newLocationRecord: lat, lng, at (ISO) y seq (ms) de la hora dada; no guarda quién reportó', () => {
    const record = newLocationRecord({ lat: 28.6, lng: -106.1, nowMs });
    assert.deepEqual(record, { lat: 28.6, lng: -106.1, at: '2026-11-17T18:00:00.250Z', seq: nowMs });
    assert.equal(Date.parse(record.at), record.seq);
    assert.equal('driverId' in record, false);
    // Aunque le pasen más datos, no los copia.
    assert.deepEqual(Object.keys(newLocationRecord({ lat: 1, lng: 2, nowMs, driverId: 'secreto' })).sort(), ['at', 'lat', 'lng', 'seq']);
  });

  test('parseLocationRecord: ida y vuelta, y null con valores que no son un punto', () => {
    const record = newLocationRecord({ lat: 28.6, lng: -106.1, nowMs });
    assert.deepEqual(parseLocationRecord(JSON.stringify(record)), record);
    for (const raw of [null, undefined, '', 'no es json', '[]', 'null', '42', '{}', 123,
      JSON.stringify({ ...record, lat: 'x' }), JSON.stringify({ ...record, lng: null }), JSON.stringify({ ...record, at: 'ayer' }),
      JSON.stringify({ ...record, seq: '1' })]) {
      assert.equal(parseLocationRecord(raw), null, String(raw));
    }
  });

  test('parseLocationRecord solo conserva las cuatro claves (un valor anterior con driverId también se lee)', () => {
    const record = newLocationRecord({ lat: 1, lng: 2, nowMs });
    assert.deepEqual(Object.keys(parseLocationRecord(JSON.stringify({ ...record, driverId: 'viejo', extra: 'x' }))).sort(), ['at', 'lat', 'lng', 'seq']);
  });
});

describe('locationView: solo coordenadas y tiempos, con la hora de Redis', () => {
  const nowMs = Date.parse('2026-11-17T18:00:00.250Z');
  const record = newLocationRecord({ lat: 28.6, lng: -106.1, nowMs });

  test('lat, lng, updatedAt y ageSeconds; nada más', () => {
    const view = locationView(record, nowMs + 4_900);
    assert.deepEqual(view, { lat: 28.6, lng: -106.1, updatedAt: '2026-11-17T18:00:00.250Z', ageSeconds: 4 });
    assert.doesNotMatch(JSON.stringify(view), /driverId|seq/);
  });

  test('ageSeconds: entero hacia abajo', () => {
    assert.equal(locationView(record, nowMs).ageSeconds, 0);
    assert.equal(locationView(record, nowMs + 999).ageSeconds, 0);
    assert.equal(locationView(record, nowMs + 1000).ageSeconds, 1);
    assert.equal(locationView(record, nowMs + 61_000).ageSeconds, 61);
  });

  test('un punto con hora algo adelantada (dentro de la tolerancia) se trata como reciente: ageSeconds 0', () => {
    assert.equal(FUTURE_TOLERANCE_MS, 5000);
    for (const ahead of [1, 1_000, 4_999, FUTURE_TOLERANCE_MS]) {
      assert.equal(locationView(record, nowMs - ahead).ageSeconds, 0, `${ahead} ms adelantado`);
    }
  });

  test('un punto con hora del futuro más allá de la tolerancia no es confiable: null (no parece reciente)', () => {
    assert.equal(locationView(record, nowMs - FUTURE_TOLERANCE_MS - 1), null);
    assert.equal(locationView(record, nowMs - 60_000), null);
    assert.equal(locationView(record, nowMs - 3_600_000), null);
  });
});

describe('shouldReplaceLocation: el reporte nuevo reemplaza al guardado solo si llega ≥ 1 s después', () => {
  const NOW = 1_000_000_000; // la hora de Redis al escribir; lo guardado está en el pasado salvo que se diga
  test('el intervalo mínimo es de un segundo', () => assert.equal(MIN_REPORT_INTERVAL_MS, 1000));
  test('sin punto guardado (o ilegible), se guarda', () => {
    for (const stored of [null, undefined, NaN, 'x']) assert.equal(shouldReplaceLocation(stored, NOW, NOW), true, String(stored));
  });
  test('a menos de un segundo: se ignora (límite de 1 por segundo)', () => {
    const stored = NOW - 5_000;
    assert.equal(shouldReplaceLocation(stored, stored, NOW), false);
    assert.equal(shouldReplaceLocation(stored, stored + 500, NOW), false);
    assert.equal(shouldReplaceLocation(stored, stored + 999, NOW), false);
  });
  test('al segundo exacto o después: se guarda', () => {
    const stored = NOW - 5_000;
    assert.equal(shouldReplaceLocation(stored, stored + 1000, NOW), true);
    assert.equal(shouldReplaceLocation(stored, stored + 4_000, NOW), true);
  });
  test('uno que llegó tarde (seq menor que el guardado) nunca lo reemplaza', () => {
    const stored = NOW - 5_000;
    assert.equal(shouldReplaceLocation(stored, stored - 1, NOW), false);
    assert.equal(shouldReplaceLocation(stored, stored - 4_000, NOW), false);
    assert.equal(shouldReplaceLocation(stored, 0, NOW), false);
  });
  test('un punto guardado con hora del futuro (reloj que retrocedió) no congela las escrituras: se reemplaza', () => {
    for (const ahead of [1, 1_000, 60_000, 3_600_000]) {
      const stored = NOW + ahead;
      assert.equal(shouldReplaceLocation(stored, NOW, NOW), true, `${ahead} ms adelantado`);
      assert.equal(shouldReplaceLocation(stored, NOW - 2_000, NOW), true, `${ahead} ms adelantado, reporte algo viejo`);
    }
    // Justo ahora (no es del futuro): rige el límite de 1 por segundo.
    assert.equal(shouldReplaceLocation(NOW, NOW, NOW), false);
  });
  test('intervalo configurable', () => {
    const stored = NOW - 5_000;
    assert.equal(shouldReplaceLocation(stored, stored + 100, NOW, 100), true);
    assert.equal(shouldReplaceLocation(stored, stored + 99, NOW, 100), false);
  });
});

describe('location-store: Redis caído es SERVICE_UNAVAILABLE (LOCATION)', () => {
  const redisDown = () => Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' });
  const isUnavailable = err => {
    assert.ok(err instanceof DomainError);
    assert.deepEqual(err.extensions, { code: 'SERVICE_UNAVAILABLE', service: 'LOCATION' });
    return true;
  };

  // Cliente falso: registra los comandos; `failing` los hace fallar como un Redis caído.
  // `reply` da la respuesta de cada comando (para eval, por su script).
  function fakeRedis({ isReady = true, failing = false, reply = {} } = {}) {
    const calls = [];
    const command = (name, answer) => async (...args) => {
      calls.push([name, ...args]);
      if (failing) throw redisDown();
      return answer(...args);
    };
    return {
      calls,
      isReady,
      eval: command('eval', script => reply.eval?.[script]),
      sendCommand: command('sendCommand', () => reply.time),
      del: command('del', () => reply.del),
    };
  }

  // Los avisos de consola son esperados aquí.
  const quietly = async fn => {
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try { return await fn(warnings); } finally { console.warn = warn; }
  };

  test('locationUnavailable', () => {
    assert.ok(isUnavailable(locationUnavailable()));
  });

  test('now, save y get con Redis no listo: SERVICE_UNAVAILABLE sin tocar Redis', async () => {
    const redis = fakeRedis({ isReady: false });
    const store = createLocationStore(redis, { ttlSeconds: 600 });
    await assert.rejects(store.now(), isUnavailable);
    await assert.rejects(store.save('o1', newLocationRecord({ lat: 1, lng: 2, nowMs: 1_700_000_000_000 })), isUnavailable);
    await assert.rejects(store.get('o1'), isUnavailable);
    assert.deepEqual(redis.calls, []);
  });

  test('now, save y get con Redis que falla a mitad: SERVICE_UNAVAILABLE', async () => {
    const store = createLocationStore(fakeRedis({ failing: true }), { ttlSeconds: 600 });
    await quietly(async () => {
      await assert.rejects(store.now(), isUnavailable);
      await assert.rejects(store.save('o1', newLocationRecord({ lat: 1, lng: 2, nowMs: 1_700_000_000_000 })), isUnavailable);
      await assert.rejects(store.get('o1'), isUnavailable);
    });
  });

  test('clear nunca lanza ni rechaza: devuelve false y lo registra (Redis caído o no listo)', async () => {
    await quietly(async warnings => {
      assert.equal(await createLocationStore(fakeRedis({ failing: true }), { ttlSeconds: 600 }).clear('o1'), false);
      assert.equal(await createLocationStore(fakeRedis({ isReady: false }), { ttlSeconds: 600 }).clear('o1'), false);
      assert.equal(warnings.length, 2);
      assert.match(warnings[0], /o1/);
    });
  });

  test('clear borra driver:loc:<orderId> y devuelve true', async () => {
    const redis = fakeRedis();
    assert.equal(await createLocationStore(redis, { ttlSeconds: 600 }).clear('o1'), true);
    assert.deepEqual(redis.calls, [['del', 'driver:loc:o1']]);
  });

  test('clear se puede lanzar sin esperarla: la promesa no rechaza aunque Redis falle (nada sin atrapar)', async () => {
    const unhandled = [];
    const onUnhandled = err => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      await quietly(async () => {
        const store = createLocationStore(fakeRedis({ failing: true }), { ttlSeconds: 600 });
        void store.clear('o1');
        void createLocationStore(fakeRedis({ isReady: false }), { ttlSeconds: 600 }).clear('o2');
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('now lee TIME de Redis y lo da en milisegundos', async () => {
    const redis = fakeRedis({ reply: { time: ['1794930798', '975574'] } });
    assert.equal(await createLocationStore(redis, { ttlSeconds: 600 }).now(), 1_794_930_798_975);
    assert.deepEqual(redis.calls, [['sendCommand', ['TIME']]]);
  });

  test('save manda el punto, su seq, el TTL y el intervalo mínimo al script; 1 es guardado y 0 ignorado', async () => {
    const record = newLocationRecord({ lat: 28.6, lng: -106.1, nowMs: Date.parse('2026-11-17T18:00:00Z') });
    const saved = fakeRedis({ reply: { eval: { [WRITE_LOCATION_SCRIPT]: 1 } } });
    assert.equal(await createLocationStore(saved, { ttlSeconds: 90 }).save('o1', record), true);
    const [name, script, options] = saved.calls[0];
    assert.equal(name, 'eval');
    assert.equal(script, WRITE_LOCATION_SCRIPT);
    assert.deepEqual(options, { keys: ['driver:loc:o1'], arguments: [JSON.stringify(record), String(record.seq), '90', '1000'] });
    assert.equal(await createLocationStore(fakeRedis({ reply: { eval: { [WRITE_LOCATION_SCRIPT]: 0 } } }), { ttlSeconds: 90 }).save('o1', record), false);
  });

  test('el script de escritura lee TIME y deja pasar un punto guardado del futuro; el de lectura devuelve el valor y la hora', () => {
    assert.match(WRITE_LOCATION_SCRIPT, /redis\.call\('TIME'\)/);
    assert.match(WRITE_LOCATION_SCRIPT, /last\.seq <= now/);
    assert.match(READ_LOCATION_SCRIPT, /redis\.call\('TIME'\)/);
  });

  test('get interpreta el JSON guardado y la hora de Redis, o record null si no hay punto o es ilegible', async () => {
    const record = newLocationRecord({ lat: 28.6, lng: -106.1, nowMs: 1_794_930_798_000 });
    const read = stored => createLocationStore(fakeRedis({ reply: { eval: { [READ_LOCATION_SCRIPT]: [stored, '1794930800', '500000'] } } }), { ttlSeconds: 600 }).get('o1');
    assert.deepEqual(await read(JSON.stringify(record)), { record, nowMs: 1_794_930_800_500 });
    assert.deepEqual(await read(''), { record: null, nowMs: 1_794_930_800_500 });
    assert.deepEqual(await read('basura'), { record: null, nowMs: 1_794_930_800_500 });
  });
});
