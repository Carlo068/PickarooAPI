// ============================================================
// PERSISTENCIA PICKAROO (Mongoose) — Capa de Infraestructura
//
// Traducción de la BD MySQL a documentos Mongo. Criterio de diseño:
//
//  INCRUSTACIÓN (subdocumentos de lectura frecuente, tamaño acotado, sin
//  vida propia fuera de su padre):
//   users.addresses[]        <- user_addresses
//   products.discounts[]     <- product_discounts
//   products.components[]    <- contenido de un PAQUETE (combo carne asada)
//   orders.items[]           <- order_items, con SNAPSHOT de precio y de la
//                               composición del paquete al momento de comprar
//   orders.deliveryAddress   <- copia de la dirección elegida
//   shopping_lists.items[]   <- shopping_list_items
//
//  REFERENCIACIÓN (entidades compartidas o de crecimiento ilimitado):
//   orders.userId / storeId  -> el historial de pedidos de un cliente crece
//                               sin límite: es su propia colección que
//                               referencia a User/Store, nunca un array dentro
//                               del usuario.
//   products.categoryId      -> catálogo compartido.
//   *.items[].productId      -> apunta al catálogo vivo.
// ============================================================

import mongoose from 'mongoose';
import {
  UNITS, USER_ROLES, ORDER_MODES, ORDER_STATUSES, PRODUCT_KINDS,
  PACKAGE_MAX_COMPONENTS, round2, priceOrder, assertProductPersistable,
} from '../domain/entities.js';

const { Schema } = mongoose;

// ---------- helpers de definición ----------
const text = (max = 120, min = 2) => ({
  type: String,
  required: [true, 'El campo {PATH} es obligatorio.'],
  trim: true,
  minlength: [min, 'El campo {PATH} debe tener al menos ' + min + ' caracteres.'],
  maxlength: [max, 'El campo {PATH} excede la longitud permitida.'],
});
const optionalText = (max = 500) => ({ type: String, trim: true, maxlength: [max, 'El campo {PATH} excede la longitud permitida.'] });
const money = (min = 0) => ({
  type: Number,
  required: [true, 'El campo {PATH} es obligatorio.'],
  min: [min, 'El campo {PATH} no puede ser negativo.'],
  set: round2,
});
const integer = (min = 0) => ({
  type: Number,
  required: [true, 'El campo {PATH} es obligatorio.'],
  min: [min, 'El campo {PATH} es menor que el mínimo permitido.'],
  validate: { validator: Number.isInteger, message: 'El campo {PATH} debe ser un entero.' },
});
const ref = name => ({ type: Schema.Types.ObjectId, ref: name, required: [true, 'El campo {PATH} es obligatorio.'] });
const choice = (values, def) => {
  const d = { type: String, enum: { values, message: 'El valor de {PATH} no está permitido.' } };
  if (def === undefined) d.required = [true, 'El campo {PATH} es obligatorio.'];
  else d.default = def;
  return d;
};
const geo = () => ({ type: Number, min: -180, max: 180, default: null });
const sub = fields => new Schema(fields, { _id: false });
const withId = fields => new Schema(fields, { _id: true });
const array = (schema, max, min = 0) => ({
  type: [schema],
  default: [],
  validate: { validator: v => v.length >= min && v.length <= max, message: `Se requieren entre ${min} y ${max} elementos.` },
});
const main = fields => new Schema(fields, { timestamps: true, optimisticConcurrency: true });

// ------------------------------------------------------------
// USERS  (+ user_addresses incrustadas)
// ------------------------------------------------------------
const address = withId({
  label: text(60),
  street: text(200),
  city: text(80),
  state: { ...optionalText(80) },
  zipCode: { ...optionalText(10) },
  lat: geo(),
  lng: geo(),
  isDefault: { type: Boolean, default: false },
});

