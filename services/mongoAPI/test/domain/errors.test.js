// Contrato de errores (src/domain/errors.js): el catálogo y el código + los datos
// estructurados de cada regla del dominio. Los clientes traducen por
// extensions.code y estos campos; si cambian, hay que avisarles. Sin bases de datos.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, FORBIDDEN_REASONS, DomainError, notFoundError, isErrorCode, ENTITY_LABELS } from '../../src/domain/errors.js';
import {
  assertProductPersistable, assertPackagePersistable, Product, Package, assertModeConsistency, priceOrder,
  assertQuoteStillValid, assertTransition, PACKAGE_MIN_ITEMS, PACKAGE_MAX_ITEMS, orderNotAvailableError,
  assertPackageSameStore, linesStoreId, cartStoreId, assertCartAccepts,
} from '../../src/domain/entities.js';
import * as access from '../../src/domain/access.js';

const prod = (id, over = {}) => ({ id, name: `Producto ${id}`, price: 100, stock: 10, unit: 'UNIDAD', isActive: true, discounts: [], ...over });
const pkgOf = (items, over = {}) => new Package({ id: 'PK1', name: 'Combo asada', price: 250, isActive: true, ...over }, items);

// Lanza un DomainError con ese código y esas extensions (exactas, sin campos de más).
const expectError = (fn, code, extensions = {}) => assert.throws(fn, e => {
  assert.ok(e instanceof DomainError, `debe ser DomainError, fue ${e?.name}: ${e?.message}`);
  assert.deepEqual(e.extensions, { ...extensions, code });
  return true;
});

describe('catálogo de códigos', () => {
  const entries = Object.entries(ERROR_CODES);

  test('los códigos son UPPER_SNAKE y únicos (las llaves de un objeto no se repiten)', () => {
    assert.ok(entries.length > 0);
    for (const [code] of entries) assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, code);
    assert.equal(new Set(entries.map(([c]) => c)).size, entries.length);
  });

  test('cada código tiene descripción en español y la lista de campos de extensions', () => {
    for (const [code, def] of entries) {
      assert.equal(typeof def.description, 'string', code);
      assert.ok(def.description.trim().length >= 10, `${code} sin descripción`);
      assert.ok(Array.isArray(def.fields), `${code} sin fields`);
      for (const field of def.fields) assert.match(field, /^[a-z][A-Za-z0-9]*\??$/, `${code}.${field} no es camelCase`);
      assert.ok(def.source === undefined || def.source === 'apollo', code);
    }
  });

  test('los códigos que ya consumían los clientes siguen existiendo', () => {
    for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'SERVICE_UNAVAILABLE', 'CART_EMPTY', 'QUOTE_EXPIRED',
      'PRICE_CHANGED', 'QUOTE_MISMATCH', 'CART_HAS_UNAVAILABLE_ITEMS']) assert.ok(isErrorCode(code), code);
  });

  test('el código genérico DOMAIN_RULE_VIOLATION ya no existe', () => {
    assert.equal(isErrorCode('DOMAIN_RULE_VIOLATION'), false);
  });

  test('las razones de FORBIDDEN son UPPER_SNAKE con descripción', () => {
    for (const [reason, description] of Object.entries(FORBIDDEN_REASONS)) {
      assert.match(reason, /^[A-Z]+(_[A-Z]+)*$/);
      assert.ok(description.length > 5);
    }
  });

  test('isErrorCode rechaza lo que no es una llave propia del catálogo', () => {
    assert.equal(isErrorCode('toString'), false);
    assert.equal(isErrorCode(undefined), false);
    assert.equal(isErrorCode(''), false);
  });
});

