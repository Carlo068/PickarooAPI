// Configuración del gateway derivada del entorno. Funciones puras (reciben `env`)
// para poder probarlas sin levantar servidores. También las usa scripts/start.js.

const flagOff = value => String(value ?? '').trim().toLowerCase() === 'false';

// La auditoría (auditAPI + ScyllaDB) es opcional: AUDIT_ENABLED=false la quita de todo.
export const auditEnabled = (env = process.env) => !flagOff(env.AUDIT_ENABLED);

// PORT_GATEWAY (desarrollo), si no PORT (lo asigna Render) y si no 4000.
export const gatewayPort = (env = process.env) => parseInt(env.PORT_GATEWAY) || parseInt(env.PORT) || 4000;

// Subgrafos que compone el gateway. Mismos nombres que scripts/build-schema.js.
export function subgraphList(env = process.env) {
  const list = [
    // Catálogo, órdenes, carrito, sesiones y roles (MongoDB + Redis + Neo4j).
    { name: 'pickaroo', url: env.SUBGRAPH_MONGO_URL || `http://localhost:${env.PORT_CAMPAMENTOS || 4001}/graphql` },
  ];
  // Bitácora de auditoría (ScyllaDB, alimentada por RabbitMQ).
  if (auditEnabled(env)) {
    list.push({ name: 'auditoria', url: env.SUBGRAPH_AUDIT_URL || `http://localhost:${env.PORT_AUDITORIA || 4003}/graphql` });
  }
  return list;
}

// Sin NODE_ENV=production se conserva el comportamiento de desarrollo (con stacktrace).
export const includeStacktrace = (env = process.env) => env.NODE_ENV !== 'production';

// CORS abierto por defecto; CORS_ORIGIN="https://a.com,https://b.com" lo limita a esos orígenes.
export function corsOptions(env = process.env) {
  // Sin barra final: el navegador envía el origen sin ella (https://a.com, no https://a.com/).
  const origins = String(env.CORS_ORIGIN ?? '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return origins.length === 0 || origins.includes('*') ? {} : { origin: origins };
}

// Intentos de composición inicial (uno cada 2 s). En producción los subgrafos y las bases
// alojadas tardan más en arrancar en frío: 90 intentos ≈ 3 min. GATEWAY_COMPOSE_RETRIES lo fija.
export function composeRetries(env = process.env) {
  const configured = parseInt(env.GATEWAY_COMPOSE_RETRIES);
  if (configured >= 1) return configured;
  return env.NODE_ENV === 'production' ? 90 : 15;
}
