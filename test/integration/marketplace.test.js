// Marketplace: cada sucursal es un negocio con su propio catálogo y stock
// (README, secciones 2, 4, 6 y 8). Listados por sucursal, un carrito / una
// cotización / una orden por sucursal, envío de la sucursal de los artículos,
// permisos de catálogo e inventario por sucursal y reportes por sucursal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok, fails, forbidden, tokenOf, uid, newCustomer, newProduct, newPackage, newStore, setStoreActive, stockOf,
  seedStore, huertaStore, createOrder, moveOrder, ORDER_FIELDS,
} from './client.js';

const CART_FIELDS = 'itemCount store { id } items { quantity product { id } package { id } } unavailable { productId reason } quote { quoteId deliveryFee total }';
const ADD = `mutation($p: ID, $k: ID) { addToCart(productId: $p, packageId: $k, quantity: 1) { ${CART_FIELDS} } }`;
const CART = `query($s: ID) { cart(mode: PICKUP, storeId: $s) { ${CART_FIELDS} } }`;
const QUOTE = 'query($input: QuoteInput!) { quoteOrder(input: $input) { mode deliveryFee subtotal total } }';
const CREATE = `mutation($input: CreateOrderInput!) { createOrder(input: $input) { ${ORDER_FIELDS} } }`;
const STORE_CATALOG = `query($id: ID!) { store(id: $id) {
  id name
  products(limit: 100) { id name store { id } }
  packages { id name store { id } }
  categories { name }
} }`;

const ids = list => list.map(x => x.id);

test('the seed has a second, independent business: Frutería La Huerta with its own catalog', async () => {
  const huerta = await huertaStore();
  assert.ok(huerta, 'missing the La Huerta store');
  assert.equal(huerta.deliveryFee, 25);
  assert.equal(huerta.freeDeliveryThreshold, 250);
  const { store } = await ok(STORE_CATALOG, { id: huerta.id });
  const names = store.products.map(p => p.name);
  for (const name of ['Manzana roja', 'Naranja para jugo', 'Aguacate Hass', 'Jitomate saladet', 'Chile jalapeño', 'Papa blanca']) {
    assert.ok(names.includes(name), `missing La Huerta product ${name}`);
  }
  assert.ok(store.products.every(p => p.store.id === huerta.id));
  assert.ok(store.packages.some(k => k.name === 'Canasta para guacamole y salsa'));
  const categories = store.categories.map(c => c.name);
  assert.ok(categories.includes('Frutas') && categories.includes('Verduras'));
  assert.ok(!categories.includes('Carnes'), 'Carnes has no La Huerta products');

  const centro = await seedStore();
  const { products } = await ok('query($s: ID) { products(storeId: $s, limit: 100) { name } }', { s: centro.id });
  assert.ok(!products.some(p => p.name === 'Manzana roja'), 'La Huerta products are not in the CARNYFRUT catalog');
});

test('products and packages list per store and across stores; an inactive store is hidden from the public', async () => {
  const token = `mkt${uid()}`;
  const [a, b] = [await newStore(), await newStore()];
  const pa = await newProduct({ storeId: a.id, name: `Producto ${token} A` });
  const pa2 = await newProduct({ storeId: a.id, name: `Producto ${token} A2` });
  const pb = await newProduct({ storeId: b.id, name: `Producto ${token} B` });
  const ka = await newPackage([{ productId: pa.id, quantity: 1 }, { productId: pa2.id, quantity: 1 }], 150, { storeId: a.id });

  const PRODUCTS = 'query($s: ID, $q: String) { products(storeId: $s, search: $q, limit: 100) { id store { id } } }';
  const PACKAGES = 'query($s: ID) { packages(storeId: $s) { id store { id } } }';
  assert.deepEqual(ids((await ok(PRODUCTS, { s: a.id, q: token })).products).sort(), [pa.id, pa2.id].sort());
  assert.deepEqual(ids((await ok(PRODUCTS, { s: b.id, q: token })).products), [pb.id]);
  assert.deepEqual(ids((await ok(PRODUCTS, { q: token })).products).sort(), [pa.id, pa2.id, pb.id].sort(), 'without storeId: every active store');
  assert.deepEqual(ids((await ok(PACKAGES, { s: a.id })).packages), [ka.id]);
  assert.deepEqual((await ok(PACKAGES, { s: b.id })).packages, []);
  assert.ok(ids((await ok('{ packages { id } }')).packages).includes(ka.id));

  const { store } = await ok(STORE_CATALOG, { id: a.id });
  assert.deepEqual(ids(store.products).sort(), [pa.id, pa2.id].sort());
  assert.deepEqual(ids(store.packages), [ka.id]);
  assert.deepEqual(store.categories.map(c => c.name), ['Abarrotes']);

  await setStoreActive(a.id, false);
  assert.deepEqual(ids((await ok(PRODUCTS, { q: token })).products), [pb.id], 'an inactive store is not listed across stores');
  assert.deepEqual((await ok(PRODUCTS, { s: a.id, q: token })).products, []);
  assert.ok(!ids((await ok('{ packages { id } }')).packages).includes(ka.id));
  const hidden = (await ok(STORE_CATALOG, { id: a.id })).store;
  assert.deepEqual([hidden.products, hidden.packages, hidden.categories], [[], [], []]);
  const customer = await newCustomer();
  assert.deepEqual((await ok(PRODUCTS, { s: a.id, q: token }, customer.token)).products, []);
  // Quien administra su catálogo (ADMIN: todas las sucursales) sí lo ve.
  assert.deepEqual(ids((await ok(PRODUCTS, { s: a.id, q: token }, await tokenOf('ADMIN'))).products).sort(), [pa.id, pa2.id].sort());
});

