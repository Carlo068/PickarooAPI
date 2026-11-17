// Ubicación del repartidor (PIC-77, README sección 6 "Reparto: ubicación del
// repartidor"): reportDriverLocation (solo el repartidor asignado, DELIVERY en
// IN_DELIVERY), la última posición en Redis (driver:loc:<orderId>, TTL, límite de 1
// por segundo, escritura atómica, un solo reloj: el de Redis), driverLocation /
// Order.driverLocation (quien puede ver la orden, solo mientras va en camino), el borrado al
// entregar o cancelar y que un reporte (o su falta de sesión) no llena la bitácora.
// Cada prueba usa orden, cliente y repartidor propios (un repartidor lleva una entrega a la vez).
// La hora de los puntos es la de Redis (que puede ir desfasada del equipo si Redis corre en una
// VM de Docker): las pruebas comparan contra el TIME de Redis, no contra Date.now().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, gql, fails, forbidden, tokenOf, newCustomer, newProduct, newDriver, newStore, newStoreUser, huertaStore,
  createOrder, moveOrder, acceptDelivery, eventually, today,
} from './client.js';
import { createLocationStore } from '../../services/mongoAPI/src/infrastructure/location-store.js';
import { newLocationRecord, shouldReplaceLocation, locationView, FUTURE_TOLERANCE_MS } from '../../services/mongoAPI/src/domain/driver-location.js';

const MONGO_API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'mongoAPI');
const { createClient } = createRequire(path.join(MONGO_API, 'package.json'))('redis');

const TTL = parseInt(process.env.IT_DRIVER_LOCATION_TTL, 10); // lo que arranca stack.js (no el 600 por omisión)
const REPORT = 'mutation($o: ID!, $lat: Float!, $lng: Float!) { reportDriverLocation(orderId: $o, lat: $lat, lng: $lng) }';
const LOCATION = 'query($o: ID!) { driverLocation(orderId: $o) { lat lng updatedAt ageSeconds } }';
const ORDER_LOCATION = 'query($id: ID!) { order(id: $id) { id status driverLocation { lat lng updatedAt ageSeconds } } }';
const CANCEL = 'mutation($id: ID!) { cancelOrder(id: $id) { id status } }';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const keyOf = orderId => `driver:loc:${orderId}`;

// Redis de las pruebas (base lógica 1, nunca la 0 del dev): para ver la clave y su TTL.
let redis;
before(async () => {
  const { pathname } = new URL(process.env.IT_REDIS_URL);
  assert.ok(pathname.length > 1 && pathname !== '/0', `IT_REDIS_URL debe apuntar a una base lógica distinta de la 0: ${pathname}`);
  assert.ok(TTL > 0 && TTL !== 600, `IT_DRIVER_LOCATION_TTL debe venir de stack.js y no ser el de omisión: ${TTL}`);
  redis = createClient({ url: process.env.IT_REDIS_URL });
  redis.on('error', () => {});
  await redis.connect();
});
after(async () => { await redis?.quit(); });

const stored = async orderId => JSON.parse(await redis.get(keyOf(orderId)) ?? 'null');

// La hora de Redis (TIME) en ms: el único reloj de los puntos.
const redisNow = async () => {
  const [seconds, microseconds] = await redis.sendCommand(['TIME']);
  return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
};
// Borrar la ubicación al terminar la entrega no se espera (finishStatusChange la lanza y sigue):
// la clave desaparece en unos milisegundos, así que se sondea un momento.
const gone = async orderId => {
  for (let i = 0; i < 60; i += 1) {
    if (!(await redis.exists(keyOf(orderId)))) return true;
    await sleep(50);
  }
  return false;
};

const report = (orderId, lat, lng, token) => gql(REPORT, { o: orderId, lat, lng }, token);
const reportOk = async (orderId, lat, lng, token) => assert.equal((await ok(REPORT, { o: orderId, lat, lng }, token)).reportDriverLocation, true);
const locationAs = async (orderId, token) => (await ok(LOCATION, { o: orderId }, token)).driverLocation;
const orderLocationAs = async (orderId, token) => (await ok(ORDER_LOCATION, { id: orderId }, token)).order.driverLocation;