describe('NOT_FOUND', () => {
  test('mismo mensaje de siempre y entity/id estructurados', () => {
    const e = notFoundError('PRODUCT', 'abc');
    assert.equal(e.message, 'Producto no encontrado (abc).');
    assert.deepEqual(e.extensions, { code: 'NOT_FOUND', entity: 'PRODUCT', id: 'abc' });
  });
  test('sin id: sin paréntesis y id null; el id se normaliza a cadena', () => {
    const e = notFoundError('SHOPPING_LIST', undefined);
    assert.equal(e.message, 'Lista no encontrado.');
    assert.equal(e.extensions.id, null);
    assert.equal(notFoundError('ORDER', 12).extensions.id, '12');
  });
  test('cada entidad conocida tiene etiqueta', () => {
    for (const entity of Object.keys(ENTITY_LABELS)) assert.equal(notFoundError(entity, 'x').extensions.entity, entity);
  });
});

describe('reglas de producto y paquete', () => {
  const okProduct = { name: 'Arrachera', price: 10, stock: 1 };
  const okItems = [{ productId: 'A', quantity: 1 }, { productId: 'B', quantity: 1 }];
  const okPackage = { name: 'Combo', price: 100, items: okItems };

  test('INVALID_NAME (producto y paquete) con minLength', () => {
    expectError(() => assertProductPersistable({ ...okProduct, name: 'A' }), 'INVALID_NAME', { entity: 'PRODUCT', minLength: 2 });
    expectError(() => assertProductPersistable({ ...okProduct, name: undefined }), 'INVALID_NAME', { entity: 'PRODUCT', minLength: 2 });
    expectError(() => assertPackagePersistable({ ...okPackage, name: ' ' }), 'INVALID_NAME', { entity: 'PACKAGE', minLength: 2 });
  });
  test('INVALID_PRICE (producto y paquete)', () => {
    expectError(() => assertProductPersistable({ ...okProduct, price: 0 }), 'INVALID_PRICE', { entity: 'PRODUCT' });
    expectError(() => assertPackagePersistable({ ...okPackage, price: -1 }), 'INVALID_PRICE', { entity: 'PACKAGE' });
    expectError(() => new Product(prod('A', { price: 0 })).assertValidForSale(), 'INVALID_PRICE', { entity: 'PRODUCT' });
  });
  test('INVALID_STOCK', () => {
    for (const stock of [-1, 1.5, '3']) expectError(() => assertProductPersistable({ ...okProduct, stock }), 'INVALID_STOCK');
  });
  test('PACKAGE_SIZE_OUT_OF_RANGE con count, min y max', () => {
    const range = { min: PACKAGE_MIN_ITEMS, max: PACKAGE_MAX_ITEMS };
    expectError(() => assertPackagePersistable({ ...okPackage, items: [okItems[0]] }), 'PACKAGE_SIZE_OUT_OF_RANGE', { count: 1, ...range });
    expectError(() => assertPackagePersistable({ ...okPackage, items: undefined }), 'PACKAGE_SIZE_OUT_OF_RANGE', { count: 0, ...range });
    const many = Array.from({ length: PACKAGE_MAX_ITEMS + 1 }, (_, i) => ({ productId: `P${i}`, quantity: 1 }));
    expectError(() => assertPackagePersistable({ ...okPackage, items: many }), 'PACKAGE_SIZE_OUT_OF_RANGE', { count: PACKAGE_MAX_ITEMS + 1, ...range });
  });
  test('INVALID_PACKAGE_ITEM cuando falta productId', () => {
    expectError(() => assertPackagePersistable({ ...okPackage, items: [{ quantity: 1 }, okItems[1]] }), 'INVALID_PACKAGE_ITEM');
    expectError(() => assertPackagePersistable({ ...okPackage, items: [null, okItems[1]] }), 'INVALID_PACKAGE_ITEM');
  });
  test('INVALID_QUANTITY en el contenido del paquete: context PACKAGE_ITEM', () => {
    expectError(() => assertPackagePersistable({ ...okPackage, items: [{ productId: 'A', quantity: 0 }, okItems[1]] }), 'INVALID_QUANTITY', { context: 'PACKAGE_ITEM' });
  });
  test('DUPLICATE_PACKAGE_PRODUCT', () => {
    expectError(() => assertPackagePersistable({ ...okPackage, items: [okItems[0], okItems[0]] }), 'DUPLICATE_PACKAGE_PRODUCT');
  });
});

