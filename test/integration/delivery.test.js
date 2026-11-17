// Reparto (PIC-76, README sección 6 "Reparto"): entregas disponibles, aceptar
// (atómico, una entrega activa por repartidor), liberar, la ruta solo del
// repartidor asignado, sus vistas (myDeliveries, currentDelivery) y lo que ve el
// rol DELIVERY en `orders`.
// Cada prueba usa repartidores propios (newDriver): uno con una entrega activa
// no puede aceptar otra, así que compartir el del seed acoplaría las pruebas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, gql, fails, forbidden, tokenOf, login, newCustomer, newProduct, newStore, newDriver, newStoreUser, seedStore, huertaStore,
  createOrder, moveOrder, acceptDelivery, eventually, UPDATE_STATUS, ACCEPT_DELIVERY,
} from './client.js';

const MONGO_API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'mongoAPI');
const mongoose = createRequire(path.join(MONGO_API, 'package.json'))('mongoose');
const INDEX = 'one_active_delivery_per_driver';

// Acceso directo a la colección orders de pickaroodb_it (índices e invariantes).
async function withOrders(fn) {
  const conn = await mongoose.createConnection(process.env.IT_MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    return await fn(conn.db.collection('orders'));
  } finally {
    await conn.close();
  }
}

const FIELDS = 'id number status mode assignedAt driver { id name } store { id }';
const AVAILABLE = `query($s: ID) { availableDeliveries(storeId: $s, limit: 100) { ${FIELDS} createdAt } }`;
const RELEASE = `mutation($id: ID!) { releaseDelivery(orderId: $id) { ${FIELDS} } }`;
const ORDER = `query($id: ID!) { order(id: $id) { ${FIELDS} statusHistory { status byRole by { id } } } }`;
const MINE = `query($active: Boolean) { myDeliveries(active: $active, limit: 100) { ${FIELDS} } }`;
const CURRENT = `{ currentDelivery { ${FIELDS} } }`;
const CANCEL = 'mutation($id: ID!) { cancelOrder(id: $id) { id status driver { id } } }';
const ORDERS = '{ orders(limit: 100) { id } }';

const ids = list => list.map(o => o.id);
const available = async (token, storeId) => ids((await ok(AVAILABLE, { s: storeId }, token)).availableDeliveries);
const orderAs = async (id, token) => (await ok(ORDER, { id }, token)).order;
const changeStatus = (id, status, token) => gql(UPDATE_STATUS, { id, status }, token);
const codeOf = res => res.errors?.[0]?.extensions?.code ?? null;
const extOf = res => res.errors?.[0]?.extensions ?? {};

// Cambia la sucursal de un usuario (revoca sus sesiones) y devuelve su sesión nueva.
async function moveToStore(user, { add, remove }) {
  const admin = await tokenOf('ADMIN');
  if (add) await ok('mutation($u: ID!, $s: ID!) { assignUserToStore(userId: $u, storeId: $s) { role } }', { u: user.id, s: add }, admin);
  if (remove) await ok('mutation($u: ID!, $s: ID!) { removeUserFromStore(userId: $u, storeId: $s) { role } }', { u: user.id, s: remove }, admin);
  return { ...user, token: (await login(user.email, user.password)).token };
}

// Orden DELIVERY de `storeId` (por omisión CARNYFRUT Centro) llevada por ADMIN
// hasta `upTo` (READY por omisión).
async function deliveryOrder({ storeId, upTo = 'READY', mode = 'DELIVERY', customer } = {}) {
  customer ??= await newCustomer();
  const product = await newProduct({ storeId });
  const order = await createOrder(customer, { mode, items: [{ productId: product.id, quantity: 1 }] });
  const path = ['CONFIRMED', 'PREPARING', 'READY'];
  await moveOrder(order.id, path.slice(0, path.indexOf(upTo) + 1), await tokenOf('ADMIN'));
  return { ...order, customer };
}

