// ============================================================
// auditAPI — subgrafo de auditoría
//
// RabbitMQ ("pickaroo.events") ──► consumidor ──► ScyllaDB
// GraphQL (vía gateway) ──► consultas de la bitácora (permiso audit:view)
//
// mongoAPI publica los eventos; este servicio es el único que escribe y lee
// ScyllaDB.
// ============================================================

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuración propia y, como respaldo, la de mongoAPI: JWT_SECRET y
// REDIS_URL deben ser los mismos en los dos servicios.
dotenv.config({ path: [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', 'mongoAPI', '.env')] });

const { initScylla, isScyllaReady, eventsByDay, eventsByActor, eventsByTarget } = await import('./scylla.js');
const { startConsumer } = await import('./consumer.js');
const { authContext, connectRedis, requireAuditView } = await import('./auth.js');

const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

const CATEGORIES = ['SECURITY', 'ADMIN', 'CATALOG', 'ORDER'];
const today = () => new Date().toISOString().slice(0, 10);
const clampLimit = limit => Math.min(Math.max(limit ?? 50, 1), 500);

function assertDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
    throw new Error('El día debe tener el formato YYYY-MM-DD.');
  }
  return day;
}

const resolvers = {
  AuditEvent: {
    actor: e => (e.actorId && e.actorId !== 'ANONYMOUS' && /^[0-9a-f]{24}$/i.test(e.actorId) ? { __typename: 'User', id: e.actorId } : null),
  },

  Query: {
    auditEvents: async (_, { category, day, type, limit }, ctx) => {
      requireAuditView(ctx);
      const n = clampLimit(limit);
      // El filtro por tipo se aplica en memoria: la partición es (categoría, día).
      const rows = await eventsByDay(category, assertDay(day ?? today()), type ? 5000 : n);
      return (type ? rows.filter(r => r.type === type) : rows).slice(0, n);
    },

    auditByActor: (_, { actorId, limit }, ctx) => {
      requireAuditView(ctx);
      return eventsByActor(actorId, clampLimit(limit));
    },

    auditByTarget: (_, { targetType, targetId, limit }, ctx) => {
      requireAuditView(ctx);
      return eventsByTarget(targetType, targetId, clampLimit(limit));
    },

    auditSummary: async (_, { day }, ctx) => {
      requireAuditView(ctx);
      const d = assertDay(day ?? today());
      const counts = new Map();
      for (const category of CATEGORIES) {
        for (const e of await eventsByDay(category, d, 100_000)) {
          const key = `${category}|${e.type}`;
          const c = counts.get(key) ?? { category, type: e.type, total: 0, failures: 0 };
          c.total += 1;
          if (!e.success) c.failures += 1;
          counts.set(key, c);
        }
      }
      return [...counts.values()].sort((a, b) => b.total - a.total);
    },
  },
};

// Arranque: Redis (sesiones), ScyllaDB (con reintentos) y, cuando ScyllaDB
// está listo, el consumidor de RabbitMQ.
connectRedis();
let consuming = false;
initScylla(async () => {
  if (consuming) return;
  consuming = true;
  await startConsumer();
});

const server = new ApolloServer({
  schema: buildSubgraphSchema([{ typeDefs, resolvers }]),
  formatError: formatted => {
    const authFailure = ['UNAUTHENTICATED', 'FORBIDDEN'].includes(formatted.extensions?.code);
    if (!isScyllaReady() && formatted.path && !authFailure) {
      return { ...formatted, message: 'La bitácora (ScyllaDB) aún no está disponible.', extensions: { code: 'SERVICE_UNAVAILABLE' } };
    }
    return formatted;
  },
});

const port = parseInt(process.env.PORT_AUDITORIA) || 4003;
const { url } = await startStandaloneServer(server, { listen: { port }, context: authContext });
console.log(`📊 Subgrafo de Auditoría (ScyllaDB + consumidor RabbitMQ) listo en: ${url}`);