const user = main({
  name: text(120),
  email: { ...text(255), lowercase: true, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Correo con formato inválido.'] },
  passwordHash: { type: String, select: false, maxlength: 255 },
  avatarUrl: optionalText(500),
  role: choice(USER_ROLES, 'CUSTOMER'),
  isActive: { type: Boolean, default: true },
  addresses: array(address, 25),
});
user.index({ email: 1 }, { unique: true });
user.pre('validate', function () {
  const defaults = this.addresses.filter(a => a.isDefault);
  if (defaults.length > 1) this.invalidate('addresses', 'Solo una dirección puede ser la predeterminada.');
});

// ------------------------------------------------------------
// CATEGORIES
// ------------------------------------------------------------
const category = main({
  name: text(80),
  slug: { ...text(80), lowercase: true, match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug inválido (usa minúsculas y guiones).'] },
  icon: optionalText(80), // nombre del icono lucide
  sortOrder: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger, message: '{PATH} debe ser entero.' } },
});
category.index({ slug: 1 }, { unique: true });
category.index({ sortOrder: 1 });

// ------------------------------------------------------------
// PRODUCTS  (+ product_discounts incrustados)
// ------------------------------------------------------------
const discount = withId({
  discountPercentage: { type: Number, required: true, min: [0.01, 'El descuento debe ser mayor a 0.'], max: [100, 'El descuento no puede exceder 100%.'] },
  label: optionalText(60), // "2x1", "Precio especial", etc.
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
  isActive: { type: Boolean, default: true },
});
discount.pre('validate', function () {
  if (this.startsAt && this.endsAt && this.endsAt <= this.startsAt) this.invalidate('endsAt', 'La fecha de fin debe ser posterior al inicio.');
});

// Componente de un PAQUETE: qué producto del catálogo entra y en qué cantidad.
const packageComponent = sub({
  productId: ref('Product'),
  quantity: { ...integer(1), default: 1 },
});

const product = main({
  categoryId: ref('Category'),
  name: text(200),
  description: optionalText(4000),
  price: money(0.01),
  imageUrl: optionalText(500),
  unit: { ...choice(UNITS, 'UNIDAD') }, // "KG", "UNIDAD", "LITRO", etc.
  stock: { ...integer(0), default: 0 },
  isActive: { type: Boolean, default: true },
  kind: choice(PRODUCT_KINDS, 'SIMPLE'),          // SIMPLE | PAQUETE
  components: array(packageComponent, PACKAGE_MAX_COMPONENTS), // solo si kind = PAQUETE
  discounts: array(discount, 20),
});
// La regla de negocio (precio positivo, composición del paquete coherente...)
// vive en la Capa de Dominio; la infraestructura solo la invoca antes de persistir.
product.pre('validate', function () {
  try {
    assertProductPersistable({
      id: this._id?.toString(),
      name: this.name,
      price: this.price,
      stock: this.stock,
      kind: this.kind,
      components: this.components,
    });
  } catch (err) {
    this.invalidate('price', err.message);
  }
});
product.index({ categoryId: 1, isActive: 1 });
product.index({ kind: 1, isActive: 1 });
product.index({ name: 'text', description: 'text' });

// ------------------------------------------------------------
// STORES  (para pickup)
// ------------------------------------------------------------
const store = main({
  name: text(120),
  address: text(300),
  city: text(80),
  lat: geo(),
  lng: geo(),
  phone: optionalText(20),
  schedule: optionalText(200), // "Lun-Vie 8:00-20:00"
  isActive: { type: Boolean, default: true },
  // Configuración de reparto por sucursal (el diferenciador de Pickaroo)
  deliveryFee: { type: Number, default: 0, min: 0, set: round2 },
  freeDeliveryThreshold: { type: Number, default: null, min: 0, set: v => (v == null ? null : round2(v)) },
});
store.index({ city: 1, isActive: 1 });

// ------------------------------------------------------------
// ORDERS  (+ order_items incrustadas con snapshot de precio)
// ------------------------------------------------------------
// Snapshot del contenido de un paquete comprado (para reportes posteriores).
const orderItemComponent = sub({
  productId: ref('Product'),
  quantity: integer(1),
});

