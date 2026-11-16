// Pruebas del dominio puro (src/domain/entities.js). El oráculo es el README
// (secciones 2, 4, 5 y 6). No requieren bases de datos ni servicios.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_MODES, ORDER_STATUSES, UNITS, USER_ROLES, PACKAGE_MIN_ITEMS, PACKAGE_MAX_ITEMS, UNAVAILABLE_REASONS,
  round2, sumMoney, DomainError,
  isDiscountActive, bestDiscountPercent, applyDiscount,
  assertProductPersistable, assertPackagePersistable,
  Product, Package,
  deliveryFee, assertModeConsistency, stockDemand, priceOrder,
  cartLineStatus, reconcileCart, assertQuoteStillValid,
  lineDiscount, orderSubtotal, orderDiscountTotal,
  canTransition, assertTransition, buildOrderNumber,
} from '../../src/domain/entities.js';

// ---------- helpers ----------
const prod = (id, over = {}) => ({ id, name: `Producto ${id}`, price: 100, stock: 10, unit: 'UNIDAD', isActive: true, discounts: [], ...over });
const pkgOf = (items, over = {}) => new Package({ id: 'PK1', name: 'Combo asada', price: 250, isActive: true, ...over }, items);
const store = (over = {}) => ({ id: 'S1', deliveryFee: 40, freeDeliveryThreshold: 500, ...over });
const throwsDomain = (fn, code) => assert.throws(fn, e => {
  assert.ok(e instanceof DomainError, 'debe ser DomainError');
  if (code) assert.equal(e.extensions.code, code);
  return true;
});
const AT = new Date('2026-06-15T12:00:00Z');

