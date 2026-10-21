// CARRITO EN REDIS
//
// cart:<userId>  HASH  { "p:<productId>" | "k:<packageId>" → cantidad }
//
// Solo ids y cantidades: los precios y la disponibilidad se calculan al leer
// contra el catálogo (ver reconcileCart en el dominio). Así un cambio de
// precio o un producto desactivado se refleja al instante sin recorrer los
// carritos. El TTL se renueva con cada cambio: un carrito abandonado expira solo.

import { DomainError } from '../domain/entities.js';
import { redisClient, isRedisReady } from './redis-om.js';

const CART_TTL = parseInt(process.env.CART_TTL_SECONDS) || 7 * 24 * 3600; // 7 días
export const CART_MAX_LINES = 50;
export const CART_MAX_QUANTITY = 999;

const cartKey = userId => `cart:${userId}`;
const field = ({ productId, packageId }) => (packageId ? `k:${packageId}` : `p:${productId}`);
const parseField = f => (f.startsWith('k:') ? { packageId: f.slice(2) } : { productId: f.slice(2) });

// El carrito vive solo en Redis: sin Redis no hay carrito (error claro, no un cuelgue).
function assertReady() {
  if (!isRedisReady()) throw new DomainError('El carrito no está disponible en este momento. Intenta de nuevo.', 'SERVICE_UNAVAILABLE');
}

function assertQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > CART_MAX_QUANTITY) {
    throw new DomainError(`La cantidad debe ser un entero entre 1 y ${CART_MAX_QUANTITY}.`);
  }
}

export async function getCart(userId) {
  assertReady();
  const raw = await redisClient.hGetAll(cartKey(userId));
  return Object.entries(raw).map(([f, qty]) => ({ ...parseField(f), quantity: Number(qty) }));
}

export async function addToCart(userId, ref, quantity) {
  assertReady();
  assertQuantity(quantity);
  if (quantity === 0) throw new DomainError('La cantidad a agregar debe ser al menos 1.');
  const key = cartKey(userId);
  const current = Number((await redisClient.hGet(key, field(ref))) ?? 0);
  if (!current && (await redisClient.hLen(key)) >= CART_MAX_LINES) {
    throw new DomainError(`El carrito admite hasta ${CART_MAX_LINES} partidas.`);
  }
  assertQuantity(current + quantity);
  await redisClient.multi().hIncrBy(key, field(ref), quantity).expire(key, CART_TTL).exec();
}

// Fija la cantidad exacta; 0 quita la partida.
export async function setCartQuantity(userId, ref, quantity) {
  assertReady();
  assertQuantity(quantity);
  const key = cartKey(userId);
  if (quantity === 0) return removeFromCart(userId, ref);
  if (!(await redisClient.hExists(key, field(ref))) && (await redisClient.hLen(key)) >= CART_MAX_LINES) {
    throw new DomainError(`El carrito admite hasta ${CART_MAX_LINES} partidas.`);
  }
  await redisClient.multi().hSet(key, field(ref), quantity).expire(key, CART_TTL).exec();
}

export async function removeFromCart(userId, ref) {
  assertReady();
  await redisClient.hDel(cartKey(userId), field(ref));
}

export async function clearCart(userId) {
  assertReady();
  await redisClient.del(cartKey(userId));
}
