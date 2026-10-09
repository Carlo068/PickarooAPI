// PRODUCTS  (+ descuentos incrustados)

import mongoose from 'mongoose';
import { UNITS, assertProductPersistable } from '../../domain/entities.js';
import { text, optionalText, money, integer, ref, choice, array, main } from './helpers.js';

const { Schema } = mongoose;

const discount = new Schema({
  percent: { type: Number, required: true, min: [0.01, 'El descuento debe ser mayor a 0.'], max: [100, 'El descuento no puede exceder 100%.'] },
  label: optionalText(60), // "Precio especial", "Fin de semana"...
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
});
discount.pre('validate', function () {
  if (this.startsAt && this.endsAt && this.endsAt <= this.startsAt) this.invalidate('endsAt', 'La fecha de fin debe ser posterior al inicio.');
});

const product = main({
  categoryId: ref('Category'),
  name: text(200),
  description: optionalText(4000),
  price: money(0.01),
  imageUrl: optionalText(500),
  unit: choice(UNITS, 'UNIDAD'),
  stock: { ...integer(0), default: 0 },
  isActive: { type: Boolean, default: true },
  discounts: array(discount, 20),
});
// La regla de negocio vive en el dominio; la infraestructura la invoca antes de persistir.
product.pre('validate', function () {
  try { assertProductPersistable(this); } catch (err) { this.invalidate('price', err.message); }
});
product.index({ categoryId: 1, isActive: 1 });
product.index({ name: 'text', description: 'text' });

export const Product = mongoose.model('Product', product, 'products');
