import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { GraphQLScalarType, Kind, parse } from 'graphql';
import mongoose from 'mongoose';

import { User, Category, Product, Package, Store, Order, ShoppingList, models } from './infrastructure/models/index.js';
import { ONE_ACTIVE_DELIVERY_INDEX } from './infrastructure/models/order.js';
import {
  Product as ProductEntity,
  Package as PackageEntity,
  priceOrder,
  stockDemand,
  isDiscountActive,
  bestDiscountPercent,
  applyDiscount,
  lineDiscount,
  orderSubtotal,
  orderDiscountTotal,
  assertTransition,
  statusChangeEntry,
  STATUS_HISTORY_MAX,
  ACTIVE_DELIVERY_STATUSES,
  deliveryUnavailableReason,
  orderNotAvailableError,
  assertPackagePersistable,
  assertPackageSameStore,
  assertQuoteStillValid,
  reconcileCart,
  linesStoreId,
  cartStoreId,
  assertCartAccepts,
  buildOrderNumber,
  round2,
} from './domain/entities.js';
import { DomainError, notFoundError } from './domain/errors.js';
import { assertValidLocation, assertTrackable, isTrackable, newLocationRecord, locationView, locationTtlSeconds } from './domain/driver-location.js';
import { formatApiError } from './infrastructure/format-error.js';
import { redisClient, initRedis } from './infrastructure/redis-om.js';
import { getProduct, invalidateProducts, getUser, cacheUser, userView } from './infrastructure/entity-cache.js';
import { hashPassword } from './infrastructure/passwords.js';
import * as cartStore from './infrastructure/cart-store.js';
import { saveQuote, getQuote, deleteQuote } from './infrastructure/quote-store.js';
import { createLocationStore } from './infrastructure/location-store.js';
import { RECENT_ORDERS, pushRecentOrder, getRecentOrderIds, setRecentOrders } from './infrastructure/recent-orders.js';
import { initNeo4j, isNeo4jReady } from './infrastructure/neo4j.js';
import * as rbac from './infrastructure/rbac-graph.js';
import { initEvents, emitEvent, diff, auditPlugin, CATEGORIES } from './infrastructure/events.js';
import { runMigrations } from './infrastructure/migrations.js';
import { createAuthContext, createAuthResolvers, requireAuth, requirePermission, requireSelfOrPermission, forbidden } from './auth.js';
import {
  PERMISSIONS, DEFAULT_ROLE, hasPermission, inStoreScope, canViewOrder, orderStatusDenial, canSeeStatusActor,
  acceptDeliveryDenial, releaseDeliveryDenial, reportLocationDenial,
  storeItemDenial, managesStoreItems, seesStoreItems, categoryDenial, reportStoreScope,
} from './domain/access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// ------------------------------------------------------------
// Infraestructura: MongoDB
// ------------------------------------------------------------
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/pickaroodb';
await mongoose.connect(mongoUri);
console.log('✅ MongoDB (pickaroodb) conectado.');
await Promise.all(models.map(m => m.syncIndexes().catch(err => console.warn(`Índices de ${m.modelName}:`, err.message))));
// Una entrega activa por repartidor depende de este índice (models/order.js). Si no
// se pudo crear (p. ej. datos que ya lo violan), la API sigue, pero hay que verlo:
// acceptDelivery conserva una comprobación previa, que no protege ante aceptaciones simultáneas.
if (!(await Order.collection.indexExists(ONE_ACTIVE_DELIVERY_INDEX).catch(() => false))) {
  console.error([
    '',
    `🚨🚨🚨 ÍNDICE AUSENTE: orders.${ONE_ACTIVE_DELIVERY_INDEX} 🚨🚨🚨`,
    'No se pudo crear el índice único que garantiza UNA entrega activa por repartidor.',
    'Dos aceptaciones simultáneas del mismo repartidor podrían quedar escritas.',
    'Revisa el aviso "Índices de Order" de arriba, corrige los pedidos READY / IN_DELIVERY',
    'con el mismo driverId y reinicia mongoAPI.',
    '',
  ].join('\n'));
}
// Migraciones de datos (idempotentes), antes del seed. También: npm run migrate.
await runMigrations().catch(err => console.error('⚠️  Migración de datos fallida:', err.message));

// ------------------------------------------------------------
// Infraestructura: Redis (caché de lectura + sesiones JWT)
// ------------------------------------------------------------
await initRedis();

// ------------------------------------------------------------
// Infraestructura: Neo4j (roles y permisos) y RabbitMQ (eventos de auditoría)
// ------------------------------------------------------------
// Al conectar (y al reconectar) se crea/actualiza el catálogo RBAC y las sucursales.
await initNeo4j(async () => rbac.bootstrapRbac(await Store.find().select('name isActive')));
await initEvents();

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const notFound = notFoundError; // (ENTITY, id) -> NOT_FOUND { entity, id }
const oid = v => new mongoose.Types.ObjectId(String(v));
const uniq = xs => [...new Set(xs.map(String))];
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// Una partida referencia un producto O un paquete.
function itemRef({ productId, packageId }) {
  if (Boolean(productId) === Boolean(packageId)) throw new DomainError('Cada partida debe indicar productId o packageId (solo uno).', 'INVALID_CART_LINE');
  return productId ? { productId: String(productId) } : { packageId: String(packageId) };
}
const itemType = i => (i.packageId ? 'PACKAGE' : 'PRODUCT');

function locationFrom(input) {
  if (!input) return null;
  const { street, city, state, zipCode, lat, lng } = input;
  return { street, city, state, zipCode, lat, lng };
}

function resolveDeliveryAddress(input, addressId, user) {
  if (input) return locationFrom(input);
  const id = addressId ?? user.defaultAddressId;
  const found = id ? user.addresses.id(id) : user.addresses[0];
  if (addressId && !found) throw notFound('ADDRESS', addressId);
  return found ? locationFrom(found) : null;
}

// Lista guardada: solo su dueño (o quien administra usuarios).
function ownedOrNull(ctx, doc) {
  requireAuth(ctx);
  if (!doc) return null;
  requireSelfOrPermission(ctx, doc.userId);
  return doc;
}

// Orden: su dueño o el personal de esa sucursal (según su permiso).
function viewableOrder(ctx, order) {
  const me = requireAuth(ctx);
  if (!order) return null;
  if (!canViewOrder(me, order)) throw forbidden('No tienes permiso para ver esta orden.', 'ORDER_VIEW_DENIED');
  return order;
}

// Qué órdenes ve quien consulta: un cliente las suyas; el personal de mostrador
// las de sus sucursales; el repartidor las disponibles para aceptar de sus
// sucursales más las asignadas a él; scope:all_stores todas.
function ordersFilter(me, { userId, storeId }) {
  if (userId && String(userId) === String(me.id)) return { userId: oid(me.id), ...(storeId ? { storeId: oid(storeId) } : {}) };

  if (hasPermission(me, PERMISSIONS.ALL_STORES)) {
    return { ...(userId ? { userId: oid(userId) } : {}), ...(storeId ? { storeId: oid(storeId) } : {}) };
  }

  const prepares = hasPermission(me, PERMISSIONS.ORDERS_PREPARE);
  const delivers = hasPermission(me, PERMISSIONS.ORDERS_DELIVER);
  if (prepares || delivers) {
    if (storeId && !inStoreScope(me, storeId)) throw forbidden('Esa sucursal no está asignada a tu usuario.', 'STORE_NOT_ASSIGNED', { storeId: String(storeId) });
    const stores = storeId ? oid(storeId) : { $in: me.storeIds.map(oid) };
    const customer = userId ? { userId: oid(userId) } : {};
    if (prepares) return { storeId: stores, ...customer };
    return {
      ...customer,
      $or: [
        { storeId: stores, mode: 'DELIVERY', status: 'READY', driverId: null },
        { driverId: oid(me.id), ...(storeId ? { storeId: oid(storeId) } : {}) },
      ],
    };
  }

  if (userId) throw forbidden('Solo puedes ver tus propias órdenes.', 'OWN_ORDERS_ONLY');
  return { userId: oid(me.id), ...(storeId ? { storeId: oid(storeId) } : {}) };
}

// Evento de catálogo con el documento afectado como objetivo. Productos y
// paquetes llevan su sucursal en metadata (las categorías son globales).
function catalogEvent(ctx, type, targetType, doc, reason, metadata = {}) {
  const store = doc.storeId != null ? { storeId: String(doc.storeId) } : {};
  emitEvent({ type, category: CATEGORIES.CATALOG, targetType, targetId: doc._id, reason, metadata: { ...store, ...metadata } }, ctx);
}

