// ============================================================
// AUTENTICACIÓN HÍBRIDA (JWT + sesión en Redis) Y AUTORIZACIÓN (RBAC en Neo4j)
//
//   login   → valida la contraseña (Mongo), obtiene rol, permisos efectivos
//             y sucursales del grafo (Neo4j), firma un JWT con un `jti` único
//             y guarda `session:<jti>` en Redis con esos permisos y el mismo
//             TTL que el token. Así cada petición no consulta Neo4j.
//   request → se verifica la firma del JWT Y que `session:<jti>` exista.
//   logout  → borra `session:<jti>`: el token deja de servir al instante.
//
// Cambiar el rol o las sucursales de un usuario revoca todas sus sesiones
// (índice `user:<id>:sessions`), así el cambio aplica de inmediato.
//
// Sin Redis no hay sesiones (falla cerrado). Sin Neo4j el login funciona con
// permisos vacíos (nivel cliente): nadie gana privilegios sin el grafo.
// ============================================================

import { randomBytes, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { GraphQLError } from 'graphql';
import { User, Store } from './infrastructure/models/index.js';
import { verifyPassword } from './infrastructure/passwords.js';
import { cacheUser, getUser } from './infrastructure/entity-cache.js';
import { isNeo4jReady } from './infrastructure/neo4j.js';
import * as rbac from './infrastructure/rbac-graph.js';
import { emitEvent, requestInfo, CATEGORIES } from './infrastructure/events.js';
import { DEFAULT_ROLE, PERMISSIONS, hasPermission, isRole } from './domain/access.js';
import { DomainError } from './domain/entities.js';

const SESSION_TTL_SECONDS = parseInt(process.env.JWT_TTL_SECONDS) || 3600;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET no está definido: se usa un secreto aleatorio y los tokens no sobreviven a un reinicio.');
}

const sessionKey = jti => `session:${jti}`;
const userSessionsKey = userId => `user:${userId}:sessions`;

const authError = (message, code) => new GraphQLError(message, { extensions: { code } });

// ---------- Guardas para los resolvers ----------
export function requireAuth(ctx) {
  if (!ctx.currentUser) throw authError('Debes iniciar sesión.', 'UNAUTHENTICATED');
  return ctx.currentUser;
}

export function requirePermission(ctx, permission) {
  const user = requireAuth(ctx);
  if (!hasPermission(user, permission)) throw authError(`Se requiere el permiso "${permission}".`, 'FORBIDDEN');
  return user;
}

// El dueño del recurso, o quien tenga el permiso indicado.
export function requireSelfOrPermission(ctx, ownerId, permission = PERMISSIONS.USERS_MANAGE) {
  const user = requireAuth(ctx);
  if (String(user.id) !== String(ownerId) && !hasPermission(user, permission)) {
    throw authError('No tienes permiso para este recurso.', 'FORBIDDEN');
  }
  return user;
}

export const forbidden = message => authError(message, 'FORBIDDEN');

// ---------- Contexto: se ejecuta en CADA petición ----------
function parseSession(raw) {
  if (!raw?.startsWith('{')) return null; // sesiones de una versión anterior: se pide volver a entrar
  try { return JSON.parse(raw); } catch { return null; }
}