// Orden DELIVERY de una prueba, llevada hasta `upTo` (READY, ACCEPTED: READY ya aceptada
// por su repartidor, o IN_DELIVERY) con cliente y repartidor propios.
async function deliveryOrder({ upTo = 'IN_DELIVERY', storeId } = {}) {
  const customer = await newCustomer();
  const driver = await newDriver(storeId);
  const product = await newProduct({ storeId });
  const order = await createOrder(customer, { mode: 'DELIVERY', items: [{ productId: product.id, quantity: 1 }] });
  await moveOrder(order.id, ['CONFIRMED', 'PREPARING', 'READY'], await tokenOf('ADMIN'));
  if (upTo !== 'READY') await acceptDelivery(order.id, driver.token);
  if (upTo === 'IN_DELIVERY') await moveOrder(order.id, ['IN_DELIVERY'], driver.token);
  return { order, customer, driver };
}

test('only the assigned driver reports: other drivers, staff, ADMIN and the customer are denied', async () => {
  const { order, customer, driver } = await deliveryOrder();
  const sameStoreDriver = await newDriver(); // repartidor de la sucursal sin esta orden
  const otherStore = await newStore();
  const outsider = await newStoreUser('DELIVERY', otherStore.id); // repartidor de otra sucursal

  for (const token of [sameStoreDriver.token, await tokenOf('ADMIN')]) {
    await forbidden('NOT_ASSIGNED_DRIVER', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }, token);
  }
  // Una orden que nadie aceptó: NO_DRIVER_ASSIGNED, aunque sea repartidor de la sucursal.
  const open = await deliveryOrder({ upTo: 'READY' });
  await forbidden('NO_DRIVER_ASSIGNED', REPORT, { o: open.order.id, lat: 28.6, lng: -106.1 }, sameStoreDriver.token);
  await forbidden('NO_DRIVER_ASSIGNED', REPORT, { o: open.order.id, lat: 28.6, lng: -106.1 }, open.driver.token);
  // Otra sucursal: no se entera de la asignación.
  const ext = await forbidden('STORE_NOT_ASSIGNED', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }, outsider.token);
  assert.equal(ext.storeId, order.store.id);
  // Sin orders:deliver: personal de mostrador y el cliente de la propia orden.
  for (const token of [await tokenOf('STAFF'), await tokenOf('MANAGER'), customer.token]) {
    const denied = await forbidden('PERMISSION_REQUIRED', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }, token);
    assert.equal(denied.permission, 'orders:deliver');
  }
  await fails('UNAUTHENTICATED', REPORT, { o: order.id, lat: 28.6, lng: -106.1 });

  // Nada de eso dejó un punto.
  assert.equal(await redis.exists(keyOf(order.id)), 0);
  assert.equal(await locationAs(order.id, customer.token), null);

  // El repartidor asignado sí.
  await reportOk(order.id, 28.6353, -106.0889, driver.token);
  assert.equal(await redis.exists(keyOf(order.id)), 1);
});

test('the assigned driver cannot report until the order is IN_DELIVERY (INVALID_ORDER_STATE), and not after it ends', async () => {
  const { order, customer, driver } = await deliveryOrder({ upTo: 'ACCEPTED' });
  const ext = await fails('INVALID_ORDER_STATE', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }, driver.token);
  assert.deepEqual([ext.status, ext.mode], ['READY', 'DELIVERY']);
  assert.equal(await redis.exists(keyOf(order.id)), 0);

  await moveOrder(order.id, ['IN_DELIVERY'], driver.token);
  await reportOk(order.id, 28.6, -106.1, driver.token);
  assert.deepEqual((await locationAs(order.id, customer.token)).lat, 28.6);

  await moveOrder(order.id, ['DELIVERED'], driver.token);
  const after = await fails('INVALID_ORDER_STATE', REPORT, { o: order.id, lat: 28.7, lng: -106.2 }, driver.token);
  assert.deepEqual([after.status, after.mode], ['DELIVERED', 'DELIVERY']);
  assert.equal(await redis.exists(keyOf(order.id)), 0); // el reporte rechazado no vuelve a guardar nada
  assert.ok(await gone(order.id));
});

test('not found: an unknown or malformed order id is NOT_FOUND (ORDER)', async () => {
  const { driver } = await deliveryOrder();
  for (const id of ['000000000000000000000000', 'not-an-id']) {
    const ext = await fails('NOT_FOUND', REPORT, { o: id, lat: 28.6, lng: -106.1 }, driver.token);
    assert.deepEqual([ext.entity, ext.id], ['ORDER', id]);
  }
});

