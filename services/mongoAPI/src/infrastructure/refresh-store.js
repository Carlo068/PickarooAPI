// ============================================================
// REFRESH TOKENS EN REDIS (ver auth.js y domain/refresh-tokens.js)
//
//   refresh:<hash>                    STRING (JSON { userId, familyId, createdAt, expiresAt })  TTL REFRESH_TTL
//   refresh:spent:<hash>              STRING (JSON { familyId, userId }): token ya rotado       TTL REFRESH_TTL
//   refresh:grace:<hash>              STRING (JSON { userId, familyId, jti, iat, nonce })       TTL REFRESH_REUSE_GRACE
//   refresh-family:<familyId>         STRING: hash del token vigente de la familia               TTL REFRESH_TTL
//   refresh-family:<familyId>:sessions SET de jti: sesiones abiertas por la familia              TTL REFRESH_TTL
//   user:<userId>:refresh-families    SET de familyId                                            TTL REFRESH_TTL
//
// <hash> es el SHA-256 del token: el token nunca se guarda (tampoco el
// sucesor durante la ventana de gracia: ver domain/refresh-tokens.js).
//
// Atomicidad: rotar y revocar son scripts Lua. Redis ejecuta cada script
// completo sin intercalar otro comando, así que de dos canjes simultáneos del
// mismo token exactamente uno lo consume; el otro ve la marca de "usado" y,
// dentro de la ventana de gracia, recibe el resultado del ganador (después,
// cuenta como reutilización). La rotación escribe en el mismo paso el token
// nuevo, la sesión nueva (con su jti en la familia) y el registro de gracia,
// así una revocación posterior siempre los alcanza. Se eligió Lua sobre
// GETDEL (consume pero no deja la marca en el mismo paso: el perdedor podría
// leer "desconocido" en lugar de "usado") y sobre WATCH/MULTI (exige una
// conexión aislada y reintentos). El script de revocación arma claves a partir de lo que lee
// (el hash vigente, los jti): válido en el Redis de una sola instancia del
// Compose, no en Redis Cluster.
//
// Errores de Redis a mitad de una operación (se cayó después de `isReady`):
// guardSessions / withSessionErrors los convierten en SERVICE_UNAVAILABLE
// (`service: SESSIONS`) para que el cliente conserve su token y reintente.
// ============================================================

import { DomainError } from '../domain/errors.js';

const REFRESH_PREFIX = 'refresh:';
const FAMILY_PREFIX = 'refresh-family:';
const FAMILY_SESSIONS_SUFFIX = ':sessions';

export const refreshKey = hash => `${REFRESH_PREFIX}${hash}`;
export const spentKey = hash => `${REFRESH_PREFIX}spent:${hash}`;
export const graceKey = hash => `${REFRESH_PREFIX}grace:${hash}`;
export const familyKey = familyId => `${FAMILY_PREFIX}${familyId}`;
export const familySessionsKey = familyId => `${familyKey(familyId)}${FAMILY_SESSIONS_SUFFIX}`;
export const userFamiliesKey = userId => `user:${userId}:refresh-families`;

// Jti que revisa cada canje en `refresh-family:<id>:sessions` para quitar los
// de sesiones que ya vencieron: el conjunto no crece sin límite y el costo es fijo.
export const PRUNE_PER_ROTATION = 10;

// Canje: consume el token viejo y deja la marca de usado, el registro de gracia,
// el token nuevo, el puntero de la familia y la sesión nueva, todo o nada.
//   'OK'      rotado
//   'SPENT'   el token ya se había usado (marca refresh:spent): gracia o reutilización
//   'INVALID' no existe, venció o su familia ya no apunta a él (puntero viejo)
// La poda va antes de agregar el jti nuevo: su sesión aún no existe.
const ROTATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  if redis.call('EXISTS', KEYS[2]) == 1 then return 'SPENT' end
  return 'INVALID'
end
redis.call('DEL', KEYS[1])
if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 'INVALID' end
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[8])
if tonumber(ARGV[11]) > 0 then redis.call('SET', KEYS[9], ARGV[10], 'EX', ARGV[11]) end
for _, jti in ipairs(redis.call('SRANDMEMBER', KEYS[4], ARGV[13])) do
  if redis.call('EXISTS', ARGV[12] .. jti) == 0 then
    redis.call('SREM', KEYS[4], jti)
    redis.call('SREM', KEYS[7], jti)
  end
end
redis.call('SET', KEYS[5], ARGV[3], 'EX', ARGV[8])
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[8])
redis.call('SADD', KEYS[4], ARGV[6])
redis.call('EXPIRE', KEYS[4], ARGV[8])
redis.call('SADD', KEYS[8], ARGV[7])
redis.call('EXPIRE', KEYS[8], ARGV[8])
redis.call('SET', KEYS[6], ARGV[5], 'EX', ARGV[9])
redis.call('SADD', KEYS[7], ARGV[6])
redis.call('EXPIRE', KEYS[7], ARGV[9])
return 'OK'
`;

// Revoca familias de un usuario: su token vigente, sus sesiones y su lugar en
// los índices. Sin familyId en ARGV revoca todas las del usuario.
// Devuelve { familias con token vigente, sesiones borradas, familias que existían }.
const REVOKE_SCRIPT = `
local families = {}
if #ARGV > 4 then
  for i = 5, #ARGV do families[#families + 1] = ARGV[i] end
