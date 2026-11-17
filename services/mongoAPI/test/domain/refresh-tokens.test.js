// Reglas puras de los refresh tokens (src/domain/refresh-tokens.js): forma del
// token, hash, TTL configurable, registro y su vencimiento, ventana de gracia
// (sucesor derivado y su registro) y la decisión de no canjear sin Neo4j. Sin Redis.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  REFRESH_TOKEN_BYTES, DEFAULT_REFRESH_TTL_SECONDS, refreshTtlSeconds, generateRefreshToken, isWellFormedRefreshToken,
  hashRefreshToken, newRefreshRecord, parseRefreshRecord, isRefreshRecordLive, parseSpentMarker,
  DEFAULT_REFRESH_GRACE_SECONDS, refreshGraceSeconds, generateGraceNonce, successorRefreshToken,
  newGraceRecord, parseGraceRecord, refreshUnavailableService,
} from '../../src/domain/refresh-tokens.js';

describe('generateRefreshToken', () => {
  test('256 bits aleatorios en base64url (43 caracteres, sin relleno)', () => {
    const token = generateRefreshToken();
    assert.equal(REFRESH_TOKEN_BYTES, 32);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
  });

  test('no es un JWT y no se repite', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateRefreshToken));
    assert.equal(tokens.size, 200);
    for (const t of tokens) assert.ok(!t.includes('.'));
  });

  test('lo que genera tiene la forma esperada', () => {
    for (let i = 0; i < 50; i += 1) assert.ok(isWellFormedRefreshToken(generateRefreshToken()));
  });
});

