// Catálogo: precio efectivo con descuentos y stock derivado de los paquetes
// (README, secciones 4 y 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, tokenOf, newProduct, newPackage, PRODUCT_FIELDS } from './client.js';

const SEED_PRODUCTS = [
  'Arrachera marinada', 'Chorizo argentino', 'Costilla de cerdo', 'Bistec de res', 'Pechuga de pollo', 'Limón con sal',
  'Plátano', 'Cebolla blanca', 'Nopales limpios', 'Tortillas de maíz', 'Carbón 3 kg',
];

test('products list the seed catalog with effectivePrice (15% on Plátano)', async () => {
  const { products } = await ok(`{ products(limit: 100) { ${PRODUCT_FIELDS} } }`);
  const byName = new Map(products.map(p => [p.name, p]));
  for (const name of SEED_PRODUCTS) assert.ok(byName.has(name), `missing seed product ${name}`);

  const platano = byName.get('Plátano');
  assert.equal(platano.price, 19.9);
  assert.equal(platano.activeDiscountPercent, 15);
  assert.ok(Math.abs(platano.effectivePrice - 19.9 * 0.85) < 0.006, `effectivePrice ${platano.effectivePrice}`);
  const arrachera = byName.get('Arrachera marinada');
  assert.equal(arrachera.activeDiscountPercent, 0);
  assert.equal(arrachera.effectivePrice, arrachera.price);
});

test('effectivePrice applies the best current discount and ignores future ones', async () => {
  const product = await newProduct({ price: 250 });
  const ADD = `mutation($id: ID!, $input: DiscountInput!) { addProductDiscount(productId: $id, input: $input) { ${PRODUCT_FIELDS} discounts { percent isCurrent } } }`;
  const admin = await tokenOf('ADMIN');
  await ok(ADD, { id: product.id, input: { percent: 10, label: 'IT 10' } }, admin);
  await ok(ADD, { id: product.id, input: { percent: 20, label: 'IT 20' } }, admin);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  const { addProductDiscount } = await ok(ADD, { id: product.id, input: { percent: 50, label: 'IT futuro', startsAt: tomorrow } }, admin);
  assert.deepEqual(addProductDiscount.discounts.map(d => [d.percent, d.isCurrent]), [[10, true], [20, true], [50, false]]);

  // product(id) lee del caché de Redis: la copia se invalidó al agregar el descuento.
  const { product: read } = await ok(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: product.id });
  assert.equal(read.activeDiscountPercent, 20);
  assert.equal(read.effectivePrice, 200);
});

test('the seed package availableStock is the scarcest of its products', async () => {
  const { packages } = await ok('{ packages { name price availableStock items { quantity product { stock isActive } } } }');
  const familiar = packages.find(p => p.name === 'Paquete Carne Asada Familiar (6 personas)');
  assert.ok(familiar, 'missing the seed package');
  assert.equal(familiar.items.length, 8);
  const expected = Math.min(...familiar.items.map(i => Math.floor(i.product.stock / i.quantity)));
  assert.equal(familiar.availableStock, expected);
});

test('a package availableStock follows its products stock and active flag', async () => {
  const a = await newProduct({ stock: 10 });
  const b = await newProduct({ stock: 3 });
  const pkg = await newPackage([{ productId: a.id, quantity: 2 }, { productId: b.id, quantity: 1 }]);
  assert.equal(pkg.availableStock, 3); // min(10 / 2, 3 / 1)

  const PKG = 'query($id: ID!) { package(id: $id) { availableStock } }';
  await ok('mutation($id: ID!) { setProductStock(id: $id, stock: 30) { id } }', { id: b.id }, await tokenOf('STAFF'));
  assert.equal((await ok(PKG, { id: pkg.id })).package.availableStock, 5);

  await ok('mutation($id: ID!) { setProductActive(id: $id, active: false) { id } }', { id: a.id }, await tokenOf('ADMIN'));
  assert.equal((await ok(PKG, { id: pkg.id })).package.availableStock, 0);
});