test('a cart holds one store: another store item gives CART_STORE_MISMATCH, clearing the cart allows it', async () => {
  const customer = await newCustomer();
  const [a, b] = [await newStore(), await newStore()];
  const pa = await newProduct({ storeId: a.id });
  const pb = await newProduct({ storeId: b.id });

  let cart = (await ok(ADD, { p: pa.id }, customer.token)).addToCart;
  assert.equal(cart.store.id, a.id);
  const ext = await fails('CART_STORE_MISMATCH', ADD, { p: pb.id }, customer.token);
  assert.equal(ext.cartStoreId, a.id);
  assert.equal(ext.itemStoreId, pb.store.id);
  cart = (await ok(CART, {}, customer.token)).cart;
  assert.deepEqual(cart.items.map(i => i.product.id), [pa.id], 'the rejected item is not added');

  const hint = await fails('STORE_MISMATCH', CART, { s: b.id }, customer.token);
  assert.deepEqual([hint.expectedStoreId, hint.itemsStoreId], [b.id, a.id]);
  assert.equal((await ok(CART, { s: a.id }, customer.token)).cart.store.id, a.id);

  await ok('mutation { clearCart }', {}, customer.token);
  assert.equal((await ok(CART, {}, customer.token)).cart.store, null);
  cart = (await ok(ADD, { p: pb.id }, customer.token)).addToCart;
  assert.equal(cart.store.id, b.id);
  assert.deepEqual(cart.items.map(i => i.product.id), [pb.id]);
});

test('quotes, orders and packages reject mixing stores (MIXED_STORES, STORE_MISMATCH, PACKAGE_STORE_MISMATCH)', async () => {
  const customer = await newCustomer();
  const [a, b] = [await newStore(), await newStore()];
  const pa = await newProduct({ storeId: a.id, stock: 5 });
  const pa2 = await newProduct({ storeId: a.id, stock: 5 });
  const pb = await newProduct({ storeId: b.id, stock: 5 });
  const mixed = [{ productId: pa.id, quantity: 1 }, { productId: pb.id, quantity: 1 }];

  const quoteExt = await fails('MIXED_STORES', QUOTE, { input: { mode: 'PICKUP', items: mixed } });
  assert.deepEqual(quoteExt.storeIds, [a.id, b.id].sort());
  const orderExt = await fails('MIXED_STORES', CREATE, { input: { userId: customer.id, mode: 'PICKUP', items: mixed } }, customer.token);
  assert.deepEqual(orderExt.storeIds, [a.id, b.id].sort());

  const hint = await fails('STORE_MISMATCH', QUOTE, { input: { mode: 'PICKUP', storeId: b.id, items: [{ productId: pa.id, quantity: 1 }] } });
  assert.deepEqual([hint.expectedStoreId, hint.itemsStoreId], [b.id, a.id]);
  await fails('STORE_MISMATCH', CREATE, { input: { userId: customer.id, mode: 'PICKUP', storeId: b.id, items: [{ productId: pa.id, quantity: 1 }] } }, customer.token);
  assert.equal(await stockOf(pa.id), 5);
  assert.equal(await stockOf(pb.id), 5);

  const pkgExt = await fails('PACKAGE_STORE_MISMATCH', 'mutation($input: PackageInput!) { createPackage(input: $input) { id } }', {
    input: { storeId: a.id, name: `Paquete mixto ${uid()}`, price: 100, items: [{ productId: pa.id, quantity: 1 }, { productId: pb.id, quantity: 1 }] },
  }, await tokenOf('ADMIN'));
  assert.deepEqual([pkgExt.storeId, pkgExt.productIds], [a.id, [pb.id]]);
  const pkg = await newPackage([{ productId: pa.id, quantity: 1 }, { productId: pa2.id, quantity: 1 }], 120, { storeId: a.id });
  await fails('PACKAGE_STORE_MISMATCH', 'mutation($id: ID!, $input: PackageUpdateInput!) { updatePackage(id: $id, input: $input) { id } }', {
    id: pkg.id, input: { items: [{ productId: pa.id, quantity: 1 }, { productId: pb.id, quantity: 1 }] },
  }, await tokenOf('ADMIN'));

  // Una sola sucursal y sin pista: la orden es de la sucursal de los artículos.
  const order = await createOrder(customer, { items: [{ productId: pa.id, quantity: 1 }, { packageId: pkg.id, quantity: 1 }] });
  assert.equal(order.store.id, a.id);
});