test('invalid coordinates are INVALID_LOCATION with the failing field, and never change the stored point', async () => {
  const { order, customer, driver } = await deliveryOrder();
  const invalid = async (lat, lng) => (await fails('INVALID_LOCATION', REPORT, { o: order.id, lat, lng }, driver.token)).field;

  assert.equal(await invalid(90.5, -106.1), 'lat');
  assert.equal(await invalid(-91, -106.1), 'lat');
  assert.equal(await invalid(28.6, 180.5), 'lng');
  assert.equal(await invalid(28.6, -181), 'lng');
  assert.equal(await invalid(1e9, 28.6), 'lat');
  assert.equal(await invalid(0, 0), 'location'); // el centinela "sin posición"
  assert.equal(await redis.exists(keyOf(order.id)), 0);

  // NaN e Infinity no llegan a la API: JSON no los tiene (NaN viaja como null), y GraphQL y el
  // gateway los rechazan antes. El dominio también los rechaza (INVALID_LOCATION), como defensa extra
  // (pruebas unitarias). Aquí se comprueba que ninguna forma de mandarlos guarda un punto.
  for (const bad of [NaN, null, 'NaN', 'abc', Infinity]) {
    const res = await report(order.id, bad, 10, driver.token);
    assert.equal(res.errors?.[0]?.extensions?.code, 'BAD_USER_INPUT', `lat ${bad}: ${JSON.stringify(res)}`);
  }
  for (const [lat, lng] of [['1e999', 10], [10, '-1e999']]) { // literal que se lee como Infinity
    const res = await gql(`mutation { reportDriverLocation(orderId: "${order.id}", lat: ${lat}, lng: ${lng}) }`, {}, driver.token);
    assert.equal(res.errors?.[0]?.extensions?.code, 'INVALID_GRAPHQL', `lat ${lat}, lng ${lng}: ${JSON.stringify(res)}`);
  }
  assert.equal(await redis.exists(keyOf(order.id)), 0);

  // Con un punto ya guardado, uno inválido no lo toca (ni la hora de su TTL).
  await reportOk(order.id, 28.6, -106.1, driver.token);
  await sleep(1100);
  assert.equal(await invalid(95, 10), 'lat');
  const point = await locationAs(order.id, customer.token);
  assert.deepEqual([point.lat, point.lng], [28.6, -106.1]);

  // Los extremos válidos se aceptan, y un solo cero también.
  await sleep(1100);
  await reportOk(order.id, 90, 180, driver.token);
  assert.deepEqual([(await stored(order.id)).lat, (await stored(order.id)).lng], [90, 180]);
  await sleep(1100);
  await reportOk(order.id, 0, 0.0001, driver.token);
  assert.deepEqual([(await stored(order.id)).lat, (await stored(order.id)).lng], [0, 0.0001]);
});

test('the customer, staff, ADMIN and the driver read the latest point; ageSeconds and updatedAt are plausible; no driver data', async () => {
  const { order, customer, driver } = await deliveryOrder();
  assert.equal(await locationAs(order.id, customer.token), null); // aún no se reportó nada

  const before = await redisNow();
  await reportOk(order.id, 28.6353, -106.0889, driver.token);
  const after = await redisNow();
  const readers = [customer.token, await tokenOf('STAFF'), await tokenOf('MANAGER'), await tokenOf('ADMIN'), driver.token];
  for (const token of readers) {
    const point = await locationAs(order.id, token);
    assert.deepEqual([point.lat, point.lng], [28.6353, -106.0889]);
    assert.deepEqual(Object.keys(point).sort(), ['ageSeconds', 'lat', 'lng', 'updatedAt']);
    assert.ok(Date.parse(point.updatedAt) >= before && Date.parse(point.updatedAt) <= after, `${point.updatedAt} fuera de [${before}, ${after}]`);
    assert.ok(Number.isInteger(point.ageSeconds) && point.ageSeconds >= 0 && point.ageSeconds <= 5, `ageSeconds ${point.ageSeconds}`);
    // La misma regla como campo de la orden.
    const viaOrder = await orderLocationAs(order.id, token);
    assert.deepEqual([viaOrder.lat, viaOrder.lng, viaOrder.updatedAt], [point.lat, point.lng, point.updatedAt]);
  }

  // Pasan los segundos: el punto envejece sin cambiar su hora.
  const first = await locationAs(order.id, customer.token);
  await sleep(2200);
  const later = await locationAs(order.id, customer.token);
  assert.equal(later.updatedAt, first.updatedAt);
  assert.ok(later.ageSeconds >= 2 && later.ageSeconds <= 8, `ageSeconds ${later.ageSeconds}`);

  // El esquema no ofrece al repartidor ni su recorrido: pedirlos falla en la validación.
  for (const field of ['driverId', 'driver { id }', 'seq', 'at']) {
    const res = await gql(`query($o: ID!) { driverLocation(orderId: $o) { lat ${field} } }`, { o: order.id }, customer.token);
    assert.equal(res.errors?.[0]?.extensions?.code, 'GRAPHQL_VALIDATION_FAILED', field);
  }
  // Lo guardado en Redis tampoco lleva al repartidor: el de la orden es order.driverId.
  assert.doesNotMatch(JSON.stringify(await stored(order.id)), new RegExp(driver.id));
});

