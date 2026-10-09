// ============================================================
// Helpers de definición compartidos por todos los esquemas Mongoose.
// ============================================================

import mongoose from 'mongoose';
import { round2 } from '../../domain/entities.js';

const { Schema } = mongoose;

export const text = (max = 120, min = 2) => ({
  type: String,
  required: [true, 'El campo {PATH} es obligatorio.'],
  trim: true,
  minlength: [min, 'El campo {PATH} debe tener al menos ' + min + ' caracteres.'],
  maxlength: [max, 'El campo {PATH} excede la longitud permitida.'],
});

export const optionalText = (max = 500) => ({
  type: String,
  trim: true,
  maxlength: [max, 'El campo {PATH} excede la longitud permitida.'],
});

export const money = (min = 0) => ({
  type: Number,
  required: [true, 'El campo {PATH} es obligatorio.'],
  min: [min, 'El campo {PATH} no puede ser negativo.'],
  set: round2,
});

export const integer = (min = 0) => ({
  type: Number,
  required: [true, 'El campo {PATH} es obligatorio.'],
  min: [min, 'El campo {PATH} es menor que el mínimo permitido.'],
  validate: { validator: Number.isInteger, message: 'El campo {PATH} debe ser un entero.' },
});

export const ref = name => ({ type: Schema.Types.ObjectId, ref: name, required: [true, 'El campo {PATH} es obligatorio.'] });
export const optionalRef = name => ({ type: Schema.Types.ObjectId, ref: name, default: undefined });

export const choice = (values, def) => {
  const d = { type: String, enum: { values, message: 'El valor de {PATH} no está permitido.' } };
  if (def === undefined) d.required = [true, 'El campo {PATH} es obligatorio.'];
  else d.default = def;
  return d;
};

export const geo = () => ({ type: Number, min: -180, max: 180, default: null });

// Subdocumento sin _id.
export const sub = (fields, opts = {}) => new Schema(fields, { _id: false, ...opts });

export const array = (schema, max, min = 0) => ({
  type: [schema],
  default: [],
  validate: { validator: v => v.length >= min && v.length <= max, message: `Se requieren entre ${min} y ${max} elementos.` },
});

// Documento principal: timestamps + control de concurrencia optimista.
export const main = fields => new Schema(fields, { timestamps: true, optimisticConcurrency: true });

// Colación para índices únicos sin distinguir mayúsculas.
export const caseInsensitive = { locale: 'es', strength: 2 };

// Una partida apunta a un producto O a un paquete (nunca a ambos).
export const assertOneRef = function () {
  if (Boolean(this.productId) === Boolean(this.packageId)) {
    this.invalidate('productId', 'La partida debe referenciar un producto o un paquete, no ambos.');
  }
};