// ---------- Marketplace: alcance por sucursal ----------
// FORBIDDEN a partir de una denegación de domain/access.js ({ reason, permission? | storeId? }).
function deny(denial) {
  if (denial.reason === 'STORE_NOT_ASSIGNED') throw forbidden('Esa sucursal no está asignada a tu usuario.', 'STORE_NOT_ASSIGNED', { storeId: denial.storeId });
  throw forbidden(`Se requiere el permiso "${denial.permission}".`, 'PERMISSION_REQUIRED', { permission: denial.permission });
}

// FORBIDDEN de un cambio de estado o de una entrega (orderStatusDenial,
// acceptDeliveryDenial, releaseDeliveryDenial). `cancel`: la denegación genérica es ORDER_CANCEL_DENIED.
function denyOrder(denial, { cancel = false } = {}) {
  const status = denial.status ? { status: denial.status } : {};
  if (denial.reason === 'NOT_ASSIGNED_DRIVER') throw forbidden('La orden tiene otro repartidor asignado.', 'NOT_ASSIGNED_DRIVER', status);
  if (denial.reason === 'NO_DRIVER_ASSIGNED') throw forbidden('La orden aún no tiene repartidor: primero hay que aceptarla.', 'NO_DRIVER_ASSIGNED', status);
  if (denial.reason === 'OWN_ORDER') throw forbidden('No puedes repartir una orden tuya.', 'OWN_ORDER');
  if (denial.reason === 'ORDER_STATUS_CHANGE_DENIED') {
    if (cancel) throw forbidden('No tienes permiso para cancelar esta orden.', 'ORDER_CANCEL_DENIED');
    throw forbidden(`No tienes permiso para pasar esta orden a ${denial.status}.`, 'ORDER_STATUS_CHANGE_DENIED', status);
  }
  deny(denial); // PERMISSION_REQUIRED, STORE_NOT_ASSIGNED
}

// catalog:manage o stock:manage sobre los artículos de la sucursal `storeId`.
function requireStoreItemPermission(ctx, permission, storeId) {
  const me = requireAuth(ctx);
  const denial = storeItemDenial(me, permission, storeId);
  if (denial) deny(denial);
  return me;
}

// Alta de un producto o paquete: la sucursal del input debe estar en el alcance y existir.
async function requireCatalogStore(ctx, storeId) {
  requireStoreItemPermission(ctx, PERMISSIONS.CATALOG_MANAGE, storeId);
  if (!mongoose.isValidObjectId(storeId) || !(await Store.exists({ _id: oid(storeId) }))) throw notFound('STORE', storeId);
}

// Producto o paquete que se va a editar: primero el permiso, luego que exista
// y por último que su sucursal esté en el alcance.
async function managedItem(ctx, permission, Model, entity, id) {
  requirePermission(ctx, permission);
  const doc = mongoose.isValidObjectId(id) ? await Model.findById(id) : null;
  if (!doc) throw notFound(entity, id);
  requireStoreItemPermission(ctx, permission, doc.storeId);
  return doc;
}
const managedProduct = (ctx, permission, id) => managedItem(ctx, permission, Product, 'PRODUCT', id);
const managedPackage = (ctx, id) => managedItem(ctx, PERMISSIONS.CATALOG_MANAGE, Package, 'PACKAGE', id);

// Los artículos de una sucursal inactiva no se listan al público; quien
// administra su catálogo o su inventario sí los ve.
const activeStoreIds = () => Store.find({ isActive: true }).distinct('_id');
const storeVisible = (ctx, store) => store.isActive || seesStoreItems(ctx.currentUser, store._id);

// Un producto o paquete que se resuelve por id para mostrarlo: null si es de
// una sucursal inactiva (o sin sucursal) y quien consulta no administra sus
// artículos ni tiene scope:all_stores. Igual que los listados.
async function visibleItem(ctx, doc) {
  if (!doc) return null;
  const store = doc.storeId != null && mongoose.isValidObjectId(doc.storeId) ? await Store.findById(doc.storeId).select('isActive') : null;
  return store?.isActive || seesStoreItems(ctx.currentUser, doc.storeId) ? doc : null;
}

// Filtro de los listados de productos y paquetes (null = nada que listar).
// activeOnly: false solo se respeta en las sucursales cuyos artículos ve quien
// consulta; para los demás se trata como true, sin error. Sin storeId: todas
// las sucursales activas (búsqueda del marketplace).
async function listingFilter(ctx, storeId, activeOnly) {
  const me = ctx.currentUser;
  if (storeId == null) {
    const base = { storeId: { $in: await activeStoreIds() } };
    if (activeOnly || hasPermission(me, PERMISSIONS.ALL_STORES)) return activeOnly ? { ...base, isActive: true } : base;
    const managed = (me?.storeIds ?? []).filter(id => mongoose.isValidObjectId(id) && managesStoreItems(me, id)).map(oid);
    return managed.length ? { ...base, $or: [{ isActive: true }, { storeId: { $in: managed } }] } : { ...base, isActive: true };
  }
  const store = mongoose.isValidObjectId(storeId) ? await Store.findById(storeId).select('isActive') : null;
  return storeFilterOf(ctx, store, activeOnly);
}

// Lo mismo para una sucursal ya cargada (Store.products / Store.packages).
function storeFilterOf(ctx, store, activeOnly) {
  if (!store || !storeVisible(ctx, store)) return null;
  const onlyActive = activeOnly || !seesStoreItems(ctx.currentUser, store._id);
  return { storeId: store._id, ...(onlyActive ? { isActive: true } : {}) };
}

function listProducts(filter, { categoryId, search, limit, offset }) {
  if (!filter) return [];
  const q = { ...filter };
  if (categoryId) q.categoryId = oid(categoryId);
  if (search) q.$text = { $search: search };
  return Product.find(q).sort({ name: 1 }).skip(offset).limit(Math.min(limit, 100)).exec();
}

function listPackages(filter) {
  if (!filter) return [];
  return Package.find(filter).sort({ name: 1 }).exec();
}

// Productos del contenido de un paquete: deben existir y ser de su sucursal.
async function assertPackageProducts(storeId, items) {
  const ids = uniq(items.map(i => i.productId));
  const docs = ids.every(id => mongoose.isValidObjectId(id)) ? await Product.find({ _id: { $in: ids.map(oid) } }).select('storeId') : [];
  if (docs.length !== ids.length) throw new DomainError('Algún producto del paquete no existe en el catálogo.', 'PACKAGE_PRODUCT_NOT_FOUND');
  assertPackageSameStore(storeId, docs);
}

// Reportes: $match de las sucursales del alcance (ADMIN: todas; personal: sus WORKS_AT).
function reportStoreMatch(ctx, storeId) {
  const me = requirePermission(ctx, PERMISSIONS.REPORTS_VIEW);
  const scope = reportStoreScope(me, storeId);
  if (scope.denied) deny(scope.denied);
  if (scope.storeIds == null) return {};
  return { storeId: { $in: scope.storeIds.filter(id => mongoose.isValidObjectId(id)).map(oid) } };
}

async function storeNames(ids) {
  const valid = uniq(ids.filter(Boolean));
  const docs = valid.length ? await Store.find({ _id: { $in: valid.map(oid) } }).select('name') : [];
  return new Map(docs.map(d => [String(d._id), d.name]));
}

// Refleja la sucursal en Neo4j (el alcance del personal se define con WORKS_AT).
async function syncStoreNode(store) {
  if (!isNeo4jReady()) return;
  await rbac.syncStores([store]).catch(err => console.warn('⚠️  Sucursal sin sincronizar en Neo4j:', err.message));
}

// Producto que ya no existe en el catálogo: cuenta como no disponible.
const missingProduct = id => new ProductEntity({ _id: id, name: 'Producto eliminado', price: 0, stock: 0, isActive: false });

async function loadProducts(ids) {
  const docs = ids.length ? await Product.find({ _id: { $in: uniq(ids).map(oid) } }) : [];
  return new Map(docs.map(d => [String(d._id), new ProductEntity(d)]));
}

// Convierte documentos de paquete en entidades de dominio con sus productos cargados (una sola consulta).
async function toDomainPackages(docs) {
  const products = await loadProducts(docs.flatMap(d => d.items.map(i => i.productId)));
  return new Map(docs.map(d => [String(d._id), new PackageEntity(d, d.items.map(i => ({
    product: products.get(String(i.productId)) ?? missingProduct(i.productId),
    quantity: i.quantity,
  })))]));
}

