// ============================================================
// DOMINIO PICKAROO (modelo de negocio puro — sin Mongoose ni GraphQL)
// ============================================================

export const ORDER_MODES = ['PICKUP', 'DELIVERY'];
export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED'];
export const UNITS = ['UNIDAD', 'KG', 'LITRO'];
export { ROLES as USER_ROLES } from './access.js';

// Un paquete (combo para carne asada, el producto principal de CARNYFRUT)
// agrupa productos del catálogo. No tiene stock propio: su disponibilidad
// se deriva del stock de sus productos.
export const PACKAGE_MIN_ITEMS = 2;
export const PACKAGE_MAX_ITEMS = 40;
export const MIN_NAME_LENGTH = 2;

// ------------------------------------------------------------
// Dinero: se trabaja en pesos (MXN) con 2 decimales. Se redondea
// siempre al construir importes para evitar arrastre de flotantes.
// ------------------------------------------------------------
export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const sumMoney = xs => round2(xs.reduce((a, b) => a + Number(b || 0), 0));

// DomainError y el catálogo de códigos viven en errors.js (todo código es obligatorio).
import { DomainError } from './errors.js';
export { DomainError };

// `entity` (PRODUCT | PACKAGE) viaja en extensions para que el cliente arme la frase.
const assertName = (name, what, entity) => {
  if (String(name ?? '').trim().length < MIN_NAME_LENGTH) {
    throw new DomainError(`${what} necesita un nombre de al menos ${MIN_NAME_LENGTH} caracteres.`, 'INVALID_NAME', { entity, minLength: MIN_NAME_LENGTH });
  }
};
const assertPositivePrice = (price, what, entity) => {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new DomainError(`El precio ${what} debe ser un número positivo.`, 'INVALID_PRICE', { entity });
};
// `context` dice dónde se pidió la cantidad: ORDER_LINE | PACKAGE_ITEM.
const assertPositiveInt = (n, what, context) => {
  if (!Number.isInteger(n) || n <= 0) throw new DomainError(`${what} debe ser un entero positivo.`, 'INVALID_QUANTITY', { context });
};

// ------------------------------------------------------------
// Descuentos de producto
// Vigente = dentro de su ventana [startsAt, endsAt]. Para detener una
// promoción se elimina o se cierra su endsAt; no hay un interruptor aparte.
// ------------------------------------------------------------
export function isDiscountActive(discount, at = new Date()) {
  if (!discount) return false;
  const starts = discount.startsAt ? new Date(discount.startsAt) : null;
  const ends = discount.endsAt ? new Date(discount.endsAt) : null;
  if (starts && at < starts) return false;
  if (ends && at > ends) return false;
  return true;
}

// Regla de negocio: no se acumulan promociones del mismo producto.
// Se elige la de mayor porcentaje entre las vigentes.
export function bestDiscountPercent(discounts = [], at = new Date()) {
  const active = discounts.filter(d => isDiscountActive(d, at));
  if (!active.length) return 0;
  return Math.max(...active.map(d => Number(d.percent) || 0));
}

export function applyDiscount(unitPrice, percent) {
  const pct = Math.min(Math.max(Number(percent) || 0, 0), 100);
  return round2(Number(unitPrice) * (1 - pct / 100));
}

// ------------------------------------------------------------
// Reglas previas a persistir (las invocan los hooks de Mongoose y los resolvers)
// ------------------------------------------------------------
export function assertProductPersistable(data = {}) {
  assertName(data.name, 'El producto', 'PRODUCT');
  assertPositivePrice(data.price, 'del producto', 'PRODUCT');
  const stock = data.stock ?? 0;
  if (!Number.isInteger(stock) || stock < 0) throw new DomainError('El stock debe ser un entero no negativo.', 'INVALID_STOCK');
  return true;
}

const sizeDetails = count => ({ count, min: PACKAGE_MIN_ITEMS, max: PACKAGE_MAX_ITEMS });

