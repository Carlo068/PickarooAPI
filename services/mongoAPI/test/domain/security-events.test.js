// Telemetría de seguridad (CWE-532): el recorte de datos sensibles de events.js y los cuatro eventos
// LOGIN_FAILED, LOGIN_SUCCESS, USER_REGISTERED y ROLE_CHANGED armados con las mismas fábricas
// que usan auth.js e index.js, pasados por buildEventMessage (lo que emitEvent publica).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEventMessage, scrubMetadata, scrubText, isSensitiveKey, REDACTED } from '../../src/infrastructure/events.js';
import {
  loginFailedEvent, loginSuccessEvent, userRegisteredEvent, roleChangedEvent, MAX_EMAIL_LENGTH,
} from '../../src/infrastructure/security-events.js';
import { hashPassword } from '../../src/infrastructure/passwords.js';

const PASSWORD = 'Sup3r-Secreta-Contraseña!';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLWFiY2RlZg';
const REFRESH = 'A'.repeat(20) + 'b-_'.repeat(5) + 'Z1234567';
const HASH = hashPassword(PASSWORD);

const ctx = { ip: '203.0.113.7', userAgent: 'prueba', currentUser: null };

describe('scrubMetadata', () => {
  test('quita las claves sensibles a cualquier profundidad (también en arreglos), sin importar mayúsculas', () => {
    const clean = scrubMetadata({
      email: 'a@b.mx', password: 'x', Password: 'x', newPassword: 'x', passwordHash: 'x', hash: 'x',
      token: 'x', accessToken: 'x', refreshToken: 'x', refresh: 'x', secret: 'x', clientSecret: 'x',
      authorization: 'Bearer x', Authorization: 'x', jwt: 'x',
      nested: { deep: { apiToken: 'x', ok: 1 } },
      list: [{ password: 'x', n: 1 }, 'texto'],
    });
    assert.deepEqual(clean, { email: 'a@b.mx', nested: { deep: { ok: 1 } }, list: [{ n: 1 }, 'texto'] });
  });

  test('conserva los identificadores jti y familyId (y el conteo refreshFamilies)', () => {
    const meta = { jti: 'abc', familyId: 'def', refreshFamilies: 2, revoked: 1 };
    assert.deepEqual(scrubMetadata(meta), meta);
    assert.equal(isSensitiveKey('jti'), false);
    assert.equal(isSensitiveKey('familyId'), false);
    assert.equal(isSensitiveKey('refreshTokenId'), true);
  });

  test('tacha valores con forma de credencial aunque la clave sea inocente', () => {
    const clean = scrubMetadata({ note: `usó ${JWT} ayer`, raw: REFRESH, stored: HASH, header: JWT });
    assert.equal(clean.note, `usó ${REDACTED} ayer`);
    assert.equal(clean.raw, REDACTED);
    assert.equal(clean.stored, REDACTED);
    assert.equal(clean.header, REDACTED);
  });

  test('no toca números, booleanos, null, fechas ni textos normales, y no modifica el original', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const input = { n: 1, ok: true, nothing: null, date, text: 'Rol CUSTOMER → ADMIN', changes: { price: { from: 1, to: 2 } } };
    const snapshot = structuredClone(input);
    const clean = scrubMetadata(input);
    assert.deepEqual(clean, snapshot);
    assert.equal(clean.date, date);
    assert.deepEqual(input, snapshot);
  });

  test('un cambio de un campo sensible en un diff (campo: { from, to }) no se publica', () => {
    assert.deepEqual(scrubMetadata({ changes: { passwordHash: { from: 'a', to: 'b' }, name: { from: 'x', to: 'y' } } }), { changes: { name: { from: 'x', to: 'y' } } });
  });

  test('un objeto circular o absurdamente profundo no cuelga ni lanza', () => {
    const loop = { a: 1 };
    loop.self = loop;
    assert.doesNotThrow(() => JSON.stringify(scrubMetadata(loop)));
  });

  test('scrubText deja pasar lo que no es texto', () => {
    assert.equal(scrubText(undefined), undefined);
    assert.equal(scrubText(3), 3);
  });
});

