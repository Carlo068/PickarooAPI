// PACKAGES  (combos; contenido incrustado, stock derivado)

import mongoose from 'mongoose';
import { PACKAGE_MAX_ITEMS, assertPackagePersistable } from '../../domain/entities.js';
import { text, optionalText, money, integer, ref, array, sub, main } from './helpers.js';

// Producto del catálogo + cantidad. También se reutiliza como "contenido"
// copiado en las partidas de una orden.
export const packageItem = sub({
  productId: ref('Product'),
  quantity: integer(1),
});

const pkg = main({
  name: text(200),
  description: optionalText(4000),
  price: money(0.01),
  imageUrl: optionalText(500),
  isActive: { type: Boolean, default: true },
  items: array(packageItem, PACKAGE_MAX_ITEMS),
});
pkg.pre('validate', function () {
  try { assertPackagePersistable(this); } catch (err) { this.invalidate('items', err.message); }
});
pkg.index({ isActive: 1 });
pkg.index({ 'items.productId': 1 }); // "¿qué paquetes contienen este producto?"

export const Package = mongoose.model('Package', pkg, 'packages');
