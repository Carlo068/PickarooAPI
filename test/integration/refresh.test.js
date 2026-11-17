// Refresh tokens (README, sección 2, "Autenticación"): rotación, ventana de
// gracia, reutilización, canjes simultáneos, vencimiento, cierre de sesión por
// dispositivo y en todos, y revocación por cambios de acceso. La pila de pruebas
// usa un REFRESH_TTL_SECONDS y un REFRESH_REUSE_GRACE_SECONDS cortos (stack.js)
// para probar el vencimiento y lo que pasa después de la ventana.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, fails, gql, login, refresh, refreshRaw, REFRESH, newCustomer, newUser, tokenOf, seedStore, eventually, decodeJwt,
} from './client.js';
import { loadConfig, withNeo4j } from './stack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'services', 'mongoAPI', 'package.json'));
const { createClient } = require('redis');
const mongoose = require('mongoose');

const ME = '{ me { id } }';
const MY_ACCESS = '{ myAccess { role permissions } }';
const LOGOUT = 'mutation($refreshToken: String) { logout(refreshToken: $refreshToken) }';
const AUDIT_BY_ACTOR = 'query($id: ID!) { auditByActor(actorId: $id, limit: 50) { type category success reason metadata } }';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { refreshGraceSeconds } = loadConfig();
// Espera a que venza la ventana de gracia (el TTL de refresh:grace:<hash>).
const outlastGrace = () => sleep(refreshGraceSeconds * 1000 + 1000);

const invalidRefresh = token => fails('INVALID_REFRESH_TOKEN', REFRESH, { token });
const reusedRefresh = token => fails('REFRESH_TOKEN_REUSED', REFRESH, { token });
const unauthenticated = token => fails('UNAUTHENTICATED', ME, {}, token);
const sha256 = token => createHash('sha256').update(token).digest('hex');

async function newSignedInCustomer() {
  const customer = await newCustomer();
  const payload = await login(customer.email, customer.password);
  return { ...customer, payload };
}

// Redis de la API de pruebas (base lógica 1, nunca la del dev).
async function withRedis(fn) {
  const redis = createClient({ url: process.env.IT_REDIS_URL });
  redis.on('error', () => {});
  await redis.connect();
  try { return await fn(redis); } finally { await redis.quit(); }
}

const familyOf = async refreshToken => withRedis(async redis => JSON.parse(await redis.get(`refresh:${sha256(refreshToken)}`)).familyId);

// Eventos de bitácora de un usuario, cuando ya aparece uno que cumple `wanted`.
async function auditEventsOf(userId, wanted, what) {
  const admin = await tokenOf('ADMIN');
  return eventually(async () => {
    const { auditByActor } = await ok(AUDIT_BY_ACTOR, { id: userId }, admin);
    return auditByActor.some(wanted) ? auditByActor : null;
  }, { what: `${what} for ${userId}` });
}
const metadataOf = event => JSON.parse(event.metadata ?? '{}');

test('login returns an opaque refresh token and its lifetime', async () => {
  const { payload } = await newSignedInCustomer();
  assert.match(payload.refreshToken, /^[A-Za-z0-9_-]{43}$/); // 256 bits en base64url, no un JWT
  assert.ok(payload.refreshExpiresIn > 0);
  assert.equal(payload.expiresIn, 3600); // la sesión del JWT no cambia
  assert.notEqual(payload.refreshToken, payload.token);
});

test('refresh returns a working access token and a new refresh token; the old access token keeps working', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);

  assert.notEqual(second.token, first.token);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.notEqual(decodeJwt(second.token).jti, decodeJwt(first.token).jti);
  assert.equal(second.user.id, customer.id);
  assert.equal(second.access.role, 'CUSTOMER');
  assert.equal(second.refreshExpiresIn, first.refreshExpiresIn); // vida completa nueva, no la restante
  assert.equal((await ok(ME, {}, second.token)).me.id, customer.id);

  // El token de acceso anterior sigue sirviendo hasta que vence o se cierra su sesión.
  assert.equal((await ok(ME, {}, first.token)).me.id, customer.id);
  await ok('mutation { logout }', {}, first.token);
  await unauthenticated(first.token);
  assert.equal((await ok(ME, {}, second.token)).me.id, customer.id);

  // La cadena sigue: el token nuevo también se canjea.
  const third = await refresh(second.refreshToken);
  assert.equal((await ok(ME, {}, third.token)).me.id, customer.id);
});

