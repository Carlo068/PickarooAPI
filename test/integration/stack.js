// ============================================================
// PILA DE PRUEBAS DE INTEGRACIÓN
//
// Arranca una copia propia de la API (mongoAPI, auditAPI y gateway) contra
// los mismos contenedores del Compose, pero con:
//   · su propia base de MongoDB (pickaroodb_it), sembrada con SEED=true,
//   · un JWT_SECRET recién generado (los tokens del dev no sirven aquí),
//   · otros puertos (5001, 5003 y 5000 por omisión).
// Nunca arranca ni detiene contenedores y nunca escribe en la base del dev.
//
// Lo que la corrida crea fuera de su base se borra al final, por id:
//   Neo4j  (:User {id}) y (:Store {id}) con los _id de pickaroodb_it.
//   Redis  (base lógica 1, no la 0 del dev) session:<jti>, user:<id>:sessions,
//          cart:<id>, user:<id>:orders:recent, User:<id>, Product:<id>, las
//          quote:<uuid> de sus sucursales, driver:loc:<orderId> de sus órdenes y los refresh tokens de sus usuarios
//          (user:<id>:refresh-families, refresh-family:<familyId>[:sessions],
//          refresh:<hash>, refresh:spent:<hash> y refresh:grace:<hash>).
// Las filas de ScyllaDB y los mensajes de RabbitMQ no se pueden borrar.
// ============================================================

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { createRequire } from 'module';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Las dependencias son las de mongoAPI (mongoose, neo4j-driver, redis).
const require = createRequire(path.join(ROOT, 'services', 'mongoAPI', 'package.json'));
const mongoose = require('mongoose');
const neo4j = require('neo4j-driver');
const { createClient } = require('redis');

const env = process.env;
const int = (v, fallback) => parseInt(v, 10) || fallback;

// ---------- Configuración ----------
function mongoCredentials() {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const read = key => compose.match(new RegExp(`${key}:\\s*["']?([^"'\\r\\n#]+?)["']?\\s*(#.*)?$`, 'm'))?.[1]?.trim();
  return {
    user: read('MONGO_INITDB_ROOT_USERNAME') || 'admin',
    password: env.IT_MONGO_PASSWORD ?? read('MONGO_INITDB_ROOT_PASSWORD') ?? '',
  };
}

export function loadConfig() {
  const { user, password } = mongoCredentials();
  const mongoUri = db => `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:27017/${db}?authSource=admin`;
  const config = {
    ports: { gateway: int(env.IT_GATEWAY_PORT, 5000), mongo: int(env.IT_MONGOAPI_PORT, 5001), audit: int(env.IT_AUDITAPI_PORT, 5003) },
    db: 'pickaroodb_it',
    devDb: 'pickaroodb',
    devGatewayUrl: 'http://localhost:4000/',
    mongoUri,
    password,
    jwtSecret: randomBytes(48).toString('hex'),
    refreshTtlSeconds: 10,
    // Ventana de gracia corta: las pruebas de reutilización esperan a que pase.
    refreshGraceSeconds: 2,
    // Distinto del de 600 s por omisión: así la prueba de ubicación comprueba que el TTL de la clave sale de DRIVER_LOCATION_TTL_SECONDS.
    driverLocationTtlSeconds: 120,
    // Base lógica propia en el mismo Redis: al conectar, mongoAPI vacía Product:*, User:*
    // y user:*:orders:recent de SU base; así no vacía los cachés del dev (base 0).
    redisDb: env.IT_REDIS_DB ? parseInt(env.IT_REDIS_DB, 10) : 1,
    neo4j: { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'pickaroo123' }, // los del Compose
    rabbitUrl: 'amqp://guest:guest@localhost:5672',
    queue: 'pickaroo.events',
    logFile: path.join(os.tmpdir(), `pickaroo-it-${Date.now()}.log`),
    jtiFile: path.join(os.tmpdir(), `pickaroo-it-${Date.now()}.jti`),
  };
  if ([4000, 4001, 4003].some(p => Object.values(config.ports).includes(p))) throw new Error('Los puertos de prueba no pueden ser los del dev (4000, 4001, 4003).');
  if (config.redisDb === 0) throw new Error('La base lógica de Redis de las pruebas no puede ser la del dev (0).');
  config.redisUrl = `redis://default:pickaroo123@localhost:6379/${config.redisDb}`;
  config.gatewayUrl = `http://localhost:${config.ports.gateway}/`;
  return config;
}

