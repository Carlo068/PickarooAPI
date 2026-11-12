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
import {
  DomainError,
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
  assertPackagePersistable,
  assertQuoteStillValid,
  reconcileCart,
  buildOrderNumber,
  round2,
} from './domain/entities.js';
import { redisClient, initRedis } from './infrastructure/redis-om.js';
import { getProduct, invalidateProducts, getUser, cacheUser, userView } from './infrastructure/entity-cache.js';
import { hashPassword } from './infrastructure/passwords.js';
import * as cartStore from './infrastructure/cart-store.js';
import { saveQuote, getQuote, deleteQuote } from './infrastructure/quote-store.js';
import { RECENT_ORDERS, pushRecentOrder, getRecentOrderIds, setRecentOrders } from './infrastructure/recent-orders.js';
import { initNeo4j, isNeo4jReady } from './infrastructure/neo4j.js';
import * as rbac from './infrastructure/rbac-graph.js';
import { initEvents, emitEvent, diff, auditPlugin, CATEGORIES } from './infrastructure/events.js';
import { createAuthContext, createAuthResolvers, requireAuth, requirePermission, requireSelfOrPermission, forbidden } from './auth.js';
import { PERMISSIONS, DEFAULT_ROLE, hasPermission, inStoreScope, canViewOrder, canChangeOrderStatus } from './domain/access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// ------------------------------------------------------------
// Infraestructura: MongoDB
// ------------------------------------------------------------
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/pickaroodb';
await mongoose.connect(mongoUri);
console.log('✅ MongoDB (pickaroodb) conectado.');
await Promise.all(models.map(m => m.syncIndexes().catch(err => console.warn(`Índices de ${m.modelName}:`, err.message))));

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
const notFound = (what, id) => new DomainError(`${what} no encontrado${id ? ` (${id})` : ''}.`);
const oid = v => new mongoose.Types.ObjectId(String(v));
const uniq = xs => [...new Set(xs.map(String))];
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// Una partida referencia un producto O un paquete.
function itemRef({ productId, packageId }) {
  if (Boolean(productId) === Boolean(packageId)) throw new DomainError('Cada partida debe indicar productId o packageId (solo uno).');
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
  if (addressId && !found) throw notFound('Dirección', addressId);
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
  if (!canViewOrder(me, order)) throw forbidden('No tienes permiso para ver esta orden.');
  return order;
}

// Qué órdenes ve quien consulta: un cliente las suyas; el personal las de sus
// sucursales (el repartidor solo las de reparto); scope:all_stores todas.
function ordersFilter(me, { userId, storeId }) {
  if (userId && String(userId) === String(me.id)) return { userId: oid(me.id), ...(storeId ? { storeId: oid(storeId) } : {}) };

  if (hasPermission(me, PERMISSIONS.ALL_STORES)) {
    return { ...(userId ? { userId: oid(userId) } : {}), ...(storeId ? { storeId: oid(storeId) } : {}) };
  }

  const prepares = hasPermission(me, PERMISSIONS.ORDERS_PREPARE);
  const delivers = hasPermission(me, PERMISSIONS.ORDERS_DELIVER);
  if (prepares || delivers) {
    if (storeId && !inStoreScope(me, storeId)) throw forbidden('Esa sucursal no está asignada a tu usuario.');
    return {
      storeId: storeId ? oid(storeId) : { $in: me.storeIds.map(oid) },
      ...(userId ? { userId: oid(userId) } : {}),
      ...(prepares ? {} : { mode: 'DELIVERY' }),
    };
  }

  if (userId) throw forbidden('Solo puedes ver tus propias órdenes.');
  return { userId: oid(me.id), ...(storeId ? { storeId: oid(storeId) } : {}) };
}

