// Órdenes: idempotencia, ciclo de estados por modalidad, transiciones
// inválidas, cancelación con reposición de stock, visibilidad del cliente e
// INSUFFICIENT_STOCK (README, secciones 2 y 6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok, fails, forbidden, tokenOf, uid, newCustomer, newProduct, newPackage, stockOf, seedStore, createOrder, moveOrder, UPDATE_STATUS, ORDER_FIELDS,
} from './client.js';

const ORDER = `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;
const CREATE = `mutation($input: CreateOrderInput!) { createOrder(input: $input) { ${ORDER_FIELDS} } }`;

test('createOrder with the same idempotencyKey twice returns the same order and takes stock once', async () => {
  const customer = await newCustomer();
  const product = await newProduct({ stock: 10 });
  const options = { items: [{ productId: product.id, quantity: 2 }], idempotencyKey: `it-${uid()}` };
  const first = await createOrder(customer, options);
  const second = await createOrder(customer, options);
  assert.equal(second.id, first.id);
  assert.equal(second.number, first.number);
  assert.equal(await stockOf(product.id), 8);
});

test('a PICKUP order goes PENDING → CONFIRMED → PREPARING → READY → DELIVERED (staff)', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  assert.equal(order.status, 'PENDING');
  assert.equal(order.deliveryFee, 0);
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERED'], await tokenOf('STAFF'));
  assert.equal((await ok(ORDER, { id: order.id }, customer.token)).order.status, 'DELIVERED');
});

test('a DELIVERY order goes through IN_DELIVERY to DELIVERED (staff, then the delivery driver)', async () => {
  const customer = await newCustomer();
  const product = await newProduct({ price: 100 });
  const order = await createOrder(customer, { mode: 'DELIVERY', items: [{ productId: product.id, quantity: 1 }] });
  const store = await seedStore();
  assert.equal(order.deliveryFee, store.deliveryFee); // 100 < freeDeliveryThreshold (400)
  assert.equal(order.total, 100 + store.deliveryFee);
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY'], await tokenOf('STAFF'));
  await moveOrder(order.id, ['IN_DELIVERY', 'DELIVERED'], await tokenOf('DELIVERY'));
  assert.equal((await ok(ORDER, { id: order.id }, customer.token)).order.status, 'DELIVERED');
});

test('an invalid transition gives INVALID_STATUS_TRANSITION with from and to', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  const staff = await tokenOf('STAFF');
  const ext = await fails('INVALID_STATUS_TRANSITION', UPDATE_STATUS, { id: order.id, status: 'READY' }, staff);
  assert.equal(ext.from, 'PENDING');
  assert.equal(ext.to, 'READY');

  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERED'], staff);
  const fromDelivered = await fails('INVALID_STATUS_TRANSITION', UPDATE_STATUS, { id: order.id, status: 'CANCELLED' }, staff);
  assert.equal(fromDelivered.from, 'DELIVERED');
});

test('a PICKUP order is never sent out for delivery (PICKUP_CANNOT_BE_DELIVERED)', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY'], await tokenOf('STAFF'));
  for (const role of ['DELIVERY', 'ADMIN']) {
    await fails('PICKUP_CANNOT_BE_DELIVERED', UPDATE_STATUS, { id: order.id, status: 'IN_DELIVERY' }, await tokenOf(role));
  }
  assert.equal((await ok(ORDER, { id: order.id }, customer.token)).order.status, 'READY');
});

test('cancelling an order restores the stock, package contents included', async () => {
  const customer = await newCustomer();
  const a = await newProduct({ stock: 20 });
  const b = await newProduct({ stock: 20 });
  const pkg = await newPackage([{ productId: a.id, quantity: 3 }, { productId: b.id, quantity: 1 }]);
  const order = await createOrder(customer, { items: [{ productId: a.id, quantity: 2 }, { packageId: pkg.id, quantity: 2 }] });
  assert.equal(await stockOf(a.id), 20 - 2 - 6);
  assert.equal(await stockOf(b.id), 20 - 2);

  const { cancelOrder } = await ok('mutation($id: ID!) { cancelOrder(id: $id) { id status } }', { id: order.id }, customer.token);
  assert.equal(cancelOrder.status, 'CANCELLED');
  assert.equal(await stockOf(a.id), 20);
  assert.equal(await stockOf(b.id), 20);
});

test('a customer sees only their own orders', async () => {
  const mine = await newCustomer();
  const other = await newCustomer();
  const product = await newProduct();
  const myOrder = await createOrder(mine, { items: [{ productId: product.id, quantity: 1 }] });
  const otherOrder = await createOrder(other, { items: [{ productId: product.id, quantity: 1 }] });

  const { orders } = await ok('{ orders(limit: 100) { id user { id } } }', {}, mine.token);
  assert.deepEqual(orders.map(o => o.id), [myOrder.id]);
  await forbidden('ORDER_VIEW_DENIED', ORDER, { id: otherOrder.id }, mine.token);
  await forbidden('OWN_ORDERS_ONLY', 'query($u: ID) { orders(userId: $u) { id } }', { u: other.id }, mine.token);
  await forbidden('NOT_RESOURCE_OWNER', CREATE, { input: { userId: other.id, mode: 'PICKUP', items: [{ productId: product.id, quantity: 1 }] } }, mine.token);
});

test('INSUFFICIENT_STOCK carries requested and available, also when a package and the loose product add up', async () => {
  const customer = await newCustomer();
  const product = await newProduct({ stock: 3 });
  const input = { userId: customer.id, mode: 'PICKUP', items: [{ productId: product.id, quantity: 5 }] };
  const ext = await fails('INSUFFICIENT_STOCK', CREATE, { input }, customer.token);
  assert.equal(ext.productId, product.id);
  assert.equal(ext.name, product.name);
  assert.equal(ext.requested, 5);
  assert.equal(ext.available, 3);

  // 2 sueltos + 1 paquete con 2 = 4 > 3: la disponibilidad se valida consolidada por producto.
  const other = await newProduct({ stock: 10 });
  const pkg = await newPackage([{ productId: product.id, quantity: 2 }, { productId: other.id, quantity: 1 }]);
  const combined = await fails('INSUFFICIENT_STOCK', CREATE, {
    input: { ...input, items: [{ productId: product.id, quantity: 2 }, { packageId: pkg.id, quantity: 1 }] },
  }, customer.token);
  assert.equal(combined.requested, 4);
  assert.equal(combined.available, 3);
  assert.equal(await stockOf(product.id), 3);
  assert.equal(await stockOf(other.id), 10);
});
