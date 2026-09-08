import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { GraphQLScalarType, Kind, parse } from 'graphql';
import mongoose from 'mongoose';
import amqp from 'amqplib';

import { User, Category, Product, Store, Order, ShoppingList, models } from './infrastructure/mongoose-models.js';
import {
  DomainError,
  priceOrder,
  bestDiscountPercentage,
  applyDiscount,
  assertTransition,
  assertProductPersistable,
  buildOrderNumber,
  round2,
  sumMoney,
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

function addressFromInput(input) {
  if (!input) return null;
  const { label, street, city, state, zipCode, lat, lng, isDefault } = input;
  return { label, street, city, state, zipCode, lat, lng, isDefault: Boolean(isDefault) };
}

async function resolveDeliveryAddress(input, addressId, user) {
  if (input) return addressFromInput(input);
  const list = user?.addresses ?? [];
  if (addressId) {
    const found = list.id(addressId) || list.find(a => String(a._id) === String(addressId));
    if (!found) throw notFound('Dirección', addressId);
    return found.toObject();
  }
  const def = list.find(a => a.isDefault) || list[0];
  return def ? def.toObject() : null;
}

// Carga los productos de un carrito y arma las líneas para el dominio.
async function buildLines(items) {
  if (!items?.length) throw new DomainError('El carrito está vacío.');
  const ids = [...new Set(items.map(i => String(i.productId)))];
  const products = await Product.find({ _id: { $in: ids.map(oid) } });
  const byId = new Map(products.map(p => [String(p._id), p]));
  return items.map(({ productId, quantity }) => {
    const product = byId.get(String(productId));
    if (!product) throw notFound('Producto', productId);
    return { product, quantity };
  });
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
    defaultAddress: u => (u.addresses ?? []).find(a => a.isDefault) || (u.addresses ?? [])[0] || null,
  },

  Category: {
    __resolveReference: ref => Category.findById(ref.id).exec(),
    products: cat => Product.find({ categoryId: cat._id, isActive: true }).exec(),
  },

  Product: {
    __resolveReference: ref => Product.findById(ref.id).exec(),
    category: p => Category.findById(p.categoryId).exec(),
    activeDiscountPercentage: p => bestDiscountPercentage(p.discounts),
    effectivePrice: p => applyDiscount(p.price, bestDiscountPercentage(p.discounts)),
    components: p => (p.components ?? []).map(c => ({ productId: c.productId, quantity: c.quantity })),
    alaCarteTotal: async p => {
      if (p.kind !== 'PAQUETE' || !p.components?.length) return null;
      const parts = await Product.find({ _id: { $in: p.components.map(c => c.productId) } }).exec();
      const priceById = new Map(parts.map(x => [String(x._id), applyDiscount(x.price, bestDiscountPercentage(x.discounts))]));
      return sumMoney(p.components.map(c => (priceById.get(String(c.productId)) ?? 0) * c.quantity));
    },
    packageSavings: async p => {
      if (p.kind !== 'PAQUETE' || !p.components?.length) return null;
      const parts = await Product.find({ _id: { $in: p.components.map(c => c.productId) } }).exec();
      const priceById = new Map(parts.map(x => [String(x._id), applyDiscount(x.price, bestDiscountPercentage(x.discounts))]));
      const alaCarte = sumMoney(p.components.map(c => (priceById.get(String(c.productId)) ?? 0) * c.quantity));
      return round2(alaCarte - applyDiscount(p.price, bestDiscountPercentage(p.discounts)));
    },
  },

  PackageComponent: {
    product: c => Product.findById(c.productId).exec(),
  },

  OrderItemComponent: {
    product: c => Product.findById(c.productId).exec(),
  },

  Store: {
    __resolveReference: ref => Store.findById(ref.id).exec(),
  },

  OrderItem: {
    product: item => Product.findById(item.productId).exec(),
  },

  ShoppingListItem: {
    product: item => Product.findById(item.productId).exec(),
  },

  Order: {
    __resolveReference: ref => Order.findById(ref.id).exec(),
    user: o => User.findById(o.userId).exec(),
    store: o => (o.storeId ? Store.findById(o.storeId).exec() : null),
  },

  ShoppingList: {
    user: l => User.findById(l.userId).exec(),
  },

  Query: {
    categories: () => Category.find().sort({ sortOrder: 1, name: 1 }).exec(),
    category: (_, { id }) => Category.findById(id).exec(),

    products: (_, { categoryId, kind, search, activeOnly, limit, offset }) => {
      const q = {};
      if (categoryId) q.categoryId = oid(categoryId);
      if (kind) q.kind = kind;
      if (activeOnly) q.isActive = true;
      if (search) q.$text = { $search: search };
      return Product.find(q).sort({ name: 1 }).skip(offset).limit(Math.min(limit, 100)).exec();
    },
    product: (_, { id }) => Product.findById(id).exec(),
    packages: (_, { activeOnly }) => Product.find({ kind: 'PAQUETE', ...(activeOnly ? { isActive: true } : {}) }).sort({ name: 1 }).exec(),

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
      const { mode, storeId, address, items } = input;
      let store = storeId ? await Store.findById(storeId) : null;
      if (storeId && !store) throw notFound('Sucursal', storeId);
      if (!store) store = await Store.findOne({ isActive: true }).sort({ createdAt: 1 });
      const lines = await buildLines(items);
      const priced = priceOrder({ mode, store, deliveryAddress: addressFromInput(address), lines });
      return { mode, ...priced };
    },

    // Pipeline de agregación #1: ventas consolidadas por producto.
    salesReport: async (_, { from, to }) => {
      const rows = await Order.aggregate([
        { $match: { status: 'DELIVERED', createdAt: { $gte: new Date(from), $lte: new Date(to) } } },
        { $unwind: '$items' },
        { $group: {
          _id: '$items.productId',
          name: { $first: '$items.name' },
          kind: { $first: '$items.kind' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.lineTotal' },
          orderCount: { $addToSet: '$_id' },
        } },
        { $sort: { revenue: -1 } },
      ]);
      return rows.map(r => ({
        productId: r._id,
        name: r.name,
        kind: r.kind || 'SIMPLE',
        quantity: r.quantity,
        revenue: round2(r.revenue),
        orderCount: r.orderCount.length,
      }));
    },

    // Pipeline de agregación #2: explota los PAQUETES vendidos en sus componentes
    // ($match → $unwind items → $match sólo paquetes → $unwind components →
    //  $group por componente → $lookup nombre → $sort). Sirve para saber cuánta
    // arrachera / chorizo / carbón comprar para surtir los combos del periodo.
    packageComponentDemand: async (_, { from, to }) => {
      const rows = await Order.aggregate([
        { $match: { status: { $ne: 'CANCELLED' }, createdAt: { $gte: new Date(from), $lte: new Date(to) } } },
        { $unwind: '$items' },
        { $match: { 'items.kind': 'PAQUETE' } },
        { $unwind: '$items.components' },
        { $group: {
          _id: '$items.components.productId',
          quantityNeeded: { $sum: { $multiply: ['$items.components.quantity', '$items.quantity'] } },
          packagesSold: { $sum: '$items.quantity' },
          inPackages: { $addToSet: '$items.productId' },
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
      return User.create({ ...rest, passwordHash: password ? `plain:${password}` : undefined });
    },
    addUserAddress: async (_, { userId, address }) => {
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      const data = addressFromInput(address);
      if (data.isDefault) user.addresses.forEach(a => { a.isDefault = false; });
      if (user.addresses.length === 0) data.isDefault = true;
      user.addresses.push(data);
      await user.save();
      return user;
    },
    setDefaultAddress: async (_, { userId, addressId }) => {
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      let hit = false;
      user.addresses.forEach(a => { a.isDefault = String(a._id) === String(addressId); hit ||= a.isDefault; });
      if (!hit) throw notFound('Dirección', addressId);
      await user.save();
      return user;
    },
    removeUserAddress: async (_, { userId, addressId }) => {
      const user = await User.findById(userId);
      if (!user) throw notFound('Usuario', userId);
      const before = user.addresses.length;
      user.addresses = user.addresses.filter(a => String(a._id) !== String(addressId));
      if (user.addresses.length === before) throw notFound('Dirección', addressId);
      if (!user.addresses.some(a => a.isDefault) && user.addresses[0]) user.addresses[0].isDefault = true;
      await user.save();
      return user;
    },

    // ---------- Catálogo ----------
    createCategory: (_, { input }) => Category.create(input),

    createProduct: async (_, { input }) => {
      if (!(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);
      return Product.create(input);
    },
    createPackage: async (_, { input }) => {
      const { components, ...rest } = input;
      if (!(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);

      // Valida la composición en el dominio antes de tocar la BD.
      assertProductPersistable({ ...rest, kind: 'PAQUETE', components });

      // Los componentes deben existir y ser productos SIMPLE (no se anidan paquetes).
      const ids = [...new Set(components.map(c => String(c.productId)))];
      const parts = await Product.find({ _id: { $in: ids.map(oid) } }).exec();
      if (parts.length !== ids.length) throw new DomainError('Algún componente del paquete no existe en el catálogo.');
      if (parts.some(p => p.kind === 'PAQUETE')) throw new DomainError('Un paquete no puede contener otro paquete.');

      return Product.create({ ...rest, kind: 'PAQUETE', components });
    },
    updateProduct: async (_, { id, input }) => {
      const product = await Product.findById(id);
      if (!product) throw notFound('Producto', id);
      if (input.categoryId && !(await Category.exists({ _id: oid(input.categoryId) }))) throw notFound('Categoría', input.categoryId);
      Object.assign(product, input);
      await product.save();
      return product;
    },
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
      const before = product.discounts.length;
      product.discounts = product.discounts.filter(d => String(d._id) !== String(discountId));
      if (product.discounts.length === before) throw notFound('Descuento', discountId);
      await product.save();
      return product;
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

      // La sucursal es la que surte el pedido: obligatoria en PICKUP y también
      // usada en DELIVERY para tomar su tarifa de reparto. Si no se indica,
      // se usa la primera sucursal activa (setup de un solo restaurante).
      let store = storeId ? await Store.findById(storeId) : null;
      if (storeId && !store) throw notFound('Sucursal', storeId);
      if (!store) store = await Store.findOne({ isActive: true }).sort({ createdAt: 1 });
      if (!store) throw new DomainError('No hay ninguna sucursal activa configurada.');

      const deliveryAddress = mode === 'DELIVERY'
        ? await resolveDeliveryAddress(address, addressId, user)
        : null;

      const lines = await buildLines(items);
      const priced = priceOrder({ mode, store, deliveryAddress, lines, requireAddress: true });

      let order;
      try {
        order = await Order.create({
          number: buildOrderNumber(),
          idempotencyKey: idempotencyKey || null,
          userId: user._id,
          mode,
          storeId: store._id,
          deliveryAddress: mode === 'DELIVERY' ? deliveryAddress : null,
          items: priced.items,
          subtotal: priced.subtotal,
          deliveryFee: priced.deliveryFee,
          discountTotal: priced.discountTotal,
          total: priced.total,
          notes,
        });
      } catch (err) {
        if (err.code === 11000 && idempotencyKey) return Order.findOne({ userId: user._id, idempotencyKey });
        throw err;
      }

      // Descuenta stock de forma atómica por producto.
      await Promise.all(priced.items.map(i =>
        Product.updateOne({ _id: oid(i.productId) }, { $inc: { stock: -i.quantity } })
      ));

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

      if (status === 'CANCELLED') {
        await Promise.all(order.items.map(i =>
          Product.updateOne({ _id: i.productId }, { $inc: { stock: i.quantity } })
        ));
      }
      publishEvent('ORDER_STATUS_CHANGED', { orderId: order._id, number: order.number, from: previous, to: status });
      return order;
    },

    cancelOrder: async (_, { id }) => resolvers.Mutation.updateOrderStatus(_, { id, status: 'CANCELLED' }),

    // ---------- Listas de compra ----------
    createShoppingList: async (_, { input }) => {
      if (!(await User.exists({ _id: oid(input.userId) }))) throw notFound('Usuario', input.userId);
      return ShoppingList.create(input);
    },
    addItemToShoppingList: async (_, { listId, productId, quantity }) => {
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('Lista', listId);
      if (!(await Product.exists({ _id: oid(productId) }))) throw notFound('Producto', productId);
      const item = list.items.find(i => String(i.productId) === String(productId));
      if (item) item.quantity += quantity;
      else list.items.push({ productId, quantity, addedAt: new Date() });
      await list.save();
      return list;
    },
    removeItemFromShoppingList: async (_, { listId, productId }) => {
      const list = await ShoppingList.findById(listId);
      if (!list) throw notFound('Lista', listId);
      list.items = list.items.filter(i => String(i.productId) !== String(productId));
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
  await seed({ User, Category, Product, Store });
}
