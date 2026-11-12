// ============================================================
// EVENTOS DE AUDITORÍA → RabbitMQ (cola "pickaroo.events")
//
// mongoAPI nunca escribe en ScyllaDB: publica cada evento y sigue
// (fire-and-forget). auditAPI consume la cola y persiste la bitácora.
// Si RabbitMQ no está disponible el evento se descarta con un aviso local:
// una caída del broker nunca interrumpe una compra o un login.
//
// Sobre común (lo que llega a ScyllaDB):
//   { eventId, type, category, actorId, actorRole, targetType, targetId,
//     success, reason, ip, userAgent, metadata, occurredAt }
// Nunca se incluyen contraseñas ni tokens completos.
// ============================================================

import { randomUUID } from 'crypto';
import amqp from 'amqplib';

export const EVENTS_QUEUE = process.env.RABBITMQ_QUEUE || 'pickaroo.events';
export const CATEGORIES = { SECURITY: 'SECURITY', ADMIN: 'ADMIN', CATALOG: 'CATALOG', ORDER: 'ORDER' };

let channel = null;

export async function initEvents() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    conn.on('error', err => console.error('RabbitMQ (conexión):', err.message));
    conn.on('close', () => { channel = null; });
    channel = await conn.createChannel();
    await channel.assertQueue(EVENTS_QUEUE, { durable: true });
    console.log(`✅ RabbitMQ conectado. Cola "${EVENTS_QUEUE}" lista.`);
  } catch (err) {
    console.error('⚠️  No se pudo conectar a RabbitMQ (los eventos de auditoría se omiten):', err.message || err.code);
  }
}

// IP y User-Agent del cliente. El gateway reenvía x-forwarded-for y user-agent.
export function requestInfo(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  return {
    ip: (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req?.socket?.remoteAddress || 'unknown',
    userAgent: req?.headers?.['user-agent'] || 'unknown',
  };
}

export function emitEvent(event, ctx = {}) {
  const actor = ctx.currentUser;
  const message = {
    eventId: randomUUID(),
    type: event.type,
    category: event.category,
    actorId: String(event.actorId ?? actor?.id ?? 'ANONYMOUS'),
    actorRole: event.actorRole ?? actor?.role ?? null,
    targetType: event.targetType ?? null,
    targetId: event.targetId != null ? String(event.targetId) : null,
    success: event.success !== false,
    reason: event.reason ?? '',
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: event.metadata ?? {},
    occurredAt: new Date().toISOString(),
  };
  if (!channel) return;
  try {
    channel.sendToQueue(EVENTS_QUEUE, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: 'application/json' });
  } catch (err) {
    console.warn(`⚠️  No se pudo publicar el evento "${message.type}":`, err.message);
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

export const auditPlugin = {
  async requestDidStart() {
    return {
      async didEncounterErrors({ contextValue, errors }) {
        for (const err of errors) {
          const operation = err.path?.[0];
          if (!operation) continue; // errores de sintaxis/validación: no son de negocio
          const code = err.extensions?.code ?? err.originalError?.extensions?.code ?? 'INTERNAL_SERVER_ERROR';

          if (DENIED.has(code)) {
            if (operation === 'login') continue; // ya se registra como LOGIN_FAILED
            emitEvent({
              type: 'ACCESS_DENIED', category: CATEGORIES.SECURITY, success: false,
              reason: err.message, metadata: { operation, code },
            }, contextValue);
          } else if (ORDER_OPERATIONS.has(operation)) {
            const newQuote = err.originalError?.extensions?.newQuote;
            emitEvent({
              type: 'ORDER_REJECTED', category: CATEGORIES.ORDER, success: false,
              reason: err.message,
              metadata: { operation, code, ...(newQuote ? { newQuoteTotal: newQuote.total } : {}) },
            }, contextValue);
          }
        }
      },
    };
  },
};