test('whoever cannot see the order cannot read its location (ORDER_VIEW_DENIED); unknown orders read as null', async () => {
  const { order, driver } = await deliveryOrder();
  await reportOk(order.id, 28.6353, -106.0889, driver.token);

  const stranger = await newCustomer();
  const otherDriver = await newDriver();
  const huerta = await huertaStore();
  const outsiders = [stranger.token, otherDriver.token, (await newStoreUser('STAFF', huerta.id)).token];
  for (const token of outsiders) {
    await forbidden('ORDER_VIEW_DENIED', LOCATION, { o: order.id }, token);
    await forbidden('ORDER_VIEW_DENIED', ORDER_LOCATION, { id: order.id }, token); // la propia orden se niega
  }
  await fails('UNAUTHENTICATED', LOCATION, { o: order.id });
  for (const id of ['000000000000000000000000', 'not-an-id']) assert.equal(await locationAs(id, stranger.token), null);
});

test('the location is null unless the order is DELIVERY and IN_DELIVERY (READY, pickup)', async () => {
  const ready = await deliveryOrder({ upTo: 'ACCEPTED' });
  for (const token of [ready.customer.token, ready.driver.token, await tokenOf('ADMIN')]) assert.equal(await locationAs(ready.order.id, token), null);

  // Una orden de recogida nunca tiene ubicación, aunque alguien escribiera una clave a mano.
  const customer = await newCustomer();
  const product = await newProduct();
  const pickup = await createOrder(customer, { mode: 'PICKUP', items: [{ productId: product.id, quantity: 1 }] });
  await moveOrder(pickup.id, ['CONFIRMED', 'PREPARING', 'READY'], await tokenOf('ADMIN'));
  await redis.set(keyOf(pickup.id), JSON.stringify(newLocationRecord({ lat: 28.6, lng: -106.1, nowMs: await redisNow() })), { expiration: { type: 'EX', value: 60 } });
  assert.equal(await locationAs(pickup.id, customer.token), null);
  await redis.del(keyOf(pickup.id));
  // Un reporte a una orden de recogida: nadie la tiene asignada.
  await forbidden('NO_DRIVER_ASSIGNED', REPORT, { o: pickup.id, lat: 28.6, lng: -106.1 }, ready.driver.token);
});

test('delivering the order deletes the point: null for everyone and the Redis key is gone', async () => {
  const { order, customer, driver } = await deliveryOrder();
  await reportOk(order.id, 28.6353, -106.0889, driver.token);
  assert.equal(await redis.exists(keyOf(order.id)), 1);
  assert.notEqual(await locationAs(order.id, customer.token), null);

  await moveOrder(order.id, ['DELIVERED'], driver.token);
  assert.ok(await gone(order.id), 'la clave sigue en Redis');
  for (const token of [customer.token, await tokenOf('STAFF'), await tokenOf('ADMIN'), driver.token]) {
    assert.equal(await locationAs(order.id, token), null);
    assert.equal(await orderLocationAs(order.id, token), null);
  }
});

test('cancelling an order in transit deletes the point too (customer and staff)', async () => {
  for (const cancelledBy of ['customer', 'staff']) {
    const { order, customer, driver } = await deliveryOrder();
    await reportOk(order.id, 28.6353, -106.0889, driver.token);
    assert.equal(await redis.exists(keyOf(order.id)), 1);

    const token = cancelledBy === 'customer' ? customer.token : await tokenOf('STAFF');
    assert.equal((await ok(CANCEL, { id: order.id }, token)).cancelOrder.status, 'CANCELLED');
    assert.ok(await gone(order.id), `${cancelledBy}: la clave sigue en Redis`);
    assert.equal(await locationAs(order.id, customer.token), null);
    assert.equal(await locationAs(order.id, await tokenOf('ADMIN')), null);
    const ext = await fails('INVALID_ORDER_STATE', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }, driver.token);
    assert.equal(ext.status, 'CANCELLED');
  }
});

