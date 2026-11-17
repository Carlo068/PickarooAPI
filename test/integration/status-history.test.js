// Historial de estados de una orden (PIC-78, README sección 6): una entrada por
// transición, escrita en la misma operación atómica que el cambio de estado;
// `by` solo lo ven quienes no son el cliente de la orden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, gql, fails, forbidden, tokenOf, decodeJwt, newCustomer, newProduct, createOrder, moveOrder, stockOf, uid, UPDATE_STATUS,
} from './client.js';

const MONGO_API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'mongoAPI');
const mongoose = createRequire(path.join(MONGO_API, 'package.json'))('mongoose');

// Acceso directo a pickaroodb_it para dejar una orden como la dejaba una versión anterior.
async function withOrders(fn) {
  const conn = await mongoose.createConnection(process.env.IT_MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    return await fn(conn.db.collection('orders'), id => new mongoose.Types.ObjectId(id));
  } finally {
    await conn.close();
  }
}

const HISTORY = 'query($id: ID!) { order(id: $id) { id status statusHistory { status at byRole inferred by { id name } } } }';
const historyOf = async (id, token) => (await ok(HISTORY, { id }, token)).order.statusHistory;
const statuses = h => h.map(e => e.status);
const changeStatus = (id, status, token) => gql(UPDATE_STATUS, { id, status }, token);

async function newOrder(options = {}) {
  const customer = await newCustomer();
  const product = await newProduct();
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }], ...options });
  return { customer, order };
}

test('a new order has one PENDING entry made by the customer', async () => {
  const { customer, order } = await newOrder();
  const staff = await tokenOf('STAFF');
  const history = await historyOf(order.id, staff);
  assert.equal(history.length, 1);
  const [first] = history;
  assert.equal(first.status, 'PENDING');
  assert.equal(first.byRole, 'CUSTOMER');
  assert.equal(first.inferred, false);
  assert.equal(first.by.id, customer.id);
  assert.ok(!Number.isNaN(Date.parse(first.at)));
});

test('a PICKUP order records the exact path, with increasing timestamps and the right byRole', async () => {
  const { order } = await newOrder();
  const staff = await tokenOf('STAFF');
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERED'], staff);
  const history = await historyOf(order.id, staff);
  assert.deepEqual(statuses(history), ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DELIVERED']);
  assert.deepEqual(history.map(e => e.byRole), ['CUSTOMER', 'STAFF', 'STAFF', 'STAFF', 'STAFF']);
  assert.ok(history.every(e => e.inferred === false));
  const times = history.map(e => Date.parse(e.at));
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] > times[i - 1], `entry ${i} is later than entry ${i - 1}`);
});

test('a DELIVERY order records staff for the counter steps and DELIVERY for the route', async () => {
  const { order } = await newOrder({ mode: 'DELIVERY' });
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY'], await tokenOf('STAFF'));
  const driver = await tokenOf('DELIVERY');
  await moveOrder(order.id, ['IN_DELIVERY', 'DELIVERED'], driver);
  const history = await historyOf(order.id, driver);
  assert.deepEqual(statuses(history), ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'IN_DELIVERY', 'DELIVERED']);
  assert.deepEqual(history.map(e => e.byRole), ['CUSTOMER', 'STAFF', 'STAFF', 'STAFF', 'DELIVERY', 'DELIVERY']);
  assert.equal(history[5].by.id, decodeJwt(driver).sub);
  const times = history.map(e => Date.parse(e.at));
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] > times[i - 1]);
});

test('checkoutCart also writes the initial PENDING entry', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  await ok('mutation($p: ID!) { addToCart(productId: $p, quantity: 1) { itemCount } }', { p: product.id }, customer.token);
  const { checkoutCart } = await ok('mutation { checkoutCart(input: { mode: PICKUP }) { id } }', {}, customer.token);
  const history = await historyOf(checkoutCart.id, customer.token);
  assert.deepEqual(history.map(e => [e.status, e.byRole]), [['PENDING', 'CUSTOMER']]);
});

