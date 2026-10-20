// Hash de contraseñas con scrypt (módulo nativo de Node, sin dependencias).
// Formato almacenado: scrypt$<salt hex>$<hash hex>

import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, KEY_LENGTH).toString('hex')}`;
}

// Hash de relleno: si el usuario no existe se verifica contra este para que
// "correo inexistente" y "contraseña incorrecta" tarden lo mismo.
const DUMMY_HASH = hashPassword(randomBytes(8).toString('hex'));

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored ?? DUMMY_HASH).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(String(password), salt, expected.length);
  return Boolean(stored) && timingSafeEqual(actual, expected);
}
