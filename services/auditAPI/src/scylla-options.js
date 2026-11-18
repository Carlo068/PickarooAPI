// Opciones de conexión a ScyllaDB derivadas del entorno. Funciones puras (reciben
// `env`) para poder probarlas sin una base de datos. Por defecto: el ScyllaDB local
// de docker-compose.yml, sin autenticación ni TLS.

import cassandra from 'cassandra-driver';

const flag = (value, fallback) => (value == null || value === '' ? fallback : String(value).trim().toLowerCase() === 'true');
// Error de configuración (arranque), no de una petición GraphQL.
class ScyllaConfigError extends Error {}
// Keyspace: identificador CQL sin comillas. Centro de datos: admite también "." y "-" (AWS_US_EAST_1, dc-1).
const KEYSPACE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATACENTER_NAME = /^[A-Za-z0-9_.-]+$/;

export function scyllaConfig(env = process.env) {
  const contactPoints = (env.SCYLLADB_CONTACT_POINTS || '127.0.0.1').split(',').map(s => s.trim()).filter(Boolean);
  const localDataCenter = env.SCYLLADB_DATACENTER || 'datacenter1';
  const keyspace = env.SCYLLADB_KEYSPACE || 'auditoria';

  const base = { contactPoints, localDataCenter, protocolOptions: { port: parseInt(env.SCYLLADB_PORT) || 9042 } };
  // Clústeres alojados (p. ej. ScyllaDB Cloud): usuario/contraseña y TLS.
  if (env.SCYLLADB_USERNAME) {
    base.authProvider = new cassandra.auth.PlainTextAuthProvider(env.SCYLLADB_USERNAME, env.SCYLLADB_PASSWORD ?? '');
  }
  if (flag(env.SCYLLADB_SSL, false)) {
    base.sslOptions = { rejectUnauthorized: flag(env.SCYLLADB_SSL_REJECT_UNAUTHORIZED, true) };
  }

  const strategy = env.SCYLLADB_REPLICATION_CLASS || 'SimpleStrategy';
  const rawFactor = env.SCYLLADB_REPLICATION_FACTOR;
  const factor = rawFactor == null || rawFactor === '' ? 1 : Number(rawFactor);
  if (!Number.isInteger(factor) || factor < 1) {
    throw new ScyllaConfigError(`SCYLLADB_REPLICATION_FACTOR inválido: "${rawFactor}" (entero de 1 en adelante).`);
  }
  if (!['SimpleStrategy', 'NetworkTopologyStrategy'].includes(strategy)) {
    throw new ScyllaConfigError(`SCYLLADB_REPLICATION_CLASS inválido: "${strategy}" (SimpleStrategy o NetworkTopologyStrategy).`);
  }
  if (!KEYSPACE_NAME.test(keyspace)) {
    throw new ScyllaConfigError('SCYLLADB_KEYSPACE debe empezar con una letra o "_" y solo admite letras, números y "_".');
  }
  if (!DATACENTER_NAME.test(localDataCenter)) {
    throw new ScyllaConfigError('SCYLLADB_DATACENTER solo admite letras, números, "_", "." y "-".');
  }
  // NetworkTopologyStrategy replica por centro de datos; SimpleStrategy por clúster.
  const replication = strategy === 'NetworkTopologyStrategy'
    ? `{'class': 'NetworkTopologyStrategy', '${localDataCenter}': ${factor}}`
    : `{'class': 'SimpleStrategy', 'replication_factor': ${factor}}`;

  return {
    keyspace,
    // Los clústeres alojados pueden no permitir CREATE KEYSPACE: SCYLLADB_CREATE_KEYSPACE=false lo omite
    // (el keyspace debe existir ya).
    createKeyspace: flag(env.SCYLLADB_CREATE_KEYSPACE, true),
    createKeyspaceCql: `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = ${replication}`,
    clientOptions: base,
  };
}
