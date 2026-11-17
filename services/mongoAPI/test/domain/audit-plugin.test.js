// Plugin de auditoría de Apollo (src/infrastructure/events.js): qué errores se registran
// como ACCESS_DENIED y ORDER_REJECTED. PIC-77: el UNAUTHENTICATED de reportDriverLocation
// (la app lo manda cada 3 s) no se registra, para no inundar RabbitMQ y ScyllaDB; el
// FORBIDDEN sí, y las demás operaciones se comportan como siempre. Sin RabbitMQ: el
// productor de eventos se sustituye por uno que anota lo que recibe.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuditPlugin, auditPlugin } from '../../src/infrastructure/events.js';

// Corre las `errors` (código y operación) por el plugin y devuelve los eventos que habría emitido.
async function emitted(errors, contextValue = { currentUser: null, ip: '10.0.0.1', userAgent: 'prueba' }) {
  const events = [];
  const plugin = createAuditPlugin((event, ctx) => events.push({ event, ctx }));
  const request = await plugin.requestDidStart();
  await request.didEncounterErrors({
    contextValue,
    errors: errors.map(({ operation, code, message = `error ${code}`, newQuote }) => ({
      message,
      path: operation ? [operation] : undefined,
      extensions: { code },
      originalError: newQuote ? { extensions: { code, newQuote } } : undefined,
    })),
  });
  return events;
}

describe('UNAUTHENTICATED de reportDriverLocation no se registra', () => {
  test('una petición sin sesión (token vencido, o Redis caído) no emite ACCESS_DENIED', async () => {
    assert.deepEqual(await emitted([{ operation: 'reportDriverLocation', code: 'UNAUTHENTICATED' }]), []);
  });

  test('un reporte que salió bien no tiene errores y no emite nada', async () => {
    assert.deepEqual(await emitted([]), []);
  });

  test('el FORBIDDEN de reportDriverLocation sí se registra, con la operación y el código', async () => {
    const [only, ...rest] = await emitted([{ operation: 'reportDriverLocation', code: 'FORBIDDEN', message: 'La orden tiene otro repartidor asignado.' }],
      { currentUser: { id: 'u1', role: 'DELIVERY' } });
    assert.deepEqual(rest, []);
    assert.equal(only.event.type, 'ACCESS_DENIED');
    assert.equal(only.event.category, 'SECURITY');
    assert.equal(only.event.success, false);
    assert.deepEqual(only.event.metadata, { operation: 'reportDriverLocation', code: 'FORBIDDEN' });
    assert.equal(only.ctx.currentUser.id, 'u1');
  });

  test('otros errores de reportDriverLocation (INVALID_ORDER_STATE, NOT_FOUND, INVALID_LOCATION...) no son accesos denegados', async () => {
    for (const code of ['INVALID_ORDER_STATE', 'NOT_FOUND', 'INVALID_LOCATION', 'SERVICE_UNAVAILABLE']) {
      assert.deepEqual(await emitted([{ operation: 'reportDriverLocation', code }]), [], code);
    }
  });

  test('en una misma petición solo se omite el UNAUTHENTICATED de esa operación', async () => {
    const events = await emitted([
      { operation: 'reportDriverLocation', code: 'UNAUTHENTICATED' },
      { operation: 'reportDriverLocation', code: 'FORBIDDEN' },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event.metadata.code, 'FORBIDDEN');
  });
});

describe('las demás operaciones no cambian', () => {
  test('UNAUTHENTICATED de cualquier otra operación sigue registrándose como ACCESS_DENIED', async () => {
    for (const operation of ['me', 'order', 'driverLocation', 'acceptDelivery', 'updateOrderStatus', 'cart']) {
      const events = await emitted([{ operation, code: 'UNAUTHENTICATED' }]);
      assert.equal(events.length, 1, operation);
      assert.equal(events[0].event.type, 'ACCESS_DENIED');
      assert.deepEqual(events[0].event.metadata, { operation, code: 'UNAUTHENTICATED' });
    }
  });

  test('FORBIDDEN de otras operaciones se registra igual', async () => {
    const events = await emitted([{ operation: 'acceptDelivery', code: 'FORBIDDEN' }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event.metadata.code, 'FORBIDDEN');
  });

  test('login no se registra como ACCESS_DENIED (ya es LOGIN_FAILED), ni los errores sin operación', async () => {
    assert.deepEqual(await emitted([{ operation: 'login', code: 'UNAUTHENTICATED' }, { operation: 'login', code: 'FORBIDDEN' }]), []);
    assert.deepEqual(await emitted([{ operation: undefined, code: 'UNAUTHENTICATED' }]), []);
  });

  test('una compra rechazada sigue emitiendo ORDER_REJECTED (con el total de la cotización nueva)', async () => {
    const events = await emitted([{ operation: 'createOrder', code: 'PRICE_CHANGED', newQuote: { total: 99 } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event.type, 'ORDER_REJECTED');
    assert.deepEqual(events[0].event.metadata, { operation: 'createOrder', code: 'PRICE_CHANGED', newQuoteTotal: 99 });
    assert.deepEqual(await emitted([{ operation: 'quoteOrder', code: 'PRICE_CHANGED' }]), []); // solo createOrder y checkoutCart
  });
});

test('el plugin que usa la API es el de siempre (createAuditPlugin con emitEvent)', async () => {
  assert.equal(typeof auditPlugin.requestDidStart, 'function');
  const request = await auditPlugin.requestDidStart();
  assert.equal(typeof request.didEncounterErrors, 'function');
});
