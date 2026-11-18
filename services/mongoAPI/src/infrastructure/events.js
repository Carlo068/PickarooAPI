// ============================================================
// EVENTOS DE AUDITORÍA Y TELEMETRÍA DE SEGURIDAD
//
// Aquí vive la forma del evento, el recorte de datos sensibles, el diff de
// ediciones y el plugin de Apollo. La conexión con RabbitMQ (cola
// "eventos-seguridad"), la publicación y la reconexión están en rabbitmq.js.
//
// mongoAPI nunca escribe en ScyllaDB: publica cada evento y sigue
// (fire-and-forget). auditAPI consume la cola y persiste la bitácora.
// Si RabbitMQ no está disponible el evento se descarta con un aviso:
// una caída del broker nunca interrumpe una compra o un login.
//
// Sobre común (lo que llega a ScyllaDB):
//   { eventId, type, category, actorId, actorRole, targetType, targetId,
//     success, reason, ip, userAgent, metadata, occurredAt }
// Nunca se incluyen contraseñas, hashes ni tokens (CWE-532): quien arma el evento
// no los pone y, además, scrubMetadata los quita aquí antes de publicar.
// ============================================================

import { randomUUID } from 'crypto';
import { startPublisher, publish, EVENTS_QUEUE } from './rabbitmq.js';

export { EVENTS_QUEUE };
export const CATEGORIES = { SECURITY: 'SECURITY', ADMIN: 'ADMIN', CATALOG: 'CATALOG', ORDER: 'ORDER' };

// Conecta con RabbitMQ sin bloquear ni lanzar: si falla, reintenta solo (ver rabbitmq.js).
export const initEvents = () => startPublisher();

// ---------- Recorte de datos sensibles (CWE-532) ----------
// Claves que nunca viajan en un evento. `jti` y `familyId` son identificadores de sesión, no credenciales;
// `refreshFamilies` es un conteo (cuántas familias de refresh tokens se revocaron).
const SENSITIVE_KEY = /pass(word)?|token|secret|hash|authorization|jwt|refresh/i;
const ALLOWED_KEYS = new Set(['jti', 'familyId', 'refreshFamilies']);
// Valores con forma de credencial aunque la clave sea inocente: JWT, hash scrypt, refresh token (43 caracteres base64url).
// Cuantificadores acotados y texto truncado antes de buscar (MAX_TEXT): sin retroceso cuadrático con texto hostil.
// Un JWT cortado a medias (eyJ…, eyJ….…) también se tacha.
const SENSITIVE_VALUE = /eyJ[\w-]{5,2048}(?:\.[\w-]{0,2048}){0,2}|scrypt\$[0-9a-f]{1,512}\$[0-9a-f]{1,512}/gi;
const BARE_REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const REDACTED = '[REDACTED]';
// Ningún texto de un evento pasa de aquí: lo que escribe un atacante (correo, motivo) no cuesta CPU ni llena la bitácora.
export const MAX_TEXT = 512;
const MAX_CLIENT_TEXT = 256; // ip y user-agent
const MAX_DEPTH = 8;

export const isSensitiveKey = key => SENSITIVE_KEY.test(key) && !ALLOWED_KEYS.has(key);

export function scrubText(text, max = MAX_TEXT) {
  if (typeof text !== 'string') return text;
  const short = text.length > max ? text.slice(0, max) : text;
  return BARE_REFRESH_TOKEN.test(short) ? REDACTED : short.replace(SENSITIVE_VALUE, REDACTED);
}

// Copia profunda de `value` sin claves sensibles y con las credenciales de los textos tachadas.
// Solo recorre objetos planos y arreglos; lo demás (fechas, ObjectId…) pasa tal cual.
export function scrubMetadata(value, depth = 0) {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED; // anidamiento absurdo o circular: no se publica
  if (Array.isArray(value)) return value.map(item => scrubMetadata(item, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const clean = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!isSensitiveKey(key)) clean[key] = scrubMetadata(inner, depth + 1);
  }
  return clean;
}