// Memoiza la entidad por documento para que availableStock/alaCarteTotal/savings no recarguen productos.
const packageEntities = new WeakMap();
function packageEntity(doc) {
  if (!packageEntities.has(doc)) packageEntities.set(doc, toDomainPackages([doc]).then(m => m.get(String(doc._id))));
  return packageEntities.get(doc);
}

// Carga el catálogo actual (Mongo, nunca el caché) para unas partidas.
// Lo que ya no existe queda en null en lugar de lanzar.
async function loadLines(refs) {
  const packageIds = refs.filter(r => r.packageId).map(r => r.packageId);
  const pkgDocs = packageIds.length ? await Package.find({ _id: { $in: uniq(packageIds).map(oid) } }) : [];
  const [packages, products] = await Promise.all([
    toDomainPackages(pkgDocs),
    loadProducts(refs.filter(r => r.productId).map(r => r.productId)),
  ]);
  return refs.map(r => (r.packageId
    ? { ...r, package: packages.get(r.packageId) ?? null }
    : { ...r, product: products.get(r.productId) ?? null }));
}

// Carga productos y paquetes de un carrito y arma las líneas para el dominio.
async function buildLines(items) {
  if (!items?.length) throw new DomainError('El carrito está vacío.', 'CART_EMPTY');
  const lines = await loadLines(items.map(i => ({ ...itemRef(i), quantity: i.quantity })));
  for (const l of lines) {
    if (l.packageId && !l.package) throw notFound('PACKAGE', l.packageId);
    if (l.productId && !l.product) throw notFound('PRODUCT', l.productId);
  }
  return lines;
}

// ---------- Cotizaciones (Redis, 15 min) ----------
// Lo que se guarda y se compara al comprar: partidas con precio, envío y total.
function quoteRecord({ mode, store }, priced) {
  return {
    mode,
    storeId: store ? String(store._id) : null,
    items: priced.items.map(i => ({
      productId: i.productId ?? null, packageId: i.packageId ?? null, quantity: i.quantity,
      unitPrice: i.unitPrice, discountPercent: i.discountPercent, lineTotal: i.lineTotal,
    })),
    deliveryFee: priced.deliveryFee,
    total: priced.total,
  };
}

async function issueQuote({ mode, store }, priced) {
  const { quoteId, expiresAt } = await saveQuote(quoteRecord({ mode, store }, priced));
  const { stockDemand: _demand, ...amounts } = priced;
  return { mode, ...amounts, quoteId, expiresAt };
}

// Resumen serializable que viaja en extensions.newQuote cuando hay que reconfirmar.
const quoteSummary = q => ({
  quoteId: q.quoteId, expiresAt: q.expiresAt, subtotal: q.subtotal, discountTotal: q.discountTotal,
  deliveryFee: q.deliveryFee, total: q.total,
  items: q.items.map(({ productId, packageId, name, quantity, unitPrice, discountPercent, lineTotal }) => ({
    productId: productId ?? null, packageId: packageId ?? null, name, quantity, unitPrice, discountPercent, lineTotal,
  })),
});

// Si el cliente confirmó una cotización, el cobro debe coincidir con ella.
async function assertMatchesQuote(quoteId, { mode, store }, priced) {
  const quoted = await getQuote(quoteId);
  try {
    if (!quoted) throw new DomainError('La cotización expiró o no existe. Revisa el total y confirma de nuevo.', 'QUOTE_EXPIRED');
    assertQuoteStillValid(quoted, quoteRecord({ mode, store }, priced));
  } catch (err) {
    if (err instanceof DomainError) err.extensions.newQuote = quoteSummary(await issueQuote({ mode, store }, priced));
    throw err;
  }
}

// ---------- Crear una orden (createOrder y checkoutCart) ----------
async function placeOrder({ userId, mode, storeId, address, addressId, items, notes, idempotencyKey, quoteId }, ctx) {
  if (idempotencyKey) {
    const existing = await Order.findOne({ userId: oid(userId), idempotencyKey });
    if (existing) return existing;
  }

  const user = await User.findById(userId);
  if (!user) throw notFound('USER', userId);
  if (!user.isActive) throw new DomainError('El usuario está desactivado.', 'USER_INACTIVE');

  // Precios y stock salen siempre de Mongo, nunca del caché. La sucursal es la de los artículos.
  const lines = await buildLines(items);
  const store = await purchaseStore(lines, storeId);
  const deliveryAddress = mode === 'DELIVERY' ? resolveDeliveryAddress(address, addressId, user) : null;
  const priced = priceOrder({ mode, store, deliveryAddress, lines, requireAddress: true });
  if (quoteId) await assertMatchesQuote(quoteId, { mode, store }, priced);

  // Primero se aparta el stock (atómico por producto) y después se guarda la orden.
  const taken = await takeStock(priced.stockDemand);
  let order;
  try {
    order = await Order.create({
      number: buildOrderNumber(),
      idempotencyKey: idempotencyKey || null,
      userId: user._id,
      storeId: store._id,
      mode,
      deliveryAddress,
      items: priced.items,
      deliveryFee: priced.deliveryFee,
      total: priced.total,
      notes,
      // Quien crea la orden: el cliente, o el admin / gestor de usuarios que la crea a su nombre.
      statusHistory: [statusChangeEntry('PENDING', ctx.currentUser?.id ? ctx.currentUser : { id: user._id, role: 'CUSTOMER' })],
    });
  } catch (err) {
    await releaseStock(taken);
    if (err.code === 11000 && idempotencyKey) return Order.findOne({ userId: user._id, idempotencyKey });
    throw err;
  }

  await Promise.all([deleteQuote(quoteId), pushRecentOrder(order.userId, order._id)]);
  emitEvent({
    type: 'ORDER_CREATED', category: CATEGORIES.ORDER, targetType: 'Order', targetId: order._id,
    reason: `Orden ${order.number}`,
    metadata: {
      number: order.number, customerId: String(order.userId), storeId: String(order.storeId), mode: order.mode,
      total: order.total, deliveryFee: order.deliveryFee, itemCount: order.items.length, quoteId: quoteId ?? null,
    },
  }, ctx);
  return order;
}

// ---------- Carrito (Redis) ----------
// Lee el carrito, lo contrasta con el catálogo actual y cotiza lo disponible.
// La sucursal del carrito es la de sus partidas (`storeId` es solo una pista);
// las de otra sucursal (carritos anteriores al marketplace) quedan como OTHER_STORE.
async function buildCart(userId, { mode = 'PICKUP', storeId: hintStoreId } = {}) {
  const lines = await loadLines(await cartStore.getCart(userId));
  const storeId = cartStoreId(lines, hintStoreId);
  const { available, unavailable } = reconcileCart(lines, { storeId });
  const unavailableKeys = new Set(unavailable.map(u => u.productId ?? u.packageId));

  let quote = null;
  let quoteError = null;
  if (available.length) {
    try {
      const store = await purchaseStore(available);
      quote = await issueQuote({ mode, store }, priceOrder({ mode, store, lines: available }));
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      quoteError = err.message; // p. ej. el mismo producto suelto y en paquete supera el stock
    }
  }

  return {
    storeId,
    items: lines.map(l => ({
      productId: l.productId ?? null, packageId: l.packageId ?? null, quantity: l.quantity,
      available: !unavailableKeys.has(l.productId ?? l.packageId),
    })),
    unavailable: unavailable.map(u => ({
      productId: u.productId ?? null, packageId: u.packageId ?? null, quantity: u.quantity,
      name: (u.package ?? u.product)?.name ?? (u.packageId ? 'Paquete eliminado' : 'Producto eliminado'),
      reason: u.reason, availableQuantity: u.available,
    })),
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    quote,
    quoteError,
  };
}

// Valida la referencia antes de guardarla en el carrito: debe existir, estar
// activa, tener sucursal y ser de la sucursal que ya tiene el carrito
// (CART_STORE_MISMATCH: el cliente ofrece vaciarlo y agregar).
async function assertCartAcceptsRef(userId, ref) {
  const id = ref.productId ?? ref.packageId;
  const Model = ref.productId ? Product : Package;
  const what = ref.productId ? 'PRODUCT' : 'PACKAGE';
  if (!mongoose.isValidObjectId(id)) throw notFound(what, id);
  const doc = await Model.findById(id).select('name isActive storeId');
  if (!doc) throw notFound(what, id);
  const store = doc.storeId ? await Store.findById(doc.storeId).select('name isActive') : null;
  if (store && !store.isActive) throw new DomainError(`La sucursal "${store.name}" no está activa.`, 'STORE_INACTIVE', { storeId: String(store._id), name: store.name });
  if (!doc.isActive) {
    throw new DomainError(`"${doc.name}" no está disponible.`, 'ITEM_UNAVAILABLE', { itemType: what, id: String(id), name: doc.name });
  }
  if (!doc.storeId) throw new DomainError(`"${doc.name}" no pertenece a ninguna sucursal.`, 'ITEM_WITHOUT_STORE', { itemType: what, id: String(id), name: doc.name });
  const lines = await loadLines(await cartStore.getCart(userId));
  assertCartAccepts(cartStoreId(lines), doc.storeId);
}

