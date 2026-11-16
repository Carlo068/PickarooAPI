// ============================================================
// npm run test:integration
//
// 1. Si el Compose no está arriba, se omite con un mensaje y sale con 0.
// 2. Toma la "foto" de aislamiento del dev (gateway :4000, conteos de
//    pickaroodb, sucursales en Neo4j) y limpia restos de una corrida anterior.
// 3. Arranca su propia API (stack.js), corre los *.test.js de esta carpeta
//    con node:test a través del gateway de pruebas y, pase lo que pase
//    (fallo, excepción o Ctrl+C), mata a sus hijos y limpia.
// 4. Compara la foto de aislamiento: si el dev cambió, la corrida falla.
// ============================================================

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, redactor, unreachableService, busyPorts, isolationSnapshot, compareIsolation, cleanup, startStack } from './stack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const started = Date.now();
const seconds = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const down = await unreachableService();
if (down) {
  console.log(`integration tests skipped: ${down.name} not reachable on localhost:${down.port}`);
  process.exit(0);
}

const config = loadConfig();
const redact = redactor(config);
const log = msg => console.log(`[integration] ${redact(msg)}`);

const busy = await busyPorts(config);
if (busy.length) {
  log(`ports already in use: ${busy.join(', ')} (set IT_GATEWAY_PORT, IT_MONGOAPI_PORT or IT_AUDITAPI_PORT)`);
  process.exit(1);
}

let stack = null;
let testRun = null;
let finishing = null;

// Una sola vez: matar hijos, limpiar Neo4j/Redis/Mongo y comparar el aislamiento.
function finish(code, before) {
  finishing ??= (async () => {
    if (testRun && testRun.exitCode === null) testRun.kill();
    if (stack) await stack.stop();
    try {
      const removed = await cleanup(config);
      log(`cleanup: dropped ${config.db}; removed ${removed.redisKeys} keys from Redis db ${config.redisDb} (${removed.redisKeysLeft} left), ${removed.neo4jUsers} Neo4j users and ${removed.neo4jStores} Neo4j stores`);
    } catch (err) {
      log(`cleanup failed: ${err.message}`);
      code ||= 1;
    }
    if (before) {
      const after = await isolationSnapshot(config);
      const problems = compareIsolation(before, after);
      const counts = Object.entries(after.counts).map(([n, c]) => `${n}=${c}`).join(' ');
      log(`isolation: dev gateway ${before.devGateway ? 'answering' : 'not running'} before, ${after.devGateway ? 'answering' : 'not running'} after; Neo4j stores ${before.neo4jStores} → ${after.neo4jStores}; ${config.devDb} ${counts}`);
      if (problems.length) {
        log(`isolation check FAILED: ${problems.join('; ')}`);
        code ||= 1;
      } else {
        log(`isolation check passed (${config.devDb} unchanged)`);
      }
    }
    log(`child logs: ${config.logFile}`);
    log(`finished in ${seconds()}`);
    // Salida natural (process.exit con sockets cerrándose aborta Node en Windows);
    // si algo quedara abierto, se fuerza a los 10 s.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 10_000).unref();
  })();
  return finishing;
}

let before = null;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (interrupted) process.exit(130); // segundo Ctrl+C: salir ya
    interrupted = true;
    log(`${signal}: stopping the test stack and cleaning up...`);
    finish(130, before);
  });
}
process.on('exit', () => stack?.killNow());

try {
  before = await isolationSnapshot(config);
  const leftovers = await cleanup(config);
  if (leftovers.mongo.users.length) log(`removed leftovers of an earlier run (${leftovers.mongo.users.length} users in ${config.db})`);

  stack = startStack(config, log);
  try {
    await stack.ready();
  } catch (err) {
    log(`the test stack did not start: ${err.message}\n${stack.tail()}`);
    await finish(1, before);
  }

  const files = fs.readdirSync(HERE).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(HERE, f));
  const code = await new Promise(resolve => {
    testRun = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], {
      stdio: 'inherit',
      env: { ...process.env, IT_GATEWAY_URL: config.gatewayUrl, IT_JWT_SECRET: config.jwtSecret, IT_JTI_FILE: config.jtiFile },
    });
    testRun.on('exit', c => resolve(c ?? 1));
  });
  await finish(code, before);
} catch (err) {
  log(`integration run failed: ${err.stack ?? err.message}`);
  await finish(1, before);
}
