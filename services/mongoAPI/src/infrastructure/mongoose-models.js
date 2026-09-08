import mongoose from 'mongoose';
import { amount, sum, ProductRule } from '../domain/catalog.js';
const { Schema } = mongoose;
const text = (max = 120) => ({ type: String, required: [true, "El campo {PATH} es obligatorio."], trim: true, minlength: [2, "El campo {PATH} debe tener al menos 2 caracteres."], maxlength: [max, "El campo {PATH} excede la longitud permitida."] });
const integer = (min = 0) => ({ type: Number, required: [true, "El campo {PATH} es obligatorio."], min: [min, "El campo {PATH} es menor que el mínimo permitido."], max: Number.MAX_SAFE_INTEGER, validate: { validator: Number.isSafeInteger, message: 'Debe ser un entero seguro.' } });
const ref = name => ({ type: Schema.Types.ObjectId, ref: name, required: [true, "El campo {PATH} es obligatorio."] });
const choice = values => ({ type: String, required: [true, "El campo {PATH} es obligatorio."], enum: { values, message: "El valor de {PATH} no está permitido." } });
const sub = fields => new Schema(fields, { _id: false, strict: 'throw' });
const array = (schema, max, min = 0) => ({ type: [schema], default: [], validate: { validator: v => v.length >= min && v.length <= max, message: `Se requieren entre ${min} y ${max} elementos.` } });
const main = fields => new Schema(fields, { timestamps: true, strict: 'throw', optimisticConcurrency: true });
const units = ['PIEZA', 'PAQUETE', 'GRAMO'];
const address = sub({ recipient: text(), phone: text(25), street: text(250), city: text(), state: text(), postalCode: text(12), country: { ...text(2), default: 'MX' }, instructions: { type: String, trim: true, maxlength: 500 } });
const savedAddress = new Schema(address.obj, { strict: 'throw' });
const user = main({ name: text(), email: { ...text(254), lowercase: true, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ }, passwordHash: { ...text(255), select: false }, role: { ...choice(['CUSTOMER', 'ADMIN']), default: 'CUSTOMER' }, active: { type: Boolean, default: true }, addresses: array(savedAddress, 20) });
user.index({ email: 1 }, { unique: true });
const category = main({ name: text(), slug: text(), sortOrder: { ...integer(), default: 0 }, active: { type: Boolean, default: true } });
category.index({ slug: 1 }, { unique: true });
const store = main({ name: text(), address: { type: address, required: [true, "El campo {PATH} es obligatorio."] }, active: { type: Boolean, default: true }, schedule: array(sub({ day: { ...integer(), max: 6 }, opens: { ...text(5), match: /^([01]\d|2[0-3]):[0-5]\d$/ }, closes: { ...text(5), match: /^([01]\d|2[0-3]):[0-5]\d$/ } }), 14) });
const component = sub({ productId: ref('Product'), quantity: integer(1) });
const product = main({ sku: text(64), slug: text(), name: text(), description: { type: String, trim: true, maxlength: 4000 }, imageUrl: { type: String, trim: true, maxlength: 2048 }, categoryId: ref('Category'), kind: choice(['SIMPLE', 'PORTAFOLIO']), unit: choice(units), priceMinor: integer(1), priceBasisQuantity: { ...integer(1), default: 1 }, quantityStep: { ...integer(1), default: 1 }, currency: { type: String, enum: ['MXN'], default: 'MXN' }, active: { type: Boolean, default: true }, components: array(component, 30), compositionVersion: { ...integer(1), default: 1 } });
product.pre('validate', function () {
  try { new ProductRule(this); } catch (error) { this.invalidate('priceMinor', error.message); }
  if (this.kind === 'SIMPLE' && this.components.length) this.invalidate('components', 'Un producto simple no tiene componentes.');
  if (this.kind === 'PORTAFOLIO') {
    if (this.unit !== 'PAQUETE' || this.priceBasisQuantity !== 1) this.invalidate('unit', 'El portafolio se vende por paquete completo.');
    if (this.components.length < 2) this.invalidate('components', 'Incluye al menos dos productos.');
  }
  const ids = this.components.map(c => String(c.productId));
  if (new Set(ids).size !== ids.length || ids.includes(String(this._id))) this.invalidate('components', 'Componentes duplicados o autorreferencia.');
});
product.index({ sku: 1 }, { unique: true });
product.index({ slug: 1 }, { unique: true });
product.index({ kind: 1, active: 1, categoryId: 1 });
const inventory = main({ storeId: ref('Store'), productId: ref('Product'), onHand: integer(), reserved: { ...integer(), default: 0 } });
inventory.pre('validate', function () { if (this.reserved > this.onHand) this.invalidate('reserved', 'La reserva excede las existencias.'); });
inventory.index({ storeId: 1, productId: 1 }, { unique: true });
const list = main({ userId: ref('User'), name: text(), items: array(sub({ productId: ref('Product'), quantity: integer(1), addedAt: { type: Date, default: Date.now } }), 100) });
list.index({ userId: 1, updatedAt: -1 });
const discount = main({ productId: ref('Product'), percentBps: { ...integer(1), max: 9999 }, startsAt: { type: Date, required: [true, "El campo {PATH} es obligatorio."] }, endsAt: { type: Date, default: null }, active: { type: Boolean, default: true } });
discount.pre('validate', function () { if (this.endsAt && this.endsAt <= this.startsAt) this.invalidate('endsAt', 'Debe ser posterior al inicio.'); });
discount.index({ productId: 1, active: 1, startsAt: 1, endsAt: 1 });
const snapshotComponent = sub({ productId: ref('Product'), sku: text(64), name: text(), unit: choice(units), quantity: integer(1) });
const orderItem = sub({ discountId: { type: Schema.Types.ObjectId, ref: 'ProductDiscount', default: null }, discountPercentBps: { ...integer(), max: 9999, default: 0 }, lineId: text(64), parentLineId: { type: String, default: null, maxlength: 64 }, productId: ref('Product'), sku: text(64), name: text(), kind: choice(['SIMPLE', 'PORTAFOLIO']), unit: choice(units), quantity: integer(1), priceMinor: integer(1), priceBasisQuantity: integer(1), grossMinor: integer(), discountMinor: integer(), totalMinor: integer(), compositionVersion: integer(1), components: array(snapshotComponent, 30) });
const order = main({ number: text(64), idempotencyKey: text(128), requestHash: text(64), userId: ref('User'), storeId: ref('Store'), mode: choice(['PICKUP', 'DELIVERY']), status: { ...choice(['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']), default: 'PENDING' }, deliveryAddress: { type: address, required: function () { return this.mode === 'DELIVERY'; } }, items: array(orderItem, 100, 1), currency: { type: String, enum: ['MXN'], default: 'MXN' }, subtotalMinor: integer(), discountMinor: integer(), deliveryFeeMinor: integer(), totalMinor: integer(), notes: { type: String, trim: true, maxlength: 1000 } });
order.pre('validate', function () {
  for (const item of this.items) {
    if (item.grossMinor !== amount(item.priceMinor, item.quantity, item.priceBasisQuantity) || item.totalMinor !== item.grossMinor - item.discountMinor || item.discountMinor > item.grossMinor) this.invalidate('items', 'Importes de partida inconsistentes.');
    if ((item.kind === 'SIMPLE' && item.components.length) || (item.kind === 'PORTAFOLIO' && (item.components.length < 2 || item.unit !== 'PAQUETE' || item.priceBasisQuantity !== 1))) this.invalidate('items', 'Composición de partida inconsistente.');
  }
  const ids = this.items.map(i => i.lineId);
  if (new Set(ids).size !== ids.length) this.invalidate('items', 'Identificadores de partida duplicados.');
  for (const item of this.items) if (item.parentLineId) {
    const parent = this.items.find(i => i.lineId === item.parentLineId);
    if (item.kind !== 'SIMPLE' || !parent || parent.kind !== 'PORTAFOLIO' || parent.parentLineId) this.invalidate('items', 'Extra sin portafolio válido.');
  }
  const total = field => sum(this.items.map(i => i[field]));
  if (this.subtotalMinor !== total('grossMinor') || this.discountMinor !== total('discountMinor') || this.totalMinor !== this.subtotalMinor - this.discountMinor + this.deliveryFeeMinor || (this.mode === 'PICKUP' && this.deliveryFeeMinor !== 0)) this.invalidate('totalMinor', 'Totales inconsistentes.');
});
order.index({ number: 1 }, { unique: true });
order.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
order.index({ userId: 1, createdAt: -1 });
order.index({ storeId: 1, status: 1, createdAt: -1 });
export const User = mongoose.model('User', user, 'users');
export const Category = mongoose.model('Category', category, 'categories');
export const Store = mongoose.model('Store', store, 'stores');
export const Product = mongoose.model('Product', product, 'products');
export const Inventory = mongoose.model('Inventory', inventory, 'inventories');
export const ShoppingList = mongoose.model('ShoppingList', list, 'shopping_lists');
export const ProductDiscount = mongoose.model('ProductDiscount', discount, 'product_discounts');
export const Order = mongoose.model('Order', order, 'orders');
export const models = [User, Category, Store, Product, Inventory, ShoppingList, ProductDiscount, Order];
