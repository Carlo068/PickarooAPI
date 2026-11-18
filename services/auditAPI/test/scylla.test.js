// Fila de logs_eventos (src/scylla.js): el timeuuid determinista y los parámetros del INSERT.
// Funciones puras: no abren ninguna conexión a ScyllaDB.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import cassandra from 'cassandra-driver';
import { buildLogsEventosParams, eventTimeUuid } from '../src/scylla.js';

const { LocalDate, TimeUuid } = cassandra.types;

const event = (over = {}) => ({
  eventId: '3f0c1c52-8f5e-4a0e-9a53-7a1d2d6a9b10',
  type: 'LOGIN_FAILED',
  category: 'SECURITY',
  actorId: 'ANONYMOUS',
  actorRole: null,
  targetType: null,
  targetId: null,
  success: false,
  reason: 'Contraseña incorrecta',
  ip: '::1',
  userAgent: 'curl/8',
  metadata: { email: 'a@b.mx' },
  occurredAt: '2026-11-17T18:00:00.123Z',
  ...over,
});

// Orden de LOGS_EVENTOS_COLUMNS.
const [FECHA_DIA, TIPO, TIMESTAMP, EVENTO_ID] = [0, 1, 2, 3];

describe('buildLogsEventosParams', () => {
  test('mismo evento dos veces: el mismo timeuuid (un mensaje reentregado reescribe la misma fila)', () => {
    const a = buildLogsEventosParams(event())[EVENTO_ID];
    const b = buildLogsEventosParams(event())[EVENTO_ID];
    assert.ok(a instanceof TimeUuid);
    assert.ok(a.equals(b));
    assert.equal(a.toString(), b.toString());
  });

  test('eventId distinto: timeuuid distinto aunque la hora sea la misma', () => {
    const a = buildLogsEventosParams(event())[EVENTO_ID];
    const b = buildLogsEventosParams(event({ eventId: '9a8b7c6d-1111-4222-8333-444455556666' }))[EVENTO_ID];
    assert.ok(!a.equals(b));
  });

  test('la parte de tiempo del timeuuid es occurredAt (con milisegundos)', () => {
    const params = buildLogsEventosParams(event());
    assert.equal(params[EVENTO_ID].getDate().toISOString(), '2026-11-17T18:00:00.123Z');
    assert.equal(params[TIMESTAMP].toISOString(), '2026-11-17T18:00:00.123Z');
    assert.equal(params[EVENTO_ID].getDate().getTime(), params[TIMESTAMP].getTime());
  });

  test('es un uuid versión 1 y los ticks caen dentro del milisegundo', () => {
    const id = eventTimeUuid('x', new Date('2026-11-17T18:00:00.000Z'));
    assert.equal(id.toString()[14], '1');
    assert.ok(id.getDatePrecision().ticks >= 0 && id.getDatePrecision().ticks < 10000);
  });

  test('fecha_dia es el día UTC, no el local (a las 23:30 UTC sigue siendo ese día)', () => {
    const late = buildLogsEventosParams(event({ occurredAt: '2026-11-17T23:30:00.000Z' }))[FECHA_DIA];
    assert.ok(late instanceof LocalDate);
    assert.equal(late.toString(), '2026-11-17');
    const early = buildLogsEventosParams(event({ occurredAt: '2026-11-18T00:00:01.000Z' }))[FECHA_DIA];
    assert.equal(early.toString(), '2026-11-18');
    // Un instante con zona horaria distinta que en UTC cae en el día siguiente.
    const offset = buildLogsEventosParams(event({ occurredAt: '2026-11-17T22:00:00-05:00' }))[FECHA_DIA];
    assert.equal(offset.toString(), '2026-11-18');
  });

  test('tipo_evento es el tipo del evento y el resto de columnas sigue el orden del INSERT', () => {
    const params = buildLogsEventosParams(event());
    assert.equal(params[TIPO], 'LOGIN_FAILED');
    assert.deepEqual(params.slice(4), ['SECURITY', 'ANONYMOUS', null, null, null, false, 'Contraseña incorrecta', '::1', 'curl/8', '{"email":"a@b.mx"}']);
    assert.equal(params.length, 14);
  });

  test('metadata ausente se guarda como {}', () => {
    assert.equal(buildLogsEventosParams(event({ metadata: undefined }))[13], '{}');
  });
});