test('the delivery fee and the free delivery threshold come from the items store', async () => {
  const customer = await newCustomer();
  const a = await newStore({ deliveryFee: 20 });
  const b = await newStore({ deliveryFee: 55, freeDeliveryThreshold: 300 });
  const pa = await newProduct({ storeId: a.id, price: 100 });
  const pb = await newProduct({ storeId: b.id, price: 100 });

  const quoteA = (await ok(QUOTE, { input: { mode: 'DELIVERY', items: [{ productId: pa.id, quantity: 1 }] } })).quoteOrder;
  assert.deepEqual([quoteA.deliveryFee, quoteA.total], [20, 120]);
  const quoteB = (await ok(QUOTE, { input: { mode: 'DELIVERY', items: [{ productId: pb.id, quantity: 1 }] } })).quoteOrder;
  assert.deepEqual([quoteB.deliveryFee, quoteB.total], [55, 155]);
  const freeB = (await ok(QUOTE, { input: { mode: 'DELIVERY', items: [{ productId: pb.id, quantity: 3 }] } })).quoteOrder;
  assert.equal(freeB.deliveryFee, 0, 'subtotal 300 reaches the threshold of store B');

  const order = await createOrder(customer, { mode: 'DELIVERY', items: [{ productId: pb.id, quantity: 1 }] });
  assert.equal(order.store.id, b.id);
  assert.deepEqual([order.deliveryFee, order.total], [55, 155]);
});

test('catalog:manage and stock:manage apply only to the stores the user works at', async () => {
  const centro = await seedStore();
  const huerta = await huertaStore();
  const fromCentro = await newProduct({ storeId: centro.id, stock: 10 });
  const fromHuerta = await newProduct({ storeId: huerta.id, stock: 10 });
  const managerHuerta = await tokenOf('HUERTA_MANAGER');
  const staffHuerta = await tokenOf('HUERTA_STAFF');
  const notAssigned = async (storeId, query, variables, token) => {
    const ext = await forbidden('STORE_NOT_ASSIGNED', query, variables, token);
    assert.equal(ext.storeId, storeId);
  };

  const CREATE_PRODUCT = 'mutation($input: ProductInput!) { createProduct(input: $input) { id store { id } } }';
  const { categories } = await ok('{ categories { id name } }');
  const frutas = categories.find(c => c.name === 'Frutas').id;
  const input = storeId => ({ input: { storeId, categoryId: frutas, name: `Fruta IT ${uid()}`, price: 30, stock: 4 } });
  await notAssigned(centro.id, CREATE_PRODUCT, input(centro.id), managerHuerta);
  const { createProduct } = await ok(CREATE_PRODUCT, input(huerta.id), managerHuerta);
  assert.equal(createProduct.store.id, huerta.id);

  const UPDATE = 'mutation($id: ID!, $input: ProductUpdateInput!) { updateProduct(id: $id, input: $input) { id price } }';
  await notAssigned(centro.id, UPDATE, { id: fromCentro.id, input: { price: 1 } }, managerHuerta);
  assert.equal((await ok(UPDATE, { id: fromHuerta.id, input: { price: 120 } }, managerHuerta)).updateProduct.price, 120);
  await notAssigned(centro.id, 'mutation($id: ID!) { setProductActive(id: $id, active: false) { id } }', { id: fromCentro.id }, managerHuerta);
  await notAssigned(centro.id, 'mutation($id: ID!, $input: DiscountInput!) { addProductDiscount(productId: $id, input: $input) { id } }', { id: fromCentro.id, input: { percent: 10 } }, managerHuerta);
  await notAssigned(centro.id, 'mutation($input: PackageInput!) { createPackage(input: $input) { id } }', {
    input: { storeId: centro.id, name: `Paquete IT ${uid()}`, price: 50, items: [{ productId: fromCentro.id, quantity: 1 }, { productId: (await newProduct()).id, quantity: 1 }] },
  }, managerHuerta);

  const STOCK = 'mutation($id: ID!, $stock: Int!) { setProductStock(id: $id, stock: $stock) { id stock } }';
  await notAssigned(centro.id, STOCK, { id: fromCentro.id, stock: 0 }, staffHuerta);
  assert.equal((await ok(STOCK, { id: fromHuerta.id, stock: 7 }, staffHuerta)).setProductStock.stock, 7);
  await notAssigned(huerta.id, STOCK, { id: fromHuerta.id, stock: 0 }, await tokenOf('STAFF'));
  assert.equal(await stockOf(fromCentro.id), 10);
  assert.equal(await stockOf(fromHuerta.id), 7);
});