describe('ITEM_UNAVAILABLE', () => {
  const A = prod('A');
  const B = prod('B');
  test('producto desactivado', () => {
    expectError(() => new Product(prod('X', { isActive: false })).assertAvailable(), 'ITEM_UNAVAILABLE', { itemType: 'PRODUCT', id: 'X', name: 'Producto X' });
  });
  test('paquete desactivado', () => {
    expectError(() => pkgOf([{ product: A, quantity: 1 }, { product: B, quantity: 1 }], { isActive: false }).assertAvailable(),
      'ITEM_UNAVAILABLE', { itemType: 'PACKAGE', id: 'PK1', name: 'Combo asada' });
  });
  test('paquete con un producto desactivado: trae el componente', () => {
    expectError(() => pkgOf([{ product: A, quantity: 1 }, { product: prod('C', { isActive: false }), quantity: 1 }]).assertAvailable(),
      'ITEM_UNAVAILABLE', { itemType: 'PACKAGE', id: 'PK1', name: 'Combo asada', componentId: 'C', componentName: 'Producto C' });
  });
});

describe('reglas de la orden', () => {
  const store = { id: 'S1', deliveryFee: 40, freeDeliveryThreshold: 500 };
  const A = prod('A', { stock: 5 });
  const base = { mode: 'PICKUP', store, lines: [{ product: A, quantity: 1 }] };

  test('INVALID_ORDER_MODE', () => {
    expectError(() => assertModeConsistency({ mode: 'DRONE', store }), 'INVALID_ORDER_MODE', { mode: 'DRONE' });
    expectError(() => assertModeConsistency({ store }), 'INVALID_ORDER_MODE', { mode: null });
  });
  test('STORE_REQUIRED', () => {
    expectError(() => assertModeConsistency({ mode: 'PICKUP' }), 'STORE_REQUIRED');
  });
  test('DELIVERY_ADDRESS_REQUIRED solo al confirmar', () => {
    expectError(() => assertModeConsistency({ mode: 'DELIVERY', store, requireAddress: true }), 'DELIVERY_ADDRESS_REQUIRED');
  });
  test('EMPTY_ORDER', () => {
    expectError(() => priceOrder({ ...base, lines: [] }), 'EMPTY_ORDER');
    expectError(() => priceOrder({ ...base, lines: undefined }), 'EMPTY_ORDER');
  });
  test('INVALID_QUANTITY en la partida: context ORDER_LINE', () => {
    for (const quantity of [0, -1, 1.5]) expectError(() => priceOrder({ ...base, lines: [{ product: A, quantity }] }), 'INVALID_QUANTITY', { context: 'ORDER_LINE' });
  });
  test('ITEM_UNAVAILABLE al cotizar un producto desactivado', () => {
    expectError(() => priceOrder({ ...base, lines: [{ product: prod('X', { isActive: false }), quantity: 1 }] }),
      'ITEM_UNAVAILABLE', { itemType: 'PRODUCT', id: 'X', name: 'Producto X' });
  });
  test('INSUFFICIENT_STOCK con lo pedido y lo disponible (sumando paquete y producto suelto)', () => {
    expectError(() => priceOrder({ ...base, lines: [{ product: A, quantity: 6 }] }),
      'INSUFFICIENT_STOCK', { productId: 'A', name: 'Producto A', requested: 6, available: 5 });
    const B = prod('B', { stock: 5 });
    const k = pkgOf([{ product: A, quantity: 2 }, { product: B, quantity: 1 }]);
    expectError(() => priceOrder({ ...base, lines: [{ package: k, quantity: 1 }, { product: A, quantity: 4 }] }),
      'INSUFFICIENT_STOCK', { productId: 'A', name: 'Producto A', requested: 6, available: 5 });
  });
  test('el mensaje en español no cambió', () => {
    assert.throws(() => priceOrder({ ...base, lines: [{ product: A, quantity: 6 }] }),
      { message: 'Sin stock suficiente de "Producto A" (se necesitan 6, disponible: 5).' });
  });
});