export function assertPackagePersistable(data = {}) {
  assertName(data.name, 'El paquete', 'PACKAGE');
  assertPositivePrice(data.price, 'del paquete', 'PACKAGE');
  const items = data.items ?? [];
  if (items.length < PACKAGE_MIN_ITEMS) throw new DomainError(`Un paquete debe incluir al menos ${PACKAGE_MIN_ITEMS} productos.`, 'PACKAGE_SIZE_OUT_OF_RANGE', sizeDetails(items.length));
  if (items.length > PACKAGE_MAX_ITEMS) throw new DomainError(`Un paquete no puede tener más de ${PACKAGE_MAX_ITEMS} productos.`, 'PACKAGE_SIZE_OUT_OF_RANGE', sizeDetails(items.length));
  for (const item of items) {
    if (!item || item.productId == null) throw new DomainError('Cada producto del paquete necesita un productId.', 'INVALID_PACKAGE_ITEM');
    assertPositiveInt(item.quantity, 'La cantidad de cada producto del paquete', 'PACKAGE_ITEM');
  }
  const ids = items.map(i => String(i.productId));
  if (new Set(ids).size !== ids.length) throw new DomainError('El paquete tiene productos duplicados.', 'DUPLICATE_PACKAGE_PRODUCT');
  return true;
}

// Marketplace: un paquete solo puede contener productos de su propia sucursal.
// products: los productos del contenido ya cargados ([{ id | _id, storeId }]).
export function assertPackageSameStore(storeId, products = []) {
  const offending = products.filter(p => String(p.storeId ?? '') !== String(storeId ?? '')).map(p => String(p.id ?? p._id));
  if (offending.length) {
    throw new DomainError('Un paquete solo puede contener productos de su propia sucursal.', 'PACKAGE_STORE_MISMATCH', {
      storeId: storeId == null ? null : String(storeId), productIds: offending,
    });
  }
  return true;
}

// ------------------------------------------------------------
// Entidad Producto
// ------------------------------------------------------------
export class Product {
  constructor(doc) {
    this.id = doc.id ?? doc._id?.toString();
    this.storeId = doc.storeId != null ? String(doc.storeId) : null; // sucursal dueña del producto y de su stock
    this.name = doc.name;
    this.price = Number(doc.price);
    this.stock = Number(doc.stock ?? 0);
    this.unit = doc.unit ?? 'UNIDAD';
    this.isActive = doc.isActive !== false;
    this.discounts = doc.discounts ?? [];
  }

  assertValidForSale() {
    return assertProductPersistable(this);
  }

  assertAvailable() {
    if (!this.isActive) throw new DomainError(`El producto "${this.name}" no está disponible.`, 'ITEM_UNAVAILABLE', { itemType: 'PRODUCT', id: this.id ?? null, name: this.name });
  }

  currentDiscountPercent(at = new Date()) {
    return bestDiscountPercent(this.discounts, at);
  }

  effectivePrice(at = new Date()) {
    return applyDiscount(this.price, this.currentDiscountPercent(at));
  }
}

// ------------------------------------------------------------
// Entidad Paquete
// items: [{ product: Product, quantity }]
// ------------------------------------------------------------
export class Package {
  constructor(doc, items) {
    this.id = doc.id ?? doc._id?.toString();
    this.storeId = doc.storeId != null ? String(doc.storeId) : null;
    this.name = doc.name;
    this.price = Number(doc.price);
    this.isActive = doc.isActive !== false;
    this.items = items.map(({ product, quantity }) => ({
      product: product instanceof Product ? product : new Product(product),
      quantity: Number(quantity),
    }));
  }

  // Cuántos paquetes completos se pueden armar con el stock actual.
  availableStock() {
    if (!this.isActive || this.items.some(i => !i.product.isActive)) return 0;
    return Math.min(...this.items.map(i => Math.floor(i.product.stock / i.quantity)));
  }

  assertAvailable() {
    const base = { itemType: 'PACKAGE', id: this.id ?? null, name: this.name };
    if (!this.isActive) throw new DomainError(`El paquete "${this.name}" no está disponible.`, 'ITEM_UNAVAILABLE', base);
    const off = this.items.find(i => !i.product.isActive);
    if (off) throw new DomainError(`El paquete "${this.name}" no está disponible: "${off.product.name}" está desactivado.`, 'ITEM_UNAVAILABLE', {
      ...base, componentId: off.product.id ?? null, componentName: off.product.name,
    });
  }

