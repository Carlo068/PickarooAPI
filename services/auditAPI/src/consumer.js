// ============================================================
// CONSUMIDOR DE RABBITMQ → ScyllaDB
//
// - Solo consume cuando ScyllaDB está listo: mientras tanto los eventos
//   esperan en la cola durable "pickaroo.events".
// - ack después de escribir. Si la escritura falla, el mensaje vuelve a la
//   cola tras una pausa (sin bucle caliente).
// - Un mensaje que no es JSON o no trae tipo se descarta con aviso.
// - Acepta el formato anterior de mongoAPI ({ event, payload, occurredAt }).
// ============================================================

import { createHash } from 'crypto';
import amqp from 'amqplib';
import { saveEvent } from './scylla.js';

const QUEUE = process.env.RABBITMQ_QUEUE || 'pickaroo.events';
const RETRY_MS = 5000;
const PREFETCH = 20;

const CATEGORIES = new Set(['SECURITY', 'ADMIN', 'CATALOG', 'ORDER']);

// uuid determinista a partir del contenido: un mensaje sin eventId reentregado
// produce el mismo id (idempotente).
function contentUuid(text) {
  const h = createHash('sha1').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function normalize(raw, text) {
  const legacy = !raw.type && raw.event;
  const type = String(raw.type ?? raw.event ?? '').trim();
  if (!type) return null;
  const occurredAt = new Date(raw.occurredAt);
  const category = String(raw.category ?? (type.startsWith('ORDER') ? 'ORDER' : 'ADMIN')).toUpperCase();
  const payload = legacy ? raw.payload ?? {} : raw.metadata ?? {};
  return {
    eventId: isUuid(raw.eventId) ? raw.eventId : contentUuid(text),
    type,
    category: CATEGORIES.has(category) ? category : 'ADMIN',
    actorId: raw.actorId != null ? String(raw.actorId) : (payload.userId != null ? String(payload.userId) : 'ANONYMOUS'),
    actorRole: raw.actorRole ?? null,
    targetType: raw.targetType ?? (legacy && payload.orderId ? 'Order' : null),
    targetId: raw.targetId != null ? String(raw.targetId) : (legacy && payload.orderId ? String(payload.orderId) : null),
    success: raw.success !== false,
    reason: String(raw.reason ?? ''),
    ip: raw.ip ?? null,
    userAgent: raw.userAgent ?? null,
    metadata: payload,
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date().toISOString() : occurredAt.toISOString(),
  };
}

export async function startConsumer() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    conn.on('error', err => console.error('RabbitMQ (conexión):', err.message));
    conn.on('close', () => {
      console.warn(`⚠️  Conexión con RabbitMQ cerrada. Reintento en ${RETRY_MS / 1000}s.`);
      setTimeout(startConsumer, RETRY_MS);
    });
    const channel = await conn.createChannel();
    await channel.assertQueue(QUEUE, { durable: true });
    await channel.prefetch(PREFETCH);

    await channel.consume(QUEUE, async msg => {
      if (!msg) return;
      const text = msg.content.toString();
      let event;
      try {
        event = normalize(JSON.parse(text), text);
      } catch {
        event = null;
      }
      if (!event) {
        console.warn('⚠️  Mensaje inválido descartado:', text.slice(0, 200));
        channel.ack(msg);
        return;
      }
      try {
        await saveEvent(event);
        channel.ack(msg);
        console.log(`💾 [${event.category}] ${event.type} → ScyllaDB`);
      } catch (err) {
        console.error(`❌ No se pudo guardar ${event.type} (se reintentará):`, err.message);
        setTimeout(() => channel.nack(msg, false, true), RETRY_MS);
      }
    });
    console.log(`📥 Consumiendo la cola "${QUEUE}" hacia ScyllaDB.`);
  } catch (err) {
    console.warn(`⚠️  RabbitMQ no disponible (${err.message || err.code}). Reintento en ${RETRY_MS / 1000}s.`);
    setTimeout(startConsumer, RETRY_MS);
  }
}