// Nunca se imprime la contraseña de MongoDB, ni aunque un proceso hijo la muestre.
export function redactor(config) {
  const secrets = [config.password, encodeURIComponent(config.password), config.jwtSecret].filter(s => s && s.length >= 4);
  return text => secrets.reduce((t, s) => t.split(s).join('***'), String(text));
}

// ---------- ¿Está arriba el Compose? ----------
const SERVICES = [
  { name: 'MongoDB', port: 27017 },
  { name: 'Redis', port: 6379 },
  { name: 'Neo4j', port: 7687 },
  { name: 'RabbitMQ', port: 5672 },
  { name: 'ScyllaDB', port: 9042 },
];

const canConnect = (port, host = 'localhost', timeout = 1500) => new Promise(resolve => {
  const socket = net.connect({ port, host });
  const done = ok => { socket.destroy(); resolve(ok); };
  socket.setTimeout(timeout, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

// El primer servicio que no responde, o null si están todos.
export async function unreachableService() {
  for (const s of SERVICES) if (!(await canConnect(s.port))) return s;
  return null;
}

export async function busyPorts(config) {
  const busy = [];
  for (const p of Object.values(config.ports)) if (await canConnect(p)) busy.push(p);
  return busy;
}

// ---------- Conexiones de la propia herramienta ----------
async function withMongo(uri, fn) {
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  try { return await fn(conn.db); } finally { await conn.close(); }
}

export async function withNeo4j(config, fn) {
  const driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password));
  try { return await fn((query, params) => driver.executeQuery(query, params, { database: 'neo4j' })); } finally { await driver.close(); }
}

async function withRedis(config, fn) {
  const client = createClient({ url: config.redisUrl });
  client.on('error', () => {});
  await client.connect();
  try { return await fn(client); } finally { await client.quit(); }
}

// ---------- Aislamiento: lo que se compara antes y después ----------
async function gatewayAnswers(url, attempts = 1) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{ __typename }"}', signal: AbortSignal.timeout(5000) });
      if ((await res.json())?.data?.__typename === 'Query') return true;
    } catch { /* no responde (todavía) */ }
    if (i + 1 < attempts) await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// Solo lectura sobre la base del dev: cuántos documentos hay por colección.
export async function isolationSnapshot(config) {
  const counts = await withMongo(config.mongoUri(config.devDb), async db => {
    const out = {};
    for (const { name } of (await db.listCollections({}, { nameOnly: true }).toArray()).sort((a, b) => a.name.localeCompare(b.name))) {
      out[name] = await db.collection(name).countDocuments();
    }
    return out;
  });
  const stores = await withNeo4j(config, async q => (await q('MATCH (s:Store) RETURN count(s) AS n')).records[0].get('n').toNumber());
  return { devGateway: await gatewayAnswers(config.devGatewayUrl, 3), counts, neo4jStores: stores };
}

export function compareIsolation(before, after) {
  const problems = [];
  if (before.devGateway && !after.devGateway) problems.push('el gateway del dev dejó de responder');
  const names = new Set([...Object.keys(before.counts), ...Object.keys(after.counts)]);
  for (const n of names) {
    if (before.counts[n] !== after.counts[n]) problems.push(`${n}: ${before.counts[n] ?? 0} → ${after.counts[n] ?? 0} documentos`);
  }
  if (before.neo4jStores !== after.neo4jStores) problems.push(`Neo4j: ${before.neo4jStores} → ${after.neo4jStores} sucursales`);
  return problems;
}

