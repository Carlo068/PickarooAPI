// "MIS PEDIDOS" RECIENTES EN REDIS
//
// user:<userId>:orders:recent  LIST de ids de orden (más nueva primero), máx. 20, TTL 24 h
//
// Solo ids: el estado y los importes se leen siempre de Mongo, así que la
// lista nunca queda desactualizada. El historial completo sigue en Mongo.

import { redisClient, isRedisReady } from './redis-om.js';

export const RECENT_ORDERS = 20;
const RECENT_TTL = 24 * 3600;
const recentKey = userId => `user:${userId}:orders:recent`;

// LPUSHX: solo agrega si la lista ya existe. Si no existe, la próxima lectura
// la reconstruye desde Mongo (así nunca queda una lista incompleta).
export async function pushRecentOrder(userId, orderId) {
  if (!isRedisReady()) return;
  try {
    const key = recentKey(userId);
    await redisClient.multi().lPushX(key, String(orderId)).lTrim(key, 0, RECENT_ORDERS - 1).exec();
  } catch (err) {
    console.warn('⚠️  No se pudo actualizar los pedidos recientes:', err.message);
  }
}

// null = no hay lista en Redis (o Redis no responde): leer de Mongo.
export async function getRecentOrderIds(userId) {
  if (!isRedisReady()) return null;
  try {
    const ids = await redisClient.lRange(recentKey(userId), 0, RECENT_ORDERS - 1);
    return ids.length ? ids : null;
  } catch (err) {
    console.warn('⚠️  No se pudo leer los pedidos recientes:', err.message);
    return null;
  }
}

export async function setRecentOrders(userId, orderIds) {
  if (!orderIds.length || !isRedisReady()) return;
  try {
    const key = recentKey(userId);
    await redisClient.multi().del(key).rPush(key, orderIds.map(String)).expire(key, RECENT_TTL).exec();
  } catch (err) {
    console.warn('⚠️  No se pudo guardar los pedidos recientes:', err.message);
  }
}
