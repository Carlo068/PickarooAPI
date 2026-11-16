// Permisos: una operación denegada y una permitida por cada familia de
// permisos, y el alcance por sucursal del personal (README, sección 2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok, forbidden, tokenOf, login, uid, today, newCustomer, newUser, newProduct, seedStore, createOrder, moveOrder, UPDATE_STATUS, ADDRESS,
} from './client.js';

const permissionRequired = async (permission, query, variables, token) => {
  const ext = await forbidden('PERMISSION_REQUIRED', query, variables, token);
  assert.equal(ext.permission, permission);
};

test('users:manage: a customer cannot list users, an admin can', async () => {
  const USERS = '{ users(limit: 5) { id email } }';
  const customer = await newCustomer();
  await permissionRequired('users:manage', USERS, {}, customer.token);
  const { users } = await ok(USERS, {}, await tokenOf('ADMIN'));
  assert.ok(users.length > 0);
});

test('catalog:manage: staff cannot create a category, a manager can', async () => {
  const CREATE = 'mutation($input: CategoryInput!) { createCategory(input: $input) { id name } }';
  await permissionRequired('catalog:manage', CREATE, { input: { name: `Denegada ${uid()}` } }, await tokenOf('STAFF'));
  const name = `Categoria IT ${uid()}`;
  const { createCategory } = await ok(CREATE, { input: { name } }, await tokenOf('MANAGER'));
  assert.equal(createCategory.name, name);
});

test('stock:manage: a delivery driver cannot set stock, staff can', async () => {
  const product = await newProduct({ stock: 10 });
  const SET = 'mutation($id: ID!, $stock: Int!) { setProductStock(id: $id, stock: $stock) { id stock } }';
  await permissionRequired('stock:manage', SET, { id: product.id, stock: 3 }, await tokenOf('DELIVERY'));
  const { setProductStock } = await ok(SET, { id: product.id, stock: 7 }, await tokenOf('STAFF'));
  assert.equal(setProductStock.stock, 7);
});

test('reports:view: staff cannot see the sales report, a manager can', async () => {
  const REPORT = 'query($from: DateTime!, $to: DateTime!) { salesReport(from: $from, to: $to) { itemId revenue } }';
  const range = { from: '2020-01-01T00:00:00.000Z', to: new Date(Date.now() + 86_400_000).toISOString() };
  await permissionRequired('reports:view', REPORT, range, await tokenOf('STAFF'));
  const { salesReport } = await ok(REPORT, range, await tokenOf('MANAGER'));
  assert.ok(Array.isArray(salesReport));
});

test('stores:manage: a manager cannot create a store, an admin can', async () => {
  const CREATE = 'mutation($input: StoreInput!) { createStore(input: $input) { id name isActive } }';
  await permissionRequired('stores:manage', CREATE, { input: { name: `Denegada ${uid()}`, address: ADDRESS } }, await tokenOf('MANAGER'));
  const name = `Sucursal IT ${uid()}`;
  const { createStore } = await ok(CREATE, { input: { name, address: ADDRESS } }, await tokenOf('ADMIN'));
  assert.equal(createStore.name, name);
  assert.equal(createStore.isActive, true);
});

test('audit:view: a manager cannot read the audit log, an admin can', async () => {
  const AUDIT = 'query($day: String) { auditEvents(category: SECURITY, day: $day, limit: 5) { id type } }';
  await permissionRequired('audit:view', AUDIT, { day: today() }, await tokenOf('MANAGER'));
  const { auditEvents } = await ok(AUDIT, { day: today() }, await tokenOf('ADMIN'));
  assert.ok(Array.isArray(auditEvents));
});

test('orders:prepare: a delivery driver cannot confirm an order, staff can', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  const ext = await forbidden('ORDER_STATUS_CHANGE_DENIED', UPDATE_STATUS, { id: order.id, status: 'CONFIRMED' }, await tokenOf('DELIVERY'));
  assert.equal(ext.status, 'CONFIRMED');
  await moveOrder(order.id, ['CONFIRMED'], await tokenOf('STAFF'));
});

test('orders:deliver: staff cannot send an order out for delivery, the delivery driver can', async () => {
  const customer = await newCustomer();
  const product = await newProduct();
  const order = await createOrder(customer, { mode: 'DELIVERY', items: [{ productId: product.id, quantity: 1 }] });
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY'], await tokenOf('STAFF'));
  await forbidden('ORDER_STATUS_CHANGE_DENIED', UPDATE_STATUS, { id: order.id, status: 'IN_DELIVERY' }, await tokenOf('STAFF'));
  await moveOrder(order.id, ['IN_DELIVERY'], await tokenOf('DELIVERY'));
});

test('store scope: staff of another store cannot see or move orders of CARNYFRUT Centro', async () => {
  const admin = await tokenOf('ADMIN');
  const { createStore: norte } = await ok('mutation($input: StoreInput!) { createStore(input: $input) { id name } }', {
    input: { name: `Sucursal Norte IT ${uid()}`, address: ADDRESS },
  }, admin);
  const staff = await newUser('STAFF');
  const { assignUserToStore } = await ok('mutation($u: ID!, $s: ID!) { assignUserToStore(userId: $u, storeId: $s) { role stores { id } } }', { u: staff.id, s: norte.id }, admin);
  assert.deepEqual(assignUserToStore.stores.map(s => s.id), [norte.id]);
  const { token, access } = await login(staff.email, staff.password);
  assert.deepEqual(access.stores.map(s => s.id), [norte.id]);

  const centro = await seedStore();
  const customer = await newCustomer();
  const product = await newProduct();
  const inCentro = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  const inNorte = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }], storeId: norte.id });

  await forbidden('ORDER_STATUS_CHANGE_DENIED', UPDATE_STATUS, { id: inCentro.id, status: 'CONFIRMED' }, token);
  await forbidden('ORDER_VIEW_DENIED', 'query($id: ID!) { order(id: $id) { id } }', { id: inCentro.id }, token);
  const ext = await forbidden('STORE_NOT_ASSIGNED', 'query($s: ID) { orders(storeId: $s) { id } }', { s: centro.id }, token);
  assert.equal(ext.storeId, centro.id);

  // Lo de su sucursal sí: la ve en su listado y la puede confirmar.
  const { orders } = await ok('{ orders(limit: 100) { id store { id } } }', {}, token);
  assert.ok(orders.some(o => o.id === inNorte.id));
  assert.ok(orders.every(o => o.store.id === norte.id));
  await moveOrder(inNorte.id, ['CONFIRMED'], token);
  // El personal de Centro, en cambio, no ve la de Norte.
  await forbidden('ORDER_VIEW_DENIED', 'query($id: ID!) { order(id: $id) { id } }', { id: inNorte.id }, await tokenOf('STAFF'));
});