test('a point written after the order ended (a report in flight) is never served', async () => {
  const { order, customer, driver } = await deliveryOrder();
  await reportOk(order.id, 28.6353, -106.0889, driver.token);
  await moveOrder(order.id, ['DELIVERED'], driver.token);
  assert.ok(await gone(order.id));

  // Un reporte que ya había leído la orden IN_DELIVERY puede escribir después del borrado: la clave
  // queda hasta que venza su TTL, pero la lectura exige IN_DELIVERY y no la sirve.
  await redis.set(keyOf(order.id), JSON.stringify(newLocationRecord({ lat: 28.6, lng: -106.1, nowMs: await redisNow() })), { expiration: { type: 'EX', value: 60 } });
  for (const token of [customer.token, await tokenOf('STAFF'), await tokenOf('ADMIN'), driver.token]) {
    assert.equal(await locationAs(order.id, token), null);
    assert.equal(await orderLocationAs(order.id, token), null);
  }
  await redis.del(keyOf(order.id));
});

test('rate limit: at most one report per second per order; the faster ones return true and are ignored', async () => {
  const { order, customer, driver } = await deliveryOrder();
  const started = Date.now();
  await reportOk(order.id, 28.1, -106.1, driver.token);
  await Promise.all([[28.2, -106.2], [28.3, -106.3]].map(([lat, lng]) => reportOk(order.id, lat, lng, driver.token))); // en el mismo segundo
  assert.ok(Date.now() - started < 1000, 'la máquina tardó más de un segundo en tres peticiones: la prueba no puede comprobar el límite');
  const kept = await stored(order.id);
  assert.deepEqual([kept.lat, kept.lng], [28.1, -106.1]); // se queda el primero
  assert.deepEqual([(await locationAs(order.id, customer.token)).lat], [28.1]);

  await sleep(1100);
  await reportOk(order.id, 28.4, -106.4, driver.token);
  const next = await stored(order.id);
  assert.deepEqual([next.lat, next.lng], [28.4, -106.4]); // pasó el segundo: reemplaza
  assert.ok(next.seq - kept.seq >= 1000);
  assert.ok(Date.parse(next.at) > Date.parse(kept.at));
});

test('rate limit: a concurrent burst all returns true and the stored point is one of them', async () => {
  const { order, driver } = await deliveryOrder();
  const lats = [10, 11, 12, 13, 14, 15];
  const results = await Promise.all(lats.map(lat => gql(REPORT, { o: order.id, lat, lng: -106.1 }, driver.token)));
  for (const res of results) assert.equal(res.data?.reportDriverLocation, true, JSON.stringify(res));
  const point = await stored(order.id);
  assert.ok(lats.includes(point.lat), `lat ${point.lat}`); // uno solo, de los seis
});

test('the point has the stored shape and expires with DRIVER_LOCATION_TTL_SECONDS; once expired it reads null and reporting resumes', async () => {
  const { order, customer, driver } = await deliveryOrder();
  assert.equal(await redis.ttl(keyOf(order.id)), -2); // sin clave
  await reportOk(order.id, 28.6353, -106.0889, driver.token);

  const point = await stored(order.id);
  assert.deepEqual(Object.keys(point).sort(), ['at', 'lat', 'lng', 'seq']); // sin driverId: el repartidor es el de la orden
  assert.deepEqual([point.lat, point.lng], [28.6353, -106.0889]);
  assert.ok(Math.abs(Date.parse(point.at) - (await redisNow())) < 10_000); // hora de Redis
  assert.equal(point.seq, Date.parse(point.at));

  const ttl = await redis.ttl(keyOf(order.id));
  assert.ok(ttl > 0 && ttl <= TTL && ttl >= TTL - 10, `TTL ${ttl}, esperado ~${TTL}`);

  // Caduca sola si el repartidor deja de reportar: se acorta el TTL en vez de esperar 2 minutos.
  assert.equal(await redis.expire(keyOf(order.id), 1), 1);
  await sleep(1500);
  assert.equal(await redis.exists(keyOf(order.id)), 0);
  assert.equal(await locationAs(order.id, customer.token), null);
  assert.equal(await orderLocationAs(order.id, customer.token), null);
  // Sin punto ya no hay límite que aplicar: el siguiente reporte se guarda y recupera el TTL completo.
  await reportOk(order.id, 28.7, -106.2, driver.token);
  assert.equal((await locationAs(order.id, customer.token)).lat, 28.7);
  assert.ok((await redis.ttl(keyOf(order.id))) >= TTL - 10);
});

