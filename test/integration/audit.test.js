// Bitácora: los eventos llegan a ScyllaDB por RabbitMQ (asíncrono) y se leen
// con audit:view (README, sección 9). El auditAPI del dev y el de pruebas
// consumen la misma cola y escriben en la misma ScyllaDB, así que las
// pruebas no dependen de cuál de los dos guardó el evento.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gql, ok, forbidden, tokenOf, uid, today, newCustomer, newProduct, createOrder, eventually } from './client.js';

const EVENT_FIELDS = 'id type category actorId actorRole targetType targetId success reason metadata occurredAt';
const BY_DAY = `query($category: AuditCategory!, $day: String, $type: String) {
  auditEvents(category: $category, day: $day, type: $type, limit: 500) { ${EVENT_FIELDS} }
}`;
const BY_TARGET = `query($type: String!, $id: ID!) { auditByTarget(targetType: $type, targetId: $id) { ${EVENT_FIELDS} actor { id email } } }`;

// Día UTC del evento: el de ahora y, si la prueba cruzó la medianoche, también el anterior.
const daysSince = startDay => [...new Set([startDay, today()])];

test('a failed login shows up in auditEvents (SECURITY / LOGIN_FAILED)', async () => {
  const admin = await tokenOf('ADMIN');
  const email = `nadie-${uid()}@pickaroo.test`;
  const day = today();
  const res = await gql('mutation($input: LoginInput!) { login(input: $input) { token } }', { input: { email, password: 'Cualquiera1' } });
  assert.equal(res.errors?.[0]?.extensions?.code, 'INVALID_CREDENTIALS');

  const event = await eventually(async () => {
    for (const d of daysSince(day)) {
      const { auditEvents } = await ok(BY_DAY, { category: 'SECURITY', day: d, type: 'LOGIN_FAILED' }, admin);
      const found = auditEvents.find(e => JSON.parse(e.metadata).email === email);
      if (found) return found;
    }
    return null;
  }, { what: `LOGIN_FAILED for ${email}` });
  assert.equal(event.category, 'SECURITY');
  assert.equal(event.success, false);
  assert.equal(event.actorId, 'ANONYMOUS');
  assert.equal(event.reason, 'Correo no registrado');
});

test('an order creation shows up in auditByTarget and auditEvents (ORDER_CREATED)', async () => {
  const admin = await tokenOf('ADMIN');
  const customer = await newCustomer();
  const product = await newProduct();
  const day = today();
  const order = await createOrder(customer, { items: [{ productId: product.id, quantity: 1 }] });

  const created = await eventually(async () => {
    const { auditByTarget } = await ok(BY_TARGET, { type: 'Order', id: order.id }, admin);
    return auditByTarget.find(e => e.type === 'ORDER_CREATED');
  }, { what: `ORDER_CREATED for ${order.number}` });
  assert.equal(created.category, 'ORDER');
  assert.equal(created.targetId, order.id);
  assert.equal(created.actorId, customer.id);
  assert.equal(created.actorRole, 'CUSTOMER');
  assert.equal(created.actor?.id, customer.id); // el gateway resuelve el User federado
  const metadata = JSON.parse(created.metadata);
  assert.equal(metadata.number, order.number);
  assert.equal(metadata.total, order.total);

  const inDay = await eventually(async () => {
    for (const d of daysSince(day)) {
      const { auditEvents } = await ok(BY_DAY, { category: 'ORDER', day: d, type: 'ORDER_CREATED' }, admin);
      const found = auditEvents.find(e => e.targetId === order.id);
      if (found) return found;
    }
    return null;
  }, { what: `ORDER_CREATED for ${order.number} in auditEvents` });
  assert.equal(inDay.id, created.id);
});

test('a customer gets FORBIDDEN (PERMISSION_REQUIRED) on the audit queries', async () => {
  const customer = await newCustomer();
  const ext = await forbidden('PERMISSION_REQUIRED', BY_DAY, { category: 'SECURITY', day: today() }, customer.token);
  assert.equal(ext.permission, 'audit:view');
  await forbidden('PERMISSION_REQUIRED', BY_TARGET, { type: 'User', id: customer.id }, customer.token);
});