test('availableDeliveries lists only READY, DELIVERY, unassigned orders of the driver stores, oldest first', async () => {
  const store = await newStore();
  const driver = await newDriver(store.id);
  const other = await newDriver(store.id);
  const first = await deliveryOrder({ storeId: store.id });
  const second = await deliveryOrder({ storeId: store.id });
  await deliveryOrder({ storeId: store.id, upTo: 'PREPARING' });
  await deliveryOrder({ storeId: store.id, mode: 'PICKUP' });
  const taken = await deliveryOrder({ storeId: store.id });
  await acceptDelivery(taken.id, other.token);
  const inCentro = await deliveryOrder();

  const list = (await ok(AVAILABLE, {}, driver.token)).availableDeliveries;
  assert.deepEqual(ids(list), [first.id, second.id]);
  assert.ok(Date.parse(list[0].createdAt) <= Date.parse(list[1].createdAt));
  assert.ok(list.every(o => o.status === 'READY' && o.mode === 'DELIVERY' && o.driver === null && o.assignedAt === null));
  assert.deepEqual(await available(driver.token, store.id), [first.id, second.id]);

  // Otra sucursal: STORE_NOT_ASSIGNED; sin orders:deliver: PERMISSION_REQUIRED.
  const ext = await forbidden('STORE_NOT_ASSIGNED', AVAILABLE, { s: inCentro.store.id }, driver.token);
  assert.equal(ext.storeId, inCentro.store.id);
  for (const token of [(await newCustomer()).token, await tokenOf('STAFF')]) {
    const denied = await forbidden('PERMISSION_REQUIRED', AVAILABLE, {}, token);
    assert.equal(denied.permission, 'orders:deliver');
  }
  // ADMIN (scope:all_stores) ve las de cualquier sucursal.
  const admin = await tokenOf('ADMIN');
  assert.deepEqual(await available(admin, store.id), [first.id, second.id]);
  assert.ok((await available(admin, inCentro.store.id)).includes(inCentro.id));

  // Aceptar: la orden queda con su repartidor y sale de la lista.
  const accepted = await acceptDelivery(first.id, driver.token);
  assert.equal(accepted.status, 'READY');
  assert.deepEqual(accepted.driver, { id: driver.id, name: driver.name });
  assert.ok(Math.abs(Date.parse(accepted.assignedAt) - Date.now()) < 60_000);
  assert.deepEqual(await available(driver.token), [second.id]);
});

test('drivers racing for the same order: exactly one wins, the others get ORDER_NOT_AVAILABLE (TAKEN)', async () => {
  const order = await deliveryOrder();
  // Los dos repartidores del seed (repartidor y repartidor2) y dos más de la misma sucursal.
  const tokens = [await tokenOf('DELIVERY'), await tokenOf('DELIVERY2'), (await newDriver()).token, (await newDriver()).token];
  const results = await Promise.all(tokens.map(token => gql(ACCEPT_DELIVERY, { id: order.id }, token)));
  const winners = results.map((r, i) => [r, tokens[i]]).filter(([r]) => !r.errors);
  assert.equal(winners.length, 1, JSON.stringify(results));
  for (const loser of results.filter(r => r.errors)) {
    assert.equal(loser.errors[0].extensions.code, 'ORDER_NOT_AVAILABLE');
    assert.deepEqual([loser.errors[0].extensions.orderId, loser.errors[0].extensions.reason], [order.id, 'TAKEN']);
  }
  const [[won, winnerToken]] = winners;
  assert.equal((await orderAs(order.id, await tokenOf('ADMIN'))).driver.id, won.data.acceptDelivery.driver.id);
  // Deja libres a los repartidores del seed para otras pruebas.
  await ok(RELEASE, { id: order.id }, winnerToken);
});

test('one active delivery per driver: two concurrent accepts by the same driver, only one wins (ALREADY_DELIVERING)', async () => {
  const driver = await newDriver();
  const a = await deliveryOrder();
  const b = await deliveryOrder();
  const results = await Promise.all([a, b].map(o => gql(ACCEPT_DELIVERY, { id: o.id }, driver.token)));
  const won = results.filter(r => !r.errors);
  assert.equal(won.length, 1, JSON.stringify(results));
  const activeId = won[0].data.acceptDelivery.id;
  const [lost] = results.filter(r => r.errors);
  assert.equal(lost.errors[0].extensions.code, 'ALREADY_DELIVERING');
  assert.equal(lost.errors[0].extensions.activeOrderId, activeId);
  const otherId = activeId === a.id ? b.id : a.id;
  assert.equal((await orderAs(otherId, await tokenOf('ADMIN'))).driver, null);

  // También en serie, y también con la orden ya en camino (IN_DELIVERY).
  const c = await deliveryOrder();
  assert.equal((await fails('ALREADY_DELIVERING', ACCEPT_DELIVERY, { id: c.id }, driver.token)).activeOrderId, activeId);
  await moveOrder(activeId, ['IN_DELIVERY'], driver.token);
  assert.equal((await fails('ALREADY_DELIVERING', ACCEPT_DELIVERY, { id: c.id }, driver.token)).activeOrderId, activeId);
  // Al entregarla queda libre para aceptar otra.
  await moveOrder(activeId, ['DELIVERED'], driver.token);
  assert.equal((await acceptDelivery(otherId, driver.token)).driver.id, driver.id);
});

