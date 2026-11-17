// Decisión pura de la migración del marketplace (src/domain/migrations.js):
// a qué sucursal van los productos y paquetes sin storeId. La aplicación
// (contar y escribir en MongoDB) se prueba en test/integration/migration.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planCatalogStoreBackfill, planStatusHistoryBackfill } from '../../src/domain/migrations.js';

const store = (id, createdAt, name = `Sucursal ${id}`) => ({ _id: { toString: () => id }, name, createdAt });

describe('planCatalogStoreBackfill', () => {
  test('nada pendiente: NONE (la segunda corrida no cambia nada)', () => {
    assert.deepEqual(planCatalogStoreBackfill({ stores: [store('S1', '2026-01-01')], pending: { products: 0, packages: 0 } }), { action: 'NONE' });
    assert.deepEqual(planCatalogStoreBackfill({ stores: [] }), { action: 'NONE' });
    assert.deepEqual(planCatalogStoreBackfill(), { action: 'NONE' });
  });

  test('asigna a la sucursal más antigua por createdAt, con los conteos', () => {
    const stores = [store('S2', '2026-05-01T00:00:00Z'), store('S1', new Date('2026-01-01T00:00:00Z'), 'CARNYFRUT Centro'), store('S3', '2026-09-01')];
    assert.deepEqual(planCatalogStoreBackfill({ stores, pending: { products: 11, packages: 1 } }), {
      action: 'ASSIGN', storeId: 'S1', storeName: 'CARNYFRUT Centro', storeActive: true, products: 11, packages: 1,
    });
  });

  test('elige la sucursal ACTIVA más antigua, no la más antigua a secas', () => {
    const stores = [store('S1', '2026-01-01'), store('S2', '2026-05-01'), store('S3', '2026-03-01')];
    stores[0].isActive = false;
    stores[2].isActive = false;
    const plan = planCatalogStoreBackfill({ stores, pending: { products: 2 } });
    assert.deepEqual([plan.storeId, plan.storeActive], ['S2', true]);
    // isActive ausente cuenta como activa.
    assert.equal(planCatalogStoreBackfill({ stores: [{ ...store('S1', '2026-01-01'), isActive: false }, store('S2', '2026-05-01')], pending: { products: 1 } }).storeId, 'S2');
  });

  test('hay sucursales pero ninguna activa: la más antigua, con storeActive: false (se avisa)', () => {
    const stores = [{ ...store('S2', '2026-05-01'), isActive: false }, { ...store('S1', '2026-01-01'), isActive: false }];
    const plan = planCatalogStoreBackfill({ stores, pending: { packages: 1 } });
    assert.deepEqual([plan.action, plan.storeId, plan.storeActive], ['ASSIGN', 'S1', false]);
  });

  test('solo paquetes o solo productos pendientes también se asignan', () => {
    const stores = [store('S1', '2026-01-01')];
    assert.equal(planCatalogStoreBackfill({ stores, pending: { products: 0, packages: 2 } }).action, 'ASSIGN');
    assert.equal(planCatalogStoreBackfill({ stores, pending: { products: 3 } }).products, 3);
  });

  test('empate de fecha: el id menor; sin fecha: al final', () => {
    const same = '2026-01-01T00:00:00Z';
    assert.equal(planCatalogStoreBackfill({ stores: [store('b', same), store('a', same)], pending: { products: 1 } }).storeId, 'a');
    assert.equal(planCatalogStoreBackfill({ stores: [store('a', null), store('b', '2026-03-01')], pending: { products: 1 } }).storeId, 'b');
  });

  test('acepta id en lugar de _id', () => {
    assert.equal(planCatalogStoreBackfill({ stores: [{ id: 'X', name: 'X', createdAt: '2026-01-01' }], pending: { packages: 1 } }).storeId, 'X');
  });

  test('pendientes pero ninguna sucursal: NO_STORE (se avisa y quedan sin listar)', () => {
    assert.deepEqual(planCatalogStoreBackfill({ stores: [], pending: { products: 4, packages: 1 } }), { action: 'NO_STORE', products: 4, packages: 1 });
  });
});

describe('planStatusHistoryBackfill', () => {
  const createdAt = new Date('2026-01-01T10:00:00Z');
  const updatedAt = new Date('2026-01-02T11:00:00Z');
  const entry = (status, at) => ({ status, at, byUserId: null, byRole: null, inferred: true });

  test('orden PENDING: solo PENDING en createdAt', () => {
    assert.deepEqual(planStatusHistoryBackfill({ status: 'PENDING', createdAt, updatedAt }), [entry('PENDING', createdAt)]);
  });

  test('orden que ya cambió: PENDING en createdAt y el estado actual en updatedAt', () => {
    for (const status of ['CONFIRMED', 'DELIVERED', 'CANCELLED']) {
      assert.deepEqual(planStatusHistoryBackfill({ status, createdAt, updatedAt }), [entry('PENDING', createdAt), entry(status, updatedAt)]);
    }
  });

  test('todas las entradas son inferidas y sin autor', () => {
    for (const e of planStatusHistoryBackfill({ status: 'READY', createdAt, updatedAt })) {
      assert.equal(e.inferred, true);
      assert.equal(e.byUserId, null);
      assert.equal(e.byRole, null);
    }
  });

  test('historial que no empieza en PENDING: solo antepone el PENDING inferido', () => {
    const real = { status: 'CONFIRMED', at: updatedAt, byUserId: null, byRole: 'STAFF', inferred: false };
    assert.deepEqual(planStatusHistoryBackfill({ status: 'CONFIRMED', createdAt, updatedAt, statusHistory: [real] }), [entry('PENDING', createdAt)]);
  });

  test('idempotente: con historial completo no decide nada (null); arreglo vacío o ausente sí', () => {
    assert.equal(planStatusHistoryBackfill({ status: 'PENDING', createdAt, updatedAt, statusHistory: [entry('PENDING', createdAt)] }), null);
    assert.equal(planStatusHistoryBackfill({ status: 'CONFIRMED', createdAt, updatedAt, statusHistory: [entry('PENDING', createdAt), entry('CONFIRMED', updatedAt)] }), null);
    assert.ok(planStatusHistoryBackfill({ status: 'PENDING', createdAt, updatedAt, statusHistory: [] }));
    assert.ok(planStatusHistoryBackfill({ status: 'PENDING', createdAt, updatedAt }));
  });

  test('sin updatedAt usa createdAt; sin ninguna fecha no falla', () => {
    assert.deepEqual(planStatusHistoryBackfill({ status: 'READY', createdAt }).map(e => e.at), [createdAt, createdAt]);
    assert.equal(planStatusHistoryBackfill({ status: 'PENDING' }).length, 1);
  });
});
