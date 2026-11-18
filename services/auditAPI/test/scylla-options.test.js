// Opciones de conexión a ScyllaDB (src/scylla-options.js). No abre ninguna conexión.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import cassandra from 'cassandra-driver';
import { scyllaConfig } from '../src/scylla-options.js';

describe('scyllaConfig', () => {
  test('por defecto: el ScyllaDB local de docker-compose (sin auth ni TLS)', () => {
    const c = scyllaConfig({});
    assert.deepEqual(c.clientOptions, { contactPoints: ['127.0.0.1'], localDataCenter: 'datacenter1', protocolOptions: { port: 9042 } });
    assert.equal(c.keyspace, 'pickaroo_audit');
    assert.equal(c.createKeyspace, true);
    assert.equal(c.createKeyspaceCql, "CREATE KEYSPACE IF NOT EXISTS pickaroo_audit WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}");
  });

  test('puntos de contacto, puerto, datacenter y keyspace configurables', () => {
    const c = scyllaConfig({ SCYLLADB_CONTACT_POINTS: 'a.example, b.example', SCYLLADB_PORT: '19042', SCYLLADB_DATACENTER: 'AWS_US_EAST_1', SCYLLADB_KEYSPACE: 'demo' });
    assert.deepEqual(c.clientOptions.contactPoints, ['a.example', 'b.example']);
    assert.equal(c.clientOptions.protocolOptions.port, 19042);
    assert.equal(c.clientOptions.localDataCenter, 'AWS_US_EAST_1');
    assert.equal(c.keyspace, 'demo');
  });

  test('usuario y contraseña: PlainTextAuthProvider', () => {
    const { authProvider } = scyllaConfig({ SCYLLADB_USERNAME: 'scylla', SCYLLADB_PASSWORD: 'secreto' }).clientOptions;
    assert.ok(authProvider instanceof cassandra.auth.PlainTextAuthProvider);
    assert.equal(authProvider.username, 'scylla');
    assert.equal(authProvider.password, 'secreto');
    assert.equal(scyllaConfig({ SCYLLADB_PASSWORD: 'x' }).clientOptions.authProvider, undefined);
  });

  test('SCYLLADB_SSL=true activa TLS verificando el certificado; el opt-out es explícito', () => {
    assert.deepEqual(scyllaConfig({ SCYLLADB_SSL: 'true' }).clientOptions.sslOptions, { rejectUnauthorized: true });
    assert.deepEqual(scyllaConfig({ SCYLLADB_SSL: 'true', SCYLLADB_SSL_REJECT_UNAUTHORIZED: 'false' }).clientOptions.sslOptions, { rejectUnauthorized: false });
    assert.equal(scyllaConfig({ SCYLLADB_SSL: 'false' }).clientOptions.sslOptions, undefined);
    // El opt-out por sí solo no activa TLS.
    assert.equal(scyllaConfig({ SCYLLADB_SSL_REJECT_UNAUTHORIZED: 'false' }).clientOptions.sslOptions, undefined);
  });

  test('SCYLLADB_CREATE_KEYSPACE=false omite la creación del keyspace', () => {
    assert.equal(scyllaConfig({ SCYLLADB_CREATE_KEYSPACE: 'false' }).createKeyspace, false);
    assert.equal(scyllaConfig({ SCYLLADB_CREATE_KEYSPACE: 'true' }).createKeyspace, true);
  });

  test('replicación configurable: factor y NetworkTopologyStrategy por datacenter', () => {
    assert.match(scyllaConfig({ SCYLLADB_REPLICATION_FACTOR: '3' }).createKeyspaceCql, /'replication_factor': 3\}$/);
    const c = scyllaConfig({ SCYLLADB_REPLICATION_CLASS: 'NetworkTopologyStrategy', SCYLLADB_REPLICATION_FACTOR: '3', SCYLLADB_DATACENTER: 'dc1' });
    assert.match(c.createKeyspaceCql, /\{'class': 'NetworkTopologyStrategy', 'dc1': 3\}$/);
  });

  test('rechaza una estrategia desconocida y nombres con caracteres peligrosos', () => {
    assert.throws(() => scyllaConfig({ SCYLLADB_REPLICATION_CLASS: 'Otra' }), /SCYLLADB_REPLICATION_CLASS/);
    assert.throws(() => scyllaConfig({ SCYLLADB_KEYSPACE: 'x; DROP KEYSPACE y' }), /SCYLLADB_KEYSPACE/);
    assert.throws(() => scyllaConfig({ SCYLLADB_DATACENTER: "dc1'}; DROP" }), /SCYLLADB_DATACENTER/);
  });

  test('el keyspace es un identificador CQL (sin punto ni guion, sin empezar con número); el datacenter puede llevar - y .', () => {
    for (const bad of ['1audit', 'pickaroo-audit', 'pickaroo.audit']) assert.throws(() => scyllaConfig({ SCYLLADB_KEYSPACE: bad }), /SCYLLADB_KEYSPACE/, bad);
    assert.equal(scyllaConfig({ SCYLLADB_KEYSPACE: '_audit2' }).keyspace, '_audit2');
    assert.equal(scyllaConfig({ SCYLLADB_DATACENTER: 'dc-1.eu' }).clientOptions.localDataCenter, 'dc-1.eu');
  });

  test('SCYLLADB_REPLICATION_FACTOR no numérico, decimal o menor que 1 lanza ScyllaConfigError', () => {
    for (const bad of ['abc', '0', '-1', '1.5', '2x']) {
      assert.throws(() => scyllaConfig({ SCYLLADB_REPLICATION_FACTOR: bad }), err => err.name === 'ScyllaConfigError' || err.constructor.name === 'ScyllaConfigError', bad);
    }
    assert.match(scyllaConfig({ SCYLLADB_REPLICATION_FACTOR: '' }).createKeyspaceCql, /'replication_factor': 1}$/);
  });
});
