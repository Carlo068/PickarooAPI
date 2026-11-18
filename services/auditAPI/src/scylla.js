// ============================================================
// SCYLLADB — bitácora de auditoría inmutable
//
// Diseño por consulta (wide-column): cada evento se escribe en cuatro tablas,
// una por cada pregunta que se le hace a la bitácora.
//
//   events_by_day     PK ((category, day))       "eventos de seguridad de hoy"
//   events_by_actor   PK ((actor_id))            "qué hizo este usuario"
//   events_by_target  PK ((target_type, target_id)) "historia de la orden X",
//                                                   "historial de precios del producto Y"
//   logs_eventos      PK ((fecha_dia, tipo_evento)) "eventos de un tipo en un día"
//                                                   (la tabla que se consulta con cqlsh)
//
// Todas ordenan de lo más reciente a lo más antiguo, sin ordenar en memoria. El
// event_id lo genera el productor, así que un mensaje reentregado por RabbitMQ
// reescribe la misma fila (escrituras idempotentes); en logs_eventos el timeuuid
// se deriva del eventId (ver eventTimeUuid) para conservar esa propiedad.
// ============================================================

import { createHash } from 'crypto';
import cassandra from 'cassandra-driver';
import { GraphQLError } from 'graphql';
import { scyllaConfig } from './scylla-options.js';

const { LocalDate, TimeUuid } = cassandra.types;

const config = scyllaConfig();
export const KEYSPACE = config.keyspace;