// Descuenta stock solo si alcanza (condición atómica por producto). Si algún
// producto no alcanza, devuelve lo ya descontado y rechaza la compra.
async function takeStock(demand) {
  const taken = [];
  try {
    for (const { productId, quantity } of demand) {
      const res = await Product.updateOne({ _id: oid(productId), stock: { $gte: quantity } }, { $inc: { stock: -quantity } });
      if (res.modifiedCount !== 1) {
        await releaseStock(taken);
        const p = await Product.findById(productId).select('name stock');
        throw new DomainError(`Sin stock suficiente de "${p?.name ?? productId}" (disponible: ${p?.stock ?? 0}).`, 'INSUFFICIENT_STOCK', {
          productId: String(productId), name: p?.name ?? String(productId), requested: quantity, available: p?.stock ?? 0,
        });
      }
      taken.push({ productId, quantity });
    }
  } finally {
    await invalidateProducts(taken.map(t => t.productId)); // el stock cambió: se descarta la copia en Redis
  }
  return taken;
}

async function releaseStock(demand) {
  await Promise.all(demand.map(({ productId, quantity }) =>
    Product.updateOne({ _id: oid(productId) }, { $inc: { stock: quantity } })));
  await invalidateProducts(demand.map(d => d.productId));
}

// Sucursal de una compra: la de sus partidas, que debe existir y estar activa.
// `hintStoreId` (el storeId del cliente) solo se valida: si difiere, STORE_MISMATCH.
async function purchaseStore(lines, hintStoreId = null) {
  const storeId = linesStoreId(lines, hintStoreId);
  const store = storeId ? await Store.findById(storeId) : null;
  if (!store) throw notFound('STORE', storeId);
  if (!store.isActive) throw new DomainError(`La sucursal "${store.name}" no está activa.`, 'STORE_INACTIVE', { storeId: String(store._id), name: store.name });
  return store;
}

// ------------------------------------------------------------
// Scalars
// ------------------------------------------------------------
const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'Fecha y hora en formato ISO-8601 (UTC).',
  serialize(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw new TypeError(`Fecha inválida: ${value}`);
    return d.toISOString();
  },
  parseValue(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new TypeError(`Fecha inválida: ${value}`);
    return d;
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new TypeError('DateTime debe ser una cadena ISO-8601.');
    const d = new Date(ast.value);
    if (Number.isNaN(d.getTime())) throw new TypeError(`Fecha inválida: ${ast.value}`);
    return d;
  },
});

// ------------------------------------------------------------
// Resolvers
// ------------------------------------------------------------
const authResolvers = createAuthResolvers(redisClient); // sesión, acceso (Neo4j) y administración de roles

// Cambia el estado de una orden (valida quién puede y la transición, y repone
// stock al cancelar). El cambio y su entrada en statusHistory son UNA escritura
// atómica condicionada al estado y al repartidor que se validaron: si otra
// petición movió la orden, la aceptó o la liberó en medio, no escribe nada, se
// relee y se vuelve a validar contra la orden real, permiso y repartidor
// incluidos (el perdedor recibe ORDER_ALREADY_IN_STATUS, INVALID_STATUS_TRANSITION
// o NOT_ASSIGNED_DRIVER, o se aplica si sigue siendo válido). Así nunca hay una
// transición sin entrada ni una entrada sin transición.
// Actualización con pipeline (Mongoose no castea aquí: ids como ObjectId y fechas como Date).
// Si el historial está vacío, ausente o no empieza en PENDING (la migración no corrió),
// antepone el PENDING inferido; luego agrega la entrada nueva y conserva solo las últimas
// STATUS_HISTORY_MAX (findOneAndUpdate no corre los validadores del esquema).
function statusChangeUpdate(status, actor) {
  const entry = statusChangeEntry(status, actor);
  if (entry.byUserId != null) entry.byUserId = oid(entry.byUserId);
  const history = { $ifNull: ['$statusHistory', []] };
  const firstStatus = { $arrayElemAt: [{ $map: { input: history, as: 'e', in: '$$e.status' } }, 0] };
  const seed = { status: 'PENDING', at: { $ifNull: ['$createdAt', '$updatedAt'] }, byUserId: null, byRole: null, inferred: true };
  return [{
    $set: {
      status: { $literal: status },
      __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
      statusHistory: {
        $slice: [{ $concatArrays: [{ $cond: [{ $ne: [firstStatus, 'PENDING'] }, [seed], []] }, history, [{ $literal: entry }]] }, -STATUS_HISTORY_MAX],
      },
    },
  }];
}

async function changeOrderStatus(order, status, ctx, { cancel = false } = {}) {
  const actor = ctx.currentUser;
  // Cada reintento significa que el estado avanzó (las transiciones no regresan)
  // o que cambió el repartidor de una orden READY: termina.
  for (;;) {
    const denial = orderStatusDenial(actor, order, status);
    if (denial) denyOrder(denial, { cancel });
    assertTransition(order.status, status, order.mode);
    const previous = order.status;
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: previous, driverId: order.driverId ?? null },
      statusChangeUpdate(status, actor),
      { returnDocument: 'after' },
    );
    if (updated) return finishStatusChange(updated, previous, status, ctx);
    const id = order._id;
    order = await Order.findById(id);
    if (!order) throw notFound('ORDER', id);
  }
}

async function finishStatusChange(order, previous, status, ctx) {
  // Salió de reparto (entregada o cancelada): su última posición ya no se sirve. La escritura de
  // Mongo ya salió bien y esto no la espera: un Redis lento o colgado no retrasa el stock, el evento
  // ni la respuesta. clear nunca lanza ni rechaza; si falla lo registra y el TTL limpia.
  if (previous === 'IN_DELIVERY') void locationStore.clear(order._id);
  // Repone el stock consumido, incluido el contenido de los paquetes.
  if (status === 'CANCELLED') await releaseStock(stockDemand(order.items));
  emitEvent({
    type: 'ORDER_STATUS_CHANGED', category: CATEGORIES.ORDER, targetType: 'Order', targetId: order._id,
    reason: `${previous} → ${status}`,
    metadata: { number: order.number, from: previous, to: status, storeId: String(order.storeId), mode: order.mode },
  }, ctx);
  return order;
}

// ---------- Reparto: aceptar y liberar una entrega ----------
// Aceptar no cambia el estado (la orden sigue READY): statusHistory no registra
// nada; la asignación se lee en Order.driver y Order.assignedAt.
async function loadOrder(orderId) {
  const order = mongoose.isValidObjectId(orderId) ? await Order.findById(orderId) : null;
  if (!order) throw notFound('ORDER', orderId);
  return order;
}

// Una entrega activa por repartidor: el índice único parcial
// `one_active_delivery_per_driver` (models/order.js) rechaza con E11000 la
// escritura que le daría una segunda orden READY / IN_DELIVERY.
const isActiveDeliveryClash = err => err?.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'driverId');
const activeDeliveryOf = driverId => Order.findOne({ driverId: oid(driverId), status: { $in: ACTIVE_DELIVERY_STATUSES } }).select('_id');
const alreadyDelivering = activeId => new DomainError('Ya tienes una entrega activa: termínala o libérala antes de aceptar otra.', 'ALREADY_DELIVERING', {
  activeOrderId: activeId == null ? null : String(activeId),
});

function deliveryEvent(type, order, driverId, ctx) {
  emitEvent({
    type, category: CATEGORIES.ORDER, targetType: 'Order', targetId: order._id,
    reason: `Orden ${order.number}`,
    metadata: { number: order.number, storeId: String(order.storeId), driverId: String(driverId) },
  }, ctx);
}