test('reports are per store: a manager sees their stores, an admin every store or the one asked for', async () => {
  const centro = await seedStore();
  const huerta = await huertaStore();
  const from = new Date(Date.now() - 60_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const customer = await newCustomer();
  const c1 = await newProduct({ storeId: centro.id, stock: 20 });
  const c2 = await newProduct({ storeId: centro.id, stock: 20 });
  const h1 = await newProduct({ storeId: huerta.id, stock: 20 });
  const h2 = await newProduct({ storeId: huerta.id, stock: 20 });
  const kc = await newPackage([{ productId: c1.id, quantity: 2 }, { productId: c2.id, quantity: 1 }], 150, { storeId: centro.id });
  const kh = await newPackage([{ productId: h1.id, quantity: 3 }, { productId: h2.id, quantity: 1 }], 150, { storeId: huerta.id });
  const inCentro = await createOrder(customer, { items: [{ productId: c1.id, quantity: 2 }, { packageId: kc.id, quantity: 1 }] });
  const inHuerta = await createOrder(customer, { items: [{ productId: h1.id, quantity: 3 }, { packageId: kh.id, quantity: 2 }] });
  await moveOrder(inCentro.id, ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERED'], await tokenOf('STAFF'));
  await moveOrder(inHuerta.id, ['CONFIRMED', 'PREPARING', 'READY', 'DELIVERED'], await tokenOf('HUERTA_STAFF'));

  const SALES = 'query($from: DateTime!, $to: DateTime!, $s: ID) { salesReport(from: $from, to: $to, storeId: $s) { storeId storeName type itemId quantity } }';
  const DEMAND = 'query($from: DateTime!, $to: DateTime!, $s: ID) { packageComponentDemand(from: $from, to: $to, storeId: $s) { storeId storeName productId quantityNeeded } }';
  const row = (rows, itemId) => rows.find(r => r.itemId === itemId || r.productId === itemId);

  const manager = await tokenOf('MANAGER');
  const mine = (await ok(SALES, { from, to }, manager)).salesReport;
  assert.ok(mine.length > 0);
  assert.ok(mine.every(r => r.storeId === centro.id && r.storeName === 'CARNYFRUT Centro'));
  assert.equal(row(mine, c1.id).quantity, 2);
  assert.equal(row(mine, h1.id), undefined, 'a CARNYFRUT manager does not see La Huerta sales');
  const ext = await forbidden('STORE_NOT_ASSIGNED', SALES, { from, to, s: huerta.id }, manager);
  assert.equal(ext.storeId, huerta.id);
  await forbidden('STORE_NOT_ASSIGNED', DEMAND, { from, to, s: huerta.id }, manager);
  const myDemand = (await ok(DEMAND, { from, to }, manager)).packageComponentDemand;
  assert.ok(myDemand.every(r => r.storeId === centro.id));
  assert.equal(row(myDemand, c1.id).quantityNeeded, 2);
  assert.equal(row(myDemand, h1.id), undefined);

  const huertaManager = (await ok(SALES, { from, to }, await tokenOf('HUERTA_MANAGER'))).salesReport;
  assert.ok(huertaManager.every(r => r.storeId === huerta.id));
  assert.equal(row(huertaManager, h1.id).quantity, 3);

  const admin = await tokenOf('ADMIN');
  const all = (await ok(SALES, { from, to }, admin)).salesReport;
  assert.deepEqual([row(all, c1.id)?.storeId, row(all, h1.id)?.storeId, row(all, kh.id)?.storeName], [centro.id, huerta.id, 'Frutería La Huerta']);
  const onlyHuerta = (await ok(SALES, { from, to, s: huerta.id }, admin)).salesReport;
  assert.ok(onlyHuerta.every(r => r.storeId === huerta.id));
  assert.equal(row(onlyHuerta, kh.id).quantity, 2);
  const huertaDemand = (await ok(DEMAND, { from, to, s: huerta.id }, admin)).packageComponentDemand;
  assert.deepEqual([row(huertaDemand, h1.id).quantityNeeded, row(huertaDemand, h1.id).storeName], [6, 'Frutería La Huerta']);
  assert.equal(row(huertaDemand, c1.id), undefined);
});