const COLUMNS = `
  occurred_at timestamp,
  event_id uuid,
  type text,
  category text,
  actor_id text,
  actor_role text,
  target_type text,
  target_id text,
  success boolean,
  reason text,
  ip text,
  user_agent text,
  metadata text`;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS events_by_day (
     day date, ${COLUMNS},
     PRIMARY KEY ((category, day), occurred_at, event_id)
   ) WITH CLUSTERING ORDER BY (occurred_at DESC, event_id ASC)`,
  `CREATE TABLE IF NOT EXISTS events_by_actor (
     ${COLUMNS},
     PRIMARY KEY ((actor_id), occurred_at, event_id)
   ) WITH CLUSTERING ORDER BY (occurred_at DESC, event_id ASC)`,
  `CREATE TABLE IF NOT EXISTS events_by_target (
     ${COLUMNS},
     PRIMARY KEY ((target_type, target_id), occurred_at, event_id)
   ) WITH CLUSTERING ORDER BY (occurred_at DESC, event_id ASC)`,
  // Query-First: "eventos de un tipo en un día". La partición (fecha_dia, tipo_evento) acota su
  // tamaño (un tipo, un día) y dentro de ella el orden físico DESC deja lo más reciente primero.
  `CREATE TABLE IF NOT EXISTS logs_eventos (
     fecha_dia date,
     tipo_evento text,
     timestamp timestamp,
     evento_id timeuuid,
     category text,
     actor_id text,
     actor_role text,
     target_type text,
     target_id text,
     success boolean,
     reason text,
     ip text,
     user_agent text,
     metadata text,
     PRIMARY KEY ((fecha_dia, tipo_evento), timestamp, evento_id)
   ) WITH CLUSTERING ORDER BY (timestamp DESC, evento_id DESC)`,
];

let client = null;
export const isScyllaReady = () => client !== null;

const RETRY_MS = 5000;

// ScyllaDB tarda en arrancar: se reintenta hasta conectar y luego se avisa con onReady.
export async function initScylla(onReady) {
  const bootstrap = new cassandra.Client(config.clientOptions);
  try {
    if (config.createKeyspace) {
      await bootstrap.connect();
      await bootstrap.execute(config.createKeyspaceCql);
    }
    await bootstrap.shutdown();

    const audit = new cassandra.Client({ ...config.clientOptions, keyspace: KEYSPACE });
    await audit.connect();
    for (const ddl of TABLES) await audit.execute(ddl);
    client = audit;
    console.log(`🗄️  ScyllaDB conectado. Keyspace "${KEYSPACE}" y tablas de auditoría listos.`);
    await onReady?.();
  } catch (err) {
    await bootstrap.shutdown().catch(() => {});
    console.warn(`⚠️  ScyllaDB no disponible (${err.message}). Reintento en ${RETRY_MS / 1000}s; los eventos esperan en RabbitMQ.`);
    setTimeout(() => initScylla(onReady), RETRY_MS);
  }
}

const INSERT_COLUMNS = 'occurred_at, event_id, type, category, actor_id, actor_role, target_type, target_id, success, reason, ip, user_agent, metadata';
const INSERT_MARKS = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

const LOGS_EVENTOS_COLUMNS = 'fecha_dia, tipo_evento, timestamp, evento_id, category, actor_id, actor_role, target_type, target_id, success, reason, ip, user_agent, metadata';
const LOGS_EVENTOS_MARKS = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

const utcDay = date => LocalDate.fromString(date.toISOString().slice(0, 10));

// timeuuid determinista: la hora es la del evento; nodeId, clockId y ticks salen del sha1 del eventId.
// Así un mensaje reentregado produce el mismo evento_id y reescribe la misma fila en vez de duplicarla.
export function eventTimeUuid(eventId, occurredAt) {
  const h = createHash('sha1').update(String(eventId)).digest();
  return TimeUuid.fromDate(occurredAt, h.readUInt16BE(8) % 10000, h.subarray(0, 6), h.subarray(6, 8));
}

// Valores de la fila de logs_eventos, en el orden de LOGS_EVENTOS_COLUMNS. Función pura: se prueba sin ScyllaDB.
export function buildLogsEventosParams(e) {
  const occurredAt = new Date(e.occurredAt);
  return [
    utcDay(occurredAt), e.type, occurredAt, eventTimeUuid(e.eventId, occurredAt), e.category, e.actorId, e.actorRole,
    e.targetType, e.targetId, e.success, e.reason, e.ip, e.userAgent, JSON.stringify(e.metadata ?? {}),
  ];
}

// Escribe el evento en las tablas que le corresponden (batch con log: o todas o ninguna).
// Todo va con prepare: true (sentencias preparadas): el servidor las analiza una sola vez.
export async function saveEvent(e) {
  const occurredAt = new Date(e.occurredAt);
  const values = [
    occurredAt, e.eventId, e.type, e.category, e.actorId, e.actorRole, e.targetType, e.targetId,
    e.success, e.reason, e.ip, e.userAgent, JSON.stringify(e.metadata ?? {}),
  ];
  const queries = [{
    query: `INSERT INTO events_by_day (day, ${INSERT_COLUMNS}) VALUES (?, ${INSERT_MARKS})`,
    params: [utcDay(occurredAt), ...values], // día en UTC
  }, {
    query: `INSERT INTO logs_eventos (${LOGS_EVENTOS_COLUMNS}) VALUES (${LOGS_EVENTOS_MARKS})`,
    params: buildLogsEventosParams(e),
  }];
  // Sin usuario no hay partición útil (y crecería sin límite): solo va por día.
  if (e.actorId && e.actorId !== 'ANONYMOUS') {
    queries.push({ query: `INSERT INTO events_by_actor (${INSERT_COLUMNS}) VALUES (${INSERT_MARKS})`, params: values });
  }
  if (e.targetType && e.targetId) {
    queries.push({ query: `INSERT INTO events_by_target (${INSERT_COLUMNS}) VALUES (${INSERT_MARKS})`, params: values });
  }
  await client.batch(queries, { prepare: true, logged: true });
}

const toEvent = row => ({
  id: row.event_id.toString(),
  type: row.type,
  category: row.category,
  actorId: row.actor_id,
  actorRole: row.actor_role,
  targetType: row.target_type,
  targetId: row.target_id,
  success: row.success,
  reason: row.reason,
  ip: row.ip,
  userAgent: row.user_agent,
  metadata: row.metadata,
  occurredAt: row.occurred_at.toISOString(),
});

async function select(query, params) {
  if (!client) throw new GraphQLError('La bitácora (ScyllaDB) no está disponible.', { extensions: { code: 'SERVICE_UNAVAILABLE', service: 'AUDIT_LOG' } });
  const result = await client.execute(query, params, { prepare: true });
  return result.rows.map(toEvent);
}

export const eventsByDay = (category, day, limit) =>
  select('SELECT * FROM events_by_day WHERE category = ? AND day = ? LIMIT ?', [category, LocalDate.fromString(day), limit]);

export const eventsByActor = (actorId, limit) =>
  select('SELECT * FROM events_by_actor WHERE actor_id = ? LIMIT ?', [actorId, limit]);

export const eventsByTarget = (targetType, targetId, limit) =>
  select('SELECT * FROM events_by_target WHERE target_type = ? AND target_id = ? LIMIT ?', [targetType, targetId, limit]);

export async function closeScylla() {
  await client?.shutdown();
}