test('within the grace window, retrying with the just-spent token returns the identical result and keeps the family', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);
  // La respuesta "se perdió": el cliente reintenta con el token que ya se canjeó.
  const retry = await refresh(first.refreshToken);

  assert.equal(retry.refreshToken, second.refreshToken, 'same successor, not a new one');
  assert.equal(retry.token, second.token, 'same access token (same session)');
  assert.equal(decodeJwt(retry.token).jti, decodeJwt(second.token).jti);
  assert.deepEqual(retry.access, second.access);
  assert.equal(retry.user.id, customer.id);

  // La familia sigue viva: las sesiones sirven y el sucesor se canjea.
  assert.equal((await ok(ME, {}, first.token)).me.id, customer.id);
  assert.equal((await ok(ME, {}, retry.token)).me.id, customer.id);
  const third = await refresh(retry.refreshToken);
  assert.equal((await ok(ME, {}, third.token)).me.id, customer.id);

  const events = await auditEventsOf(customer.id, e => e.type === 'TOKEN_REFRESHED' && metadataOf(e).grace === true, 'TOKEN_REFRESHED (grace)');
  assert.ok(!events.some(e => e.type === 'REFRESH_REUSED'));
});

test('after the grace window, the just-spent token is reuse: the family is revoked', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);

  await outlastGrace();
  await reusedRefresh(first.refreshToken);
  await unauthenticated(second.token);
  await invalidRefresh(second.refreshToken);
});

test('within the grace window, a token two rotations old is still reuse (its successor was already spent)', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);
  const third = await refresh(second.refreshToken);

  await reusedRefresh(first.refreshToken);
  await unauthenticated(third.token);
  await invalidRefresh(third.refreshToken);
});

test('reusing a spent refresh token revokes the whole family and logs REFRESH_REUSED', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);

  await outlastGrace();
  await reusedRefresh(first.refreshToken);
  // Toda la familia: las sesiones que abrió (la del login y la del canje) y su token vigente.
  await unauthenticated(second.token);
  await unauthenticated(first.token);
  await invalidRefresh(second.refreshToken);
  // Presentarlo otra vez: la familia ya no existe, así que es solo un token inválido (sin otra alerta).
  await invalidRefresh(first.refreshToken);

  const admin = await tokenOf('ADMIN');
  const event = await eventually(async () => {
    const { auditByActor } = await ok('query($id: ID!) { auditByActor(actorId: $id, limit: 50) { type category success metadata } }', { id: customer.id }, admin);
    return auditByActor.find(e => e.type === 'REFRESH_REUSED');
  }, { what: `REFRESH_REUSED for ${customer.email}` });
  assert.equal(event.category, 'SECURITY');
  assert.equal(event.success, false);
  const metadata = JSON.parse(event.metadata);
  assert.match(metadata.familyId, /^[0-9a-f-]{36}$/);
  const text = JSON.stringify(event);
  for (const secret of [first.refreshToken, second.refreshToken]) assert.ok(!text.includes(secret), 'the audit event must not contain a token');
});

test('two concurrent refreshes with the same token: one rotation, both get the same result (grace window)', async () => {
  const customer = await newSignedInCustomer();
  const results = await Promise.all([refreshRaw(customer.payload.refreshToken), refreshRaw(customer.payload.refreshToken)]);

  assert.ok(results.every(r => r.data?.refreshToken), JSON.stringify(results));
  const [a, b] = results.map(r => r.data.refreshToken);
  assert.equal(a.refreshToken, b.refreshToken);
  assert.equal(a.token, b.token);

  // Una sola rotación: la familia sigue viva y el sucesor común se canjea.
  assert.equal((await ok(ME, {}, a.token)).me.id, customer.id);
  const next = await refresh(a.refreshToken);
  assert.equal((await ok(ME, {}, next.token)).me.id, customer.id);
});