describe('constantes', () => {
  test('catálogos del README', () => {
    assert.deepEqual(ORDER_MODES, ['PICKUP', 'DELIVERY']);
    assert.deepEqual(ORDER_STATUSES, ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED']);
    assert.deepEqual(UNITS, ['UNIDAD', 'KG', 'LITRO']);
    assert.deepEqual(USER_ROLES, ['CUSTOMER', 'STAFF', 'DELIVERY', 'MANAGER', 'ADMIN']);
    assert.equal(PACKAGE_MIN_ITEMS, 2);
    assert.equal(PACKAGE_MAX_ITEMS, 40);
    assert.deepEqual(UNAVAILABLE_REASONS, ['DELETED', 'INACTIVE', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK']);
  });
});

describe('dinero: round2 / sumMoney', () => {
  test('redondea a 2 decimales', () => {
    assert.equal(round2(8.4915), 8.49);
    assert.equal(round2(1.005), 1.01); // el EPSILON evita el arrastre de flotantes
    assert.equal(round2(2.675), 2.68);
    assert.equal(round2('12.345'), 12.35);
    assert.equal(round2(10), 10);
    assert.equal(round2(0), 0);
  });
  test('sumMoney evita el arrastre de flotantes', () => {
    assert.equal(0.1 + 0.2 === 0.3, false);
    assert.equal(sumMoney([0.1, 0.2]), 0.3);
    assert.equal(sumMoney([]), 0);
    assert.equal(sumMoney([10.005, 10.005]), 20.01);
  });
  test('sumMoney trata null/undefined como 0 y acepta cadenas numéricas', () => {
    assert.equal(sumMoney([1, null, undefined, '2.5']), 3.5);
  });
});

describe('DomainError', () => {
  test('código por defecto, código explícito y details', () => {
    const a = new DomainError('x');
    assert.equal(a.name, 'DomainError');
    assert.ok(a instanceof Error);
    assert.equal(a.message, 'x');
    assert.deepEqual(a.extensions, { code: 'DOMAIN_RULE_VIOLATION' });
    const b = new DomainError('y', 'PRICE_CHANGED', { newQuote: { total: 1 } });
    assert.equal(b.extensions.code, 'PRICE_CHANGED');
    assert.deepEqual(b.extensions.newQuote, { total: 1 });
  });
  test('details no puede pisar el code', () => {
    const e = new DomainError('z', 'A', { code: 'B' });
    assert.equal(e.extensions.code, 'A');
  });
});

describe('descuentos (README sección 5)', () => {
  const d = (percent, startsAt = null, endsAt = null) => ({ percent, startsAt, endsAt });

  test('sin descuento o nulo no está vigente', () => {
    assert.equal(isDiscountActive(null, AT), false);
    assert.equal(isDiscountActive(undefined, AT), false);
  });
  test('sin ventana (ambos nulos) siempre vigente', () => {
    assert.equal(isDiscountActive(d(10), AT), true);
  });
  test('aún no inicia', () => {
    assert.equal(isDiscountActive(d(10, '2026-07-01T00:00:00Z'), AT), false);
  });
  test('ya venció', () => {
    assert.equal(isDiscountActive(d(10, null, '2026-06-01T00:00:00Z'), AT), false);
  });
  test('abierta por el final (sin endsAt) y abierta por el inicio (sin startsAt)', () => {
    assert.equal(isDiscountActive(d(10, '2026-06-01T00:00:00Z', null), AT), true);
    assert.equal(isDiscountActive(d(10, null, '2026-12-31T00:00:00Z'), AT), true);
  });
  test('dentro de la ventana', () => {
    assert.equal(isDiscountActive(d(10, '2026-06-01T00:00:00Z', '2026-06-30T00:00:00Z'), AT), true);
  });
  test('los extremos de la ventana son inclusivos (el README no lo precisa; se prueba el comportamiento actual)', () => {
    const w = d(10, '2026-06-15T12:00:00Z', '2026-06-15T12:00:00Z');
    assert.equal(isDiscountActive(w, new Date('2026-06-15T12:00:00Z')), true);
    assert.equal(isDiscountActive(w, new Date('2026-06-15T11:59:59.999Z')), false);
    assert.equal(isDiscountActive(w, new Date('2026-06-15T12:00:00.001Z')), false);
  });
  test('acepta fechas como Date o cadena ISO', () => {
    assert.equal(isDiscountActive(d(10, new Date('2026-06-01'), new Date('2026-06-30')), AT), true);
  });

  test('bestDiscountPercent: sin descuentos o ninguno vigente => 0', () => {
    assert.equal(bestDiscountPercent([], AT), 0);
    assert.equal(bestDiscountPercent(undefined, AT), 0);
    assert.equal(bestDiscountPercent([d(30, '2026-07-01T00:00:00Z'), d(20, null, '2026-01-01T00:00:00Z')], AT), 0);
  });
  test('bestDiscountPercent: varios vigentes => el mayor, nunca acumulados', () => {
    assert.equal(bestDiscountPercent([d(10), d(25), d(15)], AT), 25);
    assert.notEqual(bestDiscountPercent([d(10), d(25), d(15)], AT), 50);
  });
  test('bestDiscountPercent ignora los no vigentes aunque sean mayores', () => {
    assert.equal(bestDiscountPercent([d(90, '2026-07-01T00:00:00Z'), d(80, null, '2026-01-01T00:00:00Z'), d(5)], AT), 5);
  });

  test('applyDiscount: porcentajes normales, 0 y 100%', () => {
    assert.equal(applyDiscount(200, 10), 180);
    assert.equal(applyDiscount(200, 0), 200);
    assert.equal(applyDiscount(200, 100), 0);
  });
  test('applyDiscount redondea a 2 decimales', () => {
    assert.equal(applyDiscount(9.99, 15), 8.49);
    assert.equal(applyDiscount(33.33, 33.33), 22.22);
  });
  test('applyDiscount acota porcentajes fuera de rango y no numéricos', () => {
    assert.equal(applyDiscount(100, 150), 0);
    assert.equal(applyDiscount(100, -20), 100);
    assert.equal(applyDiscount(100, undefined), 100);
    assert.equal(applyDiscount(100, 'abc'), 100);
  });
});

describe('assertProductPersistable', () => {
  const ok = { name: 'Arrachera', price: 199.9, stock: 5 };
  test('producto válido', () => {
    assert.equal(assertProductPersistable(ok), true);
  });
  test('stock omitido cuenta como 0; stock 0 es válido', () => {
    assert.equal(assertProductPersistable({ name: 'Ab', price: 1 }), true);
    assert.equal(assertProductPersistable({ ...ok, stock: 0 }), true);
  });
  test('rechaza nombre ausente, vacío, de espacios o de 1 carácter; acepta 2', () => {
    throwsDomain(() => assertProductPersistable({ price: 1 }));
    throwsDomain(() => assertProductPersistable({ ...ok, name: '' }));
    throwsDomain(() => assertProductPersistable({ ...ok, name: '   ' }));
    throwsDomain(() => assertProductPersistable({ ...ok, name: 'A' }));
    assert.equal(assertProductPersistable({ ...ok, name: 'Ab' }), true);
  });
  test('rechaza precio cero, negativo, NaN, infinito o ausente', () => {
    for (const price of [0, -1, NaN, Infinity, undefined, 'abc']) throwsDomain(() => assertProductPersistable({ ...ok, price }));
  });
  test('acepta precio como cadena numérica', () => {
    assert.equal(assertProductPersistable({ ...ok, price: '10.5' }), true);
  });
  test('rechaza stock negativo o no entero', () => {
    for (const stock of [-1, 1.5, '3', NaN]) throwsDomain(() => assertProductPersistable({ ...ok, stock }));
  });
  test('sin argumentos rechaza', () => {
    throwsDomain(() => assertProductPersistable());
  });
});

describe('assertPackagePersistable', () => {
  const items = [{ productId: 'A', quantity: 2 }, { productId: 'B', quantity: 1 }];
  const ok = { name: 'Combo', price: 300, items };
  test('paquete válido', () => {
    assert.equal(assertPackagePersistable(ok), true);
  });
  test('valida nombre y precio', () => {
    throwsDomain(() => assertPackagePersistable({ ...ok, name: 'x' }));
    throwsDomain(() => assertPackagePersistable({ ...ok, price: 0 }));
    throwsDomain(() => assertPackagePersistable({ ...ok, price: -5 }));
  });
  test('entre 2 y 40 productos', () => {
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [] }));
    throwsDomain(() => assertPackagePersistable({ ...ok, items: undefined }));
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [items[0]] }));
    const mk = n => Array.from({ length: n }, (_, i) => ({ productId: `P${i}`, quantity: 1 }));
    assert.equal(assertPackagePersistable({ ...ok, items: mk(2) }), true);
    assert.equal(assertPackagePersistable({ ...ok, items: mk(40) }), true);
    throwsDomain(() => assertPackagePersistable({ ...ok, items: mk(41) }));
  });
  test('cada partida necesita productId', () => {
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [{ quantity: 1 }, items[1]] }));
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [null, items[1]] }));
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [{ productId: null, quantity: 1 }, items[1]] }));
  });
  test('cantidades enteras positivas', () => {
    for (const quantity of [0, -1, 1.5, '2', undefined]) {
      throwsDomain(() => assertPackagePersistable({ ...ok, items: [{ productId: 'A', quantity }, items[1]] }));
    }
  });
  test('rechaza productos duplicados (incluso con ids de distinto tipo)', () => {
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [{ productId: 'A', quantity: 1 }, { productId: 'A', quantity: 2 }] }));
    throwsDomain(() => assertPackagePersistable({ ...ok, items: [{ productId: 7, quantity: 1 }, { productId: '7', quantity: 1 }] }));
  });
  test('sin argumentos rechaza', () => {
    throwsDomain(() => assertPackagePersistable());
  });
});