// ---------- Un solo reloj: el de Redis ----------
// Si el reloj de la API se adelantara, o dos réplicas no coincidieran, un punto guardado con hora
// del futuro congelaría la clave (todo reporte siguiente se ignoraría con `true`) y, al leerlo, una edad
// negativa recortada a 0 haría pasar por reciente un punto viejo. La hora la da Redis y un punto
// guardado del futuro no frena las escrituras. Se simula escribiendo la clave con hora adelantada.
test('a stored point with a future time never freezes the writes, and is not served as fresh', async () => {
  for (const aheadMs of [60_000, 3_600_000]) {
    const { order, customer, driver } = await deliveryOrder();
    const future = newLocationRecord({ lat: 11, lng: 22, nowMs: (await redisNow()) + aheadMs });
    await redis.set(keyOf(order.id), JSON.stringify(future), { expiration: { type: 'EX', value: 120 } });

    // Más allá de la tolerancia no es confiable: no se sirve (ni parece reciente).
    assert.equal(await locationAs(order.id, customer.token), null, `+${aheadMs} ms`);
    assert.equal(await orderLocationAs(order.id, customer.token), null);

    // El reporte siguiente sí se guarda (no se ignora por "llegar antes que el guardado").
    await reportOk(order.id, 28.6, -106.1, driver.token);
    const point = await stored(order.id);
    assert.deepEqual([point.lat, point.lng], [28.6, -106.1], `+${aheadMs} ms`);
    assert.ok(point.seq <= (await redisNow()), 'el punto nuevo lleva la hora de Redis, no la del futuro');
    const served = await locationAs(order.id, customer.token);
    assert.deepEqual([served.lat, served.lng], [28.6, -106.1]);
    assert.ok(served.ageSeconds >= 0 && served.ageSeconds <= 5, `ageSeconds ${served.ageSeconds}`);
    assert.ok((await redis.ttl(keyOf(order.id))) >= TTL - 10); // el TTL también se renovó

    // Y el punto nuevo vuelve a regirse por el límite de 1 por segundo.
    await reportOk(order.id, 29, -106.2, driver.token);
    assert.equal((await stored(order.id)).lat, 28.6);
  }
});

test('a stored point slightly ahead (within the tolerance) is served as fresh (ageSeconds 0) and is still replaced by the next report', async () => {
  const { order, customer, driver } = await deliveryOrder();
  const slightly = newLocationRecord({ lat: 11, lng: 22, nowMs: (await redisNow()) + FUTURE_TOLERANCE_MS - 2_000 });
  await redis.set(keyOf(order.id), JSON.stringify(slightly), { expiration: { type: 'EX', value: 120 } });
  const served = await locationAs(order.id, customer.token);
  assert.deepEqual([served.lat, served.lng, served.ageSeconds], [11, 22, 0]);
  await reportOk(order.id, 28.6, -106.1, driver.token);
  assert.equal((await stored(order.id)).lat, 28.6);
});

// ---------- La bitácora no se inunda ----------
const EVENT_FIELDS = 'type category actorId success reason metadata occurredAt';
const BY_ACTOR = `query($id: ID!) { auditByActor(actorId: $id, limit: 100) { ${EVENT_FIELDS} } }`;
const BY_TARGET = `query($id: ID!) { auditByTarget(targetType: "Order", targetId: $id, limit: 100) { ${EVENT_FIELDS} } }`;
const DENIED_BY_DAY = `query($day: String) { auditEvents(category: SECURITY, day: $day, type: "ACCESS_DENIED", limit: 500) { ${EVENT_FIELDS} } }`;

