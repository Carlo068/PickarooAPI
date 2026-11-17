// ============================================================
// MIGRACIONES DE DATOS (MongoDB)
//
// Corren al arrancar mongoAPI, antes del seed, y también solas con
// `npm run migrate`. Son idempotentes: la segunda corrida no cambia nada.
// Las decisiones viven en domain/migrations.js; aquí solo se cuenta y se aplica.
// ============================================================

import mongoose from 'mongoose';
import { Product, Package, Store } from './models/index.js';
import { planCatalogStoreBackfill } from '../domain/migrations.js';

// Sin storeId = campo ausente o null.
const WITHOUT_STORE = { storeId: null };

// Marketplace: productos y paquetes sin sucursal pasan a la más antigua activa.
// Se escribe con el driver (collection) porque storeId es inmutable en el
// esquema de Mongoose. Devuelve { products, packages } modificados.
export async function backfillCatalogStores(log = console) {
  const [products, packages, stores] = await Promise.all([
    Product.collection.countDocuments(WITHOUT_STORE),
    Package.collection.countDocuments(WITHOUT_STORE),
    Store.find().select('name createdAt isActive').lean(),
  ]);
  const plan = planCatalogStoreBackfill({ stores, pending: { products, packages } });

  if (plan.action === 'NONE') {
    log.log('🧭 Migración storeId: productos 0, paquetes 0 (nada pendiente).');
    return { products: 0, packages: 0 };
  }
  if (plan.action === 'NO_STORE') {
    log.warn(`⚠️  Migración storeId: hay ${plan.products} producto(s) y ${plan.packages} paquete(s) sin sucursal y no existe ninguna sucursal. Quedan sin listar hasta crear una sucursal y volver a correr la migración (npm run migrate).`);
    return { products: 0, packages: 0 };
  }

  if (!plan.storeActive) {
    log.warn(`⚠️  Migración storeId: ninguna sucursal está activa; los artículos se asignan a la más antigua ("${plan.storeName}") y quedarán ocultos hasta reactivarla.`);
  }
  const set = { $set: { storeId: new mongoose.Types.ObjectId(plan.storeId) } };
  const [p, k] = await Promise.all([
    Product.collection.updateMany(WITHOUT_STORE, set),
    Package.collection.updateMany(WITHOUT_STORE, set),
  ]);
  log.log(`🧭 Migración storeId: productos ${p.modifiedCount}, paquetes ${k.modifiedCount} → "${plan.storeName}" (${plan.storeId}).`);
  return { products: p.modifiedCount, packages: k.modifiedCount };
}

export async function runMigrations(log = console) {
  return { catalogStores: await backfillCatalogStores(log) };
}