describe('Product', () => {
  test('valores por defecto y normalización', () => {
    const p = new Product({ _id: { toString: () => 'mongo1' }, name: 'Carbón', price: '25.5' });
    assert.equal(p.id, 'mongo1');
    assert.equal(p.price, 25.5);
    assert.equal(p.stock, 0);
    assert.equal(p.unit, 'UNIDAD');
    assert.equal(p.isActive, true);
    assert.deepEqual(p.discounts, []);
  });
  test('id explícito tiene prioridad; isActive solo es falso si es false', () => {
    assert.equal(new Product({ id: 'x', _id: 'y', name: 'ab', price: 1 }).id, 'x');
    assert.equal(new Product({ id: 'x', name: 'ab', price: 1, isActive: false }).isActive, false);
    assert.equal(new Product({ id: 'x', name: 'ab', price: 1, isActive: null }).isActive, true);
  });
  test('assertValidForSale delega en assertProductPersistable', () => {
    assert.equal(new Product(prod('A')).assertValidForSale(), true);
    throwsDomain(() => new Product(prod('A', { price: 0 })).assertValidForSale());
  });
  test('assertAvailable: rechaza inactivos y no revisa stock', () => {
    new Product(prod('A')).assertAvailable();
    new Product(prod('A', { stock: 0 })).assertAvailable();
    throwsDomain(() => new Product(prod('A', { isActive: false })).assertAvailable());
  });
  test('currentDiscountPercent / effectivePrice usan el mejor descuento vigente', () => {
    const p = new Product(prod('A', {
      price: 200,
      discounts: [{ percent: 10 }, { percent: 20 }, { percent: 50, startsAt: '2027-01-01T00:00:00Z' }, { percent: 60, endsAt: '2026-01-01T00:00:00Z' }],
    }));
    assert.equal(p.currentDiscountPercent(AT), 20);
    assert.equal(p.effectivePrice(AT), 160);
  });
  test('descuento de 100%: precio efectivo 0 aunque el precio base sea positivo', () => {
    const p = new Product(prod('A', { price: 80, discounts: [{ percent: 100 }] }));
    assert.equal(p.effectivePrice(AT), 0);
  });
  test('sin descuentos el precio efectivo es el de lista', () => {
    assert.equal(new Product(prod('A', { price: 77.7 })).effectivePrice(AT), 77.7);
  });
});

describe('Package: disponibilidad y ahorro (README sección 4)', () => {
  const A = prod('A', { price: 100, stock: 50 });
  const B = prod('B', { price: 40, stock: 7 });

  test('availableStock: paquetes completos según el producto limitante (ejemplo 50 kg / 2 kg = 25)', () => {
    assert.equal(pkgOf([{ product: A, quantity: 2 }]).availableStock(), 25);
    assert.equal(pkgOf([{ product: A, quantity: 2 }, { product: B, quantity: 3 }]).availableStock(), 2); // min(25, floor(7/3)=2)
  });
  test('availableStock: un componente sin stock suficiente para una unidad => 0', () => {
    assert.equal(pkgOf([{ product: A, quantity: 2 }, { product: prod('C', { stock: 1 }), quantity: 2 }]).availableStock(), 0);
    assert.equal(pkgOf([{ product: A, quantity: 2 }, { product: prod('C', { stock: 0 }), quantity: 1 }]).availableStock(), 0);
  });
  test('availableStock: componente desactivado => 0 aunque haya stock', () => {
    assert.equal(pkgOf([{ product: A, quantity: 2 }, { product: prod('C', { isActive: false, stock: 99 }), quantity: 1 }]).availableStock(), 0);
  });
  test('availableStock: paquete desactivado => 0', () => {
    assert.equal(pkgOf([{ product: A, quantity: 1 }, { product: B, quantity: 1 }], { isActive: false }).availableStock(), 0);
  });
  test('acepta componentes como instancias de Product o documentos planos', () => {
    const p = pkgOf([{ product: new Product(A), quantity: '2' }, { product: B, quantity: 1 }]);
    assert.ok(p.items.every(i => i.product instanceof Product));
    assert.equal(p.items[0].quantity, 2);
  });

  test('assertAvailable', () => {
    pkgOf([{ product: A, quantity: 1 }, { product: B, quantity: 1 }]).assertAvailable();
    throwsDomain(() => pkgOf([{ product: A, quantity: 1 }, { product: B, quantity: 1 }], { isActive: false }).assertAvailable());
    throwsDomain(() => pkgOf([{ product: A, quantity: 1 }, { product: prod('C', { isActive: false }), quantity: 1 }]).assertAvailable());
  });
  test('assertAvailable no revisa stock (un paquete sin stock sigue "disponible")', () => {
    pkgOf([{ product: A, quantity: 1 }, { product: prod('C', { stock: 0 }), quantity: 1 }]).assertAvailable();
  });

  test('alaCarteTotal usa el precio efectivo con descuentos vigentes', () => {
    const disc = prod('D', { price: 100, discounts: [{ percent: 10 }] });
    const p = pkgOf([{ product: disc, quantity: 2 }, { product: B, quantity: 3 }]);
    assert.equal(p.alaCarteTotal(AT), 2 * 90 + 3 * 40);
  });
  test('alaCarteTotal ignora descuentos no vigentes', () => {
    const disc = prod('D', { price: 100, discounts: [{ percent: 50, startsAt: '2027-01-01T00:00:00Z' }] });
    assert.equal(pkgOf([{ product: disc, quantity: 1 }, { product: B, quantity: 1 }]).alaCarteTotal(AT), 140);
  });
  test('alaCarteTotal redondea a 2 decimales', () => {
    const x = prod('X', { price: 9.99, discounts: [{ percent: 15 }] }); // 8.49
    assert.equal(pkgOf([{ product: x, quantity: 3 }, { product: B, quantity: 1 }]).alaCarteTotal(AT), round2(3 * 8.49 + 40));
  });
  test('savings = a la carta - precio fijo; puede ser negativo', () => {
    const items = [{ product: A, quantity: 2 }, { product: B, quantity: 3 }]; // 320
    assert.equal(pkgOf(items, { price: 250 }).savings(AT), 70);
    assert.equal(pkgOf(items, { price: 320 }).savings(AT), 0);
    assert.equal(pkgOf(items, { price: 400 }).savings(AT), -80);
  });
  test('contents devuelve productId y cantidad', () => {
    assert.deepEqual(pkgOf([{ product: A, quantity: 2 }, { product: B, quantity: 3 }]).contents(), [
      { productId: 'A', quantity: 2 }, { productId: 'B', quantity: 3 },
    ]);
  });
  test('valores por defecto del paquete', () => {
    const p = new Package({ _id: { toString: () => 'm1' }, name: 'Combo', price: '99' }, []);
    assert.equal(p.id, 'm1');
    assert.equal(p.price, 99);
    assert.equal(p.isActive, true);
  });
});

