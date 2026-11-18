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
// Refresh tokens (opacos, de un solo uso, ver infrastructure/refresh-store.js):
//   login        → devuelve además un refresh token; empieza una "familia"
//                  (un inicio de sesión en un dispositivo).
//   refreshToken → canjea el token por una sesión nueva (permisos releídos de
//                  Neo4j) y otro token de la misma familia (rotación).
//                  Dentro de la ventana de gracia (REFRESH_REUSE_GRACE_SECONDS)
//                  el token recién canjeado devuelve el mismo resultado que
//                  obtuvo el canje ganador (respuesta perdida, canjes dobles).
//                  Después, presentarlo revoca toda la familia: el token
//                  vigente y todas las sesiones que abrió. Si la familia ya no
//                  existe (se cerró la sesión), es solo un token inválido.
//   logout(refreshToken) → revoca también esa familia ("Olvidar este dispositivo"),
//                  con el token vigente o con uno ya canjeado.
//   logoutAllDevices     → revoca todas las familias y sesiones del usuario.
//
// Cambiar el rol o las sucursales de un usuario revoca todas sus sesiones
// (índice `user:<id>:sessions`) y todos sus refresh tokens, así el cambio
// aplica de inmediato y un refresh no revive los permisos anteriores. Sin
// Redis el cambio se rechaza antes de tocar Neo4j o Mongo.
//
// Sin Redis no hay sesiones (falla cerrado); un error de Redis a mitad de la
// operación es SERVICE_UNAVAILABLE (SESSIONS). Sin Neo4j el login funciona con
// permisos vacíos (nivel cliente): nadie gana privilegios sin el grafo; el
// refresh, en cambio, responde SERVICE_UNAVAILABLE (RBAC) sin gastar el token.
// ============================================================

import { randomBytes, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { GraphQLError } from 'graphql';
import { User, Store } from './infrastructure/models/index.js';
import { verifyPassword } from './infrastructure/passwords.js';
import { cacheUser, getUser } from './infrastructure/entity-cache.js';
import { isNeo4jReady } from './infrastructure/neo4j.js';
import * as rbac from './infrastructure/rbac-graph.js';
import { rbacService } from './infrastructure/rbac.service.js';
import { emitEvent, requestInfo, CATEGORIES } from './infrastructure/events.js';
import { loginFailedEvent, loginSuccessEvent, roleChangedEvent, MAX_EMAIL_LENGTH } from './infrastructure/security-events.js';
import { DEFAULT_ROLE, PERMISSIONS, hasPermission, isRole } from './domain/access.js';
import { DomainError } from './domain/errors.js';
import {
  refreshTtlSeconds, refreshGraceSeconds, generateRefreshToken, hashRefreshToken, isWellFormedRefreshToken,
  newRefreshRecord, parseRefreshRecord, isRefreshRecordLive, parseSpentMarker,
  generateGraceNonce, successorRefreshToken, newGraceRecord, parseGraceRecord, refreshUnavailableService,
} from './domain/refresh-tokens.js';
import { createRefreshStore, withSessionErrors, guardSessions, sessionsUnavailable } from './infrastructure/refresh-store.js';

const SESSION_TTL_SECONDS = parseInt(process.env.JWT_TTL_SECONDS) || 3600;
const REFRESH_TTL_SECONDS = refreshTtlSeconds(process.env.REFRESH_TTL_SECONDS);
const REFRESH_GRACE_SECONDS = refreshGraceSeconds(process.env.REFRESH_REUSE_GRACE_SECONDS);

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET no está definido: se usa un secreto aleatorio y los tokens no sobreviven a un reinicio.');
}

const SESSION_PREFIX = 'session:';
const sessionKey = jti => `${SESSION_PREFIX}${jti}`;
const userSessionsKey = userId => `user:${userId}:sessions`;

const refreshStoreOf = redisClient => withSessionErrors(createRefreshStore(redisClient, {
  ttlSeconds: REFRESH_TTL_SECONDS, graceSeconds: REFRESH_GRACE_SECONDS, sessionPrefix: SESSION_PREFIX, userSessionsKey,
}));

const authError = (message, code, details = {}) => new GraphQLError(message, { extensions: { ...details, code } });

// ---------- Guardas para los resolvers ----------
export function requireAuth(ctx) {
  if (!ctx.currentUser) throw authError('Debes iniciar sesión.', 'UNAUTHENTICATED');
  return ctx.currentUser;
}

