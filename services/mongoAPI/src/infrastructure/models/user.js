// USERS  (+ direcciones incrustadas)

import mongoose from 'mongoose';
import { USER_ROLES } from '../../domain/entities.js';
import { text, optionalText, choice, array, main } from './helpers.js';
import { locationFields } from './location.js';

const { Schema } = mongoose;

const userAddress = new Schema({ label: text(60), ...locationFields }); // con _id: se elige por id

const user = main({
  name: text(120),
  email: { ...text(255), lowercase: true, match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Correo con formato inválido.'] },
  passwordHash: { type: String, select: false, maxlength: 255 },
  avatarUrl: optionalText(500),
  role: choice(USER_ROLES, 'CUSTOMER'),
  isActive: { type: Boolean, default: true },
  addresses: array(userAddress, 25),
  defaultAddressId: { type: Schema.Types.ObjectId, default: null },
});
user.index({ email: 1 }, { unique: true });
user.pre('validate', function () {
  if (this.defaultAddressId && !this.addresses.id(this.defaultAddressId)) {
    this.invalidate('defaultAddressId', 'La dirección predeterminada no pertenece al usuario.');
  }
});

export const User = mongoose.model('User', user, 'users');