test('cancelling appends CANCELLED, by the customer or by staff', async () => {
  const mine = await newOrder();
  const { cancelOrder } = await ok('mutation($id: ID!) { cancelOrder(id: $id) { id status } }', { id: mine.order.id }, mine.customer.token);
  assert.equal(cancelOrder.status, 'CANCELLED');
  assert.deepEqual((await historyOf(mine.order.id, mine.customer.token)).map(e => [e.status, e.byRole]), [['PENDING', 'CUSTOMER'], ['CANCELLED', 'CUSTOMER']]);

  const theirs = await newOrder();
  const staff = await tokenOf('STAFF');
  await moveOrder(theirs.order.id, ['CONFIRMED', 'CANCELLED'], staff);
  assert.deepEqual((await historyOf(theirs.order.id, staff)).map(e => [e.status, e.byRole]), [['PENDING', 'CUSTOMER'], ['CONFIRMED', 'STAFF'], ['CANCELLED', 'STAFF']]);
});

test('an invalid transition appends nothing', async () => {
  const { order } = await newOrder();
  const staff = await tokenOf('STAFF');
  await fails('INVALID_STATUS_TRANSITION', UPDATE_STATUS, { id: order.id, status: 'READY' }, staff);
  await fails('ORDER_ALREADY_IN_STATUS', UPDATE_STATUS, { id: order.id, status: 'PENDING' }, staff);
  assert.deepEqual(statuses(await historyOf(order.id, staff)), ['PENDING']);

  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERED'], staff);
  await fails('INVALID_STATUS_TRANSITION', UPDATE_STATUS, { id: order.id, status: 'CANCELLED' }, staff);
  assert.equal((await historyOf(order.id, staff)).length, 5);
});

test('concurrent changes to the same status: exactly one wins and the history has one entry for it', async () => {
  const { order } = await newOrder();
  const staff = await tokenOf('STAFF');
  const admin = await tokenOf('ADMIN');
  const results = await Promise.all([staff, admin, staff, admin].map(token => changeStatus(order.id, 'CONFIRMED', token)));
  const winners = results.filter(r => !r.errors);
  assert.equal(winners.length, 1, JSON.stringify(results));
  for (const loser of results.filter(r => r.errors)) assert.equal(loser.errors[0].extensions.code, 'ORDER_ALREADY_IN_STATUS');
  assert.deepEqual(statuses(await historyOf(order.id, admin)), ['PENDING', 'CONFIRMED']);
});

test('a concurrent confirm and cancel keep the history consistent with the final status, and stock is restored once only if cancel won', async () => {
  const customer = await newCustomer();
  const product = await newProduct({ stock: 10 });
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 3 }] });
  assert.equal(await stockOf(product.id), 7);
  const staff = await tokenOf('STAFF');
  const results = await Promise.all([
    changeStatus(order.id, 'CONFIRMED', staff),
    gql('mutation($id: ID!) { cancelOrder(id: $id) { id status } }', { id: order.id }, customer.token),
  ]);
  const { order: after } = await ok(HISTORY, { id: order.id }, staff);
  // Cada cambio que tuvo éxito dejó exactamente una entrada; el último estado es el de la orden.
  assert.equal(after.statusHistory.length - 1, results.filter(r => !r.errors).length);
  assert.equal(after.statusHistory.at(-1).status, after.status);
  // Cancelar repone exactamente la cantidad de una orden; si ganó confirmar y nadie canceló, no se repone.
  const cancelled = after.statusHistory.some(e => e.status === 'CANCELLED');
  assert.equal(await stockOf(product.id), cancelled ? 10 : 7);
});

test('an idempotency-key replay leaves exactly one PENDING entry, also under concurrent replays', async () => {
  const customer = await newCustomer();
  const product = await newProduct({ stock: 10 });
  const options = { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: `it-${uid()}` };
  const first = await createOrder(customer, options);
  const replay = await createOrder(customer, options);
  assert.equal(replay.id, first.id);
  assert.deepEqual(statuses(await historyOf(first.id, customer.token)), ['PENDING']);

  // Réplicas simultáneas: pueden llegar a la violación de clave duplicada; todas devuelven la misma orden.
  const racing = { ...options, idempotencyKey: `it-${uid()}` };
  const results = await Promise.all([1, 2, 3, 4].map(() => createOrder(customer, racing)));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.deepEqual(statuses(await historyOf(results[0].id, customer.token)), ['PENDING']);
  assert.equal(await stockOf(product.id), 8); // una orden por clave
});

