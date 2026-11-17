// Migración del marketplace (README, sección 3): productos y paquetes sin
// storeId pasan a la sucursal más antigua. Se insertan documentos sin
// sucursal directo en pickaroodb_it y se corre `services/mongoAPI/src/migrate.js`
// (lo que ejecuta `npm run migrate`) dos veces: la segunda no cambia nada.
// Nunca toca la base del dev: el URI es el de pickaroodb_it (run.js) y el
// proceso no lee ningún .env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, uid, newCustomer, newProduct, createOrder, tokenOf, UPDATE_STATUS } from './client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MONGO_API = path.join(ROOT, 'services', 'mongoAPI');
const require = createRequire(path.join(MONGO_API, 'package.json'));
const mongoose = require('mongoose');

const MONGO_URI = process.env.IT_MONGO_URI;

function runMigrate() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(MONGO_API, 'src', 'migrate.js')], {
      cwd: MONGO_API,
      env: { ...process.env, MONGODB_URI: MONGO_URI, DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'pickaroo-it-no-dotenv') },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    child.on('error', reject);
    child.on('exit', code => {
      const m = /productos (\d+), paquetes (\d+)/.exec(out);
      const h = /historial de estados: órdenes (\d+)/.exec(out);
      resolve({ code, out, products: m ? Number(m[1]) : null, packages: m ? Number(m[2]) : null, orders: h ? Number(h[1]) : null });
    });
  });
}

test('the store migration assigns store-less products and packages to the oldest store, and a second run changes nothing', async () => {
  assert.match(MONGO_URI ?? '', /\/pickaroodb_it\?/, 'the migration test only runs against pickaroodb_it');
  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const db = conn.db;
    const token = `mig${uid()}`;
    const now = new Date();
    const category = await db.collection('categories').findOne({ name: 'Abarrotes' });
    const orphan = name => ({ name, price: 10, unit: 'UNIDAD', stock: 5, isActive: true, categoryId: category._id, discounts: [], createdAt: now, updatedAt: now });
    const { insertedIds } = await db.collection('products').insertMany([orphan(`Huerfano ${token} uno`), { ...orphan(`Huerfano ${token} dos`), storeId: null }]);
    const productIds = Object.values(insertedIds);
    const { insertedId: packageId } = await db.collection('packages').insertOne({
      name: `Paquete huerfano ${token}`, price: 15, isActive: true, createdAt: now, updatedAt: now,
      items: productIds.map(productId => ({ productId, quantity: 1 })),
    });

    // Sin sucursal no se listan.
    const PRODUCTS = 'query($q: String) { products(search: $q) { id store { id name } } }';
    assert.deepEqual((await ok(PRODUCTS, { q: token })).products, []);
    assert.ok(!(await ok('{ packages { id } }')).packages.some(k => k.id === String(packageId)));

    const first = await runMigrate();
    assert.equal(first.code, 0, first.out);
    assert.deepEqual([first.products, first.packages], [2, 1], first.out);

    const [oldest] = await db.collection('stores').find().sort({ createdAt: 1, _id: 1 }).limit(1).toArray();
    assert.equal(oldest.name, 'CARNYFRUT Centro');
    const migrated = await db.collection('products').find({ _id: { $in: productIds } }).toArray();
    assert.deepEqual(migrated.map(p => String(p.storeId)), [String(oldest._id), String(oldest._id)]);
    assert.equal(String((await db.collection('packages').findOne({ _id: packageId })).storeId), String(oldest._id));

    const listed = (await ok(PRODUCTS, { q: token })).products;
    assert.deepEqual(listed.map(p => p.id).sort(), productIds.map(String).sort());
    assert.ok(listed.every(p => p.store.name === 'CARNYFRUT Centro'));

    const second = await runMigrate();
    assert.equal(second.code, 0, second.out);
    assert.deepEqual([second.products, second.packages], [0, 0], second.out);
  } finally {
    await conn.close();
  }
});