test('a successful or unauthenticated location report writes no audit event; a forbidden one is audited', async () => {
  const startedAt = Date.now();
  const { order, customer, driver } = await deliveryOrder();
  const admin = await tokenOf('ADMIN');

  await reportOk(order.id, 28.6353, -106.0889, driver.token); // bien: nada que registrar
  for (let i = 0; i < 3; i += 1) await fails('UNAUTHENTICATED', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }); // sin sesión
  // Un FORBIDDEN (el cliente no es repartidor) sí se registra: sirve de marca para saber que la bitácora ya procesó lo anterior.
  await forbidden('PERMISSION_REQUIRED', REPORT, { o: order.id, lat: 28.6, lng: -106.1 }, customer.token);
  const marker = await eventually(async () => {
    const { auditByActor } = await ok(BY_ACTOR, { id: customer.id }, admin);
    return auditByActor.find(e => e.type === 'ACCESS_DENIED' && JSON.parse(e.metadata).operation === 'reportDriverLocation');
  }, { what: 'ACCESS_DENIED del FORBIDDEN de reportDriverLocation' });
  assert.equal(marker.category, 'SECURITY');
  assert.equal(JSON.parse(marker.metadata).code, 'FORBIDDEN');

  // Los UNAUTHENTICATED de reportDriverLocation (actor ANONYMOUS) no dejaron ACCESS_DENIED.
  const days = [...new Set([today(), new Date(startedAt).toISOString().slice(0, 10)])];
  for (const day of days) {
    const { auditEvents } = await ok(DENIED_BY_DAY, { day }, admin);
    const anonymous = auditEvents.filter(e => e.actorId === 'ANONYMOUS' && Date.parse(e.occurredAt) >= startedAt && JSON.parse(e.metadata).operation === 'reportDriverLocation');
    assert.deepEqual(anonymous, [], `ACCESS_DENIED anónimos de reportDriverLocation el ${day}`);
  }
  // El reporte exitoso tampoco: ni un acceso denegado del repartidor, ni un evento de ubicación en su historia ni en la de la orden.
  const { auditByActor: driverEvents } = await ok(BY_ACTOR, { id: driver.id }, admin);
  assert.deepEqual(driverEvents.filter(e => e.type === 'ACCESS_DENIED' || /LOCATION/.test(e.type)), []);
  const { auditByTarget: orderEvents } = await ok(BY_TARGET, { id: order.id }, admin);
  assert.deepEqual(orderEvents.filter(e => /LOCATION/.test(e.type)), []);
});