// ---------- Limpieza (también de una corrida anterior interrumpida) ----------
export async function cleanup(config) {
  const ids = await withMongo(config.mongoUri(config.db), async db => {
    const list = async name => (await db.collection(name).find({}, { projection: { _id: 1 } }).toArray()).map(d => String(d._id));
    return { users: await list('users'), stores: await list('stores'), products: await list('products'), orders: await list('orders') };
  });

  const jtis = new Set(fs.existsSync(config.jtiFile) ? fs.readFileSync(config.jtiFile, 'utf8').split(/\s+/).filter(Boolean) : []);
  const redisKeys = await withRedis(config, async redis => {
    const users = new Set(ids.users);
    const keys = [];
    // Refresh tokens, marcas de usado y registros de gracia (refresh:<hash>, refresh:spent:<hash>,
    // refresh:grace:<hash>): se reconocen por su userId.
    const families = new Set();
    for await (const batch of redis.scanIterator({ MATCH: 'refresh:*', COUNT: 500 })) {
      for (const key of [batch].flat()) {
        try {
          const value = JSON.parse(await redis.get(key));
          if (users.has(value?.userId)) { keys.push(key); families.add(value.familyId); }
        } catch { /* otra forma de valor: no es nuestra */ }
      }
    }
    for (const id of ids.users) for (const familyId of await redis.sMembers(`user:${id}:refresh-families`)) families.add(familyId);
    for (const familyId of families) for (const jti of await redis.sMembers(`refresh-family:${familyId}:sessions`)) jtis.add(jti);
    for (const id of ids.users) for (const jti of await redis.sMembers(`user:${id}:sessions`)) jtis.add(jti);
    keys.push(
      ...[...jtis].map(jti => `session:${jti}`),
      ...[...families].flatMap(familyId => [`refresh-family:${familyId}`, `refresh-family:${familyId}:sessions`]),
      ...ids.users.flatMap(id => [`user:${id}:sessions`, `user:${id}:refresh-families`, `cart:${id}`, `user:${id}:orders:recent`, `User:${id}`]),
      ...ids.products.map(id => `Product:${id}`),
      ...ids.orders.map(id => `driver:loc:${id}`),
    );
    // Cotizaciones: se reconocen por la sucursal de la base de pruebas.
    const stores = new Set(ids.stores);
    for await (const batch of redis.scanIterator({ MATCH: 'quote:*', COUNT: 500 })) {
      for (const key of [batch].flat()) {
        try {
          if (stores.has(JSON.parse(await redis.get(key))?.storeId)) keys.push(key);
        } catch { /* otra forma de valor: no es nuestra */ }
      }
    }
    let removed = 0;
    for (let i = 0; i < keys.length; i += 500) removed += await redis.del(keys.slice(i, i + 500));
    return { removed, left: await redis.dbSize() };
  });

  const graph = await withNeo4j(config, async q => {
    const users = await q('MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u RETURN count(*) AS n', { ids: ids.users });
    const stores = await q('MATCH (s:Store) WHERE s.id IN $ids DETACH DELETE s RETURN count(*) AS n', { ids: ids.stores });
    return { users: users.records[0].get('n').toNumber(), stores: stores.records[0].get('n').toNumber() };
  });

  await withMongo(config.mongoUri(config.db), db => db.dropDatabase());
  fs.rmSync(config.jtiFile, { force: true });
  return { redisKeys: redisKeys.removed, redisKeysLeft: redisKeys.left, neo4jUsers: graph.users, neo4jStores: graph.stores, mongo: ids };
}

// ---------- Procesos hijos ----------
// dotenv no pisa variables ya definidas; DOTENV_CONFIG_PATH apunta a un archivo
// inexistente para que mongoAPI y el gateway no lean los .env del dev.
function childEnv(config, extra) {
  const base = { ...env };
  for (const k of Object.keys(base)) if (/^(SEED_|CACHE_|MONGODB_|NEO4J_|REDIS_|REFRESH_|DRIVER_|RABBITMQ_|SCYLLADB_|JWT_|PORT_|IT_)/.test(k)) delete base[k];
  return {
    ...base,
    DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'pickaroo-it-no-dotenv'),
    PORT_GATEWAY: String(config.ports.gateway),
    PORT_CAMPAMENTOS: String(config.ports.mongo),
    PORT_AUDITORIA: String(config.ports.audit),
    JWT_SECRET: config.jwtSecret,
    JWT_TTL_SECONDS: '3600',
    // Corto a propósito: la prueba de vencimiento espera a que caduque (refresh.test.js).
    REFRESH_TTL_SECONDS: String(config.refreshTtlSeconds),
    REFRESH_REUSE_GRACE_SECONDS: String(config.refreshGraceSeconds),
    DRIVER_LOCATION_TTL_SECONDS: String(config.driverLocationTtlSeconds),
    REDIS_URL: config.redisUrl,
    RABBITMQ_URL: config.rabbitUrl,
    RABBITMQ_QUEUE: config.queue,
    ...extra,
  };
}

