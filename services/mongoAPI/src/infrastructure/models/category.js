// CATEGORIES  (secciones del menú de productos)

import mongoose from 'mongoose';
import { text, optionalText, main, caseInsensitive } from './helpers.js';

const category = main({
  name: text(80),
  icon: optionalText(80), // nombre del icono lucide
  sortOrder: { type: Number, default: 0, min: 0, validate: { validator: Number.isInteger, message: '{PATH} debe ser entero.' } },
});
category.index({ name: 1 }, { unique: true, collation: caseInsensitive });
category.index({ sortOrder: 1 });

export const Category = mongoose.model('Category', category, 'categories');