test('accept: NOT_FOUND, the ORDER_NOT_AVAILABLE reasons, and a retry by the same driver returns the order', async () => {
  const driver = await newDriver();
  const notFound = await fails('NOT_FOUND', ACCEPT_DELIVERY, { id: '000000000000000000000000' }, driver.token);
  assert.equal(notFound.entity, 'ORDER');
  const reasonOf = async id => (await fails('ORDER_NOT_AVAILABLE', ACCEPT_DELIVERY, { id }, driver.token)).reason;

  assert.equal(await reasonOf((await deliveryOrder({ upTo: 'PREPARING' })).id), 'NOT_READY');
  assert.equal(await reasonOf((await deliveryOrder({ mode: 'PICKUP' })).id), 'NOT_DELIVERY');
  const cancelled = await deliveryOrder();
  await ok(CANCEL, { id: cancelled.id }, await tokenOf('STAFF'));
  assert.equal(await reasonOf(cancelled.id), 'CANCELLED');

  const order = await deliveryOrder();
  const first = await acceptDelivery(order.id, driver.token);
  const again = await acceptDelivery(order.id, driver.token); // p. ej. reintento tras un corte de red
  assert.deepEqual([again.driver.id, again.assignedAt], [driver.id, first.assignedAt]);
  await moveOrder(order.id, ['IN_DELIVERY'], driver.token);
  const late = await newDriver();
  assert.equal((await fails('ORDER_NOT_AVAILABLE', ACCEPT_DELIVERY, { id: order.id }, late.token)).reason, 'PICKED_UP');
  await moveOrder(order.id, ['DELIVERED'], driver.token);
  assert.equal((await fails('ORDER_NOT_AVAILABLE', ACCEPT_DELIVERY, { id: order.id }, late.token)).reason, 'DELIVERED');
});

test('only the assigned driver picks up and delivers; another driver and staff get NOT_ASSIGNED_DRIVER', async () => {
  const order = await deliveryOrder();
  const driver = await newDriver();
  const other = await newDriver();
  const staff = await tokenOf('STAFF');
  await acceptDelivery(order.id, driver.token);

  for (const token of [other.token, staff]) {
    const ext = await forbidden('NOT_ASSIGNED_DRIVER', UPDATE_STATUS, { id: order.id, status: 'IN_DELIVERY' }, token);
    assert.equal(ext.status, 'IN_DELIVERY');
  }
  await moveOrder(order.id, ['IN_DELIVERY'], driver.token);
  for (const token of [other.token, staff]) await forbidden('NOT_ASSIGNED_DRIVER', UPDATE_STATUS, { id: order.id, status: 'DELIVERED' }, token);
  await moveOrder(order.id, ['DELIVERED'], driver.token);
  assert.equal((await orderAs(order.id, driver.token)).status, 'DELIVERED');
});

test('statusHistory records byRole DELIVERY (and the driver) for pickup and delivery; accepting adds no entry', async () => {
  const order = await deliveryOrder();
  const driver = await newDriver();
  await acceptDelivery(order.id, driver.token);
  assert.deepEqual((await orderAs(order.id, driver.token)).statusHistory.map(e => e.status), ['PENDING', 'CONFIRMED', 'PREPARING', 'READY']);
  await moveOrder(order.id, ['IN_DELIVERY', 'DELIVERED'], driver.token);
  const history = (await orderAs(order.id, await tokenOf('STAFF'))).statusHistory;
  assert.deepEqual(history.slice(-2).map(e => [e.status, e.byRole, e.by.id]), [['IN_DELIVERY', 'DELIVERY', driver.id], ['DELIVERED', 'DELIVERY', driver.id]]);
});

// Invariante: una orden IN_DELIVERY siempre tiene repartidor. ADMIN incluido: la acepta él primero.
test('nobody takes out an order with no driver, ADMIN included (NO_DRIVER_ASSIGNED); ADMIN accepts it first', async () => {
  const order = await deliveryOrder();
  const admin = await tokenOf('ADMIN');
  for (const token of [(await newDriver()).token, await tokenOf('STAFF'), admin]) {
    const ext = await forbidden('NO_DRIVER_ASSIGNED', UPDATE_STATUS, { id: order.id, status: 'IN_DELIVERY' }, token);
    assert.equal(ext.status, 'IN_DELIVERY');
  }
  const adminId = (await ok('{ me { id } }', {}, admin)).me.id;
  assert.equal((await acceptDelivery(order.id, admin)).driver.id, adminId);
  await moveOrder(order.id, ['IN_DELIVERY', 'DELIVERED'], admin);
  const after = await orderAs(order.id, admin);
  assert.equal(after.driver.id, adminId);
  assert.deepEqual(after.statusHistory.slice(-2).map(e => [e.status, e.byRole]), [['IN_DELIVERY', 'ADMIN'], ['DELIVERED', 'ADMIN']]);
});