export function startStack(config, log = console.log) {
  const redact = redactor(config);
  const logStream = fs.createWriteStream(config.logFile);
  const children = [];

  function launch(name, script, extraEnv) {
    const child = spawn(process.execPath, [path.join(ROOT, script)], {
      cwd: path.dirname(path.join(ROOT, script)),
      env: childEnv(config, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const state = { name, child, lines: [], exited: null, waiters: [] };
    const onData = chunk => {
      for (const line of redact(chunk).split(/\r?\n/).filter(Boolean)) {
        logStream.write(`[${name}] ${line}\n`);
        state.lines.push(line);
        if (state.lines.length > 80) state.lines.shift();
        for (const w of state.waiters) if (w.pattern.test(line)) w.resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      state.exited = code ?? 'signal';
      for (const w of state.waiters) w.reject(new Error(`${name} terminó (código ${state.exited}) antes de estar listo.`));
    });
    children.push(state);
    return state;
  }

  const waitForLine = (state, pattern, timeoutMs) => new Promise((resolve, reject) => {
    if (state.lines.some(l => pattern.test(l))) return resolve();
    if (state.exited !== null) return reject(new Error(`${state.name} terminó (código ${state.exited}).`));
    const timer = setTimeout(() => reject(new Error(`${state.name}: no apareció ${pattern} en ${timeoutMs / 1000}s.`)), timeoutMs);
    state.waiters.push({ pattern, resolve: () => { clearTimeout(timer); resolve(); }, reject: err => { clearTimeout(timer); reject(err); } });
  });

  async function waitForGateway(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await gatewayAnswers(config.gatewayUrl)) return;
      if (children.find(c => c.name === 'gateway')?.exited !== null) throw new Error('El gateway de pruebas terminó antes de estar listo.');
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`El gateway de pruebas no respondió en ${timeoutMs / 1000}s.`);
  }

  async function ready() {
    const api = launch('mongoAPI', 'services/mongoAPI/src/index.js', {
      MONGODB_URI: config.mongoUri(config.db),
      SEED: 'true',
      NEO4J_URI: config.neo4j.uri,
      NEO4J_USER: config.neo4j.user,
      NEO4J_PASSWORD: config.neo4j.password,
    });
    const audit = launch('auditAPI', 'services/auditAPI/src/index.js', {
      SCYLLADB_CONTACT_POINTS: '127.0.0.1',
      SCYLLADB_PORT: '9042',
      SCYLLADB_KEYSPACE: 'pickaroo_audit',
    });
    await Promise.all([
      waitForLine(api, /Seed OK/, 90_000),
      waitForLine(audit, /Consumiendo la cola/, 90_000),
    ]);
    launch('gateway', 'gateway/index.js', {});
    await waitForGateway(60_000);
    log(`stack ready: gateway ${config.gatewayUrl} (mongoAPI :${config.ports.mongo}, auditAPI :${config.ports.audit}, MongoDB ${config.db})`);
  }

  // Mata a los hijos (son procesos node directos, sin nietos) y espera a que terminen.
  async function stop() {
    await Promise.all(children.map(c => new Promise(resolve => {
      if (c.exited !== null) return resolve();
      c.child.once('exit', () => resolve());
      c.child.kill();
      setTimeout(() => { if (c.exited === null) c.child.kill('SIGKILL'); }, 5000).unref();
      setTimeout(resolve, 8000).unref();
    })));
    await new Promise(r => logStream.end(r));
  }

  // Sin esperar: último recurso en process.on('exit').
  const killNow = () => { for (const c of children) if (c.exited === null) c.child.kill(); };

  const tail = () => children.map(c => `--- ${c.name} (últimas líneas) ---\n${c.lines.slice(-25).join('\n')}`).join('\n');

  return { ready, stop, killNow, tail };
}