test('an expired refresh token gives INVALID_REFRESH_TOKEN', async () => {
  const { payload } = await newSignedInCustomer();
  assert.ok(payload.refreshExpiresIn <= 30, `the test stack should use a short REFRESH_TTL_SECONDS, got ${payload.refreshExpiresIn}`);
  await sleep(payload.refreshExpiresIn * 1000 + 1500);
  await invalidRefresh(payload.refreshToken);
  // Su sesión de acceso es independiente y sigue viva (dura JWT_TTL_SECONDS).
  await ok(ME, {}, payload.token);
});

test('an unknown or malformed refresh token gives INVALID_REFRESH_TOKEN, without Authorization', async () => {
  await invalidRefresh('A'.repeat(43));
  await invalidRefresh('no-es-un-token');
  const { payload } = await newSignedInCustomer();
  await invalidRefresh(payload.token); // un JWT no es un refresh token
});

test('logout(refreshToken) revokes that device (its family) and leaves the other devices signed in', async () => {
  const customer = await newSignedInCustomer();
  const phone = await refresh(customer.payload.refreshToken); // dispositivo 1, ya rotado una vez
  const tablet = await login(customer.email, customer.password); // dispositivo 2: otra familia

  assert.equal((await ok(LOGOUT, { refreshToken: phone.refreshToken }, phone.token)).logout, true);
  await unauthenticated(phone.token);
  await unauthenticated(customer.payload.token); // la sesión del login de esa familia también
  await invalidRefresh(phone.refreshToken);

  assert.equal((await ok(ME, {}, tablet.token)).me.id, customer.id);
  const next = await refresh(tablet.refreshToken);
  assert.equal((await ok(ME, {}, next.token)).me.id, customer.id);
});

test('logout(refreshToken) ignores a refresh token of another user', async () => {
  const owner = await newSignedInCustomer();
  const other = await newSignedInCustomer();
  assert.equal((await ok(LOGOUT, { refreshToken: owner.payload.refreshToken }, other.payload.token)).logout, true);
  await unauthenticated(other.payload.token);
  // El dueño sigue con su sesión y su refresh token.
  assert.equal((await ok(ME, {}, owner.payload.token)).me.id, owner.id);
  await refresh(owner.payload.refreshToken);
});

test('logoutAllDevices revokes every session and every refresh token of the caller', async () => {
  await fails('UNAUTHENTICATED', 'mutation { logoutAllDevices }');
  const customer = await newSignedInCustomer();
  const second = await login(customer.email, customer.password);
  const rotated = await refresh(second.refreshToken);
  const bystander = await newSignedInCustomer();

  assert.equal((await ok('mutation { logoutAllDevices }', {}, customer.payload.token)).logoutAllDevices, true);
  for (const token of [customer.payload.token, second.token, rotated.token]) await unauthenticated(token);
  await invalidRefresh(customer.payload.refreshToken);
  await invalidRefresh(rotated.refreshToken);

  // Otro usuario no se ve afectado.
  assert.equal((await ok(ME, {}, bystander.payload.token)).me.id, bystander.id);
  await refresh(bystander.payload.refreshToken);
});

test('assignRole revokes the refresh tokens of the user; the next login carries the new role', async () => {
  const admin = await tokenOf('ADMIN');
  const staff = await newUser('STAFF');
  const before = await login(staff.email, staff.password);
  assert.equal(before.access.role, 'STAFF');

  await ok('mutation($u: ID!) { assignRole(userId: $u, role: DELIVERY) { role } }', { u: staff.id }, admin);
  await invalidRefresh(before.refreshToken); // no revive los permisos anteriores
  await unauthenticated(before.token);

  const after = await login(staff.email, staff.password);
  const refreshed = await refresh(after.refreshToken);
  assert.equal(refreshed.access.role, 'DELIVERY');
  assert.deepEqual(refreshed.access.permissions, ['orders:deliver']);
});

test('assignUserToStore revokes the refresh tokens of the user', async () => {
  const staff = await newUser('STAFF');
  const before = await login(staff.email, staff.password);
  await ok('mutation($u: ID!, $s: ID!) { assignUserToStore(userId: $u, storeId: $s) { role } }', { u: staff.id, s: (await seedStore()).id }, await tokenOf('ADMIN'));
  await invalidRefresh(before.refreshToken);
});

