// Errores de Redis a mitad de una operación de sesiones (src/infrastructure/refresh-store.js):
// guardSessions y withSessionErrors los convierten en SERVICE_UNAVAILABLE
// (`service: SESSIONS`) para que el cliente conserve su refresh token y reintente.
// Sin Redis: un almacén falso.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { guardSessions, withSessionErrors, sessionsUnavailable } from '../../src/infrastructure/refresh-store.js';
import { DomainError } from '../../src/domain/errors.js';

const redisDown = () => Object.assign(new Error('Socket closed unexpectedly'), { name: 'SocketClosedUnexpectedlyError' });

// Almacén falso: cada método responde "<método>-ok" o falla como Redis caído.
function fakeStore({ failing = [] } = {}) {
  const calls = [];
  const method = name => async (...args) => {
    calls.push([name, ...args]);
    if (failing.includes(name)) throw redisDown();
    return `${name}-ok`;
  };
  return {
    calls,
    addFamily: multi => multi,
    lookup: method('lookup'),
    replay: method('replay'),
    rotate: method('rotate'),
    revokeFamily: method('revokeFamily'),
    revokeUserFamilies: method('revokeUserFamilies'),
  };
}

const isSessionsUnavailable = err => {
  assert.ok(err instanceof DomainError);
  assert.deepEqual(err.extensions, { code: 'SERVICE_UNAVAILABLE', service: 'SESSIONS' });
  return true;
};

// guardSessions registra el error real en consola: se silencia en las pruebas.
const quietly = async fn => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

describe('sessionsUnavailable', () => {
  test('SERVICE_UNAVAILABLE con service SESSIONS', () => {
    assert.ok(isSessionsUnavailable(sessionsUnavailable()));
  });
});

describe('guardSessions', () => {
  test('devuelve el resultado cuando Redis responde', async () => {
    assert.equal(await guardSessions(async () => 42), 42);
  });

  test('un error de Redis (rechazo o excepción síncrona) llega como SERVICE_UNAVAILABLE, SESSIONS', async () => {
    await quietly(async () => {
      await assert.rejects(guardSessions(async () => { throw redisDown(); }), isSessionsUnavailable);
      await assert.rejects(guardSessions(() => { throw redisDown(); }), isSessionsUnavailable);
    });
  });

  test('un DomainError pasa sin cambios', async () => {
    const own = new DomainError('otro', 'NOT_FOUND', { entity: 'USER', id: '1' });
    await assert.rejects(guardSessions(async () => { throw own; }), err => err === own);
  });
});

describe('withSessionErrors', () => {
  test('lookup, replay, rotate y las revocaciones pasan sus argumentos y su resultado', async () => {
    const store = fakeStore();
    const guarded = withSessionErrors(store);
    assert.equal(await guarded.lookup('h1'), 'lookup-ok');
    assert.equal(await guarded.replay({ familyId: 'f1' }), 'replay-ok');
    assert.equal(await guarded.rotate({ oldHash: 'h1' }), 'rotate-ok');
    assert.equal(await guarded.revokeFamily('u1', 'f1'), 'revokeFamily-ok');
    assert.equal(await guarded.revokeUserFamilies('u1'), 'revokeUserFamilies-ok');
    assert.deepEqual(store.calls, [
      ['lookup', 'h1'], ['replay', { familyId: 'f1' }], ['rotate', { oldHash: 'h1' }],
      ['revokeFamily', 'u1', 'f1'], ['revokeUserFamilies', 'u1'],
    ]);
  });

  test('si Redis se cae a mitad del canje (lookup, rotate o revocación), el cliente recibe SERVICE_UNAVAILABLE, SESSIONS', async () => {
    const methods = ['lookup', 'replay', 'rotate', 'revokeFamily', 'revokeUserFamilies'];
    const guarded = withSessionErrors(fakeStore({ failing: methods }));
    await quietly(async () => {
      for (const name of methods) await assert.rejects(guarded[name]('x'), isSessionsUnavailable, name);
    });
  });

  test('addFamily sigue siendo síncrono: arma la transacción del login', () => {
    const multi = { marker: true };
    assert.equal(withSessionErrors(fakeStore()).addFamily(multi), multi);
  });
});
