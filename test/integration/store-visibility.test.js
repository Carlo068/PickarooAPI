// Marketplace: visibilidad de los artículos de una sucursal inactiva, activeOnly
// y carrito (README, sección 2 "Sucursales inactivas y activeOnly").
// Por id, un producto o paquete de una sucursal inactiva es null salvo para quien
// administra sus artículos (o scope:all_stores); dentro de una orden ya hecha se
// conserva. activeOnly: false solo cuenta para quien administra esa sucursal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, fails, tokenOf, uid, login, newUser, newCustomer, newProduct, newPackage, newStore, setStoreActive,
  createOrder, ORDER_FIELDS,
} from './client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'services', 'mongoAPI', 'package.json'));
const { createClient } = require('redis');

const ids = list => list.map(x => x.id);
const sorted = list => ids(list).sort();

// Gerente asignado solo a `storeId` (sesión nueva: el acceso se resuelve al iniciar sesión).
async function managerOf(storeId) {
  const user = await newUser('MANAGER');
  await ok('mutation($u: ID!, $s: ID!) { assignUserToStore(userId: $u, storeId: $s) { role } }', { u: user.id, s: storeId }, await tokenOf('ADMIN'));
  return (await login(user.email, user.password)).token;
}

const setProductActive = async (id, active) => ok('mutation($id: ID!, $a: Boolean!) { setProductActive(id: $id, active: $a) { id } }', { id, a: active }, await tokenOf('ADMIN'));
const setPackageActive = async (id, active) => ok('mutation($id: ID!, $a: Boolean!) { setPackageActive(id: $id, active: $a) { id } }', { id, a: active }, await tokenOf('ADMIN'));

const PRODUCT = 'query($id: ID!) { product(id: $id) { id packages { id } } }';
const PACKAGE = 'query($id: ID!) { package(id: $id) { id items { product { id } } } }';

test('product(id) and package(id) of an inactive store are null unless the caller manages it (or has scope:all_stores)', async () => {
  const store = await newStore();
  const p1 = await newProduct({ storeId: store.id });
  const p2 = await newProduct({ storeId: store.id });
  const pkg = await newPackage([{ productId: p1.id, quantity: 1 }, { productId: p2.id, quantity: 1 }], 150, { storeId: store.id });
  const customer = await newCustomer();
  const manager = await managerOf(store.id);
  const otherManager = await tokenOf('HUERTA_MANAGER');

  // Activa: la ven todos.
  assert.equal((await ok(PRODUCT, { id: p1.id })).product.id, p1.id);
  assert.deepEqual(ids((await ok(PRODUCT, { id: p1.id }, customer.token)).product.packages), [pkg.id]);
  assert.equal((await ok(PACKAGE, { id: pkg.id })).package.id, pkg.id);

  await setStoreActive(store.id, false);
  for (const [who, token] of [['anonymous', undefined], ['customer', customer.token], ['manager of another store', otherManager]]) {
    assert.equal((await ok(PRODUCT, { id: p1.id }, token)).product, null, `${who}: product`);
    assert.equal((await ok(PACKAGE, { id: pkg.id }, token)).package, null, `${who}: package`);
  }
  for (const [who, token] of [['manager of the store', manager], ['admin (scope:all_stores)', await tokenOf('ADMIN')]]) {
    const { product } = await ok(PRODUCT, { id: p1.id }, token);
    assert.deepEqual([product.id, ids(product.packages)], [p1.id, [pkg.id]], `${who}: product with its packages`);
    const { package: pk } = await ok(PACKAGE, { id: pkg.id }, token);
    assert.deepEqual([pk.id, ids(pk.items.map(i => i.product)).sort()], [pkg.id, [p1.id, p2.id].sort()], `${who}: package`);
  }

  await setStoreActive(store.id, true);
  assert.equal((await ok(PRODUCT, { id: p1.id })).product.id, p1.id, 'reactivated: visible again');
});

test('an order already placed keeps showing its items after the store closes', async () => {
  const store = await newStore();
  const p1 = await newProduct({ storeId: store.id });
  const p2 = await newProduct({ storeId: store.id });
  const pkg = await newPackage([{ productId: p1.id, quantity: 1 }, { productId: p2.id, quantity: 1 }], 150, { storeId: store.id });
  const customer = await newCustomer();
  const order = await createOrder(customer, { items: [{ productId: p1.id, quantity: 1 }, { packageId: pkg.id, quantity: 1 }] });
  await setStoreActive(store.id, false);

  assert.equal((await ok(PRODUCT, { id: p1.id }, customer.token)).product, null, 'outside the order the item is hidden');
  const { order: mine } = await ok(`query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} items { name product { id } package { id } contents { productId product { id } } } } }`, { id: order.id }, customer.token);
  assert.deepEqual(mine.items.map(i => [i.product?.id ?? null, i.package?.id ?? null]), [[p1.id, null], [null, pkg.id]]);
  assert.deepEqual(mine.items[1].contents.map(c => c.product.id).sort(), [p1.id, p2.id].sort());
  assert.ok(mine.items.every(i => i.name));
});

