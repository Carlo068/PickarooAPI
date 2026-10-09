// STORES  (sucursales: recogida y origen del reparto)

import mongoose from 'mongoose';
import { round2 } from '../../domain/entities.js';
import { text, optionalText, main } from './helpers.js';
import { location } from './location.js';

const store = main({
  name: text(120),
  address: { type: location, required: [true, 'El campo {PATH} es obligatorio.'] },
  phone: optionalText(20),
  schedule: optionalText(200), // "Lun-Sáb 8:00-20:00"
  isActive: { type: Boolean, default: true },
  // Configuración de reparto por sucursal (el diferenciador de Pickaroo)
  deliveryFee: { type: Number, default: 0, min: 0, set: round2 },
  freeDeliveryThreshold: { type: Number, default: null, min: 0, set: v => (v == null ? null : round2(v)) },
});
store.index({ 'address.city': 1, isActive: 1 });

export const Store = mongoose.model('Store', store, 'stores');