  // Lo que costaría comprar su contenido por separado, con descuentos vigentes.
  alaCarteTotal(at = new Date()) {
    return sumMoney(this.items.map(i => i.product.effectivePrice(at) * i.quantity));
  }

  savings(at = new Date()) {
    return round2(this.alaCarteTotal(at) - this.price);
  }

  contents() {
    return this.items.map(i => ({ productId: i.product.id, quantity: i.quantity }));
  }
}

// ------------------------------------------------------------
// Política de reparto (el corazón de Pickaroo)
//
// PICKUP  -> siempre 0
// DELIVERY-> tarifa base de la sucursal, gratis si el subtotal alcanza
//            el umbral de envío gratis de la sucursal.
// ------------------------------------------------------------
export function deliveryFee({ mode, subtotal, store }) {
  if (mode === 'PICKUP') return 0;
  const base = round2(store?.deliveryFee ?? 0);
  const freeThreshold = store?.freeDeliveryThreshold ?? null;
  if (freeThreshold != null && subtotal >= Number(freeThreshold)) return 0;
  return base;
}

// ------------------------------------------------------------
// Consistencia modo <-> destino
// ------------------------------------------------------------
export function assertModeConsistency({ mode, store, deliveryAddress, requireAddress = false }) {
  if (!ORDER_MODES.includes(mode)) throw new DomainError(`Modo de orden inválido: ${mode}.`, 'INVALID_ORDER_MODE', { mode: mode ?? null });
  if (mode === 'PICKUP' && !store) throw new DomainError('Una orden de recogida necesita una sucursal.', 'STORE_REQUIRED');
  // La dirección solo es obligatoria al CONFIRMAR la orden, no al cotizar.
  if (requireAddress && mode === 'DELIVERY' && !deliveryAddress) throw new DomainError('Una orden a domicilio necesita una dirección de entrega.', 'DELIVERY_ADDRESS_REQUIRED');
}

// ------------------------------------------------------------
// Inventario
//
// Una partida (de cotización o ya guardada en una orden) consume stock de
// productos: directamente si es un producto, o a través de su contenido si
// es un paquete. Esta suma es la única fuente para validar, descontar y
// reponer stock.
// ------------------------------------------------------------
export function stockDemand(items) {
  const demand = new Map();
  const add = (productId, qty) => demand.set(String(productId), (demand.get(String(productId)) ?? 0) + qty);
  for (const item of items) {
    if (item.packageId) for (const c of item.contents ?? []) add(c.productId, c.quantity * item.quantity);
    else add(item.productId, item.quantity);
  }
  return [...demand].map(([productId, quantity]) => ({ productId, quantity }));
}

// ------------------------------------------------------------
// Una sucursal por cotización, por orden y por carrito (marketplace)
//
// Cada sucursal es un negocio con su propio catálogo y stock. La sucursal de
// una compra es la de sus partidas; el storeId que manda el cliente es solo
// una pista: si no coincide, STORE_MISMATCH. Partidas de varias sucursales en
// una compra: MIXED_STORES.
// lines: [{ product }] o [{ package }] ya cargados (Product/Package con storeId).
// ------------------------------------------------------------
const lineItem = line => line.package ?? line.product;
const lineStoreId = line => {
  const id = lineItem(line)?.storeId;
  return id == null ? null : String(id);
};

function assertStoreHint(hintStoreId, itemsStoreId) {
  if (hintStoreId == null || String(hintStoreId) === itemsStoreId) return;
  throw new DomainError('Los artículos son de otra sucursal que la indicada.', 'STORE_MISMATCH', {
    expectedStoreId: String(hintStoreId), itemsStoreId,
  });
}