// Una sola escritura condicionada a que la orden siga libre ({ READY, DELIVERY,
// driverId: null }): de dos aceptaciones simultáneas solo una la encuentra así.
// Si nada coincide se relee para decir por qué (ORDER_NOT_AVAILABLE + reason).
async function acceptDelivery(orderId, ctx) {
  const me = requirePermission(ctx, PERMISSIONS.ORDERS_DELIVER);
  let order = await loadOrder(orderId);
  const denial = acceptDeliveryDenial(me, order);
  if (denial) denyOrder(denial);
  for (let clashes = 0; ;) {
    // Defensa en profundidad: si el índice único faltara, esto aún impide una
    // segunda entrega activa en serie (ante aceptaciones simultáneas, solo el índice).
    const active = await activeDeliveryOf(me.id);
    if (active && !sameId(active._id, order._id)) throw alreadyDelivering(active._id);
    let updated;
    try {
      updated = await Order.findOneAndUpdate(
        { _id: order._id, mode: 'DELIVERY', status: 'READY', driverId: null },
        { $set: { driverId: oid(me.id), assignedAt: new Date() }, $inc: { __v: 1 } },
        { returnDocument: 'after' },
      );
    } catch (err) {
      if (!isActiveDeliveryClash(err)) throw err;
      const holding = await activeDeliveryOf(me.id);
      // La entrega activa terminó entre el choque y la consulta: se reintenta una vez.
      if (!holding && (clashes += 1) < 2) continue;
      throw alreadyDelivering(holding?._id);
    }
    if (updated) {
      deliveryEvent('DELIVERY_ACCEPTED', updated, me.id, ctx);
      return updated;
    }
    order = await loadOrder(order._id);
    // El mismo repartidor la reintenta (p. ej. tras un corte de red): ya es suya.
    if (order.status === 'READY' && sameId(order.driverId, me.id)) return order;
    const reason = deliveryUnavailableReason(order);
    if (reason) throw orderNotAvailableError(order, reason);
    // Se liberó entre la escritura y la relectura: se intenta de nuevo.
  }
}

// Solo mientras sigue READY. Condicionada al repartidor que se validó: si en medio
// otro la liberó y la tomó, se relee y se vuelve a validar quién puede liberarla.
async function releaseDelivery(orderId, ctx) {
  const me = requireAuth(ctx);
  let order = await loadOrder(orderId);
  for (;;) {
    const denial = releaseDeliveryDenial(me, order);
    if (denial) denyOrder(denial);
    const reason = deliveryUnavailableReason(order);
    if (reason && reason !== 'TAKEN') throw orderNotAvailableError(order, reason);
    if (order.driverId == null) return order; // ya estaba libre
    const { driverId } = order;
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: 'READY', driverId },
      { $set: { driverId: null, assignedAt: null }, $inc: { __v: 1 } },
      { returnDocument: 'after' },
    );
    if (updated) {
      deliveryEvent('DELIVERY_RELEASED', updated, driverId, ctx);
      return updated;
    }
    order = await loadOrder(order._id);
  }
}

// ---------- Reparto: ubicación del repartidor (Redis, solo el último punto) ----------
// Se reporta cada ~3 s por repartidor y se lee cada ~2 s por cliente: de la orden se
// carga solo lo que deciden el acceso y el estado (domain/access.js, driver-location.js).
const LOCATION_ORDER_FIELDS = 'status mode driverId storeId userId';
const loadOrderForLocation = orderId =>
  (mongoose.isValidObjectId(orderId) ? Order.findById(orderId).select(LOCATION_ORDER_FIELDS).lean() : null);

// Una sola vez al arrancar: el TTL de cada punto (DRIVER_LOCATION_TTL_SECONDS, 1 a 86400 s; 600 por omisión).
const locationStore = createLocationStore(redisClient, { ttlSeconds: locationTtlSeconds(process.env.DRIVER_LOCATION_TTL_SECONDS) });

// Primero quién (permiso, repartidor asignado) y después el estado, para que la app
// se detenga ante "no es tuya" y ante "ya no está en reparto"; al final, las coordenadas.
// La hora de recepción (at y seq) es la del reloj de Redis y se toma antes de esperar a MongoDB:
// un reporte lento no pisa a uno más nuevo y el reloj de este proceso no interviene.
async function reportDriverLocation(orderId, lat, lng, ctx) {
  const me = requirePermission(ctx, PERMISSIONS.ORDERS_DELIVER);
  const receivedMs = await locationStore.now();
  const order = await loadOrderForLocation(orderId);
  if (!order) throw notFound('ORDER', orderId);
  const denial = reportLocationDenial(me, order);
  if (denial) denyOrder(denial);
  assertTrackable(order);
  assertValidLocation(lat, lng);
  await locationStore.save(order._id, newLocationRecord({ lat, lng, nowMs: receivedMs }));
  return true; // también si se ignoró por el límite de 1 por segundo: un cliente insistente no es un error
}

// El punto vigente de una orden que el solicitante ya puede ver; solo mientras va en camino.
// Solo coordenadas y tiempos: nunca el repartidor. La edad se calcula con la hora de Redis;
// un punto con hora del futuro más allá de la tolerancia se trata como inválido (null).
async function currentDriverLocation(order) {
  if (!isTrackable(order)) return null;
  const { record, nowMs } = await locationStore.get(order._id);
  return record && locationView(record, nowMs);
}