test('a DELIVERY order cannot skip IN_DELIVERY: READY -> DELIVERED is INVALID_STATUS_TRANSITION (staff: no permission)', async () => {
  const order = await deliveryOrder();
  const driver = await newDriver();
  await acceptDelivery(order.id, driver.token);
  for (const token of [driver.token, await tokenOf('ADMIN')]) {
    const ext = await fails('INVALID_STATUS_TRANSITION', UPDATE_STATUS, { id: order.id, status: 'DELIVERED' }, token);
    assert.deepEqual([ext.from, ext.to], ['READY', 'DELIVERED']);
  }
  await forbidden('ORDER_STATUS_CHANGE_DENIED', UPDATE_STATUS, { id: order.id, status: 'DELIVERED' }, await tokenOf('STAFF'));
  assert.equal((await orderAs(order.id, driver.token)).status, 'READY');
  await moveOrder(order.id, ['IN_DELIVERY', 'DELIVERED'], driver.token);
});

test('ADMIN can move forward and deliver an order assigned to another driver; the driver stays and is freed', async () => {
  const order = await deliveryOrder();
  const driver = await newDriver();
  const admin = await tokenOf('ADMIN');
  await acceptDelivery(order.id, driver.token);
  await moveOrder(order.id, ['IN_DELIVERY'], admin);
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery.status, 'IN_DELIVERY');
  await moveOrder(order.id, ['DELIVERED'], admin);
  const after = await orderAs(order.id, admin);
  assert.equal(after.driver.id, driver.id);
  assert.deepEqual(after.statusHistory.slice(-2).map(e => [e.status, e.byRole]), [['IN_DELIVERY', 'ADMIN'], ['DELIVERED', 'ADMIN']]);
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery, null);
});

test('a driver cannot accept the delivery of their own order (OWN_ORDER); another driver can', async () => {
  const driver = await newDriver();
  const order = await deliveryOrder({ customer: driver });
  await forbidden('OWN_ORDER', ACCEPT_DELIVERY, { id: order.id }, driver.token);
  assert.ok((await available(driver.token)).includes(order.id)); // la ve en la lista: es libre para los demás
  const other = await newDriver();
  assert.equal((await acceptDelivery(order.id, other.token)).driver.id, other.id);
  await ok(RELEASE, { id: order.id }, other.token);
});

test('release by the driver and by staff puts the order back in availableDeliveries; others cannot release', async () => {
  const centro = await seedStore();
  const order = await deliveryOrder();
  const driver = await newDriver();
  const other = await newDriver();
  const admin = await tokenOf('ADMIN');

  await acceptDelivery(order.id, driver.token);
  assert.ok(!(await available(other.token, centro.id)).includes(order.id));
  await forbidden('NOT_ASSIGNED_DRIVER', RELEASE, { id: order.id }, other.token);
  const customer = await forbidden('PERMISSION_REQUIRED', RELEASE, { id: order.id }, order.customer.token);
  assert.equal(customer.permission, 'orders:deliver');
  const huertaStaff = await forbidden('STORE_NOT_ASSIGNED', RELEASE, { id: order.id }, await tokenOf('HUERTA_STAFF'));
  assert.equal(huertaStaff.storeId, centro.id);

  const released = (await ok(RELEASE, { id: order.id }, driver.token)).releaseDelivery;
  assert.deepEqual([released.status, released.driver, released.assignedAt], ['READY', null, null]);
  assert.ok((await available(other.token, centro.id)).includes(order.id));

  // Otro repartidor la toma y el personal de mostrador la libera.
  await acceptDelivery(order.id, other.token);
  const byStaff = (await ok(RELEASE, { id: order.id }, await tokenOf('STAFF'))).releaseDelivery;
  assert.equal(byStaff.driver, null);
  assert.ok((await available(driver.token, centro.id)).includes(order.id));
  // Si se perdió la respuesta de su liberación, el reintento del repartidor da
  // NO_DRIVER_ASSIGNED: ya no es suya (el cliente lo trata como liberada).
  // Liberar una orden que ya está libre no cambia nada (personal) y para un repartidor es NO_DRIVER_ASSIGNED.
  assert.equal((await ok(RELEASE, { id: order.id }, await tokenOf('STAFF'))).releaseDelivery.driver, null);
  await forbidden('NO_DRIVER_ASSIGNED', RELEASE, { id: order.id }, driver.token);

  // Bitácora: DELIVERY_ACCEPTED y DELIVERY_RELEASED con la sucursal y el repartidor.
  const BY_TARGET = 'query($id: ID!) { auditByTarget(targetType: "Order", targetId: $id) { type category metadata } }';
  const events = await eventually(async () => {
    const { auditByTarget } = await ok(BY_TARGET, { id: order.id }, admin);
    const of = type => auditByTarget.filter(e => e.type === type);
    return of('DELIVERY_ACCEPTED').length === 2 && of('DELIVERY_RELEASED').length === 2 ? auditByTarget : null;
  }, { what: `DELIVERY_ACCEPTED/RELEASED for ${order.number}` });
  const accepted = events.filter(e => e.type === 'DELIVERY_ACCEPTED').map(e => ({ category: e.category, ...JSON.parse(e.metadata) }));
  assert.deepEqual(accepted.map(m => [m.category, m.storeId, m.number]), [['ORDER', centro.id, order.number], ['ORDER', centro.id, order.number]]);
  assert.deepEqual(accepted.map(m => m.driverId).sort(), [driver.id, other.id].sort());
  const releasedDrivers = events.filter(e => e.type === 'DELIVERY_RELEASED').map(e => JSON.parse(e.metadata).driverId);
  assert.deepEqual(releasedDrivers.sort(), [driver.id, other.id].sort());
});