test('the status-history migration repairs a history that does not start with PENDING, and leaves complete ones untouched', async () => {
  assert.match(MONGO_URI ?? '', /\/pickaroodb_it\?/, 'the migration test only runs against pickaroodb_it');
  const customer = await newCustomer();
  const product = await newProduct();
  const broken = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  const complete = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  await ok(UPDATE_STATUS, { id: complete.id, status: 'CONFIRMED' }, await tokenOf('STAFF'));

  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const orders = conn.db.collection('orders');
    const oid = id => new mongoose.Types.ObjectId(id);
    const createdAt = new Date('2026-01-01T10:00:00Z');
    const real = { status: 'CONFIRMED', at: new Date('2026-01-02T11:00:00Z'), byUserId: null, byRole: 'STAFF', inferred: false };
    await orders.updateOne({ _id: oid(broken.id) }, { $set: { status: 'CONFIRMED', createdAt, statusHistory: [real] } });
    const before = await orders.findOne({ _id: oid(complete.id) });

    const first = await runMigrate();
    assert.equal(first.code, 0, first.out);
    assert.ok(first.orders >= 1, first.out);
    assert.deepEqual((await orders.findOne({ _id: oid(broken.id) })).statusHistory, [
      { status: 'PENDING', at: createdAt, byUserId: null, byRole: null, inferred: true }, real,
    ]);
    const after = await orders.findOne({ _id: oid(complete.id) });
    assert.deepEqual(after.statusHistory, before.statusHistory);
    assert.deepEqual(after.updatedAt, before.updatedAt);

    const second = await runMigrate();
    assert.equal(second.orders, 0, second.out);
    assert.equal((await orders.findOne({ _id: oid(broken.id) })).statusHistory.length, 2);
  } finally {
    await conn.close();
  }
});

test('the status-history migration synthesizes inferred entries for orders without one, and a second run changes nothing', async () => {
  assert.match(MONGO_URI ?? '', /\/pickaroodb_it\?/, 'the migration test only runs against pickaroodb_it');
  const customer = await newCustomer();
  const product = await newProduct();
  const pending = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  const delivered = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });
  const withHistory = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });

  const conn = await mongoose.createConnection(MONGO_URI, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const orders = conn.db.collection('orders');
    const oid = id => new mongoose.Types.ObjectId(id);
    const createdAt = new Date('2026-01-01T10:00:00Z');
    const updatedAt = new Date('2026-01-02T11:00:00Z');
    // Dos órdenes anteriores al historial (sin el campo); la tercera conserva el suyo.
    await orders.updateOne({ _id: oid(pending.id) }, { $unset: { statusHistory: '' }, $set: { createdAt, updatedAt: createdAt } });
    await orders.updateOne({ _id: oid(delivered.id) }, { $unset: { statusHistory: '' }, $set: { status: 'DELIVERED', createdAt, updatedAt } });
    const before = await orders.findOne({ _id: oid(withHistory.id) });

    const first = await runMigrate();
    assert.equal(first.code, 0, first.out);
    assert.ok(first.orders >= 2, first.out);

    const entry = (status, at) => ({ status, at, byUserId: null, byRole: null, inferred: true });
    assert.deepEqual((await orders.findOne({ _id: oid(pending.id) })).statusHistory, [entry('PENDING', createdAt)]);
    assert.deepEqual((await orders.findOne({ _id: oid(delivered.id) })).statusHistory, [entry('PENDING', createdAt), entry('DELIVERED', updatedAt)]);
    assert.deepEqual((await orders.findOne({ _id: oid(withHistory.id) })).statusHistory, before.statusHistory); // no se toca

    // El cliente las ve como inferidas y sin autor.
    const { order } = await ok('query($id: ID!) { order(id: $id) { statusHistory { status inferred byRole by { id } } } }', { id: delivered.id }, await tokenOf('ADMIN'));
    assert.deepEqual(order.statusHistory, [
      { status: 'PENDING', inferred: true, byRole: null, by: null },
      { status: 'DELIVERED', inferred: true, byRole: null, by: null },
    ]);

    const second = await runMigrate();
    assert.equal(second.code, 0, second.out);
    assert.equal(second.orders, 0, second.out);
  } finally {
    await conn.close();
  }
});