test('an order created by an ADMIN for a customer names the admin as the first actor; the customer names themselves', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  const admin = await tokenOf('ADMIN');
  const items = [{ productId: product.id, quantity: 1 }];
  const byAdmin = await createOrder({ ...customer, token: admin }, { items });
  const [first] = (await ok(HISTORY, { id: byAdmin.id }, admin)).order.statusHistory;
  assert.equal(first.status, 'PENDING');
  assert.equal(first.byRole, 'ADMIN');
  assert.equal(first.by.id, decodeJwt(admin).sub);

  const own = await createOrder(customer, { items });
  const [mine] = (await ok(HISTORY, { id: own.id }, admin)).order.statusHistory;
  assert.equal(mine.byRole, 'CUSTOMER');
  assert.equal(mine.by.id, customer.id);
});

test('a status change on an order whose history was never backfilled seeds the inferred PENDING first', async () => {
  const { order } = await newOrder();
  const staff = await tokenOf('STAFF');
  await withOrders((orders, oid) => orders.updateOne({ _id: oid(order.id) }, { $unset: { statusHistory: '' } }));
  await moveOrder(order.id, ['CONFIRMED'], staff);
  const history = (await ok(HISTORY, { id: order.id }, staff)).order.statusHistory;
  assert.deepEqual(history.map(e => [e.status, e.inferred, e.byRole]), [['PENDING', true, null], ['CONFIRMED', false, 'STAFF']]);

  // Igual con un arreglo vacío; y no se vuelve a sembrar en el siguiente cambio.
  const other = await newOrder();
  await withOrders((orders, oid) => orders.updateOne({ _id: oid(other.order.id) }, { $set: { statusHistory: [] } }));
  await moveOrder(other.order.id, ['CONFIRMED', 'PREPARING'], staff);
  assert.deepEqual(statuses(await historyOf(other.order.id, staff)), ['PENDING', 'CONFIRMED', 'PREPARING']);
});

test('the history keeps at most 20 entries even though findOneAndUpdate skips validators', async () => {
  const { order } = await newOrder();
  const staff = await tokenOf('STAFF');
  const filler = i => ({ status: 'PENDING', at: new Date(2026, 0, 1, 0, i), byUserId: null, byRole: null, inferred: true });
  await withOrders((orders, oid) => orders.updateOne({ _id: oid(order.id) }, { $set: { statusHistory: Array.from({ length: 20 }, (_, i) => filler(i)) } }));
  await moveOrder(order.id, ['CONFIRMED'], staff);
  const history = await historyOf(order.id, staff);
  assert.equal(history.length, 20);
  assert.equal(history.at(-1).status, 'CONFIRMED');
});

test('the customer sees byRole but by is null; staff and ADMIN see by { id name }', async () => {
  const { customer, order } = await newOrder();
  const staff = await tokenOf('STAFF');
  const admin = await tokenOf('ADMIN');
  await moveOrder(order.id, ['CONFIRMED'], staff);
  await moveOrder(order.id, ['PREPARING'], admin);

  const asCustomer = await historyOf(order.id, customer.token);
  assert.deepEqual(asCustomer.map(e => e.byRole), ['CUSTOMER', 'STAFF', 'ADMIN']);
  assert.ok(asCustomer.every(e => e.by === null), JSON.stringify(asCustomer));

  for (const token of [staff, admin]) {
    const seen = await historyOf(order.id, token);
    assert.equal(seen[0].by.id, customer.id);
    assert.equal(seen[1].by.id, decodeJwt(staff).sub);
    assert.equal(seen[2].by.id, decodeJwt(admin).sub);
    assert.ok(seen.every(e => typeof e.by.name === 'string' && e.by.name.length));
  }
});

test("another customer cannot read an order's history", async () => {
  const { order } = await newOrder();
  const other = await newCustomer();
  await forbidden('ORDER_VIEW_DENIED', HISTORY, { id: order.id }, other.token);
});