export function requirePermission(ctx, permission) {
  const user = requireAuth(ctx);
  if (!hasPermission(user, permission)) throw forbidden(`Se requiere el permiso "${permission}".`, 'PERMISSION_REQUIRED', { permission });
  return user;
}

// El dueño del recurso, o quien tenga el permiso indicado.
export function requireSelfOrPermission(ctx, ownerId, permission = PERMISSIONS.USERS_MANAGE) {
  const user = requireAuth(ctx);
  if (String(user.id) !== String(ownerId) && !hasPermission(user, permission)) {
    throw forbidden('No tienes permiso para este recurso.', 'NOT_RESOURCE_OWNER');
  }
  return user;
}

// `reason` (ver FORBIDDEN_REASONS) dice cuál regla; el código sigue siendo FORBIDDEN para la bitácora de accesos.
export const forbidden = (message, reason, details = {}) => authError(message, 'FORBIDDEN', { ...details, reason });

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
// acceso sin permisos (`degraded`); `unavailableReason` va en RBAC_UNAVAILABLE.
async function resolveAccess(user, ctx, unavailableReason = 'Neo4j no disponible: la sesión se abrió sin permisos.') {
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
    reason: unavailableReason,
  }, ctx);
  return { role: user.role, permissions: [], storeIds: [], degraded: true };
}

