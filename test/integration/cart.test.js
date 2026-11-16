// Carrito en Redis y compra con cotización (README, secciones 2 y 6).
// Cada prueba usa su propio cliente y sus propios productos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, fails, tokenOf, newCustomer, newProduct, newPackage, stockOf, ORDER_FIELDS } from './client.js';

const CART_FIELDS = `itemCount
  items { type quantity available product { id } package { id } }
  unavailable { productId packageId reason availableQuantity }
  quote { quoteId total subtotal deliveryFee }
  quoteError`;

const CART = `query { cart(mode: PICKUP) { ${CART_FIELDS} } }`;
const ADD = `mutation($p: ID, $k: ID, $q: Int) { addToCart(productId: $p, packageId: $k, quantity: $q) { ${CART_FIELDS} } }`;
const SET = `mutation($p: ID, $k: ID, $q: Int!) { setCartItemQuantity(productId: $p, packageId: $k, quantity: $q) { ${CART_FIELDS} } }`;
const REMOVE = `mutation($p: ID, $k: ID) { removeFromCart(productId: $p, packageId: $k) { ${CART_FIELDS} } }`;
const CHECKOUT = `mutation($input: CheckoutCartInput!) { checkoutCart(input: $input) { ${ORDER_FIELDS} items { type quantity lineTotal } } }`;

const lines = cart => cart.items.map(i => `${i.type}:${(i.product ?? i.package).id}x${i.quantity}`).sort();

test('add, set quantity and remove cart lines', async () => {
  const { token } = await newCustomer();
  const p = await newProduct({ stock: 50 });
  const q = await newProduct({ stock: 50 });
  const pkg = await newPackage([{ productId: p.id, quantity: 1 }, { productId: q.id, quantity: 1 }]);

  let cart = (await ok(ADD, { p: p.id, q: 2 }, token)).addToCart;
  assert.deepEqual(lines(cart), [`PRODUCT:${p.id}x2`]);
  cart = (await ok(ADD, { p: p.id, q: 1 }, token)).addToCart; // suma
  assert.deepEqual(lines(cart), [`PRODUCT:${p.id}x3`]);
  cart = (await ok(SET, { p: p.id, q: 5 }, token)).setCartItemQuantity; // fija
  assert.deepEqual(lines(cart), [`PRODUCT:${p.id}x5`]);
  cart = (await ok(ADD, { k: pkg.id, q: 1 }, token)).addToCart;
  assert.deepEqual(lines(cart), [`PACKAGE:${pkg.id}x1`, `PRODUCT:${p.id}x5`].sort());
  assert.equal(cart.itemCount, 6);

  cart = (await ok(REMOVE, { p: p.id }, token)).removeFromCart;
  assert.deepEqual(lines(cart), [`PACKAGE:${pkg.id}x1`]);
  cart = (await ok(SET, { k: pkg.id, q: 0 }, token)).setCartItemQuantity; // 0 quita la partida
  assert.deepEqual(cart.items, []);
  assert.equal(cart.quote, null);
});

test('checkoutCart with the cart quoteId creates the order, empties the cart and lowers stock (package contents included)', async () => {
  const customer = await newCustomer();
  const a = await newProduct({ price: 50, stock: 20 });
  const b = await newProduct({ price: 30, stock: 10 });
  const pkg = await newPackage([{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 1 }], 110);
  await ok(ADD, { p: a.id, q: 3 }, customer.token);
  await ok(ADD, { k: pkg.id, q: 2 }, customer.token);

  const { cart } = await ok(CART, {}, customer.token);
  assert.ok(cart.quote?.quoteId, 'cart returns a quoteId');
  assert.equal(cart.quote.total, 3 * 50 + 2 * 110);

  const { checkoutCart: order } = await ok(CHECKOUT, { input: { mode: 'PICKUP', quoteId: cart.quote.quoteId } }, customer.token);
  assert.equal(order.status, 'PENDING');
  assert.equal(order.user.id, customer.id);
  assert.equal(order.total, cart.quote.total);
  assert.deepEqual(order.items.map(i => `${i.type}x${i.quantity}`).sort(), ['PACKAGEx2', 'PRODUCTx3']);

  const after = (await ok(CART, {}, customer.token)).cart;
  assert.equal(after.itemCount, 0);
  assert.deepEqual(after.items, []);
  assert.equal(await stockOf(a.id), 20 - 3 - 2 * 2);
  assert.equal(await stockOf(b.id), 10 - 2 * 1);
});

test('a price change between quote and checkout gives PRICE_CHANGED with newQuote; the new quoteId works', async () => {
  const customer = await newCustomer();
  const product = await newProduct({ price: 100, stock: 5 });
  await ok(ADD, { p: product.id, q: 2 }, customer.token);
  const { quote } = (await ok(CART, {}, customer.token)).cart;
  assert.equal(quote.total, 200);

  await ok('mutation($id: ID!, $input: ProductUpdateInput!) { updateProduct(id: $id, input: $input) { price } }', { id: product.id, input: { price: 120 } }, await tokenOf('MANAGER'));

  const ext = await fails('PRICE_CHANGED', CHECKOUT, { input: { mode: 'PICKUP', quoteId: quote.quoteId } }, customer.token);
  assert.ok(ext.newQuote?.quoteId);
  assert.notEqual(ext.newQuote.quoteId, quote.quoteId);
  assert.equal(ext.newQuote.total, 240);
  assert.equal(ext.newQuote.items[0].unitPrice, 120);
  assert.equal((await ok(CART, {}, customer.token)).cart.itemCount, 2, 'the cart is kept after a rejected checkout');
  assert.equal(await stockOf(product.id), 5);

  const { checkoutCart: order } = await ok(CHECKOUT, { input: { mode: 'PICKUP', quoteId: ext.newQuote.quoteId } }, customer.token);
  assert.equal(order.total, 240);
  assert.equal((await ok(CART, {}, customer.token)).cart.itemCount, 0);
  assert.equal(await stockOf(product.id), 3);
});

test('an unavailable item in the cart gives CART_HAS_UNAVAILABLE_ITEMS and keeps the cart', async () => {
  const customer = await newCustomer();
  const kept = await newProduct({ stock: 5 });
  const gone = await newProduct({ stock: 5 });
  await ok(ADD, { p: kept.id, q: 1 }, customer.token);
  await ok(ADD, { p: gone.id, q: 1 }, customer.token);
  await ok('mutation($id: ID!) { setProductActive(id: $id, active: false) { id } }', { id: gone.id }, await tokenOf('MANAGER'));

  const { cart } = await ok(CART, {}, customer.token);
  assert.deepEqual(cart.unavailable, [{ productId: gone.id, packageId: null, reason: 'INACTIVE', availableQuantity: 0 }]);
  assert.equal(cart.items.find(i => i.product.id === gone.id).available, false);
  assert.ok(cart.quote?.quoteId, 'the available lines are still quoted');

  const ext = await fails('CART_HAS_UNAVAILABLE_ITEMS', CHECKOUT, { input: { mode: 'PICKUP', quoteId: cart.quote.quoteId } }, customer.token);
  assert.deepEqual(ext.unavailable, [{ productId: gone.id, packageId: null, reason: 'INACTIVE', availableQuantity: 0 }]);
  assert.equal((await ok(CART, {}, customer.token)).cart.items.length, 2);
  assert.equal(await stockOf(kept.id), 5);
});
