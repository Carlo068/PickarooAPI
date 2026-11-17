// ORDERS  (partidas incrustadas: un recibo inmutable)
//
// Cada partida guarda lo que se cobró (precio de lista, % aplicado e
// importe). El descuento en pesos, el subtotal y el descuento total se
// derivan de esos tres datos. Un paquete guarda su contenido al momento
// de la compra: sirve para preparar el pedido, reponer stock al cancelar
// y para los reportes.

import mongoose from 'mongoose';
import { UNITS, ORDER_MODES, ORDER_STATUSES, PACKAGE_MAX_ITEMS, STATUS_HISTORY_MAX, ACTIVE_DELIVERY_STATUSES } from '../../domain/entities.js';
import { ROLES } from '../../domain/access.js';
import { text, optionalText, money, integer, ref, optionalRef, choice, array, sub, main, assertOneRef } from './helpers.js';
import { location } from './location.js';
import { packageItem } from './package.js';

const orderItem = sub({
  productId: optionalRef('Product'),
  packageId: optionalRef('Package'),
  name: text(200),
  unit: { type: String, enum: UNITS, default: null }, // null en paquetes
  quantity: integer(1),
  unitPrice: money(0),
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  lineTotal: money(0),
  contents: array(packageItem, PACKAGE_MAX_ITEMS),
});
orderItem.pre('validate', assertOneRef);

// Una entrada por transición, solo se agrega (ver changeOrderStatus). Las
// inferidas (migración) no tienen autor.
const statusChange = sub({
  status: choice(ORDER_STATUSES),
  at: { type: Date, required: [true, 'El campo {PATH} es obligatorio.'] },
  byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  byRole: { type: String, enum: { values: ROLES, message: 'El valor de {PATH} no está permitido.' }, default: null },
  inferred: { type: Boolean, default: false },
});

const order = main({
  number: { ...text(40), unique: true },
  idempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
  userId: ref('User'),
  storeId: ref('Store'), // sucursal que surte: recoge ahí o reparte desde ahí
  mode: choice(ORDER_MODES),
  deliveryAddress: { type: location, default: null }, // solo DELIVERY
  status: choice(ORDER_STATUSES, 'PENDING'),
  statusHistory: array(statusChange, STATUS_HISTORY_MAX),
  // Repartidor que aceptó la orden (solo DELIVERY). Se limpia al liberarla; al
  // entregarla o cancelarla se conserva como historia.
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  assignedAt: { type: Date, default: null },
  items: array(orderItem, 200, 1),
  deliveryFee: { ...money(0), default: 0 },
  total: money(0), // lo cobrado al cliente
  notes: optionalText(500),
});
order.pre('validate', function () {
  if (this.mode === 'DELIVERY' && !this.deliveryAddress) this.invalidate('deliveryAddress', 'Una orden a domicilio necesita una dirección.');
});
order.index({ userId: 1, createdAt: -1 });
order.index({ status: 1, createdAt: -1 });
order.index({ storeId: 1, status: 1 });
order.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
// Entregas disponibles de una sucursal (READY, DELIVERY, sin repartidor), la más antigua primero.
order.index({ storeId: 1, status: 1, mode: 1, driverId: 1, createdAt: 1 });
// Entregas de un repartidor (myDeliveries, currentDelivery).
order.index({ driverId: 1, status: 1, updatedAt: -1 });
// Una sola entrega activa por repartidor: dos órdenes READY / IN_DELIVERY con el
// mismo driverId violan este índice (E11000), también entre aceptaciones simultáneas.
export const ONE_ACTIVE_DELIVERY_INDEX = 'one_active_delivery_per_driver';
order.index({ driverId: 1 }, {
  name: ONE_ACTIVE_DELIVERY_INDEX,
  unique: true,
  partialFilterExpression: { driverId: { $type: 'objectId' }, status: { $in: ACTIVE_DELIVERY_STATUSES } },
});

export const Order = mongoose.model('Order', order, 'orders');