test('a refresh re-reads role and permissions from Neo4j', async () => {
  const staff = await newUser('STAFF');
  const before = await login(staff.email, staff.password);
  assert.deepEqual(before.access.permissions, ['orders:prepare', 'stock:manage']);

  // Cambio en el grafo sin assignRole (p. ej. editado a mano): no revoca nada,
  // así que el token de antes sigue con los permisos viejos y el refresh trae los nuevos.
  await withNeo4j(loadConfig(), q => q(
    `MATCH (u:User {id: $id}) MATCH (r:Role {name: 'MANAGER'})
     OPTIONAL MATCH (u)-[old:HAS_ROLE]->(:Role)
     DELETE old
     MERGE (u)-[:HAS_ROLE]->(r)`,
    { id: staff.id },
  ));
  assert.equal((await ok(MY_ACCESS, {}, before.token)).myAccess.role, 'STAFF');

  const refreshed = await refresh(before.refreshToken);
  assert.equal(refreshed.access.role, 'MANAGER');
  assert.equal(refreshed.user.role, 'MANAGER'); // el espejo en Mongo se corrige como en el login
  assert.deepEqual(refreshed.access.permissions, ['catalog:manage', 'orders:prepare', 'reports:view', 'stock:manage']);
  assert.deepEqual((await ok(MY_ACCESS, {}, refreshed.token)).myAccess, {
    role: 'MANAGER', permissions: ['catalog:manage', 'orders:prepare', 'reports:view', 'stock:manage'],
  });
});

test('refreshToken is public: an Authorization header of another user does not matter', async () => {
  const a = await newSignedInCustomer();
  const b = await newSignedInCustomer();
  const res = await gql(REFRESH, { token: a.payload.refreshToken }, b.payload.token);
  assert.equal(res.data.refreshToken.user.id, a.id);
});

test('logout(refreshToken) with an already spent token of the family also revokes that device', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);

  // El cliente pasa su token anterior (ya canjeado): se resuelve la familia por la marca de usado.
  assert.equal((await ok(LOGOUT, { refreshToken: first.refreshToken }, second.token)).logout, true);
  await unauthenticated(second.token);
  await unauthenticated(first.token);
  await invalidRefresh(second.refreshToken);
});

test('logout(refreshToken) ignores a spent token of another user', async () => {
  const owner = await newSignedInCustomer();
  const current = await refresh(owner.payload.refreshToken);
  const other = await newSignedInCustomer();

  await ok(LOGOUT, { refreshToken: owner.payload.refreshToken }, other.payload.token);
  assert.equal((await ok(ME, {}, current.token)).me.id, owner.id);
  await refresh(current.refreshToken);
});

test('a spent token of a family revoked by logout(refreshToken) is INVALID_REFRESH_TOKEN, with REFRESH_FAILED and no reuse alert', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);
  await ok(LOGOUT, { refreshToken: second.refreshToken }, second.token);

  await outlastGrace();
  await invalidRefresh(first.refreshToken);

  const events = await auditEventsOf(customer.id, e => e.type === 'REFRESH_FAILED', 'REFRESH_FAILED');
  const failed = events.find(e => e.type === 'REFRESH_FAILED');
  assert.equal(failed.category, 'SECURITY');
  assert.match(failed.reason, /familia revocada/);
  await sleep(1000); // la bitácora es asíncrona: una alerta indebida tendría tiempo de llegar
  const { auditByActor } = await ok(AUDIT_BY_ACTOR, { id: customer.id }, await tokenOf('ADMIN'));
  assert.ok(!auditByActor.some(e => e.type === 'REFRESH_REUSED'), 'signing out is not theft');
});

test('a spent token of a family revoked by logoutAllDevices is INVALID_REFRESH_TOKEN, also within the grace window', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const second = await refresh(first.refreshToken);
  await ok('mutation { logoutAllDevices }', {}, second.token);

  await invalidRefresh(first.refreshToken); // dentro de la ventana: el sucesor ya no existe
  await outlastGrace();
  await invalidRefresh(first.refreshToken); // fuera de ella: la familia ya no existe
});

