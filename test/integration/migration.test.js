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
import { ok, uid } from './client.js';

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
      resolve({ code, out, products: m ? Number(m[1]) : null, packages: m ? Number(m[2]) : null });
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
