// ============================================================
// CONSUMIDOR DE RABBITMQ → ScyllaDB (worker de la cola "eventos-seguridad")
//
// - Solo consume cuando ScyllaDB está listo: mientras tanto los eventos
//   esperan en la cola durable "eventos-seguridad".
// - Prefetch 50 (RABBITMQ_PREFETCH) y ack manual: ack después de escribir. Si la
//   escritura falla, nack con reencolado tras una pausa (sin bucle caliente).
// - Un mensaje que no es JSON o no trae tipo se descarta con aviso (se confirma: no se reintenta).
// - Cada evento guardado deja una línea en consola con sus campos básicos (nunca metadata ni
//   secretos) y sin caracteres de control, para que un valor hostil no falsifique líneas del log.
// - Acepta el formato anterior de mongoAPI ({ event, payload, occurredAt }).
// ============================================================

import { createHash } from 'crypto';
import amqp from 'amqplib';
import { saveEvent } from './scylla.js';
import { queueName, prefetchCount } from './queue.js';

const QUEUE = queueName();
const RETRY_MS = 5000;
const PREFETCH = prefetchCount();

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

// ---------- Línea de log por evento ----------
const MAX_LOG_FIELD = 80;

// Controles C0/C1, separadores de línea Unicode, caracteres de ancho cero, marcas bidireccionales y BOM.
const UNSAFE_LOG_CHARS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'g',
);

// Un valor para el log: sin saltos de línea, tabuladores ni otros caracteres de control o de dirección de
// texto (log injection) y con tope de largo.
export function logSafe(value, max = MAX_LOG_FIELD) {
  const text = String(value ?? '-').replace(UNSAFE_LOG_CHARS, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Solo identificadores y datos de contexto: ni reason ni metadata ni userAgent.
export const eventLogLine = event => (
  `📥 [${logSafe(event.category)}] ${logSafe(event.type)} actor=${logSafe(event.actorId)} role=${logSafe(event.actorRole)} `
  + `success=${event.success} ip=${logSafe(event.ip)} at=${logSafe(event.occurredAt)} → ScyllaDB`
);

// ---------- ack / nack que nunca lanzan ----------
// Con el canal cerrado amqplib lanza al confirmar: el mensaje ya vuelve a la cola solo (sin ack), así que no hay nada que hacer.
export function safeAck(channel, msg) {
  try { channel.ack(msg); return true; } catch { return false; }
}

export function safeNack(channel, msg, requeue) {
  try { channel.nack(msg, false, requeue); return true; } catch { return false; }
}

// ---------- Mensajes venenosos ----------
// Un evento que no se puede guardar 5 veces seguidas (mismo eventId) se descarta: sin esto reintentaría para siempre.
export const MAX_SAVE_ATTEMPTS = 5;
const MAX_TRACKED = 1000;
const saveFailures = new Map(); // eventId → fallos seguidos (acotado: se olvida el más antiguo)

function noteFailure(failures, eventId) {
  const count = (failures.get(eventId) ?? 0) + 1;
  if (!failures.has(eventId) && failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value);
  failures.set(eventId, count);
  return count;
}

// Procesa un mensaje: ack tras escribir; si la escritura falla, nack con reencolado tras `retryMs`
// (y descarte a la 5.ª falla). `save`, `setTimer`, `log`, `warn`, `error` y `failures` se inyectan en las pruebas.
export async function handleMessage(channel, msg, {
  save = saveEvent, retryMs = RETRY_MS, setTimer = setTimeout, failures = saveFailures, maxAttempts = MAX_SAVE_ATTEMPTS,
  log = console.log, warn = console.warn, error = console.error,
} = {}) {
  if (!msg) return;
  const text = msg.content.toString();
  let event;
  try {
    event = normalize(JSON.parse(text), text);
  } catch {
    event = null;
  }
  if (!event) {
    warn(`⚠️  Mensaje inválido descartado (${msg.content.length} bytes).`);
    safeAck(channel, msg);
    return;
  }
  try {
    await save(event);
    failures.delete(event.eventId);
    safeAck(channel, msg);
    log(eventLogLine(event));
  } catch (err) {
    const attempts = noteFailure(failures, event.eventId);
    if (attempts >= maxAttempts) {
      failures.delete(event.eventId);
      error(`❌ Evento ${logSafe(event.eventId)} (${logSafe(event.type)}) descartado tras ${attempts} intentos fallidos: ${logSafe(err.message, 200)}`);
      safeNack(channel, msg, false); // sin reencolar: sin esto un mensaje venenoso se reintentaría para siempre
      return;
    }
    error(`❌ No se pudo guardar ${logSafe(event.type)} (intento ${attempts}/${maxAttempts}; se reintentará):`, logSafe(err.message, 200));
    setTimer(() => safeNack(channel, msg, true), retryMs);
  }
}

// ---------- Conexión ----------
// Un solo bucle de reconexión: `starting` evita arranques simultáneos y `retryTimer` un segundo reintento
// programado, venga el fallo del connect, del cierre de la conexión o del cierre del canal.
// Todo lo externo es inyectable para probarlo sin broker.
export function createConsumer({
  connect = amqp.connect, queue = QUEUE, prefetch = PREFETCH, retryMs = RETRY_MS, handle = handleMessage,
  setTimer = setTimeout, url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  log = console.log, warn = console.warn, error = console.error,
} = {}) {
  let starting = false;
  let retryTimer = null;
  let current = null; // conexión en uso: los eventos de una conexión vieja no disparan reintentos

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimer(() => { retryTimer = null; void start(); }, retryMs);
  }

  const closeQuietly = conn => { Promise.resolve().then(() => conn.close()).catch(() => {}); };

  async function start() {
    if (starting || current) return;
    starting = true;
    let conn = null;
    try {
      conn = await connect(url);
      conn.on('error', err => error('RabbitMQ (conexión):', logSafe(err?.message, 200)));
      conn.on('close', () => {
        if (current !== conn) return; // cierre de una conexión ya descartada
        current = null;
        warn(`⚠️  Conexión con RabbitMQ cerrada. Reintento en ${retryMs / 1000}s.`);
        scheduleRetry();
      });
      const channel = await conn.createChannel();
      channel.on('error', err => error('RabbitMQ (canal):', logSafe(err?.message, 200)));
      channel.on('close', () => {
        if (current !== conn) return;
        current = null;
        warn(`⚠️  Canal de RabbitMQ cerrado. Reintento en ${retryMs / 1000}s.`);
        closeQuietly(conn);
        scheduleRetry();
      });
      await channel.assertQueue(queue, { durable: true });
      await channel.prefetch(prefetch);
      current = conn;
      await channel.consume(queue, msg => handle(channel, msg)); // sin noAck: ack/nack manual
      log(`📥 Consumiendo la cola "${queue}" hacia ScyllaDB (prefetch ${prefetch}).`);
    } catch (err) {
      warn(`⚠️  RabbitMQ no disponible (${logSafe(err?.message || err?.code, 200)}). Reintento en ${retryMs / 1000}s.`);
      current = null;
      if (conn) closeQuietly(conn); // no dejar la conexión a medias abierta
      scheduleRetry();
    } finally {
      starting = false;
    }
  }

  return { start };
}

const consumer = createConsumer();
export const startConsumer = () => consumer.start();