describe('cotización confirmada', () => {
  const quote = { mode: 'PICKUP', storeId: 'S1', items: [{ productId: 'A', quantity: 1, unitPrice: 10, discountPercent: 0, lineTotal: 10 }], deliveryFee: 0, total: 10 };
  test('QUOTE_MISMATCH y PRICE_CHANGED conservan su código', () => {
    expectError(() => assertQuoteStillValid(quote, { ...quote, mode: 'DELIVERY' }), 'QUOTE_MISMATCH');
    expectError(() => assertQuoteStillValid(quote, { ...quote, total: 11 }), 'PRICE_CHANGED');
  });
});

describe('transiciones de estado', () => {
  test('INVALID_ORDER_STATUS', () => {
    expectError(() => assertTransition('PENDING', 'SHIPPED', 'DELIVERY'), 'INVALID_ORDER_STATUS', { status: 'SHIPPED' });
  });
  test('ORDER_ALREADY_IN_STATUS', () => {
    expectError(() => assertTransition('READY', 'READY', 'DELIVERY'), 'ORDER_ALREADY_IN_STATUS', { status: 'READY' });
  });
  test('INVALID_STATUS_TRANSITION con from y to', () => {
    expectError(() => assertTransition('DELIVERED', 'PENDING', 'DELIVERY'), 'INVALID_STATUS_TRANSITION', { from: 'DELIVERED', to: 'PENDING' });
    expectError(() => assertTransition('BOGUS', 'CONFIRMED', 'DELIVERY'), 'INVALID_STATUS_TRANSITION', { from: 'BOGUS', to: 'CONFIRMED' });
  });
  test('INVALID_STATUS_TRANSITION: una orden DELIVERY no pasa de READY a DELIVERED', () => {
    expectError(() => assertTransition('READY', 'DELIVERED', 'DELIVERY'), 'INVALID_STATUS_TRANSITION', { from: 'READY', to: 'DELIVERED' });
  });
  test('PICKUP_CANNOT_BE_DELIVERED', () => {
    expectError(() => assertTransition('READY', 'IN_DELIVERY', 'PICKUP'), 'PICKUP_CANNOT_BE_DELIVERED');
  });
});

describe('reparto (PIC-76)', () => {
  test('ORDER_NOT_AVAILABLE con orderId y reason', () => {
    expectError(() => { throw orderNotAvailableError({ _id: 'O1', mode: 'DELIVERY', status: 'READY', driverId: 'd1' }); }, 'ORDER_NOT_AVAILABLE', { orderId: 'O1', reason: 'TAKEN' });
    assert.deepEqual(ERROR_CODES.ORDER_NOT_AVAILABLE.fields, ['orderId', 'reason']);
  });
  test('ALREADY_DELIVERING declara activeOrderId', () => {
    assert.deepEqual(ERROR_CODES.ALREADY_DELIVERING.fields, ['activeOrderId']);
  });
  test('FORBIDDEN tiene las razones del repartidor asignado', () => {
    for (const reason of ['NOT_ASSIGNED_DRIVER', 'NO_DRIVER_ASSIGNED', 'OWN_ORDER']) assert.ok(Object.hasOwn(FORBIDDEN_REASONS, reason), reason);
  });
});