else
  families = redis.call('SMEMBERS', KEYS[1])
end
local revokedFamilies, revokedSessions, found = 0, 0, 0
for _, familyId in ipairs(families) do
  local family = ARGV[2] .. familyId
  local members = family .. ARGV[4]
  local live = redis.call('GET', family)
  if live then
    found = found + 1
    revokedFamilies = revokedFamilies + redis.call('DEL', ARGV[1] .. live)
  end
  for _, jti in ipairs(redis.call('SMEMBERS', members)) do
    revokedSessions = revokedSessions + redis.call('DEL', ARGV[3] .. jti)
    redis.call('SREM', KEYS[2], jti)
  end
  redis.call('DEL', family, members)
  redis.call('SREM', KEYS[1], familyId)
end
return { revokedFamilies, revokedSessions, found }
`;

export const sessionsUnavailable = () => new DomainError('El servicio de sesiones no está disponible. Intenta de nuevo.', 'SERVICE_UNAVAILABLE', { service: 'SESSIONS' });

// Corre `fn` (comandos de Redis de sesiones o refresh tokens); un error de Redis llega como SERVICE_UNAVAILABLE.
export async function guardSessions(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DomainError) throw err;
    console.warn('⚠️  Redis falló a mitad de una operación de sesiones:', err?.message ?? err);
    throw sessionsUnavailable();
  }
}

// El almacén con cada método asíncrono protegido por guardSessions. addFamily
// queda igual: solo agrega comandos a la transacción del login.
export function withSessionErrors(store) {
  const guarded = { ...store };
  for (const name of ['lookup', 'replay', 'rotate', 'revokeFamily', 'revokeUserFamilies']) {
    guarded[name] = (...args) => guardSessions(() => store[name](...args));
  }
  return guarded;
}

// `sessionPrefix` y `userSessionsKey` son los de las sesiones del JWT (auth.js).
export function createRefreshStore(redis, { ttlSeconds, graceSeconds = 0, sessionPrefix, userSessionsKey }) {
  const ttl = String(ttlSeconds);
  const sessionKey = jti => `${sessionPrefix}${jti}`;

  async function revoke(userId, familyIds) {
    const [families, sessions, found] = await redis.eval(REVOKE_SCRIPT, {
      keys: [userFamiliesKey(userId), userSessionsKey(userId)],
      arguments: [REFRESH_PREFIX, FAMILY_PREFIX, sessionPrefix, FAMILY_SESSIONS_SUFFIX, ...familyIds],
    });
    return { families: Number(families), sessions: Number(sessions), found: Number(found) };
  }

  return {
    // Familia nueva (login): se agrega a la transacción que abre la sesión.
    addFamily(multi, { hash, record, jti }) {
      const { userId, familyId } = record;
      return multi
        .set(refreshKey(hash), JSON.stringify(record), { expiration: { type: 'EX', value: ttlSeconds } })
        .set(familyKey(familyId), hash, { expiration: { type: 'EX', value: ttlSeconds } })
        .sAdd(familySessionsKey(familyId), jti)
        .expire(familySessionsKey(familyId), ttlSeconds)
        .sAdd(userFamiliesKey(userId), familyId)
        .expire(userFamiliesKey(userId), ttlSeconds);
    },

    // Valores crudos del token vigente, de su marca de usado y de su registro de gracia (se interpretan en el dominio).
    async lookup(hash) {
      const [raw, spent, grace] = await redis.mGet([refreshKey(hash), spentKey(hash), graceKey(hash)]);
      return { raw, spent, grace };
    },

    // Ventana de gracia: la sesión del ganador (JSON crudo) si el sucesor sigue
    // siendo el token vigente de la familia; null si ya se canjeó o se revocó.
    async replay({ familyId, successorHash, jti }) {
      const [pointer, successor, session] = await redis.mGet([familyKey(familyId), refreshKey(successorHash), sessionKey(jti)]);
      return pointer === successorHash && successor && session ? session : null;
    },

    // `grace` es el registro de gracia (domain/refresh-tokens.js, newGraceRecord).
    rotate({ oldHash, newHash, newRecord, jti, session, sessionTtlSeconds, grace }) {
      const { userId, familyId } = newRecord;
      return redis.eval(ROTATE_SCRIPT, {
        keys: [
          refreshKey(oldHash), spentKey(oldHash), familyKey(familyId), familySessionsKey(familyId),
          refreshKey(newHash), sessionKey(jti), userSessionsKey(userId), userFamiliesKey(userId), graceKey(oldHash),
        ],
        arguments: [
          oldHash, newHash, JSON.stringify(newRecord), JSON.stringify({ familyId, userId }),
          JSON.stringify(session), jti, familyId, ttl, String(sessionTtlSeconds),
          JSON.stringify(grace), String(graceSeconds), sessionPrefix, String(PRUNE_PER_ROTATION),
        ],
      });
    },

    revokeFamily: (userId, familyId) => revoke(userId, [familyId]),
    revokeUserFamilies: userId => revoke(userId, []),
  };
}