test('release after pickup is refused (ORDER_NOT_AVAILABLE, PICKED_UP)', async () => {
  const order = await deliveryOrder();
  const driver = await newDriver();
  await acceptDelivery(order.id, driver.token);
  await moveOrder(order.id, ['IN_DELIVERY'], driver.token);
  for (const token of [driver.token, await tokenOf('STAFF')]) {
    const ext = await fails('ORDER_NOT_AVAILABLE', RELEASE, { id: order.id }, token);
    assert.deepEqual([ext.orderId, ext.reason], [order.id, 'PICKED_UP']);
  }
  assert.equal((await orderAs(order.id, driver.token)).driver.id, driver.id);
  await moveOrder(order.id, ['DELIVERED'], driver.token);
});

test('the customer sees driver { id name } but not the driver email', async () => {
  const order = await deliveryOrder();
  assert.equal((await orderAs(order.id, order.customer.token)).driver, null);
  const driver = await newDriver();
  await acceptDelivery(order.id, driver.token);
  const seen = await orderAs(order.id, order.customer.token);
  assert.deepEqual(seen.driver, { id: driver.id, name: driver.name });
  assert.ok(seen.assignedAt);
  await fails('GRAPHQL_VALIDATION_FAILED', 'query($id: ID!) { order(id: $id) { driver { email } } }', { id: order.id }, order.customer.token);
  await ok(RELEASE, { id: order.id }, driver.token);
});

test('myDeliveries and currentDelivery', async () => {
  const driver = await newDriver();
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery, null);
  assert.deepEqual((await ok(MINE, { active: true }, driver.token)).myDeliveries, []);
  assert.deepEqual((await ok(MINE, {}, driver.token)).myDeliveries, []);

  const first = await deliveryOrder();
  await acceptDelivery(first.id, driver.token);
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery.id, first.id);
  assert.deepEqual(ids((await ok(MINE, { active: true }, driver.token)).myDeliveries), [first.id]);
  await moveOrder(first.id, ['IN_DELIVERY'], driver.token);
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery.status, 'IN_DELIVERY');
  await moveOrder(first.id, ['DELIVERED'], driver.token);
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery, null);
  assert.deepEqual((await ok(MINE, { active: true }, driver.token)).myDeliveries, []);

  // Historial: entregadas y canceladas, la más reciente primero.
  const second = await deliveryOrder();
  await acceptDelivery(second.id, driver.token);
  await ok(CANCEL, { id: second.id }, await tokenOf('STAFF'));
  const history = (await ok(MINE, { active: false }, driver.token)).myDeliveries;
  assert.deepEqual(history.map(o => [o.id, o.status]), [[second.id, 'CANCELLED'], [first.id, 'DELIVERED']]);
  // Una liberada no es suya: no aparece.
  const third = await deliveryOrder();
  await acceptDelivery(third.id, driver.token);
  await ok(RELEASE, { id: third.id }, driver.token);
  assert.deepEqual(ids((await ok(MINE, {}, driver.token)).myDeliveries), [second.id, first.id]);

  const customer = await newCustomer();
  await forbidden('PERMISSION_REQUIRED', MINE, {}, customer.token);
  await forbidden('PERMISSION_REQUIRED', CURRENT, {}, customer.token);
});

test('the DELIVERY role sees in `orders` only the available orders of its stores plus its own', async () => {
  const store = await newStore();
  const driver = await newDriver(store.id);
  const other = await newDriver(store.id);
  const open = await deliveryOrder({ storeId: store.id });
  const notReady = await deliveryOrder({ storeId: store.id, upTo: 'PREPARING' });
  const pickup = await deliveryOrder({ storeId: store.id, mode: 'PICKUP' });
  const theirs = await deliveryOrder({ storeId: store.id });
  await acceptDelivery(theirs.id, other.token);
  const mine = await deliveryOrder({ storeId: store.id });
  await acceptDelivery(mine.id, driver.token);

  const visible = async () => ids((await ok(ORDERS, {}, driver.token)).orders).sort();
  assert.deepEqual(await visible(), [open.id, mine.id].sort());
  // Las suyas siguen visibles al entregarlas; `status` filtra sobre lo mismo.
  await moveOrder(mine.id, ['IN_DELIVERY', 'DELIVERED'], driver.token);
  assert.deepEqual(await visible(), [open.id, mine.id].sort());
  assert.deepEqual(ids((await ok('{ orders(status: DELIVERED, limit: 100) { id } }', {}, driver.token)).orders), [mine.id]);
  assert.deepEqual(ids((await ok('query($s: ID) { orders(storeId: $s, limit: 100) { id } }', { s: store.id }, driver.token)).orders).sort(), [open.id, mine.id].sort());

  // Por id: la libre y la suya sí; la de otro, la que no está lista y la PICKUP no.
  for (const id of [open.id, mine.id]) assert.equal((await orderAs(id, driver.token)).id, id);
  for (const id of [theirs.id, notReady.id, pickup.id]) await forbidden('ORDER_VIEW_DENIED', ORDER, { id }, driver.token);
  // El personal de mostrador de la sucursal sigue viéndolas todas.
  const staff = await newStoreUser('STAFF', store.id);
  const staffSees = ids((await ok(ORDERS, {}, staff.token)).orders);
  for (const id of [open.id, notReady.id, pickup.id, theirs.id, mine.id]) assert.ok(staffSees.includes(id), id);
});

