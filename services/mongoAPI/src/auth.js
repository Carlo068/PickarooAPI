// ============================================================
// AUTENTICACIÓN HÍBRIDA: JWT + sesión activa en Redis
//
//   login   → firma un JWT con un `jti` único y guarda `session:<jti>` en
//             Redis con el mismo TTL que el token.
//   request → se verifica la firma del JWT Y que `session:<jti>` exista.
//   logout  → borra `session:<jti>`: el token deja de servir al instante,
//             aunque todavía no haya expirado.
//
// Sin Redis no hay sesiones (falla cerrado): nadie puede iniciar sesión ni
// usar un token existente hasta que Redis vuelva.
// ============================================================

import { randomBytes, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { GraphQLError } from 'graphql';
import { User } from './infrastructure/models/index.js';
import { verifyPassword } from './infrastructure/passwords.js';
import { cacheUser, getUser } from './infrastructure/entity-cache.js';

const SESSION_TTL_SECONDS = parseInt(process.env.JWT_TTL_SECONDS) || 3600;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = randomBytes(32).toString('hex');
  console.warn('⚠️  JWT_SECRET no está definido: se usa un secreto aleatorio y los tokens no sobreviven a un reinicio.');
}

const sessionKey = jti => `session:${jti}`;

const authError = (message, code) => new GraphQLError(message, { extensions: { code } });

// ---------- Guardas para los resolvers ----------
export function requireAuth(ctx) {
  if (!ctx.currentUser) throw authError('Debes iniciar sesión.', 'UNAUTHENTICATED');
  return ctx.currentUser;
}

export function requireAdmin(ctx) {
  const user = requireAuth(ctx);
  if (user.role !== 'ADMIN') throw authError('Se requiere rol ADMIN.', 'FORBIDDEN');
  return user;
}

// El dueño del recurso o un administrador.
export function requireSelfOrAdmin(ctx, ownerId) {
  const user = requireAuth(ctx);
  if (user.role !== 'ADMIN' && String(user.id) !== String(ownerId)) {
    throw authError('No tienes permiso para este recurso.', 'FORBIDDEN');
  }
  return user;
}

// ---------- Contexto: se ejecuta en CADA petición ----------
export const createAuthContext = redisClient => async ({ req }) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return { currentUser: null };

  const token = header.slice('Bearer '.length).trim();
  try {
    // 1. Firma y expiración del JWT
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // 2. La sesión sigue activa en Redis (no fue revocada con logout)
    const userId = redisClient.isReady ? await redisClient.get(sessionKey(decoded.jti)) : null;
    if (userId && userId === decoded.sub) {
      return {
        currentUser: { id: decoded.sub, name: decoded.name, email: decoded.email, role: decoded.role },
        token,
        jti: decoded.jti,
      };
    }
  } catch (err) {
    console.warn('Token inválido o expirado:', err.message);
  }
  return { currentUser: null };
};

// ---------- Resolvers ----------
export const createAuthResolvers = redisClient => ({
  Query: {
    me: (_, __, ctx) => getUser(requireAuth(ctx).id),
  },

  Mutation: {
    login: async (_, { input }) => {
      if (!redisClient.isReady) throw authError('El servicio de sesiones no está disponible. Intenta de nuevo.', 'SERVICE_UNAVAILABLE');

      const user = await User.findOne({ email: input.email.trim().toLowerCase() }).select('+passwordHash');
      const valid = verifyPassword(input.password, user?.passwordHash);
      // Mismo mensaje para correo inexistente, contraseña incorrecta o cuenta desactivada.
      if (!user || !valid || !user.isActive) throw authError('Credenciales inválidas.', 'UNAUTHENTICATED');

      const jti = randomUUID();
      const token = jwt.sign(
        { sub: String(user._id), name: user.name, email: user.email, role: user.role, jti },
        JWT_SECRET,
        { algorithm: 'HS256', expiresIn: SESSION_TTL_SECONDS },
      );

      // La sesión vive en Redis con TTL atómico (SET ... EX).
      await redisClient.set(sessionKey(jti), String(user._id), { expiration: { type: 'EX', value: SESSION_TTL_SECONDS } });
      console.log(`🔑 Sesión iniciada: ${sessionKey(jti)} (TTL ${SESSION_TTL_SECONDS}s)`);

      return { token, expiresIn: SESSION_TTL_SECONDS, user: await cacheUser(user) };
    },

    logout: async (_, __, ctx) => {
      requireAuth(ctx);
      await redisClient.del(sessionKey(ctx.jti));
      console.log(`🔒 Sesión cerrada: ${sessionKey(ctx.jti)}`);
      return true;
    },
  },
});