test('a deactivated user cannot refresh: INVALID_REFRESH_TOKEN', async () => {
  const customer = await newSignedInCustomer();
  const conn = await mongoose.createConnection(process.env.IT_MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    assert.match(conn.db.databaseName, /_it$/, 'only the test database');
    const { matchedCount } = await conn.db.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(customer.id) }, { $set: { isActive: false } });
    assert.equal(matchedCount, 1);
  } finally {
    await conn.close();
  }
  await invalidRefresh(customer.payload.refreshToken);
});

test('every key written by login and by a rotation has a TTL', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const familyId = await familyOf(first.refreshToken);
  const userKeys = [`user:${customer.id}:sessions`, `user:${customer.id}:refresh-families`];
  const familyKeys = [`refresh-family:${familyId}`, `refresh-family:${familyId}:sessions`];

  const ttls = keys => withRedis(redis => Promise.all(keys.map(async key => [key, await redis.ttl(key)])));
  const assertTtls = async keys => {
    for (const [key, ttl] of await ttls(keys)) assert.ok(ttl > 0, `${key} has TTL ${ttl} (-1 = none, -2 = missing)`);
  };

  await assertTtls([`session:${decodeJwt(first.token).jti}`, `refresh:${sha256(first.refreshToken)}`, ...familyKeys, ...userKeys]);

  const second = await refresh(first.refreshToken);
  const spent = sha256(first.refreshToken);
  await assertTtls([
    `session:${decodeJwt(second.token).jti}`, `refresh:${sha256(second.refreshToken)}`,
    `refresh:spent:${spent}`, `refresh:grace:${spent}`, ...familyKeys, ...userKeys,
  ]);
  const [[, graceTtl]] = await ttls([`refresh:grace:${spent}`]);
  assert.ok(graceTtl <= refreshGraceSeconds, `the grace record lives at most the window (${graceTtl}s)`);
});

test('a session revoked through family reuse is also rejected by auditAPI', async () => {
  const admin = await newUser('ADMIN');
  const first = await login(admin.email, admin.password);
  const second = await refresh(first.refreshToken);
  const AUDIT = 'query($id: ID!) { auditByActor(actorId: $id, limit: 1) { type } }';
  await ok(AUDIT, { id: admin.id }, second.token); // auditAPI acepta la sesión

  await outlastGrace();
  await reusedRefresh(first.refreshToken);
  for (const token of [first.token, second.token]) await fails('UNAUTHENTICATED', AUDIT, { id: admin.id }, token);
});

test('a rotation prunes jtis of expired sessions from the family set and keeps the live ones', async () => {
  const customer = await newSignedInCustomer();
  const first = customer.payload;
  const familyId = await familyOf(first.refreshToken);
  const members = `refresh-family:${familyId}:sessions`;
  const stale = '00000000-0000-4000-8000-000000000000'; // sesión que ya venció: no hay session:<jti>
  await withRedis(redis => redis.multi().sAdd(members, stale).sAdd(`user:${customer.id}:sessions`, stale).exec());

  const second = await refresh(first.refreshToken);
  const [family, user] = await withRedis(redis => Promise.all([redis.sMembers(members), redis.sMembers(`user:${customer.id}:sessions`)]));
  assert.deepEqual(family.sort(), [decodeJwt(first.token).jti, decodeJwt(second.token).jti].sort());
  assert.ok(!user.includes(stale));
});

test('a stale family pointer: the rotate script answers INVALID and consumes the token', async () => {
  const { payload } = await newSignedInCustomer();
  const familyId = await familyOf(payload.refreshToken);
  // El puntero de la familia ya no apunta a este token (estado que no debería ocurrir).
  await withRedis(redis => redis.set(`refresh-family:${familyId}`, '0'.repeat(64), { expiration: { type: 'EX', value: 60 } }));

  await invalidRefresh(payload.refreshToken);
  assert.equal(await withRedis(redis => redis.exists(`refresh:${sha256(payload.refreshToken)}`)), 0, 'consumed');
  assert.equal(await withRedis(redis => redis.exists(`refresh:spent:${sha256(payload.refreshToken)}`)), 0, 'no spent marker');
  await invalidRefresh(payload.refreshToken); // sin marca de usado: no es reutilización
});