async function safeMenu(userId) {
  if (!isNeo4jReady()) return [];
  try {
    return await rbacService.obtenerMenuUsuario(userId);
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

// JWT de una sesión. HS256 es determinista: con el mismo `jti` e `iat` (y los
// mismos datos del usuario) sale el mismo token; así la ventana de gracia
// reentrega el del canje ganador sin guardarlo.
const signSessionToken = (user, role, jti, iat) => jwt.sign(
  { sub: String(user._id), name: user.name, email: user.email, role, jti, iat },
  JWT_SECRET,
  { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS },
);

// JWT + sesión con los permisos de `access` (igual en login y en refresh).
function issueSession(user, access, ctx) {
  const userId = String(user._id);
  const jti = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const token = signSessionToken(user, access.role, jti, iat);
  const session = {
    userId, role: access.role, permissions: access.permissions, storeIds: access.storeIds,
    degraded: access.degraded, ip: ctx.ip, userAgent: ctx.userAgent, loginAt: new Date().toISOString(),
  };
  return { userId, jti, iat, token, session };
}

async function authPayload(user, access, issued, refreshToken) {
  return {
    token: issued.token,
    expiresIn: SESSION_TTL_SECONDS,
    refreshToken,
    refreshExpiresIn: REFRESH_TTL_SECONDS,
    user: await cacheUser(user),
    access: accessView(issued.userId, access),
    menu: access.degraded ? [] : await safeMenu(issued.userId),
  };
}

// Revoca todas las sesiones y todos los refresh tokens de un usuario. Devuelve
// cuántas sesiones seguían activas y cuántas familias tenían un token vigente.
// Sin Redis, o si falla a mitad, lanza SERVICE_UNAVAILABLE (SESSIONS): nunca
// devuelve "nada que revocar" sin haberlo comprobado.
export async function revokeUserSessions(redisClient, userId) {
  if (!redisClient.isReady) throw sessionsUnavailable();
  const fromFamilies = await refreshStoreOf(redisClient).revokeUserFamilies(String(userId));
  return guardSessions(async () => {
    const key = userSessionsKey(userId);
    const jtis = await redisClient.sMembers(key);
    const revoked = jtis.length ? await redisClient.del(jtis.map(sessionKey)) : 0;
    await redisClient.del(key);
    return { sessions: revoked + fromFamilies.sessions, families: fromFamilies.families };
  });
}

// ---------- Resolvers ----------
export const createAuthResolvers = redisClient => {
  const refreshStore = refreshStoreOf(redisClient);

  // Mismo error para token desconocido, vencido, revocado o de una cuenta desactivada;
  // el motivo real queda en la bitácora.
  function refreshFailed(ctx, reason, user = null) {
    emitEvent({
      type: 'REFRESH_FAILED', category: CATEGORIES.SECURITY, success: false,
      actorId: user?._id ?? 'ANONYMOUS', actorRole: user?.role ?? null, reason,
    }, ctx);
    return authError('Refresh token inválido.', 'INVALID_REFRESH_TOKEN');
  }

  // Un token ya canjeado volvió a presentarse fuera de la ventana de gracia:
  // alguien más lo tiene. Se revoca la familia completa. Si la familia ya no
  // existía (logout, logoutAllDevices, cambio de acceso), no hay nada que
  // proteger: es un token inválido más, sin alerta de seguridad.
  async function refreshReused(ctx, { userId, familyId }) {
    const revoked = await refreshStore.revokeFamily(userId, familyId);
    if (!revoked.found) return refreshFailed(ctx, 'Refresh token ya canjeado de una familia revocada', { _id: userId });
    console.warn(`⚠️  Refresh token reutilizado: familia ${familyId} revocada (${revoked.sessions} sesiones).`);
    emitEvent({
      type: 'REFRESH_REUSED', category: CATEGORIES.SECURITY, success: false, actorId: userId,
      reason: 'Se presentó un refresh token ya usado: se revocó su familia (token vigente y sesiones).',
      metadata: { familyId, sessions: revoked.sessions },
    }, ctx);
    return authError('Refresh token ya usado: se cerró la sesión de ese dispositivo.', 'REFRESH_TOKEN_REUSED');
  }

  // Ventana de gracia: el token recién canjeado `token` devuelve lo mismo que
  // obtuvo el canje ganador (el sucesor se recalcula con el nonce y el JWT se
  // vuelve a firmar con el mismo jti e iat). null si no aplica: sin registro de
  // gracia (venció), o el sucesor ya se canjeó o se revocó.
  async function replayWithinGrace(ctx, token, graceRaw) {
    const grace = parseGraceRecord(graceRaw);
    if (!grace) return null;
    const successor = successorRefreshToken(token, grace.nonce);
    const session = parseSession(await refreshStore.replay({ familyId: grace.familyId, successorHash: hashRefreshToken(successor), jti: grace.jti }));
    if (!session || session.userId !== grace.userId) return null;

    const user = await User.findById(grace.userId);
    if (!user || !user.isActive) throw refreshFailed(ctx, user ? 'Cuenta desactivada' : 'Usuario inexistente', user);
    const access = { role: session.role, permissions: session.permissions ?? [], storeIds: session.storeIds ?? [], degraded: Boolean(session.degraded) };
    const issued = { userId: grace.userId, jti: grace.jti, token: signSessionToken(user, session.role, grace.jti, grace.iat) };
    console.log(`🔄 Canje repetido dentro de la ventana de gracia: ${sessionKey(grace.jti)} familia=${grace.familyId}`);
    emitEvent({
      type: 'TOKEN_REFRESHED', category: CATEGORIES.SECURITY, actorId: grace.userId, actorRole: session.role,
      reason: 'Reintento dentro de la ventana de gracia: se devolvió el resultado del canje anterior',
      metadata: { familyId: grace.familyId, jti: grace.jti, grace: true },
    }, ctx);
    return authPayload(user, access, issued, successor);
  }

  // El token ya no está vigente: gracia, reutilización o simplemente inválido.
  async function redeemSpent(ctx, token, { spent, grace }) {
    const replayed = await replayWithinGrace(ctx, token, grace);
    if (replayed) return replayed;
    const marker = parseSpentMarker(spent);
    if (marker) throw await refreshReused(ctx, marker);
    throw refreshFailed(ctx, 'Refresh token desconocido, vencido o revocado');
  }

  // Tras cambiar rol o sucursales: espejo, caché, sesiones, refresh tokens y
  // bitácora. El cambio ya está hecho en Neo4j y Mongo, así que se registra
  // primero; si Redis falla al revocar, la operación responde SERVICE_UNAVAILABLE
  // (SESSIONS) y las sesiones abiertas conservan los permisos anteriores hasta
  // vencer (README, "Cambios de acceso inmediatos").
  async function afterAccessChange(user, ctx, event) {
    emitEvent({ ...event, targetType: 'User', targetId: user._id }, ctx);
    const revoked = await revokeUserSessions(redisClient, user._id);
    if (revoked.sessions || revoked.families) {
      emitEvent({
        type: 'SESSIONS_REVOKED', category: CATEGORIES.ADMIN, targetType: 'User', targetId: user._id,
        reason: 'Cambio de rol o de sucursales: el usuario debe volver a iniciar sesión.',
        metadata: { revoked: revoked.sessions, refreshFamilies: revoked.families },
      }, ctx);
    }
    const access = await rbac.getAccess(user._id);
    return accessView(user._id, access ?? { role: user.role, permissions: [], storeIds: [] });
  }

  async function loadManagedUser(ctx, userId) {
    requirePermission(ctx, PERMISSIONS.USERS_MANAGE);
    // Sin Redis no se podrían revocar sus sesiones: se rechaza antes de tocar Neo4j o Mongo.
    if (!redisClient.isReady) throw sessionsUnavailable();
    const user = await User.findById(userId);
    if (!user) throw new DomainError(`Usuario no encontrado (${userId}).`, 'NOT_FOUND', { entity: 'USER', id: String(userId) });
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

      // Se consulta en Neo4j en cada llamada (no sale de la sesión): falla cerrado
      // con SERVICE_UNAVAILABLE (RBAC). Una ruta sin registrar da false.
      canAccessRoute: (_, { path }, ctx) => rbacService.validarAccesoRuta(requireAuth(ctx).id, path),

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
        if (!redisClient.isReady) throw sessionsUnavailable();

        const email = input.email.trim().toLowerCase();
        // Un "correo" de más de 320 caracteres no puede existir: mismo error que cualquier credencial mala,
        // sin buscarlo ni gastar scrypt (y sin que el texto hostil llegue a la bitácora completo).
        if (email.length > MAX_EMAIL_LENGTH) {
          emitEvent(loginFailedEvent({ user: null, valid: false, email }), ctx);
          throw authError('Credenciales inválidas.', 'INVALID_CREDENTIALS');
        }
        const user = await User.findOne({ email }).select('+passwordHash');
        const valid = verifyPassword(input.password, user?.passwordHash);
        // Mismo mensaje para correo inexistente, contraseña incorrecta o cuenta desactivada;
        // el motivo real queda en la bitácora.
        if (!user || !valid || !user.isActive) {
          emitEvent(loginFailedEvent({ user, valid, email }), ctx);
          throw authError('Credenciales inválidas.', 'INVALID_CREDENTIALS');
        }

        const access = await resolveAccess(user, ctx);
        const issued = issueSession(user, access, ctx);
        const { userId, jti } = issued;

        // Familia nueva de refresh tokens (un dispositivo); en Redis solo va el hash.
        const refreshToken = generateRefreshToken();
        const record = newRefreshRecord({ userId, familyId: randomUUID(), ttlSeconds: REFRESH_TTL_SECONDS });

        // Sesión con permisos (TTL atómico) + índice de sesiones del usuario + refresh token, en una transacción.
        const multi = redisClient.multi()
          .set(sessionKey(jti), JSON.stringify(issued.session), { expiration: { type: 'EX', value: SESSION_TTL_SECONDS } })
          .sAdd(userSessionsKey(userId), jti)
          .expire(userSessionsKey(userId), SESSION_TTL_SECONDS);
        await refreshStore.addFamily(multi, { hash: hashRefreshToken(refreshToken), record, jti }).exec();
        console.log(`🔑 Sesión iniciada: ${sessionKey(jti)} rol=${access.role} (TTL ${SESSION_TTL_SECONDS}s)`);

        emitEvent(loginSuccessEvent({ userId, access, jti, familyId: record.familyId }), ctx);

        return authPayload(user, access, issued, refreshToken);
      },

      // Público: el refresh token es la credencial. De un solo uso: cada canje devuelve otro.
      refreshToken: async (_, { token }, ctx) => {
        if (!redisClient.isReady) throw sessionsUnavailable();
        if (!isWellFormedRefreshToken(token)) throw refreshFailed(ctx, 'Refresh token con formato inválido');

        const oldHash = hashRefreshToken(token);
        const looked = await refreshStore.lookup(oldHash);
        const record = parseRefreshRecord(looked.raw);
        if (!isRefreshRecordLive(record)) return redeemSpent(ctx, token, looked);

        // Como en el login: una cuenta desactivada no recibe sesión.
        const user = await User.findById(record.userId);
        if (!user || !user.isActive) throw refreshFailed(ctx, user ? 'Cuenta desactivada' : 'Usuario inexistente', user);

        // Sin Neo4j la sesión nueva saldría sin permisos: se rechaza sin gastar el token.
        const access = await resolveAccess(user, ctx, 'Neo4j no disponible: el refresh token no se canjeó (el cliente puede reintentar).');
        const unavailable = refreshUnavailableService(access);
        if (unavailable) throw new DomainError('El servicio de roles no está disponible. Intenta de nuevo.', 'SERVICE_UNAVAILABLE', { service: unavailable });

        const issued = issueSession(user, access, ctx);
        // El sucesor sale del token canjeado y un nonce (ver domain/refresh-tokens.js): así la ventana de gracia lo reentrega sin guardarlo.
        const nonce = generateGraceNonce();
        const nextToken = successorRefreshToken(token, nonce);
        const nextRecord = newRefreshRecord({ userId: issued.userId, familyId: record.familyId, ttlSeconds: REFRESH_TTL_SECONDS });

        // Atómico: solo un canje simultáneo del mismo token gana; el otro recibe
        // el mismo resultado (ventana de gracia) o, ya fuera de ella, cuenta como reutilización.
        const outcome = await refreshStore.rotate({
          oldHash, newHash: hashRefreshToken(nextToken), newRecord: nextRecord,
          jti: issued.jti, session: issued.session, sessionTtlSeconds: SESSION_TTL_SECONDS,
          grace: newGraceRecord({ userId: issued.userId, familyId: record.familyId, jti: issued.jti, iat: issued.iat, nonce }),
        });
        if (outcome === 'SPENT') return redeemSpent(ctx, token, await refreshStore.lookup(oldHash));
        if (outcome !== 'OK') throw refreshFailed(ctx, 'Refresh token revocado', user);
        console.log(`🔄 Sesión renovada: ${sessionKey(issued.jti)} rol=${access.role} familia=${record.familyId}`);

        emitEvent({
          type: 'TOKEN_REFRESHED', category: CATEGORIES.SECURITY, actorId: issued.userId, actorRole: access.role,
          reason: access.degraded ? 'Sesión sin permisos (Neo4j no disponible)' : 'Refresh token canjeado',
          metadata: { familyId: record.familyId, jti: issued.jti },
        }, ctx);

        return authPayload(user, access, issued, nextToken);
      },

      // Con `refreshToken` (del mismo usuario) también revoca ese dispositivo: su
      // familia completa. Sirve el token vigente o uno ya canjeado de la familia.
      logout: async (_, { refreshToken }, ctx) => {
        const me = requireAuth(ctx);
        await guardSessions(() => redisClient.multi().del(sessionKey(ctx.jti)).sRem(userSessionsKey(me.id), ctx.jti).exec());
        console.log(`🔒 Sesión cerrada: ${sessionKey(ctx.jti)}`);

        let familyId = null;
        if (isWellFormedRefreshToken(refreshToken)) {
          const { raw, spent } = await refreshStore.lookup(hashRefreshToken(refreshToken));
          const record = parseRefreshRecord(raw) ?? parseSpentMarker(spent);
          if (record && record.userId === String(me.id)) {
            await refreshStore.revokeFamily(record.userId, record.familyId);
            familyId = record.familyId;
            console.log(`🔒 Dispositivo olvidado: familia ${familyId}`);
          }
        }
        emitEvent({ type: 'LOGOUT', category: CATEGORIES.SECURITY, metadata: { jti: ctx.jti, ...(familyId ? { familyId } : {}) } }, ctx);
        return true;
      },

      logoutAllDevices: async (_, __, ctx) => {
        const me = requireAuth(ctx);
        const revoked = await revokeUserSessions(redisClient, me.id);
        console.log(`🔒 Sesiones cerradas en todos los dispositivos: usuario ${me.id} (${revoked.sessions} sesiones)`);
        emitEvent({
          type: 'SESSIONS_REVOKED', category: CATEGORIES.SECURITY, targetType: 'User', targetId: me.id,
          reason: 'El usuario cerró la sesión en todos sus dispositivos.',
          metadata: { revoked: revoked.sessions, refreshFamilies: revoked.families },
        }, ctx);
        return true;
      },

      assignRole: async (_, { userId, role }, ctx) => {
        const user = await loadManagedUser(ctx, userId);
        if (String(user._id) === String(ctx.currentUser.id)) throw forbidden('No puedes cambiar tu propio rol.', 'CANNOT_CHANGE_OWN_ROLE');
        const previous = await rbac.setRole(user._id, role);
        user.role = role;
        await user.save();
        await cacheUser(user);
        return afterAccessChange(user, ctx, roleChangedEvent({ previous, role }));
      },

      assignUserToStore: async (_, { userId, storeId }, ctx) => {
        const user = await loadManagedUser(ctx, userId);
        const store = await Store.findById(storeId);
        if (!store) throw new DomainError(`Sucursal no encontrada (${storeId}).`, 'NOT_FOUND', { entity: 'STORE', id: String(storeId) });
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
        if (!storeName) throw new DomainError('El usuario no está asignado a esa sucursal.', 'USER_NOT_ASSIGNED_TO_STORE', { userId: String(userId), storeId: String(storeId) });
        return afterAccessChange(user, ctx, {
          type: 'STORE_ASSIGNMENT_CHANGED', category: CATEGORIES.ADMIN,
          reason: `Retirado de ${storeName}`, metadata: { action: 'REMOVE', storeId: String(storeId), store: storeName },
        });
      },
    },
  };
};