const orderItem = sub({
  productId: ref('Product'),
  name: text(200),            // copia al momento de la compra
  kind: { type: String, enum: PRODUCT_KINDS, default: 'SIMPLE' },
  unit: { type: String, enum: UNITS, default: 'UNIDAD' },
  quantity: integer(1),
  unitPrice: money(0),        // precio de lista al comprar
  discountApplied: { type: Number, default: 0, min: 0, max: 100 }, // % aplicado
  lineDiscount: { ...money(0), default: 0 },
  lineTotal: money(0),        // quantity * unitPrice * (1 - discount)
  components: array(orderItemComponent, PACKAGE_MAX_COMPONENTS), // desglose si kind = PAQUETE
});

const order = main({
  number: { ...text(40), unique: true },
  idempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
  userId: ref('User'),
  mode: choice(ORDER_MODES),
  storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },      // solo si mode = PICKUP
  deliveryAddress: { type: sub({                                              // solo si mode = DELIVERY
    label: optionalText(60),
    street: text(200),
    city: text(80),
    state: optionalText(80),
    zipCode: optionalText(10),
    lat: geo(),
    lng: geo(),
  }), default: null },
  status: choice(ORDER_STATUSES, 'PENDING'),
  items: array(orderItem, 200, 1),
  subtotal: money(0),
  deliveryFee: { ...money(0), default: 0 },
  discountTotal: { ...money(0), default: 0 },
  total: money(0),
  notes: optionalText(500),
});
order.index({ userId: 1, createdAt: -1 });
order.index({ status: 1, createdAt: -1 });
order.index({ storeId: 1, status: 1 });
order.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });

order.pre('validate', function () {
  if (this.mode === 'PICKUP' && !this.storeId) this.invalidate('storeId', 'Una orden de recogida necesita una sucursal.');
  if (this.mode === 'DELIVERY' && !this.deliveryAddress) this.invalidate('deliveryAddress', 'Una orden a domicilio necesita una dirección.');
  if (this.mode === 'PICKUP' && this.deliveryFee !== 0) this.invalidate('deliveryFee', 'La recogida no tiene costo de envío.');

  const subtotal = round2(this.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0));
  const discountTotal = round2(this.items.reduce((a, i) => a + i.lineDiscount, 0));
  const total = round2(subtotal - discountTotal + this.deliveryFee);
  if (this.subtotal !== subtotal || this.discountTotal !== discountTotal || this.total !== total) {
    this.invalidate('total', 'Los totales de la orden son inconsistentes con las partidas.');
  }
});

// ------------------------------------------------------------
// SHOPPING_LISTS  (+ shopping_list_items incrustadas)
// ------------------------------------------------------------
const shoppingListItem = sub({
  productId: ref('Product'),
  quantity: { ...integer(1), default: 1 },
  addedAt: { type: Date, default: Date.now },
});
const shoppingList = main({
  userId: ref('User'),
  name: text(120),
  items: array(shoppingListItem, 200),
});
shoppingList.index({ userId: 1, updatedAt: -1 });
shoppingList.pre('validate', function () {
  const ids = this.items.map(i => String(i.productId));
  if (new Set(ids).size !== ids.length) this.invalidate('items', 'La lista tiene productos duplicados.');
});

// ------------------------------------------------------------
// Modelos
// ------------------------------------------------------------
export const User = mongoose.model('User', user, 'users');
export const Category = mongoose.model('Category', category, 'categories');
export const Product = mongoose.model('Product', product, 'products');
export const Store = mongoose.model('Store', store, 'stores');
export const Order = mongoose.model('Order', order, 'orders');
export const ShoppingList = mongoose.model('ShoppingList', shoppingList, 'shopping_lists');

export const models = [User, Category, Product, Store, Order, ShoppingList];

// Re-exporta la regla de precios del dominio por conveniencia de la capa de infra.
export { priceOrder };