describe('deliveryFee (README: Política de entrega)', () => {
  const s = store();
  test('PICKUP siempre cuesta 0, incluso bajo el umbral y sin sucursal', () => {
    assert.equal(deliveryFee({ mode: 'PICKUP', subtotal: 10, store: s }), 0);
    assert.equal(deliveryFee({ mode: 'PICKUP', subtotal: 10, store: undefined }), 0);
  });
  test('DELIVERY bajo el umbral cobra la tarifa de la sucursal', () => {
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 499.99, store: s }), 40);
  });
  test('umbral alcanzado exactamente => gratis; por encima => gratis', () => {
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 500, store: s }), 0);
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 800, store: s }), 0);
  });
  test('sin umbral (null o ausente) nunca es gratis', () => {
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 99999, store: store({ freeDeliveryThreshold: null }) }), 40);
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 99999, store: { deliveryFee: 25 } }), 25);
  });
  test('tarifa redondeada y sin sucursal o sin tarifa => 0', () => {
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 1, store: store({ deliveryFee: 12.345 }) }), 12.35);
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 1, store: undefined }), 0);
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 1, store: {} }), 0);
  });
  test('el umbral puede venir como cadena', () => {
    assert.equal(deliveryFee({ mode: 'DELIVERY', subtotal: 500, store: store({ freeDeliveryThreshold: '500' }) }), 0);
  });
});

describe('assertModeConsistency', () => {
  test('modo inválido', () => {
    throwsDomain(() => assertModeConsistency({ mode: 'DRONE', store: store() }));
    throwsDomain(() => assertModeConsistency({ store: store() }));
  });
  test('PICKUP necesita sucursal', () => {
    throwsDomain(() => assertModeConsistency({ mode: 'PICKUP' }));
    assertModeConsistency({ mode: 'PICKUP', store: store() });
  });
  test('DELIVERY: la dirección solo se exige con requireAddress (al confirmar, no al cotizar)', () => {
    assertModeConsistency({ mode: 'DELIVERY' });
    assertModeConsistency({ mode: 'DELIVERY', requireAddress: false });
    throwsDomain(() => assertModeConsistency({ mode: 'DELIVERY', requireAddress: true }));
    assertModeConsistency({ mode: 'DELIVERY', requireAddress: true, deliveryAddress: { street: 'x' } });
  });
  test('PICKUP con requireAddress no exige dirección', () => {
    assertModeConsistency({ mode: 'PICKUP', store: store(), requireAddress: true });
  });
});

describe('stockDemand (inventario consolidado)', () => {
  test('producto suelto', () => {
    assert.deepEqual(stockDemand([{ productId: 'A', quantity: 3 }]), [{ productId: 'A', quantity: 3 }]);
  });
  test('paquete: contenido multiplicado por la cantidad comprada', () => {
    const items = [{ packageId: 'K', quantity: 3, contents: [{ productId: 'A', quantity: 2 }, { productId: 'B', quantity: 1 }] }];
    assert.deepEqual(stockDemand(items), [{ productId: 'A', quantity: 6 }, { productId: 'B', quantity: 3 }]);
  });
  test('el mismo producto suelto y dentro de un paquete suma contra un único inventario (51 kg del README)', () => {
    const items = [
      { packageId: 'K', quantity: 1, contents: [{ productId: 'A', quantity: 2 }] },
      { productId: 'A', quantity: 49 },
    ];
    assert.deepEqual(stockDemand(items), [{ productId: 'A', quantity: 51 }]);
  });
  test('dos paquetes con el mismo producto y dos líneas del mismo producto se consolidan', () => {
    const items = [
      { packageId: 'K1', quantity: 2, contents: [{ productId: 'A', quantity: 1 }] },
      { packageId: 'K2', quantity: 1, contents: [{ productId: 'A', quantity: 5 }] },
      { productId: 'A', quantity: 1 },
      { productId: 'A', quantity: 2 },
    ];
    assert.deepEqual(stockDemand(items), [{ productId: 'A', quantity: 10 }]);
  });
  test('los ids se normalizan a cadena', () => {
    assert.deepEqual(stockDemand([{ productId: 7, quantity: 1 }, { productId: '7', quantity: 1 }]), [{ productId: '7', quantity: 2 }]);
  });
  test('sin partidas => vacío; paquete sin contents no consume', () => {
    assert.deepEqual(stockDemand([]), []);
    assert.deepEqual(stockDemand([{ packageId: 'K', quantity: 2 }]), []);
  });
});