describe('access.js: las reglas de acceso no lanzan, devuelven booleano', () => {
  // La denegación (FORBIDDEN con `reason`) la lanzan los resolvers y auth.js a partir
  // de estos booleanos; aquí se comprueba que el dominio nunca lanza por su cuenta.
  const order = { userId: 'U1', storeId: 'S1', mode: 'DELIVERY' };
  const nobody = { id: 'U9', permissions: [], storeIds: [] };
  test('canChangeOrderStatus / canViewOrder / inStoreScope devuelven false sin lanzar', () => {
    assert.equal(access.canChangeOrderStatus(nobody, order, 'CONFIRMED'), false);
    assert.equal(access.canChangeOrderStatus(undefined, order, 'CONFIRMED'), false);
    assert.equal(access.canViewOrder(nobody, order), false);
    assert.equal(access.inStoreScope(nobody, 'S1'), false);
    assert.equal(access.hasPermission(undefined, 'orders:prepare'), false);
  });
});

describe('marketplace: una sucursal por paquete, carrito, cotización y orden', () => {
  const inStore = (id, storeId) => new Product(prod(id, { storeId }));
  const line = product => ({ productId: product.id, quantity: 1, product });

  test('los códigos nuevos están en el catálogo con sus campos', () => {
    assert.deepEqual(ERROR_CODES.PACKAGE_STORE_MISMATCH.fields, ['storeId', 'productIds']);
    assert.deepEqual(ERROR_CODES.STORE_MISMATCH.fields, ['expectedStoreId', 'itemsStoreId']);
    assert.deepEqual(ERROR_CODES.MIXED_STORES.fields, ['storeIds']);
    assert.deepEqual(ERROR_CODES.CART_STORE_MISMATCH.fields, ['cartStoreId', 'itemStoreId']);
    assert.deepEqual(ERROR_CODES.ITEM_WITHOUT_STORE.fields, ['itemType', 'id', 'name']);
  });
  test('NO_ACTIVE_STORE ya no existe: sin la "primera sucursal activa" la sucursal sale de los artículos', () => {
    assert.equal(isErrorCode('NO_ACTIVE_STORE'), false);
    assert.ok(isErrorCode('STORE_INACTIVE'));
  });
  test('PACKAGE_STORE_MISMATCH', () => {
    expectError(() => assertPackageSameStore('S1', [{ id: 'A', storeId: 'S1' }, { id: 'B', storeId: 'S2' }]), 'PACKAGE_STORE_MISMATCH', { storeId: 'S1', productIds: ['B'] });
  });
  test('MIXED_STORES', () => {
    expectError(() => linesStoreId([line(inStore('A', 'S2')), line(inStore('B', 'S1'))]), 'MIXED_STORES', { storeIds: ['S1', 'S2'] });
  });
  test('STORE_MISMATCH (cotización/orden y carrito)', () => {
    expectError(() => linesStoreId([line(inStore('A', 'S1'))], 'S2'), 'STORE_MISMATCH', { expectedStoreId: 'S2', itemsStoreId: 'S1' });
    expectError(() => cartStoreId([line(inStore('A', 'S1'))], 'S2'), 'STORE_MISMATCH', { expectedStoreId: 'S2', itemsStoreId: 'S1' });
  });
  test('CART_STORE_MISMATCH', () => {
    expectError(() => assertCartAccepts('S1', 'S2'), 'CART_STORE_MISMATCH', { cartStoreId: 'S1', itemStoreId: 'S2' });
  });
  test('ITEM_WITHOUT_STORE', () => {
    expectError(() => linesStoreId([line(new Product(prod('Z')))]), 'ITEM_WITHOUT_STORE', { itemType: 'PRODUCT', id: 'Z', name: 'Producto Z' });
  });
  test('las denegaciones por sucursal usan razones de FORBIDDEN_REASONS', () => {
    const staff = { id: 'u', permissions: ['stock:manage'], storeIds: ['S1'] };
    assert.ok(Object.hasOwn(FORBIDDEN_REASONS, access.storeItemDenial(staff, 'stock:manage', 'S2').reason));
    assert.ok(Object.hasOwn(FORBIDDEN_REASONS, access.categoryDenial(staff).reason));
    assert.ok(Object.hasOwn(FORBIDDEN_REASONS, access.reportStoreScope(staff, 'S2').denied.reason));
  });
});