export const createAuthContext = redisClient => async ({ req }) => {
  const info = requestInfo(req);
  const anonymous = { currentUser: null, ...info };
  const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return anonymous;

  // 1. Firma y expiración del JWT
  let decoded;
  try {
    decoded = jwt.verify(match[1].trim(), JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    emitEvent({
      type: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      category: CATEGORIES.SECURITY, success: false, reason: err.message,
    }, anonymous);
    return anonymous;
  }

  // 2. La sesión sigue activa en Redis (no fue revocada)
  if (!redisClient.isReady) return anonymous;
  let session = null;
  try {
    session = parseSession(await redisClient.get(sessionKey(decoded.jti)));
  } catch {
    return anonymous;
  }
  if (!session || session.userId !== decoded.sub) {
    emitEvent({
      type: 'SESSION_REVOKED', category: CATEGORIES.SECURITY, success: false,
      actorId: decoded.sub, actorRole: decoded.role,
      reason: 'Token válido pero sin sesión activa (logout, cambio de rol o expiración).',
      metadata: { jti: decoded.jti },
    }, anonymous);
    return anonymous;
  }

  return {
    ...info,
    currentUser: {
      id: decoded.sub,
      name: decoded.name,
      email: decoded.email,
      role: session.role,
      permissions: session.permissions ?? [],
      storeIds: session.storeIds ?? [],
      degraded: Boolean(session.degraded),
    },
    jti: decoded.jti,
  };
};

// ---------- Acceso desde Neo4j ----------
// Rol + permisos efectivos + sucursales. Si el usuario aún no está en el grafo
// se crea con el rol espejo de Mongo (auto-reparación). Si Neo4j no responde,
// acceso sin permisos.
async function resolveAccess(user, ctx) {
  if (isNeo4jReady()) {
    try {
      let access = await rbac.getAccess(user._id);
      if (!access) {
        await rbac.ensureUser({ id: user._id, email: user.email, name: user.name }, isRole(user.role) ? user.role : DEFAULT_ROLE);
        access = await rbac.getAccess(user._id);
      }
      if (access) {
        if (access.role !== user.role) { // el grafo manda: se corrige el espejo en Mongo
          await User.updateOne({ _id: user._id }, { role: access.role });
          user.role = access.role;
        }
        return { ...access, degraded: false };
      }
    } catch (err) {
      console.warn('⚠️  No se pudo leer el acceso en Neo4j:', err.message);
    }
  }
  emitEvent({
    type: 'RBAC_UNAVAILABLE', category: CATEGORIES.SECURITY, success: false,
    actorId: user._id, actorRole: user.role,
    reason: 'Neo4j no disponible: la sesión se abrió sin permisos.',
  }, ctx);
  return { role: user.role, permissions: [], storeIds: [], degraded: true };
}

async function safeMenu(userId) {
  if (!isNeo4jReady()) return [];
  try {
    return await rbac.getMenu(userId);
  } catch (err) {
    console.warn('⚠️  No se pudo leer el menú en Neo4j:', err.message);
    return [];
  }
}

// Vista de acceso para GraphQL (el campo `stores` se resuelve contra Mongo).
const accessView = (userId, access) => ({
  userId: String(userId),
  role: access.role,
  permissions: access.permissions,
  storeIds: access.storeIds,
  degraded: Boolean(access.degraded),
});

// Revoca todas las sesiones de un usuario; devuelve cuántas seguían activas.
export async function revokeUserSessions(redisClient, userId) {
  if (!redisClient.isReady) return 0;
  const key = userSessionsKey(userId);
  const jtis = await redisClient.sMembers(key);
  const revoked = jtis.length ? await redisClient.del(jtis.map(sessionKey)) : 0;
  await redisClient.del(key);
  return revoked;
}

// ---------- Resolvers ----------
export const createAuthResolvers = redisClient => {
  // Tras cambiar rol o sucursales: espejo, caché, sesiones y bitácora.
  async function afterAccessChange(user, ctx, event) {
    const revoked = await revokeUserSessions(redisClient, user._id);
    emitEvent({ ...event, targetType: 'User', targetId: user._id }, ctx);
    if (revoked) {
      emitEvent({
        type: 'SESSIONS_REVOKED', category: CATEGORIES.ADMIN, targetType: 'User', targetId: user._id,
        reason: 'Cambio de rol o de sucursales: el usuario debe volver a iniciar sesión.', metadata: { revoked },
      }, ctx);
    }
    const access = await rbac.getAccess(user._id);
    return accessView(user._id, access ?? { role: user.role, permissions: [], storeIds: [] });
  }

  async function loadManagedUser(ctx, userId) {
    requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
    const user = await User.findById(userId);
    if (!user) throw new DomainError(`Usuario no encontrado (${userId}).`);
    await rbac.ensureUser({ id: user._id, email: user.email, name: user.name }, isRole(user.role) ? user.role : DEFAULT_ROLE);
    return user;
  }

  return {
    Access: {
      stores: a => (a.storeIds.length ? Store.find({ _id: { $in: a.storeIds } }).sort({ name: 1 }).exec() : []),
    },

    Query: {
      me: (_, __, ctx) => getUser(requireAuth(ctx).id),

      // Lo que la sesión actual puede hacer (calculado en el login).
      myAccess: (_, __, ctx) => {
        const me = requireAuth(ctx);
        return accessView(me.id, me);
      },

      myMenu: (_, __, ctx) => safeMenu(requireAuth(ctx).id),

      roles: (_, __, ctx) => {
        requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
        return rbac.listRoles();
      },

      userAccess: async (_, { userId }, ctx) => {
        requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
        const access = isNeo4jReady() ? await rbac.getAccess(userId) : null;
        if (access) return accessView(userId, access);
        const user = await User.findById(userId).select('role');
        if (!user) return null;
        return accessView(userId, { role: user.role, permissions: [], storeIds: [], degraded: true });
      },
    },

    Mutation: {
      login: async (_, { input }, ctx) => {
        if (!redisClient.isReady) throw authError('El servicio de sesiones no está disponible. Intenta de nuevo.', 'SERVICE_UNAVAILABLE');

        const email = input.email.trim().toLowerCase();
        const user = await User.findOne({ email }).select('+passwordHash');
        const valid = verifyPassword(input.password, user?.passwordHash);
        // Mismo mensaje para correo inexistente, contraseña incorrecta o cuenta desactivada;
        // el motivo real queda en la bitácora.
        if (!user || !valid || !user.isActive) {
          emitEvent({
            type: 'LOGIN_FAILED', category: CATEGORIES.SECURITY, success: false,
            actorId: user?._id ?? 'ANONYMOUS', actorRole: user?.role ?? null,
            reason: !user ? 'Correo no registrado' : !valid ? 'Contraseña incorrecta' : 'Cuenta desactivada',
            metadata: { email },
          }, ctx);
          throw authError('Credenciales inválidas.', 'UNAUTHENTICATED');
        }

        const access = await resolveAccess(user, ctx);
        const userId = String(user._id);
        const jti = randomUUID();
        const token = jwt.sign(
          { sub: userId, name: user.name, email: user.email, role: access.role, jti },
          JWT_SECRET,
          { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS },
        );

        // Sesión con permisos (TTL atómico) + índice de sesiones del usuario.
        const session = {
          userId, role: access.role, permissions: access.permissions, storeIds: access.storeIds,
          degraded: access.degraded, ip: ctx.ip, userAgent: ctx.userAgent, loginAt: new Date().toISOString(),
        };
        await redisClient.multi()
          .set(sessionKey(jti), JSON.stringify(session), { expiration: { type: 'EX', value: SESSION_TTL_SECONDS } })
          .sAdd(userSessionsKey(userId), jti)
          .expire(userSessionsKey(userId), SESSION_TTL_SECONDS)
          .exec();
        console.log(`🔑 Sesión iniciada: ${sessionKey(jti)} rol=${access.role} (TTL ${SESSION_TTL_SECONDS}s)`);

        emitEvent({
          type: 'LOGIN_SUCCESS', category: CATEGORIES.SECURITY, actorId: userId, actorRole: access.role,
          reason: access.degraded ? 'Sesión sin permisos (Neo4j no disponible)' : 'Autenticación correcta',
          metadata: { jti, permissions: access.permissions.length, stores: access.storeIds.length },
        }, ctx);

        return {
          token,
          expiresIn: SESSION_TTL_SECONDS,
          user: await cacheUser(user),
          access: accessView(userId, access),
          menu: access.degraded ? [] : await safeMenu(userId),
        };
      },

      logout: async (_, __, ctx) => {
        const me = requireAuth(ctx);
        await redisClient.multi().del(sessionKey(ctx.jti)).sRem(userSessionsKey(me.id), ctx.jti).exec();
        console.log(`🔒 Sesión cerrada: ${sessionKey(ctx.jti)}`);
        emitEvent({ type: 'LOGOUT', category: CATEGORIES.SECURITY, metadata: { jti: ctx.jti } }, ctx);
        return true;
      },

      assignRole: async (_, { userId, role }, ctx) => {
        const user = await loadManagedUser(ctx, userId);
        if (String(user._id) === String(ctx.currentUser.id)) throw forbidden('No puedes cambiar tu propio rol.');
        const previous = await rbac.setRole(user._id, role);
        user.role = role;
        await user.save();
        await cacheUser(user);
        return afterAccessChange(user, ctx, {
          type: 'ROLE_CHANGED', category: CATEGORIES.ADMIN,
          reason: `Rol ${previous ?? '—'} → ${role}`, metadata: { from: previous, to: role },
        });
      },

      assignUserToStore: async (_, { userId, storeId }, ctx) => {
        const user = await loadManagedUser(ctx, userId);
        const store = await Store.findById(storeId);
        if (!store) throw new DomainError(`Sucursal no encontrada (${storeId}).`);
        await rbac.syncStores([store]);
        await rbac.assignStore(user._id, store._id);
        return afterAccessChange(user, ctx, {
          type: 'STORE_ASSIGNMENT_CHANGED', category: CATEGORIES.ADMIN,
          reason: `Asignado a ${store.name}`, metadata: { action: 'ADD', storeId: String(store._id), store: store.name },
        });
      },

      removeUserFromStore: async (_, { userId, storeId }, ctx) => {
        const user = await loadManagedUser(ctx, userId);
        const storeName = await rbac.removeStore(user._id, storeId);
        if (!storeName) throw new DomainError('El usuario no está asignado a esa sucursal.');
        return afterAccessChange(user, ctx, {
          type: 'STORE_ASSIGNMENT_CHANGED', category: CATEGORIES.ADMIN,
          reason: `Retirado de ${storeName}`, metadata: { action: 'REMOVE', storeId: String(storeId), store: storeName },
        });
      },
    },
  };
};
