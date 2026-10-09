import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, scryptSync } from 'crypto';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { GraphQLScalarType, Kind, parse } from 'graphql';
import mongoose from 'mongoose';
import amqp from 'amqplib';

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
  buildOrderNumber,
  round2,
} from './domain/entities.js';

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
// Infraestructura: RabbitMQ (eventos de dominio para auditoría)
// ------------------------------------------------------------
const EVENTS_QUEUE = process.env.RABBITMQ_QUEUE || 'pickaroo.events';
let rabbitChannel = null;

async function initRabbit() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    conn.on('error', err => console.error('RabbitMQ (conexión):', err.message));
    conn.on('close', () => { rabbitChannel = null; });
    rabbitChannel = await conn.createChannel();
    await rabbitChannel.assertQueue(EVENTS_QUEUE, { durable: true });
    console.log(`✅ RabbitMQ conectado. Cola "${EVENTS_QUEUE}" lista.`);
  } catch (err) {
    console.error('⚠️  No se pudo conectar a RabbitMQ:', err.message);
  }
}
await initRabbit();

function publishEvent(event, payload) {
  if (!rabbitChannel) return;
  const message = { event, payload, occurredAt: new Date().toISOString() };
  try {
    rabbitChannel.sendToQueue(EVENTS_QUEUE, Buffer.from(JSON.stringify(message)), { persistent: true });
    console.log(`📤 Evento "${event}" publicado.`);
  } catch (err) {
    console.error(`No se pudo publicar el evento "${event}":`, err.message);
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const notFound = (what, id) => new DomainError(`${what} no encontrado${id ? ` (${id})` : ''}.`);
const oid = v => new mongoose.Types.ObjectId(String(v));
const uniq = xs => [...new Set(xs.map(String))];
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

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

// Carga productos y paquetes de un carrito y arma las líneas para el dominio.
async function buildLines(items) {
  if (!items?.length) throw new DomainError('El carrito está vacío.');
  const refs = items.map(i => ({ ...itemRef(i), quantity: i.quantity }));
  const packageIds = refs.filter(r => r.packageId).map(r => r.packageId);
  const pkgDocs = packageIds.length ? await Package.find({ _id: { $in: uniq(packageIds).map(oid) } }) : [];
  const [packages, products] = await Promise.all([
    toDomainPackages(pkgDocs),
    loadProducts(refs.filter(r => r.productId).map(r => r.productId)),
  ]);
  return refs.map(r => {
    if (r.packageId) {
      const pkg = packages.get(r.packageId);
      if (!pkg) throw notFound('Paquete', r.packageId);
      return { package: pkg, quantity: r.quantity };
    }
    const product = products.get(r.productId);
    if (!product) throw notFound('Producto', r.productId);
    return { product, quantity: r.quantity };
  });
}

// Descuenta stock solo si alcanza (condición atómica por producto). Si algún
// producto no alcanza, devuelve lo ya descontado y rechaza la compra.
async function takeStock(demand) {
  const taken = [];
  for (const { productId, quantity } of demand) {
    const res = await Product.updateOne({ _id: oid(productId), stock: { $gte: quantity } }, { $inc: { stock: -quantity } });
    if (res.modifiedCount !== 1) {
      await releaseStock(taken);
      const p = await Product.findById(productId).select('name stock');
      throw new DomainError(`Sin stock suficiente de "${p?.name ?? productId}" (disponible: ${p?.stock ?? 0}).`);
    }
    taken.push({ productId, quantity });
  }
  return taken;
}

function releaseStock(demand) {
  return Promise.all(demand.map(({ productId, quantity }) =>
    Product.updateOne({ _id: oid(productId) }, { $inc: { stock: quantity } })));
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
const resolvers = {
  DateTime,

  User: {
    __resolveReference: ref => User.findById(ref.id).exec(),
    addresses: u => u.addresses.map(a => ({ ...a.toObject(), id: a._id, isDefault: sameId(a._id, u.defaultAddressId) })),
    defaultAddress: u => {
      const a = u.defaultAddressId && u.addresses.id(u.defaultAddressId);
      return a ? { ...a.toObject(), id: a._id, isDefault: true } : null;
    },
  },

  Category: {
    __resolveReference: ref => Category.findById(ref.id).exec(),
    products: cat => Product.find({ categoryId: cat._id, isActive: true }).sort({ name: 1 }).exec(),
  },

  ProductDiscount: {
    isCurrent: d => isDiscountActive(d),
  },

  Product: {
    __resolveReference: ref => Product.findById(ref.id).exec(),
    category: p => Category.findById(p.categoryId).exec(),
    activeDiscountPercent: p => bestDiscountPercent(p.discounts),
    effectivePrice: p => applyDiscount(p.price, bestDiscountPercent(p.discounts)),
    packages: p => Package.find({ 'items.productId': p._id, isActive: true }).sort({ name: 1 }).exec(),
  },

  Package: {
    __resolveReference: ref => Package.findById(ref.id).exec(),
    availableStock: async doc => (await packageEntity(doc)).availableStock(),
    alaCarteTotal: async doc => (await packageEntity(doc)).alaCarteTotal(),
    savings: async doc => (await packageEntity(doc)).savings(),
  },

  PackageItem: {
    product: i => Product.findById(i.productId).exec(),
  },

  Store: {
    __resolveReference: ref => Store.findById(ref.id).exec(),
  },

  OrderItem: {
    type: itemType,
    product: i => (i.productId ? Product.findById(i.productId).exec() : null),
    package: i => (i.packageId ? Package.findById(i.packageId).exec() : null),
    lineDiscount: i => lineDiscount(i),
    contents: i => i.contents ?? [],
  },

  Order: {
    __resolveReference: ref => Order.findById(ref.id).exec(),
    user: o => User.findById(o.userId).exec(),
    store: o => Store.findById(o.storeId).exec(),
    subtotal: o => orderSubtotal(o.items),
    discountTotal: o => orderDiscountTotal(o.items),
  },

  ShoppingListItem: {
    type: itemType,
    product: i => (i.productId ? Product.findById(i.productId).exec() : null),
    package: i => (i.packageId ? Package.findById(i.packageId).exec() : null),
  },

  ShoppingList: {
    user: l => User.findById(l.userId).exec(),
  },

  Query: {
    categories: () => Category.find().sort({ sortOrder: 1, name: 1 }).exec(),
    category: (_, { id }) => Category.findById(id).exec(),

    products: (_, { categoryId, search, activeOnly, limit, offset }) => {
      const q = {};
      if (categoryId) q.categoryId = oid(categoryId);
      if (activeOnly) q.isActive = true;
      if (search) q.$text = { $search: search };
      return Product.find(q).sort({ name: 1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    product: (_, { id }) => Product.findById(id).exec(),

    packages: (_, { activeOnly }) => Package.find(activeOnly ? { isActive: true } : {}).sort({ name: 1 }).exec(),
    package: (_, { id }) => Package.findById(id).exec(),

    stores: (_, { activeOnly }) => Store.find(activeOnly ? { isActive: true } : {}).sort({ name: 1 }).exec(),
    store: (_, { id }) => Store.findById(id).exec(),

    users: (_, { limit, offset }) => User.find().sort({ createdAt: -1 }).skip(offset).limit(Math.min(limit, 100)).exec(),
    user: (_, { id }) => User.findById(id).exec(),

    orders: (_, { userId, status, limit, offset }) => {
      const q = {};
      if (userId) q.userId = oid(userId);
      if (status) q.status = status;
      return Order.find(q).sort({ createdAt: -1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    order: (_, { id }) => Order.findById(id).exec(),
    orderByNumber: (_, { number }) => Order.findOne({ number }).exec(),

    shoppingLists: (_, { userId }) => ShoppingList.find({ userId: oid(userId) }).sort({ updatedAt: -1 }).exec(),
    shoppingList: (_, { id }) => ShoppingList.findById(id).exec(),

    quoteOrder: async (_, { input }) => {
      const { mode, storeId, items } = input;
      const store = await resolveStore(storeId);
      const lines = await buildLines(items);
      const { stockDemand: _demand, ...priced } = priceOrder({ mode, store, lines });
      return { mode, ...priced };
    },

    // Pipeline de agregación #1: ventas consolidadas por producto y por paquete.
    salesReport: async (_, { from, to }) => {
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
    packageComponentDemand: async (_, { from, to }) => {
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
    // ---------- Usuarios ----------
    createUser: (_, { input }) => {
      const { password, ...rest } = input;
      return User.create({ ...rest, passwordHash: password ? hashPassword(password) : undefined });
    },
    addUserAddress: async (_, { userId, address }) => {
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      const { isDefault, ...data } = address;
      user.addresses.push(data);
      const added = user.addresses[user.addresses.length - 1];
      if (isDefault || !user.defaultAddressId) user.defaultAddressId = added._id;
      await user.save();
      return user;
    },
    setDefaultAddress: async (_, { userId, addressId }) => {
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      if (!user.addresses.id(addressId)) throw notFound('Dirección', addressId);
      user.defaultAddressId = addressId;
      await user.save();
      return user;
    },
    removeUserAddress: async (_, { userId, addressId }) => {
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      const address = user.addresses.id(addressId);
      if (!address) throw notFound('Dirección', addressId);
      address.deleteOne();
      if (sameId(user.defaultAddressId, addressId)) user.defaultAddressId = user.addresses[0]?._id ?? null;
      await user.save();
      return user;
    },

    // ---------- Catálogo ----------
    createCategory: (_, { input }) => Category.create(input),

    createProduct: async (_, { input }) => {
      if (!(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);
      return Product.create(input);
    },
    updateProduct: async (_, { id, input }) => {
      const product = await Product.findById(id);
      if (!product) throw notFound('Producto', id);
      if (input.categoryId && !(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);
      Object.assign(product, input);
      await product.save();
      return product;
    },
    // Desactivar un producto deja sin disponibilidad a los paquetes que lo
    // contienen automáticamente (su stock es derivado): no hay que tocarlos.
    setProductActive: async (_, { id, active }) => {
      const product = await Product.findByIdAndUpdate(id, { isActive: active }, { new: true });
      if (!product) throw notFound('Producto', id);
      return product;
    },
    setProductStock: async (_, { id, stock }) => {
      if (!Number.isInteger(stock) || stock < 0) throw new DomainError('El stock debe ser un entero >= 0.');
      const product = await Product.findByIdAndUpdate(id, { stock }, { new: true });
      if (!product) throw notFound('Producto', id);
      return product;
    },
    addProductDiscount: async (_, { productId, input }) => {
      const product = await Product.findById(productId);
      if (!product) throw notFound('Producto', productId);
      product.discounts.push(input);
      await product.save();
      return product;
    },
    removeProductDiscount: async (_, { productId, discountId }) => {
      const product = await Product.findById(productId);
      if (!product) throw notFound('Producto', productId);
      const discount = product.discounts.id(discountId);
      if (!discount) throw notFound('Descuento', discountId);
      discount.deleteOne();
      await product.save();
      return product;
    },

    // ---------- Paquetes ----------
    createPackage: async (_, { input }) => {
      assertPackagePersistable(input); // valida la composición antes de tocar la BD
      await assertProductsExist(input.items.map(i => i.productId));
      return Package.create(input);
    },
    updatePackage: async (_, { id, input }) => {
      const pkg = await Package.findById(id);
      if (!pkg) throw notFound('Paquete', id);
      if (input.items) {
        assertPackagePersistable({ ...pkg.toObject(), ...input });
        await assertProductsExist(input.items.map(i => i.productId));
      }
      Object.assign(pkg, input);
      await pkg.save();
      return pkg;
    },
    setPackageActive: async (_, { id, active }) => {
      const pkg = await Package.findByIdAndUpdate(id, { isActive: active }, { new: true });
      if (!pkg) throw notFound('Paquete', id);
      return pkg;
    },

    // ---------- Sucursales ----------
    createStore: (_, { input }) => Store.create(input),
    updateStore: async (_, { id, input }) => {
      const store = await Store.findByIdAndUpdate(id, input, { new: true, runValidators: true });
      if (!store) throw notFound('Sucursal', id);
      return store;
    },

    // ---------- Órdenes ----------
    createOrder: async (_, { input }) => {
      const { userId, mode, storeId, address, addressId, items, notes, idempotencyKey } = input;

      if (idempotencyKey) {
        const existing = await Order.findOne({ userId: oid(userId), idempotencyKey });
        if (existing) return existing;
      }

      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      if (!user.isActive) throw new DomainError('El usuario está desactivado.');

      const store = await resolveStore(storeId);
      if (!store) throw new DomainError('No hay ninguna sucursal activa configurada.');

      const deliveryAddress = mode === 'DELIVERY' ? resolveDeliveryAddress(address, addressId, user) : null;
      const lines = await buildLines(items);
      const priced = priceOrder({ mode, store, deliveryAddress, lines, requireAddress: true });

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

      publishEvent('ORDER_CREATED', {
        orderId: order._id, number: order.number, userId: order.userId,
        mode: order.mode, total: order.total, itemCount: order.items.length,
      });
      return order;
    },

    updateOrderStatus: async (_, { id, status }) => {
      const order = await Order.findById(id);
      if (!order) throw notFound('Orden', id);
      assertTransition(order.status, status);
      const previous = order.status;
      order.status = status;
      await order.save();

      // Repone el stock consumido, incluido el contenido de los paquetes.
      if (status === 'CANCELLED') await releaseStock(stockDemand(order.items));
      publishEvent('ORDER_STATUS_CHANGED', { orderId: order._id, number: order.number, from: previous, to: status });
      return order;
    },

    cancelOrder: async (_, { id }) => resolvers.Mutation.updateOrderStatus(_, { id, status: 'CANCELLED' }),

    // ---------- Listas guardadas ----------
    createShoppingList: async (_, { input }) => {
      if (!(await User.exists({ _id: oid(input.userId) }))) throw notFound('Usuario', input.userId);
      return ShoppingList.create(input);
    },
    addItemToShoppingList: async (_, { listId, productId, packageId, quantity }) => {
      const ref = itemRef({ productId, packageId });
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('Lista', listId);
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
    removeItemFromShoppingList: async (_, { listId, productId, packageId }) => {
      const ref = itemRef({ productId, packageId });
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('Lista', listId);
      list.items = list.items.filter(i => !(sameId(i.productId, ref.productId) || sameId(i.packageId, ref.packageId)));
      await list.save();
      return list;
    },
    deleteShoppingList: async (_, { id }) => {
      const res = await ShoppingList.findByIdAndDelete(id);
      return Boolean(res);
    },
  },
};

// ------------------------------------------------------------
// Arranque del subgrafo
// ------------------------------------------------------------
const server = new ApolloServer({
  schema: buildSubgraphSchema([{ typeDefs, resolvers }]),
  // Traduce errores de dominio / validación de Mongoose a mensajes limpios.
  formatError: (formatted, error) => {
    const original = error?.originalError ?? error;
    if (original instanceof DomainError) {
      return { message: original.message, path: formatted.path, extensions: { code: 'DOMAIN_RULE_VIOLATION' } };
    }
    if (original?.name === 'ValidationError') {
      const detail = Object.values(original.errors ?? {}).map(e => e.message).join(' ') || original.message;
      return { message: detail, path: formatted.path, extensions: { code: 'VALIDATION_ERROR' } };
    }
    return formatted;
  },
});

const port = parseInt(process.env.PORT_CAMPAMENTOS) || 4001;
const { url } = await startStandaloneServer(server, { listen: { port } });
console.log(`🛒 Subgrafo Pickaroo (catálogo + órdenes) listo en: ${url}`);

if (process.env.SEED === 'true') {
  const { seed } = await import('./infrastructure/seed.js');
  await seed({ User, Category, Product, Package, Store });
}