// Sucursal de una cotización u orden. Lanza si hay un artículo sin sucursal
// (dato sin migrar), si se mezclan sucursales o si la pista no coincide.
export function linesStoreId(lines = [], hintStoreId = null) {
  const orphan = lines.find(l => lineItem(l) && lineStoreId(l) == null);
  if (orphan) {
    const item = lineItem(orphan);
    throw new DomainError(`"${item.name}" no pertenece a ninguna sucursal.`, 'ITEM_WITHOUT_STORE', {
      itemType: orphan.package ? 'PACKAGE' : 'PRODUCT', id: item.id ?? null, name: item.name,
    });
  }
  // El contenido de un paquete debe ser de la sucursal del paquete: si no, el
  // dato es inconsistente (PACKAGE_STORE_MISMATCH) y la compra no toca el
  // stock de otra sucursal. Un producto borrado (sin sucursal e inactivo) se
  // deja para la validación de disponibilidad.
  for (const l of lines) {
    if (l.package) assertPackageSameStore(l.package.storeId, l.package.items.map(i => i.product).filter(p => p.storeId != null || p.isActive));
  }
  const storeIds = [...new Set(lines.filter(lineItem).map(lineStoreId))].sort();
  if (storeIds.length > 1) throw new DomainError('Una compra solo puede incluir artículos de una sucursal.', 'MIXED_STORES', { storeIds });
  const itemsStoreId = storeIds[0] ?? null;
  if (itemsStoreId != null) assertStoreHint(hintStoreId, itemsStoreId);
  return itemsStoreId;
}