test('`orders` for the DELIVERY role: status, storeId, limit and offset over available and own orders together', async () => {
  const s = await newStore();
  const t = await newStore();
  let driver = await newDriver(s.id);
  driver = await moveToStore(driver, { add: t.id });
  const other = await newDriver(s.id);
  // Del más antiguo al más reciente; `orders` ordena del más reciente al más antiguo.
  const o7 = await deliveryOrder({ storeId: t.id }); // libre, en la otra sucursal del repartidor
  const o1 = await deliveryOrder({ storeId: s.id }); // libre
  const o2 = await deliveryOrder({ storeId: s.id }); // la entrega él
  const o3 = await deliveryOrder({ storeId: s.id }); // libre
  const o4 = await deliveryOrder({ storeId: s.id }); // la entrega él
  const o5 = await deliveryOrder({ storeId: s.id }); // la toma otro
  await deliveryOrder({ storeId: s.id, upTo: 'PREPARING' }); // no está lista
  for (const o of [o2, o4]) {
    await acceptDelivery(o.id, driver.token);
    await moveOrder(o.id, ['IN_DELIVERY', 'DELIVERED'], driver.token);
  }
  await acceptDelivery(o5.id, other.token);

  const ORDERS_PAGE = 'query($s: ID, $st: OrderStatus, $l: Int, $o: Int) { orders(storeId: $s, status: $st, limit: $l, offset: $o) { id } }';
  const page = async (vars = {}) => ids((await ok(ORDERS_PAGE, { l: 100, o: 0, ...vars }, driver.token)).orders);
  assert.deepEqual(await page(), [o4.id, o3.id, o2.id, o1.id, o7.id]);
  assert.deepEqual(await page({ l: 2, o: 0 }), [o4.id, o3.id]);
  assert.deepEqual(await page({ l: 2, o: 2 }), [o2.id, o1.id]);
  assert.deepEqual(await page({ l: 2, o: 4 }), [o7.id]);
  assert.deepEqual(await page({ l: 2, o: 6 }), []);
  assert.deepEqual(await page({ st: 'READY' }), [o3.id, o1.id, o7.id]);
  assert.deepEqual(await page({ st: 'READY', l: 1, o: 1 }), [o1.id]);
  assert.deepEqual(await page({ st: 'DELIVERED' }), [o4.id, o2.id]);
  assert.deepEqual(await page({ st: 'DELIVERED', l: 1, o: 1 }), [o2.id]);
  assert.deepEqual(await page({ s: s.id }), [o4.id, o3.id, o2.id, o1.id]);
  assert.deepEqual(await page({ s: s.id, l: 3, o: 1 }), [o3.id, o2.id, o1.id]);
  assert.deepEqual(await page({ s: t.id }), [o7.id]);
  assert.deepEqual(await page({ s: s.id, st: 'READY', l: 1, o: 0 }), [o3.id]);
});