describe('priceOrder (README sección 6)', () => {
  const base = { mode: 'DELIVERY', store: store(), deliveryAddress: { street: 'x' }, at: AT };
  const A = prod('A', { price: 100, stock: 100 });
  const B = prod('B', { price: 50, stock: 100 });

  test('orden vacía o sin líneas', () => {
    throwsDomain(() => priceOrder({ ...base, lines: [] }));
    throwsDomain(() => priceOrder({ ...base, lines: undefined }));
  });
  test('valida el modo (PICKUP sin sucursal)', () => {
    throwsDomain(() => priceOrder({ ...base, mode: 'PICKUP', store: undefined, lines: [{ product: A, quantity: 1 }] }));
  });
  test('exige dirección solo con requireAddress en DELIVERY', () => {
    const lines = [{ product: A, quantity: 1 }];
    priceOrder({ ...base, deliveryAddress: undefined, lines });
    throwsDomain(() => priceOrder({ ...base, deliveryAddress: undefined, requireAddress: true, lines }));
  });
  test('cantidad no entera o no positiva', () => {
    for (const quantity of [0, -1, 1.5, '2', undefined]) throwsDomain(() => priceOrder({ ...base, lines: [{ product: A, quantity }] }));
  });

  test('partida de producto sin descuento: copia el precio de lista y calcula totales', () => {
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: A, quantity: 3 }] });
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.items[0], {
      productId: 'A', name: 'Producto A', unit: 'UNIDAD', quantity: 3,
      unitPrice: 100, discountPercent: 0, lineTotal: 300, contents: [],
    });
    assert.equal(r.subtotal, 300);
    assert.equal(r.discountTotal, 0);
    assert.equal(r.deliveryFee, 0);
    assert.equal(r.total, 300);
    assert.deepEqual(r.stockDemand, [{ productId: 'A', quantity: 3 }]);
  });
  test('descuento: la partida conserva precio de lista, porcentaje e importe; subtotal y descuento se derivan', () => {
    const d = prod('D', { price: 200, stock: 10, discounts: [{ percent: 10 }, { percent: 25 }] });
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: d, quantity: 2 }] });
    assert.equal(r.items[0].unitPrice, 200);
    assert.equal(r.items[0].discountPercent, 25);
    assert.equal(r.items[0].lineTotal, 300);
    assert.equal(r.subtotal, 400);
    assert.equal(r.discountTotal, 100);
    assert.equal(r.total, 300);
  });
  test('descuentos fuera de ventana no se aplican', () => {
    const d = prod('D', { price: 100, discounts: [{ percent: 50, startsAt: '2027-01-01T00:00:00Z' }, { percent: 40, endsAt: '2026-01-01T00:00:00Z' }] });
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: d, quantity: 1 }] });
    assert.equal(r.items[0].discountPercent, 0);
    assert.equal(r.total, 100);
  });
  test('descuento de 100%: el total del producto es 0 y el descuento es el subtotal', () => {
    const d = prod('D', { price: 80, discounts: [{ percent: 100 }] });
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: d, quantity: 2 }] });
    assert.equal(r.items[0].lineTotal, 0);
    assert.equal(r.subtotal, 160);
    assert.equal(r.discountTotal, 160);
    assert.equal(r.total, 0);
  });
  test('redondeo: importe = redondear(precio efectivo redondeado x cantidad)', () => {
    const d = prod('D', { price: 9.99, discounts: [{ percent: 15 }] }); // 8.4915 -> 8.49
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: d, quantity: 3 }] });
    assert.equal(r.items[0].lineTotal, 25.47);
    assert.equal(r.subtotal, 29.97);
    assert.equal(r.discountTotal, 4.5);
    assert.equal(r.total, 25.47);
  });
  test('paquete: precio fijo, sin porcentaje, con contents', () => {
    const k = pkgOf([{ product: A, quantity: 2 }, { product: B, quantity: 1 }], { price: 230.555 });
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ package: k, quantity: 2 }] });
    assert.deepEqual(r.items[0], {
      packageId: 'PK1', name: 'Combo asada', unit: null, quantity: 2,
      unitPrice: 230.56, discountPercent: 0, lineTotal: 461.12,
      contents: [{ productId: 'A', quantity: 2 }, { productId: 'B', quantity: 1 }],
    });
    assert.equal(r.subtotal, 461.12);
    assert.equal(r.discountTotal, 0);
    assert.deepEqual(r.stockDemand, [{ productId: 'A', quantity: 4 }, { productId: 'B', quantity: 2 }]);
  });
  test('el descuento de un producto no afecta al precio del paquete que lo contiene', () => {
    const d = prod('D', { price: 100, stock: 50, discounts: [{ percent: 50 }] });
    const k = pkgOf([{ product: d, quantity: 1 }, { product: B, quantity: 1 }], { price: 120 });
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ package: k, quantity: 1 }] });
    assert.equal(r.total, 120);
  });
  test('acepta producto como instancia de Product o documento plano', () => {
    const r1 = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: new Product(A), quantity: 1 }] });
    const r2 = priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: A, quantity: 1 }] });
    assert.deepEqual(r1, r2);
  });

  test('producto o paquete inactivo rechazan la orden', () => {
    throwsDomain(() => priceOrder({ ...base, lines: [{ product: prod('X', { isActive: false }), quantity: 1 }] }));
    throwsDomain(() => priceOrder({ ...base, lines: [{ package: pkgOf([{ product: A, quantity: 1 }, { product: B, quantity: 1 }], { isActive: false }), quantity: 1 }] }));
  });
  test('paquete con un componente inactivo rechaza la orden', () => {
    const k = pkgOf([{ product: A, quantity: 1 }, { product: prod('X', { isActive: false }), quantity: 1 }]);
    throwsDomain(() => priceOrder({ ...base, lines: [{ package: k, quantity: 1 }] }));
  });
  test('paquete con un componente sin stock rechaza la orden', () => {
    const k = pkgOf([{ product: A, quantity: 1 }, { product: prod('X', { stock: 1 }), quantity: 2 }]);
    throwsDomain(() => priceOrder({ ...base, lines: [{ package: k, quantity: 1 }] }));
  });

  test('stock: exactamente el disponible pasa, uno más falla', () => {
    const p = prod('S', { stock: 5 });
    priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: p, quantity: 5 }] });
    throwsDomain(() => priceOrder({ ...base, mode: 'PICKUP', lines: [{ product: p, quantity: 6 }] }));
  });
  test('stock consolidado: producto suelto + dentro de un paquete (51 kg del README)', () => {
    const arr = prod('ARR', { price: 100, stock: 50, unit: 'KG' });
    const k = pkgOf([{ product: arr, quantity: 2 }, { product: B, quantity: 1 }]);
    // Cada línea por separado cabría (2 y 49 <= 50), pero juntas exigen 51.
    throwsDomain(() => priceOrder({ ...base, mode: 'PICKUP', lines: [{ package: k, quantity: 1 }, { product: arr, quantity: 49 }] }));
    // 48 sueltos + 2 del paquete = 50 exacto.
    const r = priceOrder({ ...base, mode: 'PICKUP', lines: [{ package: k, quantity: 1 }, { product: arr, quantity: 48 }] });
    assert.deepEqual(r.stockDemand.find(d => d.productId === 'ARR'), { productId: 'ARR', quantity: 50 });
  });
  test('stock consolidado entre dos paquetes que comparten un producto', () => {
    const shared = prod('SH', { stock: 5 });
    const k1 = pkgOf([{ product: shared, quantity: 2 }, { product: A, quantity: 1 }], { id: 'K1' });
    const k2 = pkgOf([{ product: shared, quantity: 2 }, { product: B, quantity: 1 }], { id: 'K2' });
    priceOrder({ ...base, mode: 'PICKUP', lines: [{ package: k1, quantity: 1 }, { package: k2, quantity: 1 }] }); // 4 <= 5
    throwsDomain(() => priceOrder({ ...base, mode: 'PICKUP', lines: [{ package: k1, quantity: 2 }, { package: k2, quantity: 1 }] })); // 6 > 5
  });

  test('envío: PICKUP 0; DELIVERY bajo umbral cobra tarifa; el total la suma', () => {
    const lines = [{ product: A, quantity: 1 }]; // 100
    assert.equal(priceOrder({ ...base, mode: 'PICKUP', lines }).deliveryFee, 0);
    const r = priceOrder({ ...base, lines });
    assert.equal(r.deliveryFee, 40);
    assert.equal(r.total, 140);
  });
  test('envío gratis cuando el subtotal después de descuentos alcanza exactamente el umbral', () => {
    const r = priceOrder({ ...base, lines: [{ product: A, quantity: 5 }] }); // 500
    assert.equal(r.deliveryFee, 0);
    assert.equal(r.total, 500);
  });
  test('el umbral se evalúa DESPUÉS de descuentos (subtotal bruto 500 con 10% => 450 => cobra envío)', () => {
    const d = prod('D', { price: 100, stock: 50, discounts: [{ percent: 10 }] });
    const r = priceOrder({ ...base, lines: [{ product: d, quantity: 5 }] });
    assert.equal(r.subtotal, 500);
    assert.equal(r.discountTotal, 50);
    assert.equal(r.deliveryFee, 40);
    assert.equal(r.total, 490);
  });
  test('el descuento puede llevar el subtotal justo al umbral', () => {
    const d = prod('D', { price: 125, stock: 50, discounts: [{ percent: 20 }] }); // 100 c/u
    const r = priceOrder({ ...base, lines: [{ product: d, quantity: 5 }] });
    assert.equal(r.deliveryFee, 0);
    assert.equal(r.total, 500);
  });
  test('orden mixta: producto con descuento + paquete + envío', () => {
    const d = prod('D', { price: 100, stock: 50, discounts: [{ percent: 10 }] });
    const k = pkgOf([{ product: A, quantity: 1 }, { product: B, quantity: 1 }], { price: 120 });
    const r = priceOrder({ ...base, lines: [{ product: d, quantity: 2 }, { package: k, quantity: 1 }] });
    assert.equal(r.subtotal, 320);
    assert.equal(r.discountTotal, 20);
    assert.equal(r.deliveryFee, 40);
    assert.equal(r.total, 340);
    assert.equal(r.items.length, 2);
  });
});