describe('los cuatro eventos de seguridad', () => {
  const user = { _id: { toString: () => '64b000000000000000000001', toJSON: () => '64b000000000000000000001' }, email: 'ana@demo.mx', role: 'CUSTOMER' };
  const access = { role: 'ADMIN', permissions: ['a', 'b', 'c'], storeIds: ['s1'], degraded: false };

  // Eventos tal como los arma auth.js / index.js, con datos hostiles a mano por si alguien los pasara.
  const built = {
    LOGIN_FAILED: [
      loginFailedEvent({ user, valid: false, email: 'ana@demo.mx' }),
      loginFailedEvent({ user: null, valid: false, email: 'nadie@demo.mx' }),
      loginFailedEvent({ user: { ...user, isActive: false, passwordHash: HASH }, valid: true, email: 'ana@demo.mx' }),
    ],
    LOGIN_SUCCESS: [loginSuccessEvent({ userId: '64b000000000000000000001', access, jti: 'jti-1', familyId: 'fam-1' })],
    USER_REGISTERED: [
      userRegisteredEvent({ user: { ...user, passwordHash: HASH }, role: 'CUSTOMER' }),
      userRegisteredEvent({ user, role: 'MANAGER', admin: { id: 'adm1', role: 'ADMIN' } }),
    ],
    ROLE_CHANGED: [roleChangedEvent({ previous: 'CUSTOMER', role: 'MANAGER' })],
  };

  test('los nombres de tipo son exactamente los del enunciado', () => {
    assert.deepEqual(Object.keys(built), ['LOGIN_FAILED', 'LOGIN_SUCCESS', 'USER_REGISTERED', 'ROLE_CHANGED']);
    for (const [type, events] of Object.entries(built)) for (const e of events) assert.equal(e.type, type);
  });

  test('categorías: login en SECURITY; alta y cambio de rol en ADMIN', () => {
    assert.equal(built.LOGIN_FAILED[0].category, 'SECURITY');
    assert.equal(built.LOGIN_SUCCESS[0].category, 'SECURITY');
    assert.equal(built.USER_REGISTERED[0].category, 'ADMIN');
    assert.equal(built.ROLE_CHANGED[0].category, 'ADMIN');
  });

  test('LOGIN_FAILED: falla (success false), motivo fijo y sin la contraseña enviada', () => {
    const [wrongPassword, unknown, inactive] = built.LOGIN_FAILED.map(e => buildEventMessage(e, ctx));
    assert.equal(wrongPassword.success, false);
    assert.equal(wrongPassword.reason, 'Contraseña incorrecta');
    assert.equal(wrongPassword.actorId, '64b000000000000000000001');
    assert.equal(unknown.reason, 'Correo no registrado');
    assert.equal(unknown.actorId, 'ANONYMOUS');
    assert.equal(inactive.reason, 'Cuenta desactivada');
    assert.deepEqual(wrongPassword.metadata, { email: 'ana@demo.mx' });
  });

  test('LOGIN_SUCCESS lleva identificadores y conteos, no credenciales', () => {
    const msg = buildEventMessage(built.LOGIN_SUCCESS[0], ctx);
    assert.deepEqual(msg.metadata, { jti: 'jti-1', familyId: 'fam-1', permissions: 3, stores: 1 });
    assert.equal(msg.actorRole, 'ADMIN');
    assert.equal(msg.success, true);
  });

  test('USER_REGISTERED: registro abierto (el propio usuario) o alta de un administrador', () => {
    const [open, byAdmin] = built.USER_REGISTERED.map(e => buildEventMessage(e, ctx));
    assert.equal(open.reason, 'Registro abierto');
    assert.equal(open.actorId, '64b000000000000000000001');
    assert.equal(byAdmin.reason, 'Alta hecha por un administrador');
    assert.equal(byAdmin.actorId, 'adm1');
    assert.deepEqual(open.metadata, { email: 'ana@demo.mx', role: 'CUSTOMER' });
    assert.equal(open.targetType, 'User');
  });

  test('ROLE_CHANGED: de qué rol a cuál', () => {
    const msg = buildEventMessage({ ...built.ROLE_CHANGED[0], targetType: 'User', targetId: 'u1' }, { ...ctx, currentUser: { id: 'adm1', role: 'ADMIN' } });
    assert.equal(msg.reason, 'Rol CUSTOMER → MANAGER');
    assert.deepEqual(msg.metadata, { from: 'CUSTOMER', to: 'MANAGER' });
    assert.equal(msg.actorId, 'adm1');
    assert.equal(msg.targetId, 'u1');
  });

  test('el JSON publicado no contiene claves ni valores sensibles', () => {
    const everything = Object.values(built).flat().map(e => buildEventMessage(e, ctx));
    const json = JSON.stringify(everything);
    for (const secret of [PASSWORD, JWT, REFRESH, HASH, 'scrypt$']) assert.ok(!json.includes(secret), `no debe aparecer ${secret.slice(0, 12)}…`);
    assert.doesNotMatch(json, /"(\w*)(pass(word)?|token|secret|hash|authorization|jwt|refresh)(\w*)":/i);
  });

  test('aunque alguien meta secretos en un evento, buildEventMessage los quita (defensa en profundidad)', () => {
    const msg = buildEventMessage({
      ...built.LOGIN_FAILED[0],
      reason: `falló con ${JWT}`,
      metadata: { email: 'ana@demo.mx', password: PASSWORD, passwordHash: HASH, token: JWT, refreshToken: REFRESH, jti: 'ok', extra: { authorization: `Bearer ${JWT}` } },
    }, ctx);
    const json = JSON.stringify(msg);
    for (const secret of [PASSWORD, JWT, REFRESH, HASH]) assert.ok(!json.includes(secret));
    assert.deepEqual(msg.metadata, { email: 'ana@demo.mx', jti: 'ok', extra: {} });
    assert.equal(msg.reason, `falló con ${REDACTED}`);
  });
});

