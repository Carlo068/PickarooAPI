// Autenticación: login por rol (permisos y menú), credenciales inválidas,
// `me`, logout y tokens vencidos o falsificados (README, sección 2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SEED_USERS, JWT_SECRET, ok, fails, login, decodeJwt, signJwt, uid } from './client.js';

const ME = '{ me { id email role } }';

const CUSTOMER_MENU = ['tienda:catalogo,carrito,mis-pedidos,mis-listas'];
const EXPECTED = {
  CUSTOMER: { permissions: [], menu: CUSTOMER_MENU },
  STAFF: {
    permissions: ['orders:prepare', 'stock:manage'],
    menu: [...CUSTOMER_MENU, 'sucursal:pedidos-sucursal,inventario'],
  },
  DELIVERY: {
    permissions: ['orders:deliver'],
    menu: [...CUSTOMER_MENU, 'reparto:entregas'],
  },
  MANAGER: {
    permissions: ['catalog:manage', 'orders:prepare', 'reports:view', 'stock:manage'],
    menu: [...CUSTOMER_MENU, 'sucursal:pedidos-sucursal,inventario', 'administracion:productos,reportes'],
  },
  ADMIN: {
    permissions: ['audit:view', 'catalog:manage', 'orders:deliver', 'orders:prepare', 'reports:view', 'scope:all_stores', 'stock:manage', 'stores:manage', 'users:manage'],
    menu: [...CUSTOMER_MENU, 'sucursal:pedidos-sucursal,inventario', 'reparto:entregas', 'administracion:productos,reportes,sucursales,usuarios,auditoria'],
  },
};

const menuIds = menu => menu.map(m => `${m.id}:${m.children.map(c => c.id).join(',')}`);

for (const [role, expected] of Object.entries(EXPECTED)) {
  test(`login as ${role} returns its effective permissions and menu`, async () => {
    const { email, password } = SEED_USERS[role];
    const payload = await login(email, password);
    assert.ok(payload.token);
    assert.equal(payload.user.role, role);
    assert.equal(payload.access.role, role);
    assert.equal(payload.access.degraded, false);
    assert.deepEqual(payload.access.permissions, expected.permissions);
    assert.deepEqual(menuIds(payload.menu), expected.menu);
    // El personal de mostrador y reparto está asignado a la sucursal del seed; ADMIN y el cliente no.
    const stores = payload.access.stores.map(s => s.name);
    assert.deepEqual(stores, ['STAFF', 'DELIVERY', 'MANAGER'].includes(role) ? ['CARNYFRUT Centro'] : []);
  });
}

test('a wrong password and an unknown email both give INVALID_CREDENTIALS', async () => {
  const LOGIN = 'mutation($input: LoginInput!) { login(input: $input) { token } }';
  await fails('INVALID_CREDENTIALS', LOGIN, { input: { email: SEED_USERS.ADMIN.email, password: 'NoEsLaClave1' } });
  await fails('INVALID_CREDENTIALS', LOGIN, { input: { email: `nadie-${uid()}@pickaroo.test`, password: 'Cualquiera1' } });
});

test('me needs a token and returns the session user', async () => {
  await fails('UNAUTHENTICATED', ME);
  const { token, user } = await login(SEED_USERS.CUSTOMER.email, SEED_USERS.CUSTOMER.password);
  const { me } = await ok(ME, {}, token);
  assert.deepEqual(me, { id: user.id, email: SEED_USERS.CUSTOMER.email, role: 'CUSTOMER' });
});

test('logout revokes the token immediately', async () => {
  const { token } = await login(SEED_USERS.STAFF.email, SEED_USERS.STAFF.password);
  assert.ok((await ok(ME, {}, token)).me);
  assert.equal((await ok('mutation { logout }', {}, token)).logout, true);
  await fails('UNAUTHENTICATED', ME, {}, token);
  await fails('UNAUTHENTICATED', 'mutation { logout }', {}, token);
});

test('an expired token and a forged token give UNAUTHENTICATED', async () => {
  const { token } = await login(SEED_USERS.MANAGER.email, SEED_USERS.MANAGER.password);
  const claims = decodeJwt(token);

  // Control: el mismo contenido firmado con el secreto de la pila sí se acepta (la sesión sigue viva).
  assert.ok((await ok(ME, {}, signJwt(claims, JWT_SECRET))).me);

  const now = Math.floor(Date.now() / 1000);
  const expired = signJwt({ ...claims, iat: now - 7200, exp: now - 3600 }, JWT_SECRET);
  await fails('UNAUTHENTICATED', ME, {}, expired);

  const forged = signJwt({ ...claims, role: 'ADMIN' }, randomBytes(32).toString('hex'));
  await fails('UNAUTHENTICATED', ME, {}, forged);
  await fails('UNAUTHENTICATED', ME, {}, 'no-es-un-jwt');
});