test('a driver moved to another store keeps and finishes their assigned order; demoted to CUSTOMER, they stop seeing it', async () => {
  const a = await newStore();
  const b = await newStore();
  let driver = await newDriver(a.id);
  const mine = await deliveryOrder({ storeId: a.id });
  await acceptDelivery(mine.id, driver.token);
  driver = await moveToStore(driver, { add: b.id, remove: a.id });

  const stillOpen = await deliveryOrder({ storeId: a.id });
  assert.ok(ids((await ok(ORDERS, {}, driver.token)).orders).includes(mine.id));
  assert.ok(!ids((await ok(ORDERS, {}, driver.token)).orders).includes(stillOpen.id));
  assert.equal((await orderAs(mine.id, driver.token)).id, mine.id);
  assert.ok(!(await available(driver.token)).includes(stillOpen.id));
  await forbidden('STORE_NOT_ASSIGNED', ACCEPT_DELIVERY, { id: stillOpen.id }, driver.token);
  await forbidden('ORDER_VIEW_DENIED', ORDER, { id: stillOpen.id }, driver.token);
  // La termina aunque ya no sea de esa sucursal.
  await moveOrder(mine.id, ['IN_DELIVERY', 'DELIVERED'], driver.token);
  assert.equal((await orderAs(mine.id, driver.token)).status, 'DELIVERED');
  assert.deepEqual(ids((await ok(MINE, {}, driver.token)).myDeliveries), [mine.id]);

  // Si deja de ser repartidor (vuelve a CUSTOMER), ya no ve la orden ni su historial de entregas.
  await ok('mutation($u: ID!) { assignRole(userId: $u, role: CUSTOMER) { role } }', { u: driver.id }, await tokenOf('ADMIN'));
  const asCustomer = (await login(driver.email, driver.password)).token;
  await forbidden('ORDER_VIEW_DENIED', ORDER, { id: mine.id }, asCustomer);
  assert.deepEqual(ids((await ok(ORDERS, {}, asCustomer)).orders), []);
  await forbidden('PERMISSION_REQUIRED', MINE, {}, asCustomer);
});

test('a driver of La Huerta cannot see or accept a CARNYFRUT Centro order', async () => {
  const huerta = await huertaStore();
  const centro = await seedStore();
  const driver = await newDriver(huerta.id);
  const order = await deliveryOrder();

  assert.ok(!(await available(driver.token)).includes(order.id));
  await forbidden('STORE_NOT_ASSIGNED', AVAILABLE, { s: centro.id }, driver.token);
  await forbidden('ORDER_VIEW_DENIED', ORDER, { id: order.id }, driver.token);
  const ext = await forbidden('STORE_NOT_ASSIGNED', ACCEPT_DELIVERY, { id: order.id }, driver.token);
  assert.equal(ext.storeId, centro.id);
  assert.ok(!ids((await ok(ORDERS, {}, driver.token)).orders).includes(order.id));
  assert.equal((await orderAs(order.id, await tokenOf('ADMIN'))).driver, null);
});

test('staff can cancel an assigned order: the driver stays as history and is free again', async () => {
  const driver = await newDriver();
  const staff = await tokenOf('STAFF');
  const ready = await deliveryOrder();
  await acceptDelivery(ready.id, driver.token);
  const { cancelOrder } = await ok(CANCEL, { id: ready.id }, staff);
  assert.deepEqual([cancelOrder.status, cancelOrder.driver.id], ['CANCELLED', driver.id]);

  // También en camino; el repartidor no puede cancelar.
  const onTheWay = await deliveryOrder();
  await acceptDelivery(onTheWay.id, driver.token);
  await moveOrder(onTheWay.id, ['IN_DELIVERY'], driver.token);
  await forbidden('ORDER_CANCEL_DENIED', CANCEL, { id: onTheWay.id }, driver.token);
  assert.equal((await ok(CANCEL, { id: onTheWay.id }, staff)).cancelOrder.driver.id, driver.id);
  assert.equal((await ok(CURRENT, {}, driver.token)).currentDelivery, null);
  // Libre otra vez: acepta otra.
  const next = await deliveryOrder();
  assert.equal((await acceptDelivery(next.id, driver.token)).driver.id, driver.id);
  assert.equal((await changeStatus(next.id, 'IN_DELIVERY', driver.token)).data.updateOrderStatus.status, 'IN_DELIVERY');
});

// Carreras contra el reintento de changeOrderStatus (condicionado al repartidor validado).
// Varias rondas para que salgan los dos órdenes posibles; cada ronda con su repartidor.
async function race(rounds, setup, contenders) {
  const outcomes = [];
  for (let i = 0; i < rounds; i += 1) {
    const ctx = await setup();
    const results = await Promise.all(contenders.map(fn => fn(ctx)));
    const after = await orderAs(ctx.order.id, await tokenOf('ADMIN'));
    outcomes.push({ ctx, results, after });
    if (after.status === 'IN_DELIVERY') assert.ok(after.driver, `IN_DELIVERY without driver: ${JSON.stringify(after)}`);
  }
  return outcomes;
}

async function acceptedOrder() {
  const order = await deliveryOrder();
  const driver = await newDriver();
  await acceptDelivery(order.id, driver.token);
  return { order, driver };
}

test('race: the driver picks up while releasing it; exactly one wins and IN_DELIVERY always has the driver', async () => {
  const outcomes = await race(4, acceptedOrder, [
    ({ order, driver }) => changeStatus(order.id, 'IN_DELIVERY', driver.token),
    ({ order, driver }) => gql(RELEASE, { id: order.id }, driver.token),
  ]);
  for (const { ctx, results: [pickup, release], after } of outcomes) {
    assert.equal([pickup, release].filter(r => !r.errors).length, 1, JSON.stringify([pickup, release]));
    if (!pickup.errors) {
      assert.deepEqual([after.status, after.driver.id], ['IN_DELIVERY', ctx.driver.id]);
      assert.deepEqual([codeOf(release), extOf(release).reason], ['ORDER_NOT_AVAILABLE', 'PICKED_UP']);
    } else {
      assert.deepEqual([after.status, after.driver], ['READY', null]);
      assert.deepEqual([codeOf(pickup), extOf(pickup).reason], ['FORBIDDEN', 'NO_DRIVER_ASSIGNED']);
    }
  }
});

