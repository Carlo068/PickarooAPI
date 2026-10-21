// COTIZACIONES EN REDIS
//
// quote:<uuid>  STRING (JSON)  TTL 15 min
//
// Guarda lo que el cliente vio (partidas con precio, envío y total) para
// compararlo al comprar. No congela precios: si el catálogo cambió, la compra
// se rechaza con PRICE_CHANGED y una cotización nueva.
// Sin Redis la cotización se calcula igual, solo que sin quoteId.

import { randomUUID } from 'crypto';
import { redisClient, isRedisReady } from './redis-om.js';

const QUOTE_TTL = parseInt(process.env.QUOTE_TTL_SECONDS) || 900;
const quoteKey = id => `quote:${id}`;

export async function saveQuote(record) {
  if (!isRedisReady()) return { quoteId: null, expiresAt: null };
  const quoteId = randomUUID();
  try {
    await redisClient.set(quoteKey(quoteId), JSON.stringify(record), { expiration: { type: 'EX', value: QUOTE_TTL } });
    return { quoteId, expiresAt: new Date(Date.now() + QUOTE_TTL * 1000) };
  } catch (err) {
    console.warn('⚠️  No se pudo guardar la cotización:', err.message);
    return { quoteId: null, expiresAt: null };
  }
}

// null si no existe, expiró o Redis no responde.
export async function getQuote(quoteId) {
  if (!quoteId || !isRedisReady()) return null;
  try {
    const raw = await redisClient.get(quoteKey(quoteId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('⚠️  No se pudo leer la cotización:', err.message);
    return null;
  }
}

// Una cotización se usa una sola vez.
export async function deleteQuote(quoteId) {
  if (!quoteId || !isRedisReady()) return;
  await redisClient.del(quoteKey(quoteId)).catch(err => console.warn('⚠️  No se pudo borrar la cotización:', err.message));
}
