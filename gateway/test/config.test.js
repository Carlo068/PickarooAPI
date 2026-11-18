// Configuración del gateway derivada del entorno (gateway/config.js): puertos,
// subgrafos, auditoría opcional, stacktrace y CORS. No levanta ningún servidor.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { auditEnabled, gatewayPort, subgraphList, includeStacktrace, corsOptions, composeRetries } from '../config.js';

describe('gatewayPort', () => {
  test('PORT_GATEWAY > PORT (Render) > 4000', () => {
    assert.equal(gatewayPort({}), 4000);
    assert.equal(gatewayPort({ PORT: '10000' }), 10000);
    assert.equal(gatewayPort({ PORT: '10000', PORT_GATEWAY: '4100' }), 4100);
    assert.equal(gatewayPort({ PORT: 'abc' }), 4000);
  });
});

describe('subgraphList', () => {
  test('por defecto: los dos subgrafos locales (comportamiento de desarrollo)', () => {
    assert.deepEqual(subgraphList({}), [
      { name: 'pickaroo', url: 'http://localhost:4001/graphql' },
      { name: 'auditoria', url: 'http://localhost:4003/graphql' },
    ]);
  });

  test('los puertos locales salen de PORT_CAMPAMENTOS y PORT_AUDITORIA', () => {
    const [mongo, audit] = subgraphList({ PORT_CAMPAMENTOS: '5001', PORT_AUDITORIA: '5003' });
    assert.equal(mongo.url, 'http://localhost:5001/graphql');
    assert.equal(audit.url, 'http://localhost:5003/graphql');
  });

  test('SUBGRAPH_MONGO_URL y SUBGRAPH_AUDIT_URL tienen prioridad', () => {
    const list = subgraphList({ SUBGRAPH_MONGO_URL: 'http://api:1/graphql', SUBGRAPH_AUDIT_URL: 'http://audit:2/graphql', PORT_CAMPAMENTOS: '5001' });
    assert.deepEqual(list.map(s => s.url), ['http://api:1/graphql', 'http://audit:2/graphql']);
  });

  test('AUDIT_ENABLED=false quita auditoria (sin importar mayúsculas); otros valores la dejan', () => {
    for (const v of ['false', 'FALSE', ' false ']) assert.deepEqual(subgraphList({ AUDIT_ENABLED: v }).map(s => s.name), ['pickaroo']);
    for (const v of [undefined, '', 'true', '0']) assert.deepEqual(subgraphList({ AUDIT_ENABLED: v }).map(s => s.name), ['pickaroo', 'auditoria']);
  });
});

test('auditEnabled: solo "false" la apaga', () => {
  assert.equal(auditEnabled({}), true);
  assert.equal(auditEnabled({ AUDIT_ENABLED: 'true' }), true);
  assert.equal(auditEnabled({ AUDIT_ENABLED: 'false' }), false);
});

test('includeStacktrace: solo se omite con NODE_ENV=production', () => {
  assert.equal(includeStacktrace({}), true);
  assert.equal(includeStacktrace({ NODE_ENV: 'development' }), true);
  assert.equal(includeStacktrace({ NODE_ENV: 'production' }), false);
});

describe('corsOptions', () => {
  test('abierto por defecto (mismas opciones que cors() sin argumentos)', () => {
    assert.deepEqual(corsOptions({}), {});
    assert.deepEqual(corsOptions({ CORS_ORIGIN: '  ' }), {});
    assert.deepEqual(corsOptions({ CORS_ORIGIN: '*' }), {});
  });

  test('CORS_ORIGIN separado por comas limita los orígenes', () => {
    assert.deepEqual(corsOptions({ CORS_ORIGIN: 'https://a.com, https://b.com ,' }), { origin: ['https://a.com', 'https://b.com'] });
  });

  test('quita la barra final de cada origen', () => {
    assert.deepEqual(corsOptions({ CORS_ORIGIN: 'https://a.com/, https://b.com//,http://localhost:5173/' }), { origin: ['https://a.com', 'https://b.com', 'http://localhost:5173'] });
    assert.deepEqual(corsOptions({ CORS_ORIGIN: '/' }), {});
  });
});

describe('composeRetries', () => {
  test('15 en desarrollo, 90 en producción', () => {
    assert.equal(composeRetries({}), 15);
    assert.equal(composeRetries({ NODE_ENV: 'development' }), 15);
    assert.equal(composeRetries({ NODE_ENV: 'production' }), 90);
  });

  test('GATEWAY_COMPOSE_RETRIES lo fija (un valor inválido o menor que 1 se ignora)', () => {
    assert.equal(composeRetries({ GATEWAY_COMPOSE_RETRIES: '40' }), 40);
    assert.equal(composeRetries({ NODE_ENV: 'production', GATEWAY_COMPOSE_RETRIES: '5' }), 5);
    assert.equal(composeRetries({ NODE_ENV: 'production', GATEWAY_COMPOSE_RETRIES: '0' }), 90);
    assert.equal(composeRetries({ GATEWAY_COMPOSE_RETRIES: 'abc' }), 15);
  });
});