test('activeOnly: false is honoured only where the caller manages the store; anyone else gets activeOnly: true', async () => {
  const token = `act${uid()}`;
  const [a, b] = [await newStore(), await newStore()];
  const a1 = await newProduct({ storeId: a.id, name: `Producto ${token} a1` });
  const a2 = await newProduct({ storeId: a.id, name: `Producto ${token} a2` });
  const b1 = await newProduct({ storeId: b.id, name: `Producto ${token} b1` });
  const b2 = await newProduct({ storeId: b.id, name: `Producto ${token} b2` });
  const ka = await newPackage([{ productId: a1.id, quantity: 1 }, { productId: a2.id, quantity: 1 }], 150, { storeId: a.id });
  const kaOff = await newPackage([{ productId: a1.id, quantity: 1 }, { productId: a2.id, quantity: 1 }], 140, { storeId: a.id });
  const kb = await newPackage([{ productId: b1.id, quantity: 1 }, { productId: b2.id, quantity: 1 }], 150, { storeId: b.id });
  const kbOff = await newPackage([{ productId: b1.id, quantity: 1 }, { productId: b2.id, quantity: 1 }], 140, { storeId: b.id });
  await Promise.all([a2, b2].map(p => setProductActive(p.id, false)));
  await Promise.all([kaOff, kbOff].map(k => setPackageActive(k.id, false)));

  const customer = await newCustomer();
  const managerA = await managerOf(a.id);
  const admin = await tokenOf('ADMIN');
  const huertaManager = await tokenOf('HUERTA_MANAGER');

  const PRODUCTS = 'query($s: ID, $q: String) { products(storeId: $s, search: $q, activeOnly: false, limit: 100) { id } }';
  const PACKAGES = 'query($s: ID) { packages(storeId: $s, activeOnly: false) { id } }';
  const STORE = 'query($id: ID!) { store(id: $id) { products(activeOnly: false, limit: 100) { id } packages(activeOnly: false) { id } } }';
  // De la lista, solo los artículos de esta prueba (los paquetes de otras pruebas también se listan).
  const among = (list, ...wanted) => sorted(list.filter(x => wanted.some(w => w.id === x.id)));
  const only = (...xs) => xs.map(x => x.id).sort();

  // Sin sesión, cliente y gerente de otra sucursal: solo lo activo.
  for (const [who, t] of [['anonymous', undefined], ['customer', customer.token], ['manager of another store', huertaManager]]) {
    assert.deepEqual(among((await ok(PRODUCTS, { s: a.id, q: token }, t)).products, a1, a2), only(a1), `${who}: products(storeId)`);
    assert.deepEqual(among((await ok(PACKAGES, { s: a.id }, t)).packages, ka, kaOff), only(ka), `${who}: packages(storeId)`);
    const { store } = await ok(STORE, { id: a.id }, t);
    assert.deepEqual(among(store.products, a1, a2), only(a1), `${who}: Store.products`);
    assert.deepEqual(among(store.packages, ka, kaOff), only(ka), `${who}: Store.packages`);
    assert.deepEqual(among((await ok(PRODUCTS, { q: token }, t)).products, a1, a2, b1, b2), only(a1, b1), `${who}: products without storeId`);
    assert.deepEqual(among((await ok(PACKAGES, {}, t)).packages, ka, kaOff, kb, kbOff), only(ka, kb), `${who}: packages without storeId`);
  }

  // Gerente de A: lo desactivado de A, pero no de B.
  assert.deepEqual(among((await ok(PRODUCTS, { s: a.id, q: token }, managerA)).products, a1, a2), only(a1, a2));
  assert.deepEqual(among((await ok(PRODUCTS, { s: b.id, q: token }, managerA)).products, b1, b2), only(b1), 'manager of A on store B');
  assert.deepEqual(among((await ok(PACKAGES, { s: a.id }, managerA)).packages, ka, kaOff), only(ka, kaOff));
  assert.deepEqual(among((await ok(PACKAGES, { s: b.id }, managerA)).packages, kb, kbOff), only(kb), 'manager of A on store B');
  const { store: mine } = await ok(STORE, { id: a.id }, managerA);
  assert.deepEqual([among(mine.products, a1, a2), among(mine.packages, ka, kaOff)], [only(a1, a2), only(ka, kaOff)]);
  assert.deepEqual(among((await ok(PRODUCTS, { q: token }, managerA)).products, a1, a2, b1, b2), only(a1, a2, b1), 'without storeId: inactive items only from the managed stores');
  assert.deepEqual(among((await ok(PACKAGES, {}, managerA)).packages, ka, kaOff, kb, kbOff), only(ka, kaOff, kb), 'packages without storeId');

  // scope:all_stores: todo.
  assert.deepEqual(among((await ok(PRODUCTS, { q: token }, admin)).products, a1, a2, b1, b2), only(a1, a2, b1, b2));
  assert.deepEqual(among((await ok(PACKAGES, {}, admin)).packages, ka, kaOff, kb, kbOff), only(ka, kaOff, kb, kbOff));
  assert.deepEqual(among((await ok(PRODUCTS, { s: b.id, q: token }, admin)).products, b1, b2), only(b1, b2));
});