const resolvers = {
  DateTime,

  Access: authResolvers.Access,

  // Los usuarios llegan a GraphQL como vistas planas (ver entity-cache.js): sin passwordHash.
  User: {
    __resolveReference: ref => getUser(ref.id),
  },

  Category: {
    __resolveReference: ref => Category.findById(ref.id).exec(),
    // Categoría global: sus productos activos de todas las sucursales activas.
    products: async cat => Product.find({ categoryId: cat._id, isActive: true, storeId: { $in: await activeStoreIds() } }).sort({ name: 1 }).exec(),
  },

  ProductDiscount: {
    isCurrent: d => isDiscountActive(d),
  },

  Product: {
    __resolveReference: ref => getProduct(ref.id),
    store: p => Store.findById(p.storeId).exec(),
    category: p => Category.findById(p.categoryId).exec(),
    activeDiscountPercent: p => bestDiscountPercent(p.discounts),
    effectivePrice: p => applyDiscount(p.price, bestDiscountPercent(p.discounts)),
    packages: async (p, _, ctx) => {
      const docs = await Package.find({ 'items.productId': p.id, isActive: true }).sort({ name: 1 }).exec();
      return (await Promise.all(docs.map(d => visibleItem(ctx, d)))).filter(Boolean);
    },
  },

  Package: {
    __resolveReference: ref => Package.findById(ref.id).exec(),
    store: doc => Store.findById(doc.storeId).exec(),
    availableStock: async doc => (await packageEntity(doc)).availableStock(),
    alaCarteTotal: async doc => (await packageEntity(doc)).alaCarteTotal(),
    savings: async doc => (await packageEntity(doc)).savings(),
  },

  PackageItem: {
    product: i => getProduct(i.productId),
  },

  // Catálogo de la sucursal (marketplace). Si está inactiva solo lo ve quien lo administra.
  Store: {
    __resolveReference: ref => Store.findById(ref.id).exec(),
    products: (store, args, ctx) => listProducts(storeFilterOf(ctx, store, args.activeOnly), args),
    packages: (store, { activeOnly }, ctx) => listPackages(storeFilterOf(ctx, store, activeOnly)),
    // Categorías (globales) con al menos un producto activo en esta sucursal.
    categories: async (store, _, ctx) => {
      if (!storeVisible(ctx, store)) return [];
      const ids = await Product.distinct('categoryId', { storeId: store._id, isActive: true });
      return Category.find({ _id: { $in: ids } }).sort({ sortOrder: 1, name: 1 }).exec();
    },
  },

  OrderItem: {
    type: itemType,
    product: i => getProduct(i.productId),
    package: i => (i.packageId ? Package.findById(i.packageId).exec() : null),
    lineDiscount: i => lineDiscount(i),
    contents: i => i.contents ?? [],
  },

  Order: {
    __resolveReference: ref => Order.findById(ref.id).exec(),
    user: o => getUser(o.userId),
    store: o => Store.findById(o.storeId).exec(),
    subtotal: o => orderSubtotal(o.items),
    discountTotal: o => orderDiscountTotal(o.items),
    // Más antiguo primero. `order` viaja con cada entrada para decidir quién ve `by`.
    statusHistory: o => (o.statusHistory ?? []).map(h => ({ ...h.toObject(), order: o })),
    // Solo id y nombre: el cliente no ve el correo ni el rol del repartidor.
    driver: async o => {
      const user = o.driverId ? await getUser(o.driverId) : null;
      return user ? { id: user.id, name: user.name } : null;
    },
    // Mismas reglas que la consulta driverLocation (quien no puede ver la orden, null).
    driverLocation: (o, _, ctx) => (canViewOrder(ctx.currentUser, o) ? currentDriverLocation(o) : null),
  },

  OrderStatusChange: {
    // El cliente ve el rol, no quién fue; el personal de la sucursal y ADMIN, sí.
    // Solo id y nombre (OrderActor): ni correo ni direcciones del empleado o repartidor.
    by: async (h, _, ctx) => {
      const user = h.byUserId && canSeeStatusActor(ctx.currentUser, h.order) ? await getUser(h.byUserId) : null;
      return user ? { id: user.id, name: user.name } : null;
    },
  },

  ShoppingListItem: {
    type: itemType,
    product: async (i, _, ctx) => visibleItem(ctx, await getProduct(i.productId)),
    package: async (i, _, ctx) => (i.packageId ? visibleItem(ctx, await Package.findById(i.packageId).exec()) : null),
  },

  ShoppingList: {
    user: l => getUser(l.userId),
  },

  CartLine: {
    type: itemType,
    product: i => getProduct(i.productId),
    package: i => (i.packageId ? Package.findById(i.packageId).exec() : null),
  },

  UnavailableCartLine: {
    type: itemType,
  },

  Cart: {
    store: c => (c.storeId ? Store.findById(c.storeId).exec() : null),
  },

  Query: {
    ...authResolvers.Query,

    categories: () => Category.find().sort({ sortOrder: 1, name: 1 }).exec(),
    category: (_, { id }) => Category.findById(id).exec(),

    // Sin storeId: el marketplace completo (todas las sucursales activas).
    products: async (_, { storeId, ...args }, ctx) => listProducts(await listingFilter(ctx, storeId, args.activeOnly), args),
    product: async (_, { id }, ctx) => visibleItem(ctx, await getProduct(id)),

    packages: async (_, { storeId, activeOnly }, ctx) => listPackages(await listingFilter(ctx, storeId, activeOnly)),
    package: async (_, { id }, ctx) => visibleItem(ctx, await Package.findById(id).exec()),

    stores: (_, { activeOnly }) => Store.find(activeOnly ? { isActive: true } : {}).sort({ name: 1 }).exec(),
    store: (_, { id }) => Store.findById(id).exec(),

    users: async (_, { limit, offset }, ctx) => {
      requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
      const docs = await User.find().sort({ createdAt: -1 }).skip(offset).limit(Math.min(limit, 100)).exec();
      return docs.map(userView);
    },
    user: (_, { id }, ctx) => {
      requireSelfOrPermission(ctx, id);
      return getUser(id);
    },

    // Cliente: las suyas. Personal: las de sus sucursales. ADMIN: todas (ver ordersFilter).
    orders: (_, { userId, storeId, status, limit, offset }, ctx) => {
      const q = ordersFilter(requireAuth(ctx), { userId, storeId });
      if (status) q.status = status;
      return Order.find(q).sort({ createdAt: -1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    order: async (_, { id }, ctx) => viewableOrder(ctx, await Order.findById(id).exec()),
    orderByNumber: async (_, { number }, ctx) => viewableOrder(ctx, await Order.findOne({ number }).exec()),

    // ---------- Reparto (orders:deliver) ----------
    // Mismo alcance que los reportes: con storeId esa sucursal (si es del alcance); sin él, las del alcance (ADMIN: todas).
    availableDeliveries: (_, { storeId, limit, offset }, ctx) => {
      const me = requirePermission(ctx, PERMISSIONS.ORDERS_DELIVER);
      const scope = reportStoreScope(me, storeId);
      if (scope.denied) deny(scope.denied);
      const stores = scope.storeIds == null ? {} : { storeId: { $in: scope.storeIds.filter(id => mongoose.isValidObjectId(id)).map(oid) } };
      return Order.find({ ...stores, mode: 'DELIVERY', status: 'READY', driverId: null })
        .sort({ createdAt: 1, _id: 1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    // active: la entrega en curso; si no, el historial (entregadas y canceladas), la más reciente primero.
    myDeliveries: (_, { active, limit, offset }, ctx) => {
      const me = requirePermission(ctx, PERMISSIONS.ORDERS_DELIVER);
      const status = active ? ACTIVE_DELIVERY_STATUSES : ['DELIVERED', 'CANCELLED'];
      return Order.find({ driverId: oid(me.id), status: { $in: status } })
        .sort({ updatedAt: -1, _id: -1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    currentDelivery: (_, __, ctx) => {
      const me = requirePermission(ctx, PERMISSIONS.ORDERS_DELIVER);
      return Order.findOne({ driverId: oid(me.id), status: { $in: ACTIVE_DELIVERY_STATUSES } }).exec();
    },
    // Quien puede ver la orden (viewableOrder); null si no existe o no va en camino.
    // Sesión primero: sin ella no se consulta MongoDB.
    driverLocation: async (_, { orderId }, ctx) => {
      requireAuth(ctx);
      const order = viewableOrder(ctx, await loadOrderForLocation(orderId));
      return order && currentDriverLocation(order);
    },

    shoppingLists: (_, { userId }, ctx) => {
      requireSelfOrPermission(ctx, userId);
      return ShoppingList.find({ userId: oid(userId) }).sort({ updatedAt: -1 }).exec();
    },
    shoppingList: async (_, { id }, ctx) => ownedOrNull(ctx, await ShoppingList.findById(id).exec()),

    // Cotiza y guarda la cotización 15 min; su quoteId se manda al comprar.
    // La sucursal (y su tarifa de envío) es la de los artículos.
    quoteOrder: async (_, { input }) => {
      const { mode, storeId, items } = input;
      const lines = await buildLines(items);
      const store = await purchaseStore(lines, storeId);
      return issueQuote({ mode, store }, priceOrder({ mode, store, lines }));
    },

    cart: (_, { mode, storeId }, ctx) => buildCart(requireAuth(ctx).id, { mode, storeId }),

    // Ids desde Redis (lista de 20); estado e importes siempre desde Mongo.
    recentOrders: async (_, __, ctx) => {
      const me = requireAuth(ctx);
      const ids = await getRecentOrderIds(me.id);
      if (ids) {
        const docs = await Order.find({ _id: { $in: ids.map(oid) } }).exec();
        const byId = new Map(docs.map(d => [String(d._id), d]));
        return ids.map(id => byId.get(id)).filter(Boolean);
      }
      const docs = await Order.find({ userId: oid(me.id) }).sort({ createdAt: -1 }).limit(RECENT_ORDERS).exec();
      await setRecentOrders(me.id, docs.map(d => d._id));
      return docs;
    },

    // Pipeline de agregación #1: ventas consolidadas por sucursal y por producto o paquete.
    salesReport: async (_, { from, to, storeId }, ctx) => {
      const stores = reportStoreMatch(ctx, storeId);
      const rows = await Order.aggregate([
        { $match: { status: 'DELIVERED', createdAt: { $gte: new Date(from), $lte: new Date(to) }, ...stores } },
        { $unwind: '$items' },
        { $group: {
          _id: { storeId: '$storeId', productId: '$items.productId', packageId: '$items.packageId' },
          name: { $first: '$items.name' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.lineTotal' },
          orderCount: { $addToSet: '$_id' },
        } },
        { $sort: { revenue: -1 } },
      ]);
      const names = await storeNames(rows.map(r => r._id.storeId));
      return rows.map(r => ({
        storeId: String(r._id.storeId),
        storeName: names.get(String(r._id.storeId)) ?? 'N/D',
        type: r._id.packageId ? 'PACKAGE' : 'PRODUCT',
        itemId: r._id.packageId ?? r._id.productId,
        name: r.name,
        quantity: r.quantity,
        revenue: round2(r.revenue),
        orderCount: r.orderCount.length,
      }));
    },

    // Pipeline de agregación #2: explota los paquetes vendidos en sus productos
    // ($match → $unwind items → $match paquetes → $unwind contents →
    //  $group por sucursal y producto → $lookup nombre → $sort). Sirve para saber cuánta
    // arrachera / chorizo / carbón comprar para surtir los combos del periodo.
    packageComponentDemand: async (_, { from, to, storeId }, ctx) => {
      const stores = reportStoreMatch(ctx, storeId);
      const rows = await Order.aggregate([
        { $match: { status: { $ne: 'CANCELLED' }, createdAt: { $gte: new Date(from), $lte: new Date(to) }, ...stores } },
        { $unwind: '$items' },
        { $match: { 'items.packageId': { $ne: null } } },
        { $unwind: '$items.contents' },
        { $group: {
          _id: { storeId: '$storeId', productId: '$items.contents.productId' },
          quantityNeeded: { $sum: { $multiply: ['$items.contents.quantity', '$items.quantity'] } },
          packagesSold: { $sum: '$items.quantity' },
          inPackages: { $addToSet: '$items.packageId' },
        } },
        { $lookup: { from: 'products', localField: '_id.productId', foreignField: '_id', as: 'product' } },
        { $sort: { quantityNeeded: -1 } },
      ]);
      const names = await storeNames(rows.map(r => r._id.storeId));
      return rows.map(r => ({
        storeId: String(r._id.storeId),
        storeName: names.get(String(r._id.storeId)) ?? 'N/D',
        productId: r._id.productId,
        name: r.product?.[0]?.name ?? 'N/D',
        quantityNeeded: r.quantityNeeded,
        packagesSold: r.packagesSold,
        inPackages: r.inPackages.length,
      }));
    },
  },

  Mutation: {
    ...authResolvers.Mutation, // login, refreshToken, logout, logoutAllDevices

    // ---------- Usuarios ----------
    // Registro abierto: siempre CUSTOMER. Otro rol solo con users:manage.
    createUser: async (_, { input }, ctx) => {
      const { password, role = DEFAULT_ROLE, ...rest } = input;
      if (role !== DEFAULT_ROLE) requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
      if (password.length < 8) throw new DomainError('La contraseña debe tener al menos 8 caracteres.', 'PASSWORD_TOO_SHORT', { minLength: 8 });
      const user = await User.create({ ...rest, role, passwordHash: hashPassword(password) });
      // El nodo en Neo4j se crea ya; si el grafo no responde, se crea en su primer login.
      if (isNeo4jReady()) {
        await rbac.ensureUser({ id: user._id, email: user.email, name: user.name }, role)
          .catch(err => console.warn('⚠️  Usuario sin nodo en Neo4j (se creará al iniciar sesión):', err.message));
      }
      emitEvent({
        type: 'USER_REGISTERED', category: CATEGORIES.ADMIN,
        actorId: ctx.currentUser?.id ?? user._id, actorRole: ctx.currentUser?.role ?? role,
        targetType: 'User', targetId: user._id,
        reason: ctx.currentUser ? 'Alta hecha por un administrador' : 'Registro abierto',
        metadata: { email: user.email, role },
      }, ctx);
      return cacheUser(user);
    },
    addUserAddress: async (_, { userId, address }, ctx) => {
      requireSelfOrPermission(ctx, userId);
      const user = await User.findById(userId);
      if (!user) throw notFound('USER', userId);
      const { isDefault, ...data } = address;
      user.addresses.push(data);
      const added = user.addresses[user.addresses.length - 1];
      if (isDefault || !user.defaultAddressId) user.defaultAddressId = added._id;
      await user.save();
      return cacheUser(user);
    },
    setDefaultAddress: async (_, { userId, addressId }, ctx) => {
      requireSelfOrPermission(ctx, userId);
      const user = await User.findById(userId);
      if (!user) throw notFound('USER', userId);
      if (!user.addresses.id(addressId)) throw notFound('ADDRESS', addressId);
      user.defaultAddressId = addressId;
      await user.save();
      return cacheUser(user);
    },
    removeUserAddress: async (_, { userId, addressId }, ctx) => {
      requireSelfOrPermission(ctx, userId);
      const user = await User.findById(userId);
      if (!user) throw notFound('USER', userId);
      const address = user.addresses.id(addressId);
      if (!address) throw notFound('ADDRESS', addressId);
      address.deleteOne();
      if (sameId(user.defaultAddressId, addressId)) user.defaultAddressId = user.addresses[0]?._id ?? null;
      await user.save();
      return cacheUser(user);
    },

    // ---------- Catálogo (catalog:manage; inventario: stock:manage) ----------
    // Marketplace: los dos permisos aplican solo a los artículos de las
    // sucursales del alcance (WORKS_AT; ADMIN: todas). Las categorías son
    // globales: crearlas exige además scope:all_stores.
    createCategory: async (_, { input }, ctx) => {
      const denial = categoryDenial(requireAuth(ctx));
      if (denial) deny(denial);
      const category = await Category.create(input);
      catalogEvent(ctx, 'CATEGORY_CREATED', 'Category', category, category.name);
      return category;
    },

    createProduct: async (_, { input }, ctx) => {
      await requireCatalogStore(ctx, input.storeId);
      if (!(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('CATEGORY', input.categoryId);
      const product = await Product.create(input);
      catalogEvent(ctx, 'PRODUCT_CREATED', 'Product', product, product.name, { price: product.price, stock: product.stock, unit: product.unit });
      return product;
    },
    // La sucursal no cambia: ProductUpdateInput no la trae y el campo es inmutable.
    updateProduct: async (_, { id, input }, ctx) => {
      const product = await managedProduct(ctx, PERMISSIONS.CATALOG_MANAGE, id);
      if (input.categoryId && !(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('CATEGORY', input.categoryId);
      const changes = diff(product.toObject(), input);
      Object.assign(product, input);
      await product.save();
      await invalidateProducts(id);
      if (Object.keys(changes).length) {
        const reason = changes.price ? `Precio $${changes.price.from} → $${changes.price.to}` : `Cambios: ${Object.keys(changes).join(', ')}`;
        catalogEvent(ctx, 'PRODUCT_UPDATED', 'Product', product, reason, { name: product.name, changes });
      }
      return product;
    },
    // Desactivar un producto deja sin disponibilidad a los paquetes que lo
    // contienen automáticamente (su stock es derivado): no hay que tocarlos.
    setProductActive: async (_, { id, active }, ctx) => {
      await managedProduct(ctx, PERMISSIONS.CATALOG_MANAGE, id);
      const before = await Product.findByIdAndUpdate(id, { isActive: active }, { new: false });
      if (!before) throw notFound('PRODUCT', id);
      await invalidateProducts(id);
      if (before.isActive !== active) {
        catalogEvent(ctx, 'PRODUCT_ACTIVE_CHANGED', 'Product', before, active ? 'Activado' : 'Desactivado', { name: before.name, from: before.isActive, to: active });
      }
      return Product.findById(id).exec();
    },
    // El stock es de la sucursal del producto.
    setProductStock: async (_, { id, stock }, ctx) => {
      requirePermission(ctx, PERMISSIONS.STOCK_MANAGE);
      if (!Number.isInteger(stock) || stock < 0) throw new DomainError('El stock debe ser un entero >= 0.', 'INVALID_STOCK');
      await managedProduct(ctx, PERMISSIONS.STOCK_MANAGE, id);
      const before = await Product.findByIdAndUpdate(id, { stock }, { new: false });
      if (!before) throw notFound('PRODUCT', id);
      await invalidateProducts(id);
      catalogEvent(ctx, 'STOCK_SET', 'Product', before, `Stock ${before.stock} → ${stock}`, { name: before.name, from: before.stock, to: stock });
      return Product.findById(id).exec();
    },
    addProductDiscount: async (_, { productId, input }, ctx) => {
      const product = await managedProduct(ctx, PERMISSIONS.CATALOG_MANAGE, productId);
      product.discounts.push(input);
      await product.save();
      await invalidateProducts(productId);
      const added = product.discounts[product.discounts.length - 1];
      catalogEvent(ctx, 'DISCOUNT_ADDED', 'Product', product, `${added.percent}% ${added.label ?? ''}`.trim(), {
        name: product.name, discountId: String(added._id), percent: added.percent, label: added.label, startsAt: added.startsAt, endsAt: added.endsAt,
      });
      return product;
    },
    removeProductDiscount: async (_, { productId, discountId }, ctx) => {
      const product = await managedProduct(ctx, PERMISSIONS.CATALOG_MANAGE, productId);
      const discount = product.discounts.id(discountId);
      if (!discount) throw notFound('DISCOUNT', discountId);
      const { percent, label } = discount;
      discount.deleteOne();
      await product.save();
      await invalidateProducts(productId);
      catalogEvent(ctx, 'DISCOUNT_REMOVED', 'Product', product, `${percent}% ${label ?? ''}`.trim(), { name: product.name, discountId: String(discountId), percent, label });
      return product;
    },

    // ---------- Paquetes (catalog:manage) ----------
    // Un paquete solo contiene productos de su propia sucursal (PACKAGE_STORE_MISMATCH).
    createPackage: async (_, { input }, ctx) => {
      await requireCatalogStore(ctx, input.storeId);
      assertPackagePersistable(input); // valida la composición antes de tocar la BD
      await assertPackageProducts(input.storeId, input.items);
      const pkg = await Package.create(input);
      catalogEvent(ctx, 'PACKAGE_CREATED', 'Package', pkg, pkg.name, { price: pkg.price, items: pkg.items.length });
      return pkg;
    },
    updatePackage: async (_, { id, input }, ctx) => {
      const pkg = await managedPackage(ctx, id);
      if (input.items) {
        assertPackagePersistable({ ...pkg.toObject(), ...input });
        await assertPackageProducts(pkg.storeId, input.items);
      }
      const { items, ...fields } = input;
      const changes = diff(pkg.toObject(), fields);
      Object.assign(pkg, input);
      await pkg.save();
      const reason = changes.price ? `Precio $${changes.price.from} → $${changes.price.to}` : 'Paquete editado';
      catalogEvent(ctx, 'PACKAGE_UPDATED', 'Package', pkg, reason, { name: pkg.name, changes, itemsChanged: Boolean(items), items: pkg.items.length });
      return pkg;
    },
    setPackageActive: async (_, { id, active }, ctx) => {
      await managedPackage(ctx, id);
      const before = await Package.findByIdAndUpdate(id, { isActive: active }, { new: false });
      if (!before) throw notFound('PACKAGE', id);
      if (before.isActive !== active) {
        catalogEvent(ctx, 'PACKAGE_ACTIVE_CHANGED', 'Package', before, active ? 'Activado' : 'Desactivado', { name: before.name, from: before.isActive, to: active });
      }
      return Package.findById(id).exec();
    },

    // ---------- Sucursales (stores:manage) ----------
    createStore: async (_, { input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.STORES_MANAGE);
      const store = await Store.create(input);
      await syncStoreNode(store);
      emitEvent({ type: 'STORE_CREATED', category: CATEGORIES.ADMIN, targetType: 'Store', targetId: store._id, reason: store.name, metadata: { city: store.address?.city } }, ctx);
      return store;
    },
    updateStore: async (_, { id, input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.STORES_MANAGE);
      const before = await Store.findById(id);
      if (!before) throw notFound('STORE', id);
      const changes = diff(before.toObject(), input);
      const store = await Store.findByIdAndUpdate(id, input, { new: true, runValidators: true });
      await syncStoreNode(store);
      emitEvent({ type: 'STORE_UPDATED', category: CATEGORIES.ADMIN, targetType: 'Store', targetId: store._id, reason: store.name, metadata: { changes } }, ctx);
      return store;
    },

    // ---------- Órdenes ----------
    createOrder: (_, { input }, ctx) => {
      requireSelfOrPermission(ctx, input.userId);
      return placeOrder(input, ctx);
    },

    // ---------- Carrito (Redis: solo ids y cantidades) ----------
    addToCart: async (_, { productId, packageId, quantity }, ctx) => {
      const me = requireAuth(ctx);
      const ref = itemRef({ productId, packageId });
      await assertCartAcceptsRef(me.id, ref);
      await cartStore.addToCart(me.id, ref, quantity);
      return buildCart(me.id);
    },
    setCartItemQuantity: async (_, { productId, packageId, quantity }, ctx) => {
      const me = requireAuth(ctx);
      const ref = itemRef({ productId, packageId });
      if (quantity > 0) await assertCartAcceptsRef(me.id, ref);
      await cartStore.setCartQuantity(me.id, ref, quantity);
      return buildCart(me.id);
    },
    removeFromCart: async (_, { productId, packageId }, ctx) => {
      const me = requireAuth(ctx);
      await cartStore.removeFromCart(me.id, itemRef({ productId, packageId }));
      return buildCart(me.id);
    },
    clearCart: async (_, __, ctx) => {
      await cartStore.clearCart(requireAuth(ctx).id);
      return true;
    },

    // Compra el carrito del usuario autenticado. Si alguna partida ya no se
    // puede comprar, se rechaza con la lista; el carrito se vacía solo si la
    // orden se creó.
    checkoutCart: async (_, { input }, ctx) => {
      const me = requireAuth(ctx);
      if (input.idempotencyKey) {
        const existing = await Order.findOne({ userId: oid(me.id), idempotencyKey: input.idempotencyKey });
        if (existing) return existing;
      }

      const refs = await cartStore.getCart(me.id);
      if (!refs.length) throw new DomainError('El carrito está vacío.', 'CART_EMPTY');
      const lines = await loadLines(refs);
      const { unavailable } = reconcileCart(lines, { storeId: cartStoreId(lines, input.storeId) });
      if (unavailable.length) {
        const names = unavailable.map(u => (u.package ?? u.product)?.name ?? 'producto eliminado').join(', ');
        throw new DomainError(`Hay partidas no disponibles en el carrito: ${names}.`, 'CART_HAS_UNAVAILABLE_ITEMS', {
          unavailable: unavailable.map(u => ({ productId: u.productId ?? null, packageId: u.packageId ?? null, reason: u.reason, availableQuantity: u.available })),
        });
      }

      const order = await placeOrder({ ...input, userId: me.id, items: refs }, ctx);
      await cartStore.clearCart(me.id);
      return order;
    },

    // El personal mueve las órdenes de SUS sucursales: orders:prepare (confirmar,
    // preparar, lista, entregar en mostrador, cancelar) u orders:deliver (reparto:
    // solo el repartidor asignado, o ADMIN). El permiso se valida en changeOrderStatus.
    updateOrderStatus: async (_, { id, status }, ctx) => {
      requireAuth(ctx);
      const order = await Order.findById(id);
      if (!order) throw notFound('ORDER', id);
      return changeOrderStatus(order, status, ctx);
    },

    // El cliente cancela la suya (si el estado lo permite); el personal, las de su
    // sucursal. Cancelar una orden asignada conserva su driverId como historia.
    cancelOrder: async (_, { id }, ctx) => {
      requireAuth(ctx);
      const order = await Order.findById(id);
      if (!order) throw notFound('ORDER', id);
      return changeOrderStatus(order, 'CANCELLED', ctx, { cancel: true });
    },

    // ---------- Reparto ----------
    acceptDelivery: (_, { orderId }, ctx) => acceptDelivery(orderId, ctx),
    releaseDelivery: (_, { orderId }, ctx) => releaseDelivery(orderId, ctx),
    reportDriverLocation: (_, { orderId, lat, lng }, ctx) => reportDriverLocation(orderId, lat, lng, ctx),

    // ---------- Listas guardadas ----------
    createShoppingList: async (_, { input }, ctx) => {
      requireSelfOrPermission(ctx, input.userId);
      if (!(await User.exists({ _id: oid(input.userId) }))) throw notFound('USER', input.userId);
      return ShoppingList.create(input);
    },
    addItemToShoppingList: async (_, { listId, productId, packageId, quantity }, ctx) => {
      const ref = itemRef({ productId, packageId });
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('SHOPPING_LIST', listId);
      requireSelfOrPermission(ctx, list.userId);
      const exists = ref.productId
        ? await Product.exists({ _id: oid(ref.productId) })
        : await Package.exists({ _id: oid(ref.packageId) });
      if (!exists) throw notFound(ref.productId ? 'PRODUCT' : 'PACKAGE', ref.productId ?? ref.packageId);
      const item = list.items.find(i => sameId(i.productId, ref.productId) || sameId(i.packageId, ref.packageId));
      if (item) item.quantity += quantity;
      else list.items.push({ ...ref, quantity });
      await list.save();
      return list;
    },
    removeItemFromShoppingList: async (_, { listId, productId, packageId }, ctx) => {
      const ref = itemRef({ productId, packageId });
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('SHOPPING_LIST', listId);
      requireSelfOrPermission(ctx, list.userId);
      list.items = list.items.filter(i => !(sameId(i.productId, ref.productId) || sameId(i.packageId, ref.packageId)));
      await list.save();
      return list;
    },
    deleteShoppingList: async (_, { id }, ctx) => {
      requireAuth(ctx);
      const list = await ShoppingList.findById(id);
      if (!list) return false;
      requireSelfOrPermission(ctx, list.userId);
      await list.deleteOne();
      return true;
    },
  },
};

// ------------------------------------------------------------
// Arranque del subgrafo
// ------------------------------------------------------------
const server = new ApolloServer({
  schema: buildSubgraphSchema([{ typeDefs, resolvers }]),
  plugins: [auditPlugin], // ACCESS_DENIED y ORDER_REJECTED → bitácora
  // Errores de dominio, validación de Mongoose y claves duplicadas -> extensions.code estable.
  formatError: formatApiError,
  // En producción las respuestas de error no llevan stacktrace.
  includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production',
});

const port = parseInt(process.env.PORT_CAMPAMENTOS) || 4001;
const { url } = await startStandaloneServer(server, {
  listen: { port },
  // Se ejecuta en CADA petición: valida el JWT y que su sesión siga activa en Redis.
  context: createAuthContext(redisClient),
});
console.log(`🛒 Subgrafo Pickaroo (catálogo + órdenes) listo en: ${url}`);

if (process.env.SEED === 'true') {
  const { seed } = await import('./infrastructure/seed.js');
  await seed({ User, Category, Product, Package, Store });
}
