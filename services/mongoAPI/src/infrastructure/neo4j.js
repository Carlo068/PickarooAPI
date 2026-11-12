// ============================================================
// NEO4J — grafo de roles, permisos, sucursales y menús (RBAC)
//
// Se conecta sin bloquear el arranque: si Neo4j no responde, reintenta
// en segundo plano. Mientras tanto el login funciona con permisos vacíos
// (nivel cliente): falla cerrado, nadie gana privilegios sin el grafo.
// ============================================================

import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'pickaroo123'; // el de docker-compose.yml

export const neo4jDriver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  maxConnectionPoolSize: 50,
  connectionTimeout: 5000,
  connectionAcquisitionTimeout: 5000,
});

let ready = false;
let retryTimer = null;
let onReadyHook = null;
export const isNeo4jReady = () => ready;

const RETRY_MS = 10_000;

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; initNeo4j(); }, RETRY_MS);
  retryTimer.unref();
}

// Conecta y, cada vez que lo logra, ejecuta `onReady` (crear catálogo, sincronizar sucursales).
export async function initNeo4j(onReady) {
  if (onReady) onReadyHook = onReady;
  try {
    await withTimeout(neo4jDriver.verifyConnectivity());
    ready = true;
    console.log('🌿 Neo4j (roles y permisos) conectado.');
    await onReadyHook?.();
  } catch (err) {
    ready = false;
    console.warn(`⚠️  Neo4j no disponible (${err.message}). Reintento en ${RETRY_MS / 1000}s; mientras tanto el login no otorga permisos.`);
    scheduleRetry();
  }
}

// Un servidor congelado no rechaza la conexión: sin este límite un login podría
// quedarse esperando. Pasado el tiempo se trata como Neo4j no disponible.
const QUERY_TIMEOUT_MS = parseInt(process.env.NEO4J_QUERY_TIMEOUT_MS) || 5000;

function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Neo4j no respondió a tiempo.'), { code: 'ServiceUnavailable' })), QUERY_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Ejecuta Cypher parametrizado. Si falla la conexión marca el grafo como no disponible
// y vuelve a intentarlo en segundo plano.
async function run(query, params, routing) {
  try {
    const { records } = await withTimeout(neo4jDriver.executeQuery(query, params, { routing, database: process.env.NEO4J_DATABASE || 'neo4j' }));
    return records.map(r => r.toObject());
  } catch (err) {
    if (err.code === 'ServiceUnavailable' || err.code === 'SessionExpired') {
      ready = false;
      scheduleRetry();
    }
    throw err;
  }
}

export const readQuery = (query, params = {}) => run(query, params, neo4j.routing.READ);
export const writeQuery = (query, params = {}) => run(query, params, neo4j.routing.WRITE);

// Enteros de 64 bits de Neo4j → número de JS.
export const toNumber = v => (neo4j.isInt(v) ? v.toNumber() : Number(v ?? 0));

export async function closeNeo4j() {
  await neo4jDriver.close();
}