const ADD = 'mutation($p: ID, $k: ID) { addToCart(productId: $p, packageId: $k, quantity: 1) { itemCount } }';
const SET_QTY = 'mutation($p: ID) { setCartItemQuantity(productId: $p, quantity: 2) { itemCount } }';

test('addToCart and setCartItemQuantity reject items of an inactive store with STORE_INACTIVE', async () => {
  const store = await newStore();
  const p1 = await newProduct({ storeId: store.id });
  const p2 = await newProduct({ storeId: store.id });
  const pkg = await newPackage([{ productId: p1.id, quantity: 1 }, { productId: p2.id, quantity: 1 }], 150, { storeId: store.id });
  const customer = await newCustomer();
  await ok(ADD, { p: p1.id }, customer.token);

  await setStoreActive(store.id, false);
  for (const vars of [{ p: p2.id }, { k: pkg.id }]) {
    const ext = await fails('STORE_INACTIVE', ADD, vars, customer.token);
    assert.deepEqual([ext.storeId, ext.name], [store.id, store.name]);
  }
  await fails('STORE_INACTIVE', SET_QTY, { p: p1.id }, customer.token);
  assert.equal((await ok('query { cart(mode: PICKUP) { itemCount } }', {}, customer.token)).cart.itemCount, 1, 'nothing was added');

  await setStoreActive(store.id, true);
  assert.equal((await ok(ADD, { p: p2.id }, customer.token)).addToCart.itemCount, 2);
});

test('a legacy cart that mixes two stores: OTHER_STORE lines, CART_HAS_UNAVAILABLE_ITEMS and STORE_MISMATCH', async () => {
  const customer = await newCustomer();
  const [a, b, c] = [await newStore(), await newStore(), await newStore()];
  const a1 = await newProduct({ storeId: a.id, stock: 10 });
  const a2 = await newProduct({ storeId: a.id, stock: 10 });
  const b1 = await newProduct({ storeId: b.id, stock: 10 });

  // Carrito anterior al marketplace: se escribe directo en Redis (base lógica de la API de pruebas).
  const redis = createClient({ url: process.env.IT_REDIS_URL });
  redis.on('error', () => {});
  await redis.connect();
  const key = `cart:${customer.id}`;
  try {
    await redis.hSet(key, { [`p:${a1.id}`]: '1', [`p:${a2.id}`]: '1', [`p:${b1.id}`]: '1' });
    await redis.expire(key, 3600);

    const CART = 'query($s: ID) { cart(mode: PICKUP, storeId: $s) { store { id } items { product { id } available } unavailable { productId reason } } }';
    const { cart } = await ok(CART, {}, customer.token);
    assert.equal(cart.store.id, a.id, 'the store with more lines');
    assert.deepEqual(cart.unavailable.map(u => [u.productId, u.reason]), [[b1.id, 'OTHER_STORE']]);
    assert.deepEqual(cart.items.map(i => [i.product.id, i.available]).sort(), [[a1.id, true], [a2.id, true], [b1.id, false]].sort());

    const CHECKOUT = 'mutation($input: CheckoutCartInput!) { checkoutCart(input: $input) { id } }';
    const ext = await fails('CART_HAS_UNAVAILABLE_ITEMS', CHECKOUT, { input: { mode: 'PICKUP' } }, customer.token);
    assert.deepEqual(ext.unavailable.map(u => [u.productId, u.reason]), [[b1.id, 'OTHER_STORE']]);

    const hint = await fails('STORE_MISMATCH', CHECKOUT, { input: { mode: 'PICKUP', storeId: c.id } }, customer.token);
    assert.equal(hint.expectedStoreId, c.id);
    await fails('STORE_MISMATCH', CART, { s: c.id }, customer.token);
    assert.equal((await ok('query($id: ID!) { product(id: $id) { stock } }', { id: a1.id })).product.stock, 10, 'no stock was taken');
  } finally {
    await redis.del(key);
    await redis.quit();
  }
});