describe('importes derivados de las partidas', () => {
  const items = [
    { unitPrice: 100, quantity: 2, lineTotal: 150 },
    { unitPrice: 9.99, quantity: 3, lineTotal: 25.47 },
    { unitPrice: 50, quantity: 1, lineTotal: 50 },
  ];
  test('lineDiscount', () => {
    assert.equal(lineDiscount(items[0]), 50);
    assert.equal(lineDiscount(items[1]), 4.5);
    assert.equal(lineDiscount(items[2]), 0);
  });
  test('orderSubtotal / orderDiscountTotal', () => {
    assert.equal(orderSubtotal(items), 279.97);
    assert.equal(orderDiscountTotal(items), 54.5);
    assert.equal(orderSubtotal([]), 0);
    assert.equal(orderDiscountTotal([]), 0);
  });
});

describe('cartLineStatus / reconcileCart (README: Carrito)', () => {
  const A = prod('A', { stock: 10 });
  const B = prod('B', { stock: 10 });
  const pk = (over = {}, comps = [{ product: A, quantity: 2 }, { product: B, quantity: 1 }]) => pkgOf(comps, over);

  test('DELETED: el producto ya no existe', () => {
    assert.deepEqual(cartLineStatus({ productId: 'A', quantity: 1, product: null }), { reason: 'DELETED', available: 0 });
  });
  test('DELETED: el paquete ya no existe', () => {
    assert.deepEqual(cartLineStatus({ packageId: 'K', quantity: 1, package: null }), { reason: 'DELETED', available: 0 });
  });
  test('INACTIVE: producto desactivado (aunque haya stock)', () => {
    assert.deepEqual(cartLineStatus({ quantity: 1, product: new Product(prod('A', { isActive: false, stock: 99 })) }), { reason: 'INACTIVE', available: 0 });
  });
  test('INACTIVE: paquete desactivado, o con un componente desactivado', () => {
    assert.equal(cartLineStatus({ quantity: 1, package: pk({ isActive: false }) }).reason, 'INACTIVE');
    const off = pk({}, [{ product: A, quantity: 1 }, { product: prod('C', { isActive: false }), quantity: 1 }]);
    assert.deepEqual(cartLineStatus({ quantity: 1, package: off }), { reason: 'INACTIVE', available: 0 });
  });
  test('INACTIVE tiene prioridad sobre OUT_OF_STOCK', () => {
    assert.equal(cartLineStatus({ quantity: 1, product: new Product(prod('A', { isActive: false, stock: 0 })) }).reason, 'INACTIVE');
  });
  test('OUT_OF_STOCK: producto en 0', () => {
    assert.deepEqual(cartLineStatus({ quantity: 1, product: new Product(prod('A', { stock: 0 })) }), { reason: 'OUT_OF_STOCK', available: 0 });
  });
  test('OUT_OF_STOCK: no alcanza ni para un paquete completo', () => {
    const k = pk({}, [{ product: prod('A', { stock: 1 }), quantity: 2 }, { product: B, quantity: 1 }]);
    assert.deepEqual(cartLineStatus({ quantity: 1, package: k }), { reason: 'OUT_OF_STOCK', available: 0 });
  });
  test('INSUFFICIENT_STOCK: hay menos que lo pedido, informa lo disponible', () => {
    assert.deepEqual(cartLineStatus({ quantity: 5, product: new Product(prod('A', { stock: 3 })) }), { reason: 'INSUFFICIENT_STOCK', available: 3 });
    const k = pk({}, [{ product: prod('A', { stock: 5 }), quantity: 2 }, { product: B, quantity: 1 }]); // 2 paquetes
    assert.deepEqual(cartLineStatus({ quantity: 3, package: k }), { reason: 'INSUFFICIENT_STOCK', available: 2 });
  });
  test('disponible: stock igual a lo pedido y stock mayor', () => {
    assert.deepEqual(cartLineStatus({ quantity: 3, product: new Product(prod('A', { stock: 3 })) }), { reason: null, available: 3 });
    assert.deepEqual(cartLineStatus({ quantity: 1, product: new Product(prod('A', { stock: 3 })) }), { reason: null, available: 3 });
    assert.deepEqual(cartLineStatus({ quantity: 4, package: pk() }), { reason: null, available: 5 });
  });

  test('reconcileCart separa disponibles y no disponibles conservando la línea y añadiendo reason/available', () => {
    const ok = { productId: 'A', quantity: 2, product: new Product(A) };
    const gone = { productId: 'G', quantity: 1, product: null };
    const off = { productId: 'O', quantity: 1, product: new Product(prod('O', { isActive: false })) };
    const oos = { productId: 'Z', quantity: 1, product: new Product(prod('Z', { stock: 0 })) };
    const few = { productId: 'F', quantity: 9, product: new Product(prod('F', { stock: 4 })) };
    const pkgOk = { packageId: 'K', quantity: 1, package: pk() };
    const r = reconcileCart([ok, gone, off, oos, few, pkgOk]);
    assert.deepEqual(r.available, [ok, pkgOk]);
    assert.deepEqual(r.unavailable.map(u => [u.productId, u.reason, u.available]), [
      ['G', 'DELETED', 0], ['O', 'INACTIVE', 0], ['Z', 'OUT_OF_STOCK', 0], ['F', 'INSUFFICIENT_STOCK', 4],
    ]);
    assert.equal(r.unavailable[0].quantity, 1);
    for (const u of r.unavailable) assert.ok(UNAVAILABLE_REASONS.includes(u.reason));
  });
  test('reconcileCart con carrito vacío', () => {
    assert.deepEqual(reconcileCart([]), { available: [], unavailable: [] });
  });
});

