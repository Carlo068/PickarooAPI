// ============================================================
// REDIS (Redis Stack + Redis OM) — Capa de velocidad y sesiones
//
// Mongo sigue siendo la fuente de verdad. Redis guarda:
//   · copias de lectura de Product y User (Redis OM, JSON en RAM, con TTL),
//   · las sesiones activas del JWT (`session:<jti>`, ver auth.js).
//
// Si Redis no está disponible el subgrafo sigue funcionando: las lecturas
// van directo a Mongo y los inicios de sesión se rechazan (no se pueden
// registrar ni revocar sesiones sin Redis).
// ============================================================

import { createClient } from 'redis';
import { Schema, Repository } from 'redis-om';

// Por defecto, el Redis Stack de docker-compose.yml.
const redisUrl = process.env.REDIS_URL || 'redis://default:pickaroo123@localhost:6379';

// disableOfflineQueue: sin conexión los comandos fallan al instante en lugar de
// quedarse esperando; el cliente reintenta conectarse en segundo plano.
export const redisClient = createClient({
  url: redisUrl,
  disableOfflineQueue: true,
  socket: { reconnectStrategy: retries => Math.min(retries * 500, 5000) },
});

let outageLogged = false;
redisClient.on('error', err => {
  if (outageLogged) return;
  outageLogged = true;
  console.error('⚠️  Redis no disponible:', err.message || err.code || err);
});

// Los cachés son desechables: al (re)conectar se vacían para no servir copias
// de cambios hechos en Mongo mientras la app o Redis estaban caídos.
async function purgeEntityCaches() {
  for (const pattern of ['Product:*', 'User:*']) {
    for await (const keys of redisClient.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      const batch = [keys].flat();
      if (batch.length) await redisClient.del(batch);
    }
  }
}

redisClient.on('ready', () => {
  outageLogged = false;
  console.log('⚡ Redis Stack conectado (caché + sesiones).');
  purgeEntityCaches().catch(err => console.warn('No se pudo limpiar el caché:', err.message));
});

// ---------- Esquemas Redis OM (JSON nativo) ----------
// Solo lo necesario para responder lecturas. Las listas de objetos (descuentos,
// direcciones) se guardan serializadas; el passwordHash nunca se cachea.
export const productSchema = new Schema('Product', {
  mongoId: { type: 'string' },
  categoryId: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
  price: { type: 'number' },
  imageUrl: { type: 'string' },
  unit: { type: 'string' },
  stock: { type: 'number' },
  isActive: { type: 'boolean' },
  discountsJson: { type: 'string' },
  createdAt: { type: 'date' },
  updatedAt: { type: 'date' },
}, { dataStructure: 'JSON' });

export const userSchema = new Schema('User', {
  mongoId: { type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
  avatarUrl: { type: 'string' },
  role: { type: 'string' },
  isActive: { type: 'boolean' },
  addressesJson: { type: 'string' },
  createdAt: { type: 'date' },
}, { dataStructure: 'JSON' });

export const productRepository = new Repository(productSchema, redisClient);
export const userRepository = new Repository(userSchema, redisClient);

export const isRedisReady = () => redisClient.isReady;

// Conecta sin bloquear el arranque más de `waitMs`; si Redis tarda, el cliente
// sigue reintentando en segundo plano.
export async function initRedis(waitMs = 3000) {
  redisClient.connect().catch(err => console.error('Redis (conexión):', err.message));
  await new Promise(resolve => {
    const timer = setTimeout(resolve, waitMs);
    redisClient.once('ready', () => { clearTimeout(timer); resolve(); });
  });
  if (!redisClient.isReady) console.warn('⚠️  Redis aún no responde: caché y sesiones inactivos hasta que conecte.');
}
