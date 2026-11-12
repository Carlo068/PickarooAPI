// ============================================================
// AUTENTICACIÓN EN auditAPI
//
// Mismo esquema que mongoAPI: se verifica el JWT (mismo JWT_SECRET) y que
// `session:<jti>` siga en Redis (mismo REDIS_URL). Los permisos se leen de
// la sesión, que mongoAPI calculó con Neo4j al iniciar sesión.
// ============================================================

import jwt from 'jsonwebtoken';
import { GraphQLError } from 'graphql';
import { createClient } from 'redis';

export const AUDIT_VIEW = 'audit:view';

export const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://default:pickaroo123@localhost:6379',
  disableOfflineQueue: true,
  socket: { reconnectStrategy: retries => Math.min(retries * 500, 5000) },
});
let outageLogged = false;
redisClient.on('error', err => {
  if (!outageLogged) console.error('⚠️  Redis no disponible:', err.message || err.code);
  outageLogged = true;
});
redisClient.on('ready', () => {
  outageLogged = false;
  console.log('⚡ Redis conectado (verificación de sesiones).');
});

export function connectRedis() {
  redisClient.connect().catch(err => console.error('Redis (conexión):', err.message));
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET no está definido en auditAPI: ningún token será aceptado.');

export async function authContext({ req }) {
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match || !JWT_SECRET || !redisClient.isReady) return { currentUser: null };
  try {
    const decoded = jwt.verify(match[1].trim(), JWT_SECRET, { algorithms: ['HS256'] });
    const raw = await redisClient.get(`session:${decoded.jti}`);
    const session = raw?.startsWith('{') ? JSON.parse(raw) : null;
    if (session?.userId !== decoded.sub) return { currentUser: null };
    return { currentUser: { id: decoded.sub, role: session.role, permissions: session.permissions ?? [] } };
  } catch {
    return { currentUser: null };
  }
}

export function requireAuditView(ctx) {
  if (!ctx.currentUser) throw new GraphQLError('Debes iniciar sesión.', { extensions: { code: 'UNAUTHENTICATED' } });
  if (!ctx.currentUser.permissions.includes(AUDIT_VIEW)) {
    throw new GraphQLError(`Se requiere el permiso "${AUDIT_VIEW}".`, { extensions: { code: 'FORBIDDEN' } });
  }
}