describe('assertQuoteStillValid (README: Carrito y cotizaciones)', () => {
  const lines = [{ product: prod('A', { price: 100, stock: 50 }), quantity: 2 }, { product: prod('B', { price: 40, stock: 50 }), quantity: 1 }];
  const quoteOf = (over = {}) => {
    const r = priceOrder({ mode: 'DELIVERY', store: store(), lines, at: AT });
    return { mode: 'DELIVERY', storeId: 'S1', items: r.items, deliveryFee: r.deliveryFee, total: r.total, ...over };
  };
  const expectCode = (quote, fresh, code) => throwsDomain(() => assertQuoteStillValid(quote, fresh), code);

  test('cotización idéntica es válida', () => {
    assert.equal(assertQuoteStillValid(quoteOf(), quoteOf()), true);
  });
  test('el orden de las partidas no importa', () => {
    const f = quoteOf();
    f.items = [...f.items].reverse();
    assert.equal(assertQuoteStillValid(quoteOf(), f), true);
  });
  test('storeId nulo vs ausente cuenta igual', () => {
    assert.equal(assertQuoteStillValid(quoteOf({ storeId: null }), quoteOf({ storeId: undefined })), true);
  });
  test('QUOTE_MISMATCH: cambió el modo', () => {
    expectCode(quoteOf(), quoteOf({ mode: 'PICKUP' }), 'QUOTE_MISMATCH');
  });
  test('QUOTE_MISMATCH: cambió la sucursal', () => {
    expectCode(quoteOf(), quoteOf({ storeId: 'S2' }), 'QUOTE_MISMATCH');
  });
  test('QUOTE_MISMATCH: cambió una cantidad', () => {
    const f = quoteOf();
    f.items = f.items.map((i, n) => (n === 0 ? { ...i, quantity: 3 } : i));
    expectCode(quoteOf(), f, 'QUOTE_MISMATCH');
  });
  test('QUOTE_MISMATCH: producto distinto, partida de menos o de más', () => {
    const f = quoteOf();
    expectCode(quoteOf(), { ...f, items: f.items.slice(1) }, 'QUOTE_MISMATCH');
    expectCode(quoteOf(), { ...f, items: [...f.items, { productId: 'Z', quantity: 1, unitPrice: 1, discountPercent: 0, lineTotal: 1 }] }, 'QUOTE_MISMATCH');
    expectCode(quoteOf(), { ...f, items: f.items.map((i, n) => (n === 0 ? { ...i, productId: 'Z' } : i)) }, 'QUOTE_MISMATCH');
  });
  test('QUOTE_MISMATCH: un producto no se confunde con un paquete del mismo id', () => {
    const q = { mode: 'PICKUP', storeId: 'S1', items: [{ productId: 'X', quantity: 1, unitPrice: 1, discountPercent: 0, lineTotal: 1 }], deliveryFee: 0, total: 1 };
    const f = { ...q, items: [{ packageId: 'X', quantity: 1, unitPrice: 1, discountPercent: 0, lineTotal: 1 }] };
    expectCode(q, f, 'QUOTE_MISMATCH');
  });
  test('PRICE_CHANGED: cambió el precio unitario', () => {
    const f = quoteOf();
    f.items = f.items.map((i, n) => (n === 0 ? { ...i, unitPrice: i.unitPrice + 1 } : i));
    expectCode(quoteOf(), f, 'PRICE_CHANGED');
  });
  test('PRICE_CHANGED: cambió el descuento (porcentaje e importe de partida)', () => {
    const f = quoteOf();
    f.items = f.items.map((i, n) => (n === 0 ? { ...i, discountPercent: 10, lineTotal: 180 } : i));
    expectCode(quoteOf(), f, 'PRICE_CHANGED');
  });
  test('PRICE_CHANGED: cambió solo el importe de partida, solo el envío o solo el total', () => {
    const f = quoteOf();
    expectCode(quoteOf(), { ...f, items: f.items.map((i, n) => (n === 0 ? { ...i, lineTotal: i.lineTotal - 1 } : i)) }, 'PRICE_CHANGED');
    expectCode(quoteOf(), { ...f, deliveryFee: f.deliveryFee + 10 }, 'PRICE_CHANGED');
    expectCode(quoteOf(), { ...f, total: f.total + 0.01 }, 'PRICE_CHANGED');
  });
  test('QUOTE_MISMATCH tiene prioridad sobre PRICE_CHANGED cuando cambian ambos', () => {
    expectCode(quoteOf(), quoteOf({ mode: 'PICKUP', total: 1 }), 'QUOTE_MISMATCH');
  });
  test('el mensaje del error de precio invita a confirmar de nuevo', () => {
    assert.throws(() => assertQuoteStillValid(quoteOf(), quoteOf({ total: 1 })), /confirma de nuevo/);
  });
  test('QUOTE_EXPIRED no se decide en el dominio', {
    skip: 'QUOTE_EXPIRED lo emite el resolver cuando quote:<uuid> ya no existe en Redis (TTL o uso previo); no hay funcion de dominio que probar.',
  }, () => {});
});