// IP y User-Agent del cliente. El gateway reenvía x-forwarded-for y user-agent.
export function requestInfo(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  return {
    ip: (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req?.socket?.remoteAddress || 'unknown',
    userAgent: req?.headers?.['user-agent'] || 'unknown',
  };
}

// El mensaje exacto que se publica (exportado para probar qué sale, sin broker).
export function buildEventMessage(event, ctx = {}) {
  const actor = ctx.currentUser;
  return {
    eventId: randomUUID(),
    type: event.type,
    category: event.category,
    actorId: String(event.actorId ?? actor?.id ?? 'ANONYMOUS'),
    actorRole: event.actorRole ?? actor?.role ?? null,
    targetType: event.targetType ?? null,
    targetId: event.targetId != null ? String(event.targetId) : null,
    success: event.success !== false,
    reason: scrubText(event.reason ?? ''),
    ip: scrubText(ctx.ip ?? null, MAX_CLIENT_TEXT),
    userAgent: scrubText(ctx.userAgent ?? null, MAX_CLIENT_TEXT),
    metadata: scrubMetadata(event.metadata ?? {}),
    occurredAt: new Date().toISOString(),
  };
}

// Fire-and-forget: nunca lanza ni espera al broker (publish descarta con aviso único si está caído).
export function emitEvent(event, ctx = {}) {
  try {
    publish(buildEventMessage(event, ctx));
  } catch (err) {
    console.warn(`⚠️  No se pudo publicar el evento "${event?.type}":`, err.message);
  }
}

// Campos que cambiaron en una edición: { campo: { from, to } }.
export function diff(before, input) {
  const changes = {};
  for (const [key, to] of Object.entries(input ?? {})) {
    const from = before?.[key];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) changes[key] = { from: from ?? null, to: to ?? null };
  }
  return changes;
}

// ---------- Plugin de Apollo: un solo lugar para accesos denegados y compras rechazadas ----------
const ORDER_OPERATIONS = new Set(['createOrder', 'checkoutCart']);
const DENIED = new Set(['FORBIDDEN', 'UNAUTHENTICATED']);
// Operaciones que la app manda en bucle (reportDriverLocation: cada 3 s por repartidor). Su
// UNAUTHENTICATED (sesión vencida, o Redis caído, que deja el contexto anónimo) no se registra como
// ACCESS_DENIED: inundaría RabbitMQ y ScyllaDB. Su FORBIDDEN sí, y las demás operaciones no cambian.
const QUIET_UNAUTHENTICATED = new Set(['reportDriverLocation']);

// `emit` es emitEvent; las pruebas pasan uno propio para ver qué se registra.
export const createAuditPlugin = (emit = emitEvent) => ({
  async requestDidStart() {
    return {
      async didEncounterErrors({ contextValue, errors }) {
        for (const err of errors) {
          const operation = err.path?.[0];
          if (!operation) continue; // errores de sintaxis/validación: no son de negocio
          const code = err.extensions?.code ?? err.originalError?.extensions?.code ?? 'INTERNAL_SERVER_ERROR';

          if (DENIED.has(code)) {
            if (operation === 'login') continue; // ya se registra como LOGIN_FAILED
            if (code === 'UNAUTHENTICATED' && QUIET_UNAUTHENTICATED.has(operation)) continue;
            emit({
              type: 'ACCESS_DENIED', category: CATEGORIES.SECURITY, success: false,
              reason: err.message, metadata: { operation, code },
            }, contextValue);
          } else if (ORDER_OPERATIONS.has(operation)) {
            const newQuote = err.originalError?.extensions?.newQuote;
            emit({
              type: 'ORDER_REJECTED', category: CATEGORIES.ORDER, success: false,
              reason: err.message,
              metadata: { operation, code, ...(newQuote ? { newQuoteTotal: newQuote.total } : {}) },
            }, contextValue);
          }
        }
      },
    };
  },
});

export const auditPlugin = createAuditPlugin();