test('race: the driver picks up while staff release it; exactly one wins and IN_DELIVERY always has the driver', async () => {
  const staff = await tokenOf('STAFF');
  const outcomes = await race(4, acceptedOrder, [
    ({ order, driver }) => changeStatus(order.id, 'IN_DELIVERY', driver.token),
    ({ order }) => gql(RELEASE, { id: order.id }, staff),
  ]);
  for (const { ctx, results: [pickup, release], after } of outcomes) {
    assert.equal([pickup, release].filter(r => !r.errors).length, 1, JSON.stringify([pickup, release]));
    if (!pickup.errors) {
      assert.deepEqual([after.status, after.driver.id], ['IN_DELIVERY', ctx.driver.id]);
      assert.deepEqual([codeOf(release), extOf(release).reason], ['ORDER_NOT_AVAILABLE', 'PICKED_UP']);
    } else {
      assert.deepEqual([after.status, after.driver], ['READY', null]);
      assert.deepEqual([codeOf(pickup), extOf(pickup).reason], ['FORBIDDEN', 'NO_DRIVER_ASSIGNED']);
    }
  }
});

test('race: a driver accepts while staff cancel; the cancel always lands and the driver ends up free', async () => {
  const staff = await tokenOf('STAFF');
  const outcomes = await race(4, async () => ({ order: await deliveryOrder(), driver: await newDriver() }), [
    ({ order, driver }) => gql(ACCEPT_DELIVERY, { id: order.id }, driver.token),
    ({ order }) => gql(CANCEL, { id: order.id }, staff),
  ]);
  for (const { ctx, results: [accept, cancel], after } of outcomes) {
    assert.ok(!cancel.errors, JSON.stringify(cancel));
    assert.equal(after.status, 'CANCELLED');
    if (!accept.errors) assert.equal(after.driver.id, ctx.driver.id); // aceptó antes: queda como historia
    else {
      assert.deepEqual([codeOf(accept), extOf(accept).reason], ['ORDER_NOT_AVAILABLE', 'CANCELLED']);
      assert.equal(after.driver, null);
    }
    assert.equal((await ok(CURRENT, {}, ctx.driver.token)).currentDelivery, null);
  }
});

test('the one_active_delivery_per_driver index exists in the test database (unique, partial on READY / IN_DELIVERY)', async () => {
  const index = await withOrders(orders => orders.indexes()).then(list => list.find(i => i.name === INDEX));
  assert.ok(index, `${INDEX} is missing`);
  assert.deepEqual(index.key, { driverId: 1 });
  assert.equal(index.unique, true);
  assert.deepEqual(index.partialFilterExpression, { driverId: { $type: 'objectId' }, status: { $in: ['READY', 'IN_DELIVERY'] } });
});

test('without the index, acceptDelivery still refuses a second active delivery (check before the write)', async () => {
  const driver = await newDriver();
  const first = await deliveryOrder();
  const second = await deliveryOrder();
  let spec;
  await withOrders(async orders => {
    spec = (await orders.indexes()).find(i => i.name === INDEX);
    await orders.dropIndex(INDEX);
  });
  try {
    await acceptDelivery(first.id, driver.token);
    const ext = await fails('ALREADY_DELIVERING', ACCEPT_DELIVERY, { id: second.id }, driver.token);
    assert.equal(ext.activeOrderId, first.id);
    assert.equal((await orderAs(second.id, await tokenOf('ADMIN'))).driver, null);
  } finally {
    await withOrders(orders => orders.createIndex(spec.key, { name: INDEX, unique: true, partialFilterExpression: spec.partialFilterExpression }));
  }
  assert.ok(await withOrders(orders => orders.indexExists(INDEX)));
});

test('invariant: no DELIVERY order is IN_DELIVERY without a driver', async () => {
  assert.equal(await withOrders(orders => orders.countDocuments({ mode: 'DELIVERY', status: 'IN_DELIVERY', driverId: null })), 0);
});

test('accept and release need a session and orders:deliver to accept', async () => {
  const order = await deliveryOrder();
  await fails('UNAUTHENTICATED', ACCEPT_DELIVERY, { id: order.id });
  await fails('UNAUTHENTICATED', RELEASE, { id: order.id });
  const ext = await forbidden('PERMISSION_REQUIRED', ACCEPT_DELIVERY, { id: order.id }, (await newCustomer()).token);
  assert.equal(ext.permission, 'orders:deliver');
});
