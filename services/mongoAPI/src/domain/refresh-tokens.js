// ============================================================
// REFRESH TOKENS — reglas puras (sin Redis)
//
// Un refresh token es opaco: 256 bits aleatorios en base64url, no un JWT.
// En Redis solo se guarda su SHA-256 (hex), nunca el token: quien lea Redis
// no puede usarlo. Una "familia" es un inicio de sesión en un dispositivo:
// la cadena de tokens rotados que empezó con un `login`.
//
// Registro guardado en `refresh:<hash>`:
//   { userId, familyId, createdAt, expiresAt }   (fechas ISO)
// Marca de token ya usado en `refresh:spent:<hash>`:
//   { familyId, userId }
// Ventana de gracia en `refresh:grace:<hash>` (TTL = REFRESH_REUSE_GRACE_SECONDS):
//   { userId, familyId, jti, iat, nonce }
//
// Ventana de gracia: si la respuesta de un canje se pierde (red móvil) o dos
// partes de la app canjean el mismo token a la vez, el reintento con el token
// recién canjeado recibe el MISMO resultado que el ganador, no una
// reutilización. Para reentregar el sucesor sin guardarlo, el sucesor no es
// aleatorio puro: es HMAC-SHA256(clave = token canjeado, nonce aleatorio de
// 256 bits). Redis guarda solo el nonce, unos segundos; sin el token canjeado
// (que Redis no tiene) el nonce no sirve, y sin el nonce (que caduca con la
// ventana) el token canjeado tampoco. El token de acceso se vuelve a firmar
// igual: HS256 es determinista con los mismos datos (`jti`, `iat`).
// ============================================================

import { createHash, createHmac, randomBytes } from 'crypto';

export const REFRESH_TOKEN_BYTES = 32;
export const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 3600; // 30 días

// TTL configurable (REFRESH_TTL_SECONDS); un valor ausente o inválido usa el de 30 días.
export function refreshTtlSeconds(value) {
  const seconds = parseInt(value, 10);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : DEFAULT_REFRESH_TTL_SECONDS;
}

export const DEFAULT_REFRESH_GRACE_SECONDS = 10;

// REFRESH_REUSE_GRACE_SECONDS; 0 la desactiva y un valor ausente o inválido usa 10 s.
export function refreshGraceSeconds(value) {
  const seconds = parseInt(value, 10);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : DEFAULT_REFRESH_GRACE_SECONDS;
}

export const generateRefreshToken = () => randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

// 32 bytes en base64url sin relleno: 43 caracteres de [A-Za-z0-9_-].
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedRefreshToken = token => typeof token === 'string' && TOKEN_SHAPE.test(token);

export const hashRefreshToken = token => createHash('sha256').update(String(token), 'utf8').digest('hex');

export function newRefreshRecord({ userId, familyId, ttlSeconds, now = Date.now() }) {
  return {
    userId: String(userId),
    familyId: String(familyId),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
}

const isNonEmptyString = v => typeof v === 'string' && v.length > 0;

// null si el valor no es un registro completo (ausente, otro formato o JSON roto).
export function parseRefreshRecord(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const record = JSON.parse(raw);
    const valid = [record.userId, record.familyId, record.createdAt, record.expiresAt].every(isNonEmptyString)
      && !Number.isNaN(Date.parse(record.expiresAt));
    return valid ? record : null;
  } catch {
    return null;
  }
}

// Redis borra la clave al vencer el TTL; esto cubre el instante intermedio y relojes desfasados.
export const isRefreshRecordLive = (record, now = Date.now()) => Boolean(record) && Date.parse(record.expiresAt) > now;

// ---------- Ventana de gracia ----------
export const generateGraceNonce = () => randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

// Sucesor de `token` en un canje: 32 bytes en base64url, la misma forma que un token aleatorio.
export const successorRefreshToken = (token, nonce) => createHmac('sha256', String(token)).update(String(nonce), 'utf8').digest('base64url');

// Lo mínimo para repetir el resultado: dónde está la sesión (jti), cómo se firmó su JWT (iat) y el nonce del sucesor.
export function newGraceRecord({ userId, familyId, jti, iat, nonce }) {
  return { userId: String(userId), familyId: String(familyId), jti: String(jti), iat, nonce: String(nonce) };
}

export function parseGraceRecord(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const record = JSON.parse(raw);
    const valid = [record.userId, record.familyId, record.jti, record.nonce].every(isNonEmptyString) && Number.isInteger(record.iat);
    return valid ? record : null;
  } catch {
    return null;
  }
}

// ---------- Decisiones del canje ----------
// Un acceso degradado (Neo4j caído) abriría una sesión sin permisos y gastaría
// el token: el canje se rechaza antes de rotar con este servicio, y el cliente
// reintenta con el mismo token. El login sí entra degradado (nivel cliente).
export const refreshUnavailableService = access => (access?.degraded ? 'RBAC' : null);

export function parseSpentMarker(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const marker = JSON.parse(raw);
    return isNonEmptyString(marker.familyId) && isNonEmptyString(marker.userId) ? marker : null;
  } catch {
    return null;
  }
}