// Evento de catálogo con el documento afectado como objetivo.
function catalogEvent(ctx, type, targetType, doc, reason, metadata = {}) {
  emitEvent({ type, category: CATEGORIES.CATALOG, targetType, targetId: doc._id, reason, metadata }, ctx);
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

async function assertProductsExist(ids) {
  const found = await Product.countDocuments({ _id: { $in: uniq(ids).map(oid) } });
  if (found !== uniq(ids).length) throw new DomainError('Algún producto del paquete no existe en el catálogo.');
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
    if (l.packageId && !l.package) throw notFound('Paquete', l.packageId);
    if (l.productId && !l.product) throw notFound('Producto', l.productId);
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
  if (!user) throw notFound('Usuario', userId);
  if (!user.isActive) throw new DomainError('El usuario está desactivado.');

  const store = await resolveStore(storeId);
  if (!store) throw new DomainError('No hay ninguna sucursal activa configurada.');

  // Precios y stock salen siempre de Mongo, nunca del caché.
  const deliveryAddress = mode === 'DELIVERY' ? resolveDeliveryAddress(address, addressId, user) : null;
  const lines = await buildLines(items);
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
async function buildCart(userId, { mode = 'PICKUP', storeId } = {}) {
  const lines = await loadLines(await cartStore.getCart(userId));
  const { available, unavailable } = reconcileCart(lines);
  const unavailableKeys = new Set(unavailable.map(u => u.productId ?? u.packageId));

  let quote = null;
  let quoteError = null;
  if (available.length) {
    try {
      const store = await resolveStore(storeId);
      quote = await issueQuote({ mode, store }, priceOrder({ mode, store, lines: available }));
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      quoteError = err.message; // p. ej. el mismo producto suelto y en paquete supera el stock
    }
  }

  return {
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

// Valida la referencia antes de guardarla en el carrito: debe existir y estar activa.
async function assertPurchasableRef(ref) {
  const id = ref.productId ?? ref.packageId;
  const Model = ref.productId ? Product : Package;
  const what = ref.productId ? 'Producto' : 'Paquete';
  if (!mongoose.isValidObjectId(id)) throw notFound(what, id);
  const doc = await Model.findById(id).select('name isActive');
  if (!doc) throw notFound(what, id);
  if (!doc.isActive) throw new DomainError(`"${doc.name}" no está disponible.`);
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
        throw new DomainError(`Sin stock suficiente de "${p?.name ?? productId}" (disponible: ${p?.stock ?? 0}).`);
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

async function resolveStore(storeId) {
  let store = storeId ? await Store.findById(storeId) : null;
  if (storeId && !store) throw notFound('Sucursal', storeId);
  if (store && !store.isActive) throw new DomainError(`La sucursal "${store.name}" no está activa.`);
  // Sin sucursal indicada se usa la primera activa (setup de un solo restaurante).
  if (!store) store = await Store.findOne({ isActive: true }).sort({ createdAt: 1 });
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

// Cambia el estado de una orden (valida la transición y repone stock al cancelar).
async function changeOrderStatus(order, status, ctx) {
  assertTransition(order.status, status, order.mode);
  const previous = order.status;
  order.status = status;
  await order.save();

  // Repone el stock consumido, incluido el contenido de los paquetes.
  if (status === 'CANCELLED') await releaseStock(stockDemand(order.items));
  emitEvent({
    type: 'ORDER_STATUS_CHANGED', category: CATEGORIES.ORDER, targetType: 'Order', targetId: order._id,
    reason: `${previous} → ${status}`,
    metadata: { number: order.number, from: previous, to: status, storeId: String(order.storeId), mode: order.mode },
  }, ctx);
  return order;
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
    products: cat => Product.find({ categoryId: cat._id, isActive: true }).sort({ name: 1 }).exec(),
  },

  ProductDiscount: {
    isCurrent: d => isDiscountActive(d),
  },

  Product: {
    __resolveReference: ref => getProduct(ref.id),
    category: p => Category.findById(p.categoryId).exec(),
    activeDiscountPercent: p => bestDiscountPercent(p.discounts),
    effectivePrice: p => applyDiscount(p.price, bestDiscountPercent(p.discounts)),
    packages: p => Package.find({ 'items.productId': p.id, isActive: true }).sort({ name: 1 }).exec(),
  },

  Package: {
    __resolveReference: ref => Package.findById(ref.id).exec(),
    availableStock: async doc => (await packageEntity(doc)).availableStock(),
    alaCarteTotal: async doc => (await packageEntity(doc)).alaCarteTotal(),
    savings: async doc => (await packageEntity(doc)).savings(),
  },

  PackageItem: {
    product: i => getProduct(i.productId),
  },

  Store: {
    __resolveReference: ref => Store.findById(ref.id).exec(),
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
  },

  ShoppingListItem: {
    type: itemType,
    product: i => getProduct(i.productId),
    package: i => (i.packageId ? Package.findById(i.packageId).exec() : null),
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

  Query: {
    ...authResolvers.Query,

    categories: () => Category.find().sort({ sortOrder: 1, name: 1 }).exec(),
    category: (_, { id }) => Category.findById(id).exec(),

    products: (_, { categoryId, search, activeOnly, limit, offset }) => {
      const q = {};
      if (categoryId) q.categoryId = oid(categoryId);
      if (activeOnly) q.isActive = true;
      if (search) q.$text = { $search: search };
      return Product.find(q).sort({ name: 1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    product: (_, { id }) => getProduct(id),

    packages: (_, { activeOnly }) => Package.find(activeOnly ? { isActive: true } : {}).sort({ name: 1 }).exec(),
    package: (_, { id }) => Package.findById(id).exec(),

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

    shoppingLists: (_, { userId }, ctx) => {
      requireSelfOrPermission(ctx, userId);
      return ShoppingList.find({ userId: oid(userId) }).sort({ updatedAt: -1 }).exec();
    },
    shoppingList: async (_, { id }, ctx) => ownedOrNull(ctx, await ShoppingList.findById(id).exec()),

    // Cotiza y guarda la cotización 15 min; su quoteId se manda al comprar.
    quoteOrder: async (_, { input }) => {
      const { mode, storeId, items } = input;
      const store = await resolveStore(storeId);
      const lines = await buildLines(items);
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

    // Pipeline de agregación #1: ventas consolidadas por producto y por paquete.
    salesReport: async (_, { from, to }, ctx) => {
      requirePermission(ctx, PERMISSIONS.REPORTS_VIEW);
      const rows = await Order.aggregate([
        { $match: { status: 'DELIVERED', createdAt: { $gte: new Date(from), $lte: new Date(to) } } },
        { $unwind: '$items' },
        { $group: {
          _id: { productId: '$items.productId', packageId: '$items.packageId' },
          name: { $first: '$items.name' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.lineTotal' },
          orderCount: { $addToSet: '$_id' },
        } },
        { $sort: { revenue: -1 } },
      ]);
      return rows.map(r => ({
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
    //  $group por producto → $lookup nombre → $sort). Sirve para saber cuánta
    // arrachera / chorizo / carbón comprar para surtir los combos del periodo.
    packageComponentDemand: async (_, { from, to }, ctx) => {
      requirePermission(ctx, PERMISSIONS.REPORTS_VIEW);
      const rows = await Order.aggregate([
        { $match: { status: { $ne: 'CANCELLED' }, createdAt: { $gte: new Date(from), $lte: new Date(to) } } },
        { $unwind: '$items' },
        { $match: { 'items.packageId': { $ne: null } } },
        { $unwind: '$items.contents' },
        { $group: {
          _id: '$items.contents.productId',
          quantityNeeded: { $sum: { $multiply: ['$items.contents.quantity', '$items.quantity'] } },
          packagesSold: { $sum: '$items.quantity' },
          inPackages: { $addToSet: '$items.packageId' },
        } },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
        { $sort: { quantityNeeded: -1 } },
      ]);
      return rows.map(r => ({
        productId: r._id,
        name: r.product?.[0]?.name ?? 'N/D',
        quantityNeeded: r.quantityNeeded,
        packagesSold: r.packagesSold,
        inPackages: r.inPackages.length,
      }));
    },
  },

  Mutation: {
    ...authResolvers.Mutation, // login, logout

    // ---------- Usuarios ----------
    // Registro abierto: siempre CUSTOMER. Otro rol solo con users:manage.
    createUser: async (_, { input }, ctx) => {
      const { password, role = DEFAULT_ROLE, ...rest } = input;
      if (role !== DEFAULT_ROLE) requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
      if (password.length < 8) throw new DomainError('La contraseña debe tener al menos 8 caracteres.');
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
      if (!user) throw notFound('Usuario', userId);
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
      if (!user) throw notFound('Usuario', userId);
      if (!user.addresses.id(addressId)) throw notFound('Dirección', addressId);
      user.defaultAddressId = addressId;
      await user.save();
      return cacheUser(user);
    },
    removeUserAddress: async (_, { userId, addressId }, ctx) => {
      requireSelfOrPermission(ctx, userId);
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      const address = user.addresses.id(addressId);
      if (!address) throw notFound('Dirección', addressId);
      address.deleteOne();
      if (sameId(user.defaultAddressId, addressId)) user.defaultAddressId = user.addresses[0]?._id ?? null;
      await user.save();
      return cacheUser(user);
    },

    // ---------- Catálogo (catalog:manage; inventario: stock:manage) ----------
    createCategory: async (_, { input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const category = await Category.create(input);
      catalogEvent(ctx, 'CATEGORY_CREATED', 'Category', category, category.name);
      return category;
    },

    createProduct: async (_, { input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      if (!(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);
      const product = await Product.create(input);
      catalogEvent(ctx, 'PRODUCT_CREATED', 'Product', product, product.name, { price: product.price, stock: product.stock, unit: product.unit });
      return product;
    },
    updateProduct: async (_, { id, input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const product = await Product.findById(id);
      if (!product) throw notFound('Producto', id);
      if (input.categoryId && !(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);
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
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const before = await Product.findByIdAndUpdate(id, { isActive: active }, { new: false });
      if (!before) throw notFound('Producto', id);
      await invalidateProducts(id);
      if (before.isActive !== active) {
        catalogEvent(ctx, 'PRODUCT_ACTIVE_CHANGED', 'Product', before, active ? 'Activado' : 'Desactivado', { name: before.name, from: before.isActive, to: active });
      }
      return Product.findById(id).exec();
    },
    setProductStock: async (_, { id, stock }, ctx) => {
      requirePermission(ctx, PERMISSIONS.STOCK_MANAGE);
      if (!Number.isInteger(stock) || stock < 0) throw new DomainError('El stock debe ser un entero >= 0.');
      const before = await Product.findByIdAndUpdate(id, { stock }, { new: false });
      if (!before) throw notFound('Producto', id);
      await invalidateProducts(id);
      catalogEvent(ctx, 'STOCK_SET', 'Product', before, `Stock ${before.stock} → ${stock}`, { name: before.name, from: before.stock, to: stock });
      return Product.findById(id).exec();
    },
    addProductDiscount: async (_, { productId, input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const product = await Product.findById(productId);
      if (!product) throw notFound('Producto', productId);
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
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const product = await Product.findById(productId);
      if (!product) throw notFound('Producto', productId);
      const discount = product.discounts.id(discountId);
      if (!discount) throw notFound('Descuento', discountId);
      const { percent, label } = discount;
      discount.deleteOne();
      await product.save();
      await invalidateProducts(productId);
      catalogEvent(ctx, 'DISCOUNT_REMOVED', 'Product', product, `${percent}% ${label ?? ''}`.trim(), { name: product.name, discountId: String(discountId), percent, label });
      return product;
    },

    // ---------- Paquetes (catalog:manage) ----------
    createPackage: async (_, { input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      assertPackagePersistable(input); // valida la composición antes de tocar la BD
      await assertProductsExist(input.items.map(i => i.productId));
      const pkg = await Package.create(input);
      catalogEvent(ctx, 'PACKAGE_CREATED', 'Package', pkg, pkg.name, { price: pkg.price, items: pkg.items.length });
      return pkg;
    },
    updatePackage: async (_, { id, input }, ctx) => {
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const pkg = await Package.findById(id);
      if (!pkg) throw notFound('Paquete', id);
      if (input.items) {
        assertPackagePersistable({ ...pkg.toObject(), ...input });
        await assertProductsExist(input.items.map(i => i.productId));
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
      requirePermission(ctx, PERMISSIONS.CATALOG_MANAGE);
      const before = await Package.findByIdAndUpdate(id, { isActive: active }, { new: false });
      if (!before) throw notFound('Paquete', id);
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
      if (!before) throw notFound('Sucursal', id);
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
      await assertPurchasableRef(ref);
      await cartStore.addToCart(me.id, ref, quantity);
      return buildCart(me.id);
    },
    setCartItemQuantity: async (_, { productId, packageId, quantity }, ctx) => {
      const me = requireAuth(ctx);
      const ref = itemRef({ productId, packageId });
      if (quantity > 0) await assertPurchasableRef(ref);
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
      const { unavailable } = reconcileCart(await loadLines(refs));
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
    // preparar, lista, entregar en mostrador, cancelar) u orders:deliver (reparto).
    updateOrderStatus: async (_, { id, status }, ctx) => {
      const me = requireAuth(ctx);
      const order = await Order.findById(id);
      if (!order) throw notFound('Orden', id);
      if (!canChangeOrderStatus(me, order, status)) throw forbidden(`No tienes permiso para pasar esta orden a ${status}.`);
      return changeOrderStatus(order, status, ctx);
    },

    // El cliente cancela la suya (si el estado lo permite); el personal, las de su sucursal.
    cancelOrder: async (_, { id }, ctx) => {
      const me = requireAuth(ctx);
      const order = await Order.findById(id);
      if (!order) throw notFound('Orden', id);
      if (!canChangeOrderStatus(me, order, 'CANCELLED')) throw forbidden('No tienes permiso para cancelar esta orden.');
      return changeOrderStatus(order, 'CANCELLED', ctx);
    },

    // ---------- Listas guardadas ----------
    createShoppingList: async (_, { input }, ctx) => {
      requireSelfOrPermission(ctx, input.userId);
      if (!(await User.exists({ _id: oid(input.userId) }))) throw notFound('Usuario', input.userId);
      return ShoppingList.create(input);
    },
    addItemToShoppingList: async (_, { listId, productId, packageId, quantity }, ctx) => {
      const ref = itemRef({ productId, packageId });
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('Lista', listId);
      requireSelfOrPermission(ctx, list.userId);
      const exists = ref.productId
        ? await Product.exists({ _id: oid(ref.productId) })
        : await Package.exists({ _id: oid(ref.packageId) });
      if (!exists) throw notFound(ref.productId ? 'Producto' : 'Paquete', ref.productId ?? ref.packageId);
      const item = list.items.find(i => sameId(i.productId, ref.productId) || sameId(i.packageId, ref.packageId));
      if (item) item.quantity += quantity;
      else list.items.push({ ...ref, quantity });
      await list.save();
      return list;
    },
    removeItemFromShoppingList: async (_, { listId, productId, packageId }, ctx) => {
      const ref = itemRef({ productId, packageId });
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('Lista', listId);
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
  // Traduce errores de dominio / validación de Mongoose a mensajes limpios.
  formatError: (formatted, error) => {
    const original = error?.originalError ?? error;
    if (original instanceof DomainError) {
      // extensions lleva el código (PRICE_CHANGED, CART_EMPTY…) y sus detalles (newQuote, unavailable…).
      return { message: original.message, path: formatted.path, extensions: original.extensions };
    }
    if (original?.name === 'ValidationError') {
      const detail = Object.values(original.errors ?? {}).map(e => e.message).join(' ') || original.message;
      return { message: detail, path: formatted.path, extensions: { code: 'VALIDATION_ERROR' } };
    }
    return formatted;
  },
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
