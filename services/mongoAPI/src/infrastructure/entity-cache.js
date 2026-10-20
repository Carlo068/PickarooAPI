// ============================================================
// CACHÉ DE ENTIDADES (cache-aside sobre Redis OM)
//
//   lectura:  Redis → (miss) → Mongo → se guarda en Redis con TTL
//   escritura de productos: se borra la copia (el stock cambia con cada
//                           compra, así que se recarga de Mongo al leer)
//   escritura de usuarios:  write-through (se guarda la copia ya actualizada)
//
// El caché solo sirve lecturas. Las compras (precios, stock, direcciones)
// siempre se calculan contra Mongo.
// ============================================================

import { Product, User } from './models/index.js';
import { productRepository, userRepository, isRedisReady } from './redis-om.js';

const PRODUCT_TTL = parseInt(process.env.CACHE_TTL_PRODUCT) || 120; // el precio y el stock cambian: TTL corto
const USER_TTL = parseInt(process.env.CACHE_TTL_USER) || 3600; // el perfil casi no cambia: TTL largo
const DEBUG = process.env.CACHE_DEBUG === 'true';
const log = (...args) => DEBUG && console.log(...args);

const str = v => (v == null ? null : String(v));
const date = v => (v ? new Date(v) : null);

// ---------- Vistas: la misma forma para un documento de Mongo y para una copia de Redis ----------
export function productView(d) {
  return {
    id: String(d._id ?? d.id),
    categoryId: str(d.categoryId),
    name: d.name,
    description: d.description ?? null,
    price: d.price,
    imageUrl: d.imageUrl ?? null,
    unit: d.unit,
    stock: d.stock,
    isActive: d.isActive,
    discounts: (d.discounts ?? []).map(x => ({
      id: String(x._id ?? x.id),
      percent: x.percent,
      label: x.label ?? null,
      startsAt: date(x.startsAt),
      endsAt: date(x.endsAt),
    })),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const withDefault = v => ({ ...v, defaultAddress: v.addresses.find(a => a.isDefault) ?? null });

export function userView(d) {
  const defaultId = str(d.defaultAddressId);
  return withDefault({
    id: String(d._id ?? d.id),
    name: d.name,
    email: d.email,
    avatarUrl: d.avatarUrl ?? null,
    role: d.role,
    isActive: d.isActive,
    addresses: (d.addresses ?? []).map(a => ({
      id: String(a._id ?? a.id),
      label: a.label,
      street: a.street,
      city: a.city,
      state: a.state ?? null,
      zipCode: a.zipCode ?? null,
      lat: a.lat ?? null,
      lng: a.lng ?? null,
      isDefault: String(a._id ?? a.id) === defaultId,
    })),
    createdAt: d.createdAt,
  });
}

// ---------- Vista ⇄ entidad Redis OM ----------
const productToCache = v => ({
  mongoId: v.id, categoryId: v.categoryId, name: v.name, description: v.description, price: v.price,
  imageUrl: v.imageUrl, unit: v.unit, stock: v.stock, isActive: v.isActive,
  discountsJson: JSON.stringify(v.discounts), createdAt: v.createdAt, updatedAt: v.updatedAt,
});

const productFromCache = e => ({
  id: e.mongoId, categoryId: e.categoryId, name: e.name, description: e.description ?? null, price: e.price,
  imageUrl: e.imageUrl ?? null, unit: e.unit, stock: e.stock, isActive: e.isActive,
  discounts: JSON.parse(e.discountsJson || '[]').map(x => ({ ...x, startsAt: date(x.startsAt), endsAt: date(x.endsAt) })),
  createdAt: e.createdAt, updatedAt: e.updatedAt,
});

const userToCache = v => ({
  mongoId: v.id, name: v.name, email: v.email, avatarUrl: v.avatarUrl, role: v.role,
  isActive: v.isActive, addressesJson: JSON.stringify(v.addresses), createdAt: v.createdAt,
});

const userFromCache = e => ({
  id: e.mongoId, name: e.name, email: e.email, avatarUrl: e.avatarUrl ?? null, role: e.role,
  isActive: e.isActive, addresses: JSON.parse(e.addressesJson || '[]'), createdAt: e.createdAt,
});

// ---------- Primitivas (los fallos de Redis nunca rompen una consulta) ----------
async function fetchCached(repo, id, label) {
  if (!isRedisReady()) return null;
  try {
    const entity = await repo.fetch(id);
    if (entity?.mongoId) {
      log(`⚡ [CACHE HIT] ${label} ${id}`);
      return entity;
    }
  } catch (err) {
    console.warn(`⚠️  Lectura de caché (${label}):`, err.message);
  }
  log(`🐢 [CACHE MISS] ${label} ${id}`);
  return null;
}

async function saveCached(repo, id, entity, ttl, label) {
  if (!isRedisReady()) return;
  try {
    await repo.save(id, entity);
    await repo.expire(id, ttl);
    log(`💾 [CACHE SAVE] ${label} ${id} (TTL ${ttl}s)`);
  } catch (err) {
    console.warn(`⚠️  Escritura de caché (${label}):`, err.message);
  }
}

async function removeCached(repo, ids, label) {
  if (!isRedisReady()) return;
  try {
    await Promise.all(ids.map(id => repo.remove(String(id))));
    log(`🧹 [CACHE DEL] ${label} ${ids.join(', ')}`);
  } catch (err) {
    console.warn(`⚠️  Invalidación de caché (${label}):`, err.message);
  }
}

// ---------- Productos ----------
export async function getProduct(id) {
  if (!id) return null;
  const key = String(id);
  const hit = await fetchCached(productRepository, key, 'Product');
  if (hit) return productFromCache(hit);
  const doc = await Product.findById(key).exec();
  if (!doc) return null;
  const view = productView(doc);
  await saveCached(productRepository, key, productToCache(view), PRODUCT_TTL, 'Product');
  return view;
}

export const invalidateProducts = (...ids) => removeCached(productRepository, ids.flat().filter(Boolean), 'Product');

// ---------- Usuarios ----------
export async function getUser(id) {
  if (!id) return null;
  const key = String(id);
  const hit = await fetchCached(userRepository, key, 'User');
  if (hit) return withDefault(userFromCache(hit));
  const doc = await User.findById(key).exec();
  if (!doc) return null;
  const view = userView(doc);
  await saveCached(userRepository, key, userToCache(view), USER_TTL, 'User');
  return view;
}

// Write-through: guarda la copia recién escrita en Mongo y devuelve la vista.
export async function cacheUser(doc) {
  const view = userView(doc);
  await saveCached(userRepository, view.id, userToCache(view), USER_TTL, 'User');
  return view;
}

export const invalidateUser = id => removeCached(userRepository, [id], 'User');