describe('isWellFormedRefreshToken', () => {
  test('rechaza lo que no es un token de 43 caracteres base64url', () => {
    for (const bad of [undefined, null, 42, '', 'abc', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`, `${'a'.repeat(42)}.`, 'eyJhbGciOiJIUzI1NiJ9.e30.x']) {
      assert.equal(isWellFormedRefreshToken(bad), false, String(bad));
    }
    assert.equal(isWellFormedRefreshToken('A'.repeat(21) + '_-' + 'z9'.repeat(10)), true);
  });
});

describe('hashRefreshToken', () => {
  test('SHA-256 en hex del token (64 caracteres), estable', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(hashRefreshToken(token), hash);
  });

  test('tokens distintos dan hashes distintos y el hash no contiene el token', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    assert.notEqual(hashRefreshToken(a), hashRefreshToken(b));
    assert.ok(!hashRefreshToken(a).includes(a));
  });
});

describe('refreshTtlSeconds', () => {
  test('30 días por omisión', () => {
    assert.equal(DEFAULT_REFRESH_TTL_SECONDS, 2_592_000);
    assert.equal(refreshTtlSeconds(undefined), DEFAULT_REFRESH_TTL_SECONDS);
    assert.equal(refreshTtlSeconds(''), DEFAULT_REFRESH_TTL_SECONDS);
  });

  test('acepta un entero positivo de la variable de entorno', () => {
    assert.equal(refreshTtlSeconds('10'), 10);
    assert.equal(refreshTtlSeconds('604800'), 604800);
  });

  test('cero, negativos y texto usan el valor por omisión', () => {
    for (const v of ['0', '-5', 'treinta', 'NaN']) assert.equal(refreshTtlSeconds(v), DEFAULT_REFRESH_TTL_SECONDS, v);
  });
});

describe('registro del refresh token', () => {
  const now = Date.parse('2026-11-16T12:00:00.000Z');

  test('newRefreshRecord: usuario, familia, creación y vencimiento a TTL segundos', () => {
    const record = newRefreshRecord({ userId: { toString: () => 'u1' }, familyId: 'f1', ttlSeconds: 3600, now });
    assert.deepEqual(record, {
      userId: 'u1', familyId: 'f1',
      createdAt: '2026-11-16T12:00:00.000Z',
      expiresAt: '2026-11-16T13:00:00.000Z',
    });
  });

  test('el registro no guarda el token', () => {
    const record = newRefreshRecord({ userId: 'u1', familyId: 'f1', ttlSeconds: 60, now });
    assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'expiresAt', 'familyId', 'userId']);
  });

  test('parseRefreshRecord: ida y vuelta por JSON', () => {
    const record = newRefreshRecord({ userId: 'u1', familyId: 'f1', ttlSeconds: 60, now });
    assert.deepEqual(parseRefreshRecord(JSON.stringify(record)), record);
  });

  test('parseRefreshRecord: null para ausente, otro formato, JSON roto o campos faltantes', () => {
    const record = newRefreshRecord({ userId: 'u1', familyId: 'f1', ttlSeconds: 60, now });
    for (const raw of [null, undefined, '', 'f1', '{roto', '[]', '{}',
      JSON.stringify({ ...record, userId: '' }),
      JSON.stringify({ ...record, familyId: undefined }),
      JSON.stringify({ ...record, expiresAt: 'mañana' })]) {
      assert.equal(parseRefreshRecord(raw), null, String(raw));
    }
  });

  test('isRefreshRecordLive: vigente antes de expiresAt, vencido desde ese instante', () => {
    const record = newRefreshRecord({ userId: 'u1', familyId: 'f1', ttlSeconds: 60, now });
    assert.equal(isRefreshRecordLive(record, now), true);
    assert.equal(isRefreshRecordLive(record, now + 59_999), true);
    assert.equal(isRefreshRecordLive(record, now + 60_000), false);
    assert.equal(isRefreshRecordLive(record, now + 86_400_000), false);
    assert.equal(isRefreshRecordLive(null, now), false);
  });

  test('una rotación da una vida completa nueva, no la que le quedaba al anterior', () => {
    const first = newRefreshRecord({ userId: 'u1', familyId: 'f1', ttlSeconds: 3600, now });
    const later = now + 3_000_000;
    const rotated = newRefreshRecord({ userId: 'u1', familyId: first.familyId, ttlSeconds: 3600, now: later });
    assert.equal(Date.parse(rotated.expiresAt) - later, 3_600_000);
    assert.ok(Date.parse(rotated.expiresAt) > Date.parse(first.expiresAt));
  });
});

describe('parseSpentMarker', () => {
  test('familia y usuario del token ya canjeado', () => {
    assert.deepEqual(parseSpentMarker(JSON.stringify({ familyId: 'f1', userId: 'u1' })), { familyId: 'f1', userId: 'u1' });
  });

  test('null para ausente, roto o incompleto', () => {
    for (const raw of [null, '', 'f1', '{roto', JSON.stringify({ familyId: 'f1' }), JSON.stringify({ userId: 'u1' })]) {
      assert.equal(parseSpentMarker(raw), null, String(raw));
    }
  });
});

describe('refreshGraceSeconds', () => {
  test('10 s por omisión', () => {
    assert.equal(DEFAULT_REFRESH_GRACE_SECONDS, 10);
    assert.equal(refreshGraceSeconds(undefined), 10);
    assert.equal(refreshGraceSeconds(''), 10);
  });

  test('acepta un entero no negativo; 0 desactiva la ventana', () => {
    assert.equal(refreshGraceSeconds('2'), 2);
    assert.equal(refreshGraceSeconds('30'), 30);
    assert.equal(refreshGraceSeconds('0'), 0);
  });

  test('negativos y texto usan el valor por omisión', () => {
    for (const v of ['-1', 'diez', 'NaN']) assert.equal(refreshGraceSeconds(v), 10, v);
  });
});

describe('successorRefreshToken', () => {
  test('tiene la forma de un refresh token y no es un JWT', () => {
    const next = successorRefreshToken(generateRefreshToken(), generateGraceNonce());
    assert.ok(isWellFormedRefreshToken(next));
    assert.equal(Buffer.from(next, 'base64url').length, 32);
  });

  test('el mismo token y nonce dan el mismo sucesor (la ventana de gracia lo reentrega)', () => {
    const token = generateRefreshToken();
    const nonce = generateGraceNonce();
    assert.equal(successorRefreshToken(token, nonce), successorRefreshToken(token, nonce));
  });

  test('otro nonce u otro token dan otro sucesor; el sucesor no es el token ni el nonce', () => {
    const token = generateRefreshToken();
    const nonce = generateGraceNonce();
    const next = successorRefreshToken(token, nonce);
    assert.notEqual(successorRefreshToken(token, generateGraceNonce()), next);
    assert.notEqual(successorRefreshToken(generateRefreshToken(), nonce), next);
    assert.notEqual(next, token);
    assert.notEqual(next, nonce);
  });

  test('el nonce son 256 bits aleatorios', () => {
    const nonces = new Set(Array.from({ length: 100 }, generateGraceNonce));
    assert.equal(nonces.size, 100);
    for (const n of nonces) assert.equal(Buffer.from(n, 'base64url').length, 32);
  });
});

describe('registro de gracia', () => {
  const fields = { userId: 'u1', familyId: 'f1', jti: 'j1', iat: 1_763_000_000, nonce: 'n1' };

  test('solo lo necesario para repetir el resultado: ni el token ni el sucesor', () => {
    const token = generateRefreshToken();
    const nonce = generateGraceNonce();
    const record = newGraceRecord({ ...fields, nonce });
    assert.deepEqual(Object.keys(record).sort(), ['familyId', 'iat', 'jti', 'nonce', 'userId']);
    const text = JSON.stringify(record);
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(successorRefreshToken(token, nonce)));
  });

  test('parseGraceRecord: ida y vuelta por JSON', () => {
    assert.deepEqual(parseGraceRecord(JSON.stringify(newGraceRecord(fields))), fields);
  });

  test('parseGraceRecord: null para ausente, roto o incompleto', () => {
    for (const raw of [null, undefined, '', '{roto', '{}',
      JSON.stringify({ ...fields, nonce: '' }),
      JSON.stringify({ ...fields, jti: undefined }),
      JSON.stringify({ ...fields, iat: '1763000000' }),
      JSON.stringify({ ...fields, iat: 1.5 })]) {
      assert.equal(parseGraceRecord(raw), null, String(raw));
    }
  });
});

describe('refreshUnavailableService (canje con Neo4j caído)', () => {
  test('un acceso degradado no se canjea: SERVICE_UNAVAILABLE de RBAC, el token queda sin gastar', () => {
    assert.equal(refreshUnavailableService({ role: 'STAFF', permissions: [], storeIds: [], degraded: true }), 'RBAC');
  });

  test('con el acceso leído de Neo4j se canjea, aunque no tenga permisos (un cliente)', () => {
    assert.equal(refreshUnavailableService({ role: 'CUSTOMER', permissions: [], storeIds: [], degraded: false }), null);
    assert.equal(refreshUnavailableService({ role: 'ADMIN', permissions: ['users:manage'], storeIds: [] }), null);
  });
});
