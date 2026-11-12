// ============================================================
// SCYLLADB — bitácora de auditoría inmutable
//
// Diseño por consulta (wide-column): cada evento se escribe en tres tablas,
// una por cada pregunta que se le hace a la bitácora.
//
//   events_by_day     PK ((category, day))       "eventos de seguridad de hoy"
//   events_by_actor   PK ((actor_id))            "qué hizo este usuario"
//   events_by_target  PK ((target_type, target_id)) "historia de la orden X",
//                                                   "historial de precios del producto Y"
//
// Todas ordenan por occurred_at DESC: lo más reciente primero sin ordenar en
// memoria. El event_id lo genera el productor, así que un mensaje reentregado
// por RabbitMQ reescribe la misma fila (escrituras idempotentes).
// ============================================================

import cassandra from 'cassandra-driver';

const { LocalDate } = cassandra.types;

const contactPoints = (process.env.SCYLLADB_CONTACT_POINTS || '127.0.0.1').split(',').map(s => s.trim());
const port = parseInt(process.env.SCYLLADB_PORT) || 9042;
const localDataCenter = process.env.SCYLLADB_DATACENTER || 'datacenter1';
export const KEYSPACE = process.env.SCYLLADB_KEYSPACE || 'pickaroo_audit';

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
];

let client = null;
export const isScyllaReady = () => client !== null;

const RETRY_MS = 5000;

// ScyllaDB tarda en arrancar: se reintenta hasta conectar y luego se avisa con onReady.
export async function initScylla(onReady) {
  const bootstrap = new cassandra.Client({ contactPoints, localDataCenter, protocolOptions: { port } });
  try {
    await bootstrap.connect();
    await bootstrap.execute(`CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`);
    await bootstrap.shutdown();

    const audit = new cassandra.Client({ contactPoints, localDataCenter, keyspace: KEYSPACE, protocolOptions: { port } });
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

// Escribe el evento en las tablas que le corresponden (batch con log: o todas o ninguna).
export async function saveEvent(e) {
  const occurredAt = new Date(e.occurredAt);
  const values = [
    occurredAt, e.eventId, e.type, e.category, e.actorId, e.actorRole, e.targetType, e.targetId,
    e.success, e.reason, e.ip, e.userAgent, JSON.stringify(e.metadata ?? {}),
  ];
  const queries = [{
    query: `INSERT INTO events_by_day (day, ${INSERT_COLUMNS}) VALUES (?, ${INSERT_MARKS})`,
    params: [LocalDate.fromString(occurredAt.toISOString().slice(0, 10)), ...values], // día en UTC
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
  if (!client) throw new Error('La bitácora (ScyllaDB) no está disponible.');
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