describe('texto hostil', () => {
  const timed = fn => { const t = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };

  test('un texto adversarial de 200 KB se limpia en bien menos de 100 ms (sin retroceso cuadrático)', () => {
    const attacks = [
      'eyJ'.repeat(70_000), 'eyJ' + 'a'.repeat(200_000), 'eyJaaaaaa.'.repeat(20_000), 'eyJ' + 'a.'.repeat(100_000),
      'scrypt$' + 'a'.repeat(200_000), 'A'.repeat(200_000), 'eyJ-'.repeat(50_000) + '!',
    ];
    for (const text of attacks) {
      const { out, ms } = timed(() => scrubText(text));
      assert.ok(ms < 100, `scrubText tardó ${ms.toFixed(1)} ms`);
      assert.ok(out.length <= 512);
    }
  });

  test('el mismo texto como correo de un login fallido, motivo, ip o user-agent también es barato y queda truncado', () => {
    const text = 'eyJ'.repeat(70_000);
    const { out: msg, ms } = timed(() => buildEventMessage({
      ...loginFailedEvent({ user: null, valid: false, email: text }), reason: text, metadata: { note: text, deep: [text] },
    }, { ip: text, userAgent: text }));
    assert.ok(ms < 100, `buildEventMessage tardó ${ms.toFixed(1)} ms`);
    assert.ok(JSON.stringify(msg).length < 4000);
    assert.ok(msg.ip.length <= 256 && msg.userAgent.length <= 256);
  });

  test('un JWT cortado a medias por el truncado también se tacha', () => {
    const half = JWT.slice(0, 60);
    assert.equal(scrubText(`x ${half}`), `x ${REDACTED}`);
    assert.equal(scrubText(JWT.slice(0, JWT.lastIndexOf('.') + 1)), REDACTED);
  });

  test('ip y user-agent llevan el mismo recorte de credenciales', () => {
    const msg = buildEventMessage({ type: 'X', category: 'SECURITY' }, { ip: '1.2.3.4', userAgent: `curl ${JWT}` });
    assert.equal(msg.ip, '1.2.3.4');
    assert.equal(msg.userAgent, `curl ${REDACTED}`);
    assert.equal(buildEventMessage({ type: 'X', category: 'SECURITY' }, {}).ip, null);
  });

  test('un correo sin @ (casi seguro una contraseña en el campo equivocado) no se guarda; los normales sí', () => {
    assert.deepEqual(loginFailedEvent({ user: null, valid: false, email: 'Mi-Clave-123' }).metadata, { email: '[invalid-email]' });
    assert.deepEqual(loginFailedEvent({ user: null, valid: false, email: '' }).metadata, { email: '[invalid-email]' });
    assert.deepEqual(loginFailedEvent({ user: null, valid: false, email: 'ana@demo.mx' }).metadata, { email: 'ana@demo.mx' });
    assert.equal(loginFailedEvent({ user: null, valid: false, email: `a@${'b'.repeat(1000)}` }).metadata.email.length, MAX_EMAIL_LENGTH);
  });
});
