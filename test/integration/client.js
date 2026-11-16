// Cliente GraphQL de las pruebas: todo pasa por el gateway de pruebas (run.js
// define IT_GATEWAY_URL). Ayudas para crear datos propios en cada prueba.

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';

const GATEWAY = process.env.IT_GATEWAY_URL;
if (!GATEWAY) throw new Error('Run these tests with `npm run test:integration` (IT_GATEWAY_URL is not set).');

export const JWT_SECRET = process.env.IT_JWT_SECRET;

// Usuarios del seed (README, sección 11).
export const SEED_USERS = {
  ADMIN: { email: 'admin@carnyfrut.mx', password: 'Admin1234' },
  MANAGER: { email: 'gerente@carnyfrut.mx', password: 'Manager1234' },
  STAFF: { email: 'empleado@carnyfrut.mx', password: 'Staff1234' },
  DELIVERY: { email: 'repartidor@carnyfrut.mx', password: 'Delivery1234' },
  CUSTOMER: { email: 'cliente@demo.mx', password: 'Cliente1234' },
};

export const uid = () => randomBytes(4).toString('hex');
export const today = () => new Date().toISOString().slice(0, 10);

export async function gql(query, variables = {}, token) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'pickaroo-integration-tests',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// La operación debe salir bien: devuelve data.
export async function ok(query, variables, token) {
  const res = await gql(query, variables, token);
  if (res.errors?.length) throw new Error(`Unexpected GraphQL error: ${JSON.stringify(res.errors)}`);
  return res.data;
}

// La operación debe fallar con `code`: devuelve extensions del primer error.
export async function fails(code, query, variables, token) {
  const res = await gql(query, variables, token);
  assert.ok(res.errors?.length, `expected ${code}, got data ${JSON.stringify(res.data)}`);
  assert.equal(res.errors[0].extensions?.code, code, `expected ${code}: ${JSON.stringify(res.errors[0])}`);
  return res.errors[0].extensions;
}

// FORBIDDEN con su regla (extensions.reason).
export async function forbidden(reason, query, variables, token) {
  const ext = await fails('FORBIDDEN', query, variables, token);
  assert.equal(ext.reason, reason);
  return ext;
}

// ---------- Sesiones ----------
export const decodeJwt = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

export function signJwt(payload, secret) {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

// La limpieza borra las sesiones por jti (además del índice user:<id>:sessions).
function recordJti(token) {
  if (process.env.IT_JTI_FILE) fs.appendFileSync(process.env.IT_JTI_FILE, `${decodeJwt(token).jti}\n`);
}

const LOGIN = `mutation Login($input: LoginInput!) {
  login(input: $input) {
    token
    user { id email role }
    access { role permissions degraded stores { id name } }
    menu { id children { id } }
  }
}`;

export async function login(email, password) {
  const { login: payload } = await ok(LOGIN, { input: { email, password } });
  recordJti(payload.token);
  return payload;
}

const roleSessions = new Map();
// Sesión de un usuario del seed, una por rol y por archivo de pruebas.
export async function session(role) {
  if (!roleSessions.has(role)) roleSessions.set(role, login(SEED_USERS[role].email, SEED_USERS[role].password));
  return roleSessions.get(role);
}
export const tokenOf = async role => (await session(role)).token;

// Cliente nuevo (registro abierto) con su sesión: cada prueba que compra usa el suyo.
export async function newCustomer() {
  const email = `it-${uid()}@pickaroo.test`;
  const password = 'Prueba1234';
  const { createUser } = await ok(`mutation($input: CreateUserInput!) { createUser(input: $input) { id email role } }`, {
    input: { name: `Cliente IT ${uid()}`, email, password },
  });
  const { token } = await login(email, password);
  return { id: createUser.id, email, password, token };
}

// Usuario con un rol de personal, creado por el administrador.
export async function newUser(role) {
  const email = `it-${role.toLowerCase()}-${uid()}@pickaroo.test`;
  const password = 'Prueba1234';
  const { createUser } = await ok(`mutation($input: CreateUserInput!) { createUser(input: $input) { id role } }`, {
    input: { name: `${role} IT ${uid()}`, email, password, role },
  }, await tokenOf('ADMIN'));
  return { id: createUser.id, email, password };
}

// ---------- Catálogo propio de cada prueba ----------
let categoryId = null;
async function abarrotes() {
  if (!categoryId) categoryId = (await ok('{ categories { id name } }')).categories.find(c => c.name === 'Abarrotes').id;
  return categoryId;
}

export const PRODUCT_FIELDS = 'id name price stock isActive effectivePrice activeDiscountPercent';

export async function newProduct({ price = 100, stock = 10, unit = 'UNIDAD' } = {}) {
  const { createProduct } = await ok(`mutation($input: ProductInput!) { createProduct(input: $input) { ${PRODUCT_FIELDS} } }`, {
    input: { categoryId: await abarrotes(), name: `Producto IT ${uid()}`, price, stock, unit },
  }, await tokenOf('ADMIN'));
  return createProduct;
}

export async function newPackage(items, price = 150) {
  const { createPackage } = await ok(`mutation($input: PackageInput!) { createPackage(input: $input) { id name price availableStock } }`, {
    input: { name: `Paquete IT ${uid()}`, price, items },
  }, await tokenOf('ADMIN'));
  return createPackage;
}

export async function stockOf(productId) {
  return (await ok('query($id: ID!) { product(id: $id) { stock } }', { id: productId })).product.stock;
}

let centro = null;
export async function seedStore() {
  if (!centro) centro = (await ok('{ stores { id name deliveryFee freeDeliveryThreshold } }')).stores.find(s => s.name === 'CARNYFRUT Centro');
  return centro;
}

// ---------- Órdenes ----------
export const ORDER_FIELDS = 'id number status mode total deliveryFee subtotal store { id } user { id }';

export const ADDRESS = { street: 'Calle de Prueba 1', city: 'Chihuahua', state: 'Chihuahua', zipCode: '31000' };

export async function createOrder(customer, { items, mode = 'PICKUP', storeId, idempotencyKey, address } = {}) {
  const input = {
    userId: customer.id, mode, items,
    storeId: storeId ?? (await seedStore()).id,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(mode === 'DELIVERY' ? { address: address ?? ADDRESS } : {}),
  };
  return (await ok(`mutation($input: CreateOrderInput!) { createOrder(input: $input) { ${ORDER_FIELDS} } }`, { input }, customer.token)).createOrder;
}

export const UPDATE_STATUS = `mutation($id: ID!, $status: OrderStatus!) { updateOrderStatus(id: $id, status: $status) { id status } }`;

export async function moveOrder(orderId, statuses, token) {
  for (const status of statuses) {
    const { updateOrderStatus } = await ok(UPDATE_STATUS, { id: orderId, status }, token);
    assert.equal(updateOrderStatus.status, status);
  }
}

// La bitácora es asíncrona (RabbitMQ → ScyllaDB): se consulta hasta que aparece.
export async function eventually(fn, { timeout = 30_000, interval = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out after ${timeout / 1000}s waiting for ${what}`);
}