describe('transiciones de estado (README: Estados permitidos)', () => {
  // Tabla del README, copiada literalmente como oráculo.
  const TABLE = {
    PENDING: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['PREPARING', 'CANCELLED'],
    PREPARING: ['READY', 'CANCELLED'],
    READY: ['IN_DELIVERY', 'DELIVERED', 'CANCELLED'],
    IN_DELIVERY: ['DELIVERED', 'CANCELLED'],
    DELIVERED: [],
    CANCELLED: [],
  };

  test('la tabla cubre todos los estados', () => {
    assert.deepEqual(Object.keys(TABLE), ORDER_STATUSES);
  });

  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      const allowed = TABLE[from].includes(to);
      test(`canTransition ${from} -> ${to}: ${allowed ? 'permitida' : 'prohibida'}`, () => {
        assert.equal(canTransition(from, to), allowed);
      });
      if (from === to) {
        test(`assertTransition ${from} -> ${to}: repetir el estado se rechaza`, () => {
          assert.throws(() => assertTransition(from, to, 'DELIVERY'), /ya está en estado/);
          assert.throws(() => assertTransition(from, to, 'PICKUP'), DomainError);
        });
      } else if (allowed && to === 'IN_DELIVERY') {
        test(`assertTransition ${from} -> ${to}: solo para DELIVERY`, () => {
          assert.equal(assertTransition(from, to, 'DELIVERY'), true);
          assert.equal(assertTransition(from, to), true); // sin modo no se restringe
          throwsDomain(() => assertTransition(from, to, 'PICKUP'));
        });
      } else if (allowed) {
        test(`assertTransition ${from} -> ${to}: permitida en PICKUP y DELIVERY`, () => {
          assert.equal(assertTransition(from, to, 'DELIVERY'), true);
          assert.equal(assertTransition(from, to, 'PICKUP'), true);
        });
      } else {
        test(`assertTransition ${from} -> ${to}: rechazada`, () => {
          assert.throws(() => assertTransition(from, to, 'DELIVERY'), /Transición no permitida/);
          assert.throws(() => assertTransition(from, to, 'PICKUP'), DomainError);
        });
      }
    }
  }

  test('estado destino inexistente se rechaza', () => {
    assert.throws(() => assertTransition('PENDING', 'SHIPPED', 'DELIVERY'), /Estado inválido/);
    assert.equal(canTransition('PENDING', 'SHIPPED'), false);
  });
  test('estado origen desconocido no permite nada', () => {
    assert.equal(canTransition('BOGUS', 'CONFIRMED'), false);
    throwsDomain(() => assertTransition('BOGUS', 'CONFIRMED', 'DELIVERY'));
  });
  test('READY -> DELIVERED vale para PICKUP y DELIVERY (la tabla no distingue)', () => {
    assert.equal(assertTransition('READY', 'DELIVERED', 'PICKUP'), true);
    assert.equal(assertTransition('READY', 'DELIVERED', 'DELIVERY'), true);
  });
  test('DELIVERED y CANCELLED son terminales', () => {
    for (const to of ORDER_STATUSES) {
      assert.equal(canTransition('DELIVERED', to), false);
      assert.equal(canTransition('CANCELLED', to), false);
    }
  });
});

describe('buildOrderNumber', () => {
  test('formato PK-AAAAMMDD-SUFIJO con sufijo dado en mayúsculas', () => {
    assert.equal(buildOrderNumber(new Date('2026-03-07T10:00:00Z'), 'ab12cd'), 'PK-20260307-AB12CD');
  });
  test('sufijo aleatorio por defecto: alfanumérico en mayúsculas', () => {
    assert.match(buildOrderNumber(new Date('2026-12-31T10:00:00Z')), /^PK-20261231-[0-9A-Z]{1,6}$/);
  });
  test('usa la fecha actual por defecto', () => {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    assert.match(buildOrderNumber(undefined, 'x'), new RegExp(`^PK-${today}-X$`));
  });
  test('la fecha es UTC (toISOString), no la local', () => {
    assert.equal(buildOrderNumber(new Date('2026-03-07T23:59:59Z'), 'a'), 'PK-20260307-A');
    assert.equal(buildOrderNumber(new Date('2026-03-08T00:00:00Z'), 'a'), 'PK-20260308-A');
  });
  test('números sin sufijo explícito casi siempre difieren', () => {
    const set = new Set(Array.from({ length: 50 }, () => buildOrderNumber(AT)));
    assert.ok(set.size > 40);
  });
});