// Sucursal de un carrito: la de sus partidas (las borradas y las que no tienen
// sucursal no cuentan). Un carrito que ya mezcla sucursales (datos anteriores
// al marketplace) se queda con la pista del cliente si es una de ellas o, si
// no, con la que tiene más partidas (empate: el id menor); las demás partidas
// quedan como OTHER_STORE. Una pista que no es de ninguna partida es
// STORE_MISMATCH. null si no hay partidas con sucursal.
export function cartStoreId(lines = [], hintStoreId = null) {
  const counts = new Map();
  for (const line of lines) {
    const id = lineStoreId(line);
    if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (!counts.size) return null;
  if (hintStoreId != null && counts.has(String(hintStoreId))) return String(hintStoreId);
  const [[storeId]] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  assertStoreHint(hintStoreId, storeId);
  return storeId;
}

// Al agregar al carrito: el artículo debe ser de la sucursal que ya tiene el
// carrito (null = carrito vacío, acepta cualquiera). El cliente ofrece
// "vaciar el carrito y agregar".
export function assertCartAccepts(currentStoreId, itemStoreId) {
  if (currentStoreId == null || String(currentStoreId) === String(itemStoreId)) return true;
  throw new DomainError('El carrito ya tiene artículos de otra sucursal.', 'CART_STORE_MISMATCH', {
    cartStoreId: String(currentStoreId), itemStoreId: String(itemStoreId),
  });
}

// ------------------------------------------------------------
// Cotización / armado de la orden
//
// lines: [{ product: Product|doc, quantity }] o [{ package: Package, quantity }]
// Devuelve las partidas con copia (snapshot) del precio, los totales y la
// demanda de stock ya consolidada (el mismo producto suelto y dentro de un
// paquete suma contra un único inventario).
// ------------------------------------------------------------
export function priceOrder({ mode, store, deliveryAddress, lines, requireAddress = false, at = new Date() }) {
  assertModeConsistency({ mode, store, deliveryAddress, requireAddress });
  if (!Array.isArray(lines) || lines.length === 0) throw new DomainError('La orden no tiene productos.', 'EMPTY_ORDER');

  const products = new Map();
  const items = lines.map(line => {
    assertPositiveInt(line.quantity, 'La cantidad', 'ORDER_LINE');

    if (line.package) {
      const pkg = line.package;
      pkg.assertAvailable();
      pkg.items.forEach(i => products.set(i.product.id, i.product));
      const unitPrice = round2(pkg.price);
      return {
        packageId: pkg.id,
        name: pkg.name,
        unit: null,
        quantity: line.quantity,
        unitPrice,
        discountPercent: 0,
        lineTotal: round2(unitPrice * line.quantity),
        contents: pkg.contents(),
      };
    }

    const p = line.product instanceof Product ? line.product : new Product(line.product);
    p.assertAvailable();
    products.set(p.id, p);
    const discountPercent = p.currentDiscountPercent(at);
    const unitPrice = round2(p.price);
    return {
      productId: p.id,
      name: p.name,
      unit: p.unit,
      quantity: line.quantity,
      unitPrice,
      discountPercent,
      lineTotal: round2(applyDiscount(unitPrice, discountPercent) * line.quantity),
      contents: [],
    };
  });

  const demand = stockDemand(items);
  for (const { productId, quantity } of demand) {
    const p = products.get(productId);
    if (quantity > p.stock) throw new DomainError(`Sin stock suficiente de "${p.name}" (se necesitan ${quantity}, disponible: ${p.stock}).`, 'INSUFFICIENT_STOCK', {
      productId: p.id, name: p.name, requested: quantity, available: p.stock,
    });
  }

  const subtotal = orderSubtotal(items);
  const discountTotal = orderDiscountTotal(items);
  const fee = deliveryFee({ mode, subtotal: round2(subtotal - discountTotal), store });
  const total = round2(subtotal - discountTotal + fee);

  return { items, subtotal, discountTotal, deliveryFee: fee, total, stockDemand: demand };
}

// ------------------------------------------------------------
// Carrito
//
// El carrito guarda solo referencias y cantidades, nunca precios. Cada vez
// que se lee se contrasta con el catálogo actual: lo que ya no se puede
// comprar se reporta con su motivo en lugar de cobrarse.
//
// lines: [{ productId, quantity, product: Product|null }]
//     o  [{ packageId, quantity, package: Package|null }]   (null = ya no existe)
// ------------------------------------------------------------
export const UNAVAILABLE_REASONS = ['DELETED', 'INACTIVE', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK', 'OTHER_STORE'];

// `storeId` (opcional): la sucursal del carrito (ver cartStoreId). Si se
// indica, una partida de otra sucursal queda como OTHER_STORE.
export function cartLineStatus(line, storeId) {
  const pkg = line.package;
  const item = pkg ?? line.product;
  if (!item) return { reason: 'DELETED', available: 0 };
  if (storeId !== undefined && lineStoreId(line) !== (storeId == null ? null : String(storeId))) return { reason: 'OTHER_STORE', available: 0 };
  if (!item.isActive || (pkg && pkg.items.some(i => !i.product.isActive))) return { reason: 'INACTIVE', available: 0 };
  const available = pkg ? pkg.availableStock() : item.stock;
  if (available <= 0) return { reason: 'OUT_OF_STOCK', available: 0 };
  if (available < line.quantity) return { reason: 'INSUFFICIENT_STOCK', available };
  return { reason: null, available };
}

export function reconcileCart(lines, { storeId } = {}) {
  const available = [];
  const unavailable = [];
  for (const line of lines) {
    const status = cartLineStatus(line, storeId);
    if (status.reason) unavailable.push({ ...line, ...status });
    else available.push(line);
  }
  return { available, unavailable };
}

// ------------------------------------------------------------
// Cotización confirmada
//
// Una cotización no congela precios: es el total que el cliente vio. Al
// comprar se recalcula contra el catálogo actual y, si algo cambió, la
// compra se rechaza para que el cliente confirme el total nuevo.
//
// quote / fresh: { mode, storeId, items: [{ productId|packageId, quantity,
//                  unitPrice, discountPercent, lineTotal }], deliveryFee, total }
// ------------------------------------------------------------
const lineKey = i => (i.packageId ? `k:${i.packageId}` : `p:${i.productId}`);
const sortedLines = items => [...items].sort((a, b) => lineKey(a).localeCompare(lineKey(b)));

export function assertQuoteStillValid(quote, fresh) {
  const what = q => [q.mode, String(q.storeId ?? ''), ...sortedLines(q.items).map(i => `${lineKey(i)}x${i.quantity}`)].join('|');
  if (what(quote) !== what(fresh)) {
    throw new DomainError('La compra no coincide con la cotización (cambiaron productos, cantidades, sucursal o modo).', 'QUOTE_MISMATCH');
  }
  const amounts = q => [...sortedLines(q.items).map(i => `${lineKey(i)}:${i.unitPrice}:${i.discountPercent}:${i.lineTotal}`), q.deliveryFee, q.total].join('|');
  if (amounts(quote) !== amounts(fresh)) {
    throw new DomainError('Los precios cambiaron desde la cotización. Revisa el nuevo total y confirma de nuevo.', 'PRICE_CHANGED');
  }
  return true;
}

// Importes que se derivan de las partidas en lugar de guardarse.
export const lineDiscount = item => round2(item.unitPrice * item.quantity - item.lineTotal);
export const orderSubtotal = items => sumMoney(items.map(i => i.unitPrice * i.quantity));
export const orderDiscountTotal = items => sumMoney(items.map(lineDiscount));

// ------------------------------------------------------------
// Transiciones de estado de la orden
// ------------------------------------------------------------
const TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['IN_DELIVERY', 'DELIVERED', 'CANCELLED'],
  IN_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to, mode) {
  if (!ORDER_STATUSES.includes(to)) throw new DomainError(`Estado inválido: ${to}.`, 'INVALID_ORDER_STATUS', { status: to ?? null });
  if (from === to) throw new DomainError(`La orden ya está en estado ${to}.`, 'ORDER_ALREADY_IN_STATUS', { status: to });
  if (!canTransition(from, to)) throw new DomainError(`Transición no permitida: ${from} -> ${to}.`, 'INVALID_STATUS_TRANSITION', { from: from ?? null, to });
  // Una orden a domicilio se entrega desde el reparto: READY → IN_DELIVERY → DELIVERED.
  if (from === 'READY' && to === 'DELIVERED' && mode === 'DELIVERY') {
    throw new DomainError('Una orden a domicilio pasa por IN_DELIVERY antes de entregarse.', 'INVALID_STATUS_TRANSITION', { from, to });
  }
  // Una orden de recogida se entrega en mostrador: nunca sale a reparto.
  if (to === 'IN_DELIVERY' && mode && mode !== 'DELIVERY') throw new DomainError('Una orden de recogida (PICKUP) no sale a reparto.', 'PICKUP_CANNOT_BE_DELIVERED');
  return true;
}

// ------------------------------------------------------------
// Reparto: asignación de la orden a un repartidor
// ------------------------------------------------------------
// Una orden asignada en estos estados es la entrega activa de su repartidor
// (máximo una por repartidor: índice único parcial en models/order.js).
export const ACTIVE_DELIVERY_STATUSES = ['READY', 'IN_DELIVERY'];

// Por qué una orden no está libre para aceptarla (extensions.reason de ORDER_NOT_AVAILABLE).
export const DELIVERY_UNAVAILABLE_REASONS = ['TAKEN', 'NOT_READY', 'PICKED_UP', 'NOT_DELIVERY', 'CANCELLED', 'DELIVERED'];

// null si la orden se puede aceptar: DELIVERY, READY y sin repartidor.
export function deliveryUnavailableReason(order) {
  if (order.mode !== 'DELIVERY') return 'NOT_DELIVERY';
  if (order.status === 'CANCELLED') return 'CANCELLED';
  if (order.status === 'DELIVERED') return 'DELIVERED';
  if (order.status === 'IN_DELIVERY') return 'PICKED_UP';
  if (order.status !== 'READY') return 'NOT_READY';
  if (order.driverId != null) return 'TAKEN';
  return null;
}

export const orderNotAvailableError = (order, reason = deliveryUnavailableReason(order)) => new DomainError(
  `La orden ${order.number ?? order._id ?? order.id} no está disponible para reparto (${reason}).`,
  'ORDER_NOT_AVAILABLE',
  { orderId: String(order._id ?? order.id), reason },
);

// ------------------------------------------------------------
// Historial de estados: una entrada por transición, solo se agrega.
// ------------------------------------------------------------
// Hay ~7 estados y las transiciones no regresan: 20 es holgura, no un objetivo.
export const STATUS_HISTORY_MAX = 20;

// Entrada de una transición real. `actor` es el access de la sesión ({ id, role }).
export function statusChangeEntry(status, actor, at = new Date()) {
  return { status, at, byUserId: actor?.id ?? null, byRole: actor?.role ?? null, inferred: false };
}

// Número de orden legible para el mostrador: PK-<yyyymmdd>-<sufijo>
export function buildOrderNumber(date = new Date(), suffix) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const tail = (suffix ?? Math.random().toString(36).slice(2, 8)).toUpperCase();
  return `PK-${ymd}-${tail}`;
}