// ---------- La escritura atómica (script Lua) contra el Redis de pruebas ----------
// El punto de una orden se escribe con un script que compara y guarda en un solo paso; se prueba
// directo con claves de órdenes inventadas (sin pasar por GraphQL), para forzar llegadas fuera de orden.
// Las horas son relativas a la de Redis y están en el pasado (una hora atrás) salvo en las pruebas
// del futuro, que lo dicen: el script compara con el TIME de Redis.
const fakeOrderId = () => `${Date.now().toString(16).padStart(12, '0')}${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
const pointAt = (seq, lat = 28.6) => newLocationRecord({ lat, lng: -106.1, nowMs: seq });
const HOUR = 3_600_000;

test('atomic write: a late (out-of-order) report never replaces a newer point', async () => {
  const store = createLocationStore(redis, { ttlSeconds: 60 });
  const id = fakeOrderId();
  try {
    const base = (await redisNow()) - HOUR;
    assert.equal(await store.save(id, pointAt(base + 10_000, 10)), true);
    // Llega tarde un reporte más viejo (su petición esperó en la red o en MongoDB): se ignora.
    assert.equal(await store.save(id, pointAt(base + 5_000, 5)), false);
    assert.equal(await store.save(id, pointAt(base + 9_999, 9)), false);
    assert.equal((await store.get(id)).record.lat, 10);
    // Un reporte más nuevo, pero a menos de un segundo, tampoco lo reemplaza.
    assert.equal(await store.save(id, pointAt(base + 10_999, 11)), false);
    assert.equal((await store.get(id)).record.lat, 10);
    // Uno posterior por más de un segundo sí.
    assert.equal(await store.save(id, pointAt(base + 11_000, 12)), true);
    const { record } = await store.get(id);
    assert.deepEqual([record.lat, record.seq], [12, base + 11_000]);
    // Otro tardío después de ese: se ignora.
    assert.equal(await store.save(id, pointAt(base + 10_500, 13)), false);
    assert.equal((await store.get(id)).record.lat, 12);
    assert.ok((await redis.ttl(keyOf(id))) > 0);
  } finally {
    await redis.del(keyOf(id));
  }
});

test('atomic write: whatever order a set of reports arrives in, the newest one ends up stored', async () => {
  const store = createLocationStore(redis, { ttlSeconds: 60 });
  const base = (await redisNow()) - HOUR;
  const seqs = Array.from({ length: 12 }, (_, i) => base + i * 1_000); // separados justo por el intervalo mínimo
  const newest = seqs.at(-1);
  const orders = {
    ascending: seqs,
    descending: [...seqs].reverse(),
    interleaved: [...seqs.filter((_, i) => i % 2 === 0), ...seqs.filter((_, i) => i % 2 === 1).reverse()],
    shuffled: [7, 2, 11, 0, 5, 9, 3, 10, 1, 6, 8, 4].map(i => seqs[i]),
  };
  for (const [name, arrival] of Object.entries(orders)) {
    const id = fakeOrderId();
    try {
      // En serie (el orden de llegada es el indicado) y en paralelo (Redis las serializa).
      for (const seq of arrival) await store.save(id, pointAt(seq, 1 + (seq - base) / 1000));
      assert.equal((await store.get(id)).record.seq, newest, `${name}, en serie`);
      await redis.del(keyOf(id));
      await Promise.all(arrival.map(seq => store.save(id, pointAt(seq, 1 + (seq - base) / 1000))));
      assert.equal((await store.get(id)).record.seq, newest, `${name}, en paralelo`);
    } finally {
      await redis.del(keyOf(id));
    }
  }
});

test('atomic write: the script and shouldReplaceLocation agree (past and future stored points), and an unreadable value is overwritten', async () => {
  const store = createLocationStore(redis, { ttlSeconds: 60 });
  const now = await redisNow();
  // [hora guardada, hora del reporte nuevo], ambas relativas a la hora de Redis: los guardados del
  // futuro están a más de un segundo (margen para lo que tarda el script en correr).
  const cases = [
    [-HOUR, -HOUR], [-HOUR, -HOUR + 999], [-HOUR, -HOUR + 1000], [-HOUR, -HOUR + 1001], [-HOUR, -HOUR + 60_000],
    [-HOUR + 5_000, -HOUR], [-HOUR + 5_000, -HOUR + 4_000], [-HOUR + 5_000, -HOUR + 4_500], [-HOUR + 5_000, -HOUR + 5_500],
    [-HOUR + 5_000, -HOUR + 6_000], [-HOUR + 5_000, -HOUR + 6_001],
    [60_000, 0], [60_000, -2_000], [60_000, 60_000], [60_000, 61_000], [HOUR, 0], [HOUR, HOUR], [2_000, 0], [2_000, -5_000], // guardado del futuro
  ];
  for (const [storedDelta, newDelta] of cases) {
    const id = fakeOrderId();
    try {
      assert.equal(await store.save(id, pointAt(now + storedDelta, 1)), true); // sin nada guardado: siempre se guarda
      const expected = shouldReplaceLocation(now + storedDelta, now + newDelta, now);
      assert.equal(await store.save(id, pointAt(now + newDelta, 2)), expected, `guardado ${storedDelta}, nuevo ${newDelta}`);
      assert.equal((await store.get(id)).record.lat, expected ? 2 : 1, `guardado ${storedDelta}, nuevo ${newDelta}`);
    } finally {
      await redis.del(keyOf(id));
    }
  }

  const id = fakeOrderId();
  try {
    for (const garbage of ['no es json', '[]', '{"seq":"x"}', '{}']) {
      await redis.set(keyOf(id), garbage, { expiration: { type: 'EX', value: 60 } });
      assert.equal(await store.save(id, pointAt(now - HOUR, 7)), true, garbage);
      assert.equal((await store.get(id)).record.lat, 7);
    }
  } finally {
    await redis.del(keyOf(id));
  }
});

test('atomic write: a stored point from the future is replaced, and read back it is not trustworthy until replaced', async () => {
  const store = createLocationStore(redis, { ttlSeconds: 60 });
  const id = fakeOrderId();
  try {
    const now = await redisNow();
    assert.equal(await store.save(id, pointAt(now + 60_000, 1)), true);
    const { record, nowMs } = await store.get(id);
    assert.equal(record.lat, 1);
    assert.equal(locationView(record, nowMs), null); // más allá de la tolerancia: no se sirve
    assert.equal(await store.save(id, pointAt(await store.now(), 2)), true); // el siguiente reporte lo reemplaza
    const next = await store.get(id);
    assert.equal(next.record.lat, 2);
    assert.deepEqual(Object.keys(locationView(next.record, next.nowMs)).sort(), ['ageSeconds', 'lat', 'lng', 'updatedAt']);
    assert.ok(locationView(next.record, next.nowMs).ageSeconds <= 2);
  } finally {
    await redis.del(keyOf(id));
  }
});

test('atomic write: the store clock is the Redis clock; the point carries the TTL given to the store; a missing point reads null', async () => {
  const id = fakeOrderId();
  try {
    const store = createLocationStore(redis, { ttlSeconds: 45 });
    const before = await redisNow();
    const now = await store.now();
    assert.ok(now >= before && now <= (await redisNow()), `store.now() ${now}`);
    assert.equal((await store.get(id)).record, null);
    assert.equal(await store.save(id, pointAt(now - HOUR)), true);
    const ttl = await redis.ttl(keyOf(id));
    assert.ok(ttl > 35 && ttl <= 45, `TTL ${ttl}`);
    assert.equal(await store.clear(id), true);
    assert.equal((await store.get(id)).record, null);
    assert.equal(await store.clear(id), true); // borrar lo que no existe tampoco es un error
  } finally {
    await redis.del(keyOf(id));
  }
});
