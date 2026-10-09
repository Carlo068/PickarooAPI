// ============================================================
// DOMINIO PICKAROO (modelo de negocio puro — sin Mongoose ni GraphQL)
// ============================================================

export const ORDER_MODES = ['PICKUP', 'DELIVERY'];
export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED'];
export const UNITS = ['UNIDAD', 'KG', 'LITRO'];
export const USER_ROLES = ['CUSTOMER', 'ADMIN'];

// Un paquete (combo para carne asada, el producto principal de CARNYFRUT)
// agrupa productos del catálogo. No tiene stock propio: su disponibilidad
// se deriva del stock de sus productos.
export const PACKAGE_MIN_ITEMS = 2;
export const PACKAGE_MAX_ITEMS = 40;

// ------------------------------------------------------------
// Dinero: se trabaja en pesos (MXN) con 2 decimales. Se redondea
// siempre al construir importes para evitar arrastre de flotantes.
// ------------------------------------------------------------
export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const sumMoney = xs => round2(xs.reduce((a, b) => a + Number(b || 0), 0));

export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
    this.extensions = { code: 'DOMAIN_RULE_VIOLATION' };
  }
}

const assertName = (name, what) => {
  if (String(name ?? '').trim().length < 2) throw new DomainError(`${what} necesita un nombre de al menos 2 caracteres.`);
};
const assertPositivePrice = (price, what) => {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new DomainError(`El precio ${what} debe ser un número positivo.`);
};
const assertPositiveInt = (n, what) => {
  if (!Number.isInteger(n) || n <= 0) throw new DomainError(`${what} debe ser un entero positivo.`);
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
  assertName(data.name, 'El producto');
  assertPositivePrice(data.price, 'del producto');
  const stock = data.stock ?? 0;
  if (!Number.isInteger(stock) || stock < 0) throw new DomainError('El stock debe ser un entero no negativo.');
  return true;
}

export function assertPackagePersistable(data = {}) {
  assertName(data.name, 'El paquete');
  assertPositivePrice(data.price, 'del paquete');
  const items = data.items ?? [];
  if (items.length < PACKAGE_MIN_ITEMS) throw new DomainError(`Un paquete debe incluir al menos ${PACKAGE_MIN_ITEMS} productos.`);
  if (items.length > PACKAGE_MAX_ITEMS) throw new DomainError(`Un paquete no puede tener más de ${PACKAGE_MAX_ITEMS} productos.`);
  for (const item of items) {
    if (!item || item.productId == null) throw new DomainError('Cada producto del paquete necesita un productId.');
    assertPositiveInt(item.quantity, 'La cantidad de cada producto del paquete');
  }
  const ids = items.map(i => String(i.productId));
  if (new Set(ids).size !== ids.length) throw new DomainError('El paquete tiene productos duplicados.');
  return true;
}

// ------------------------------------------------------------
// Entidad Producto
// ------------------------------------------------------------
export class Product {
  constructor(doc) {
    this.id = doc.id ?? doc._id?.toString();
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
    if (!this.isActive) throw new DomainError(`El producto "${this.name}" no está disponible.`);
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
    if (!this.isActive) throw new DomainError(`El paquete "${this.name}" no está disponible.`);
    const off = this.items.find(i => !i.product.isActive);
    if (off) throw new DomainError(`El paquete "${this.name}" no está disponible: "${off.product.name}" está desactivado.`);
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
  if (!ORDER_MODES.includes(mode)) throw new DomainError(`Modo de orden inválido: ${mode}.`);
  if (mode === 'PICKUP' && !store) throw new DomainError('Una orden de recogida necesita una sucursal.');
  // La dirección solo es obligatoria al CONFIRMAR la orden, no al cotizar.
  if (requireAddress && mode === 'DELIVERY' && !deliveryAddress) throw new DomainError('Una orden a domicilio necesita una dirección de entrega.');
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
// Cotización / armado de la orden
//
// lines: [{ product: Product|doc, quantity }] o [{ package: Package, quantity }]
// Devuelve las partidas con copia (snapshot) del precio, los totales y la
// demanda de stock ya consolidada (el mismo producto suelto y dentro de un
// paquete suma contra un único inventario).
// ------------------------------------------------------------
export function priceOrder({ mode, store, deliveryAddress, lines, requireAddress = false, at = new Date() }) {
  assertModeConsistency({ mode, store, deliveryAddress, requireAddress });
  if (!Array.isArray(lines) || lines.length === 0) throw new DomainError('La orden no tiene productos.');

  const products = new Map();
  const items = lines.map(line => {
    assertPositiveInt(line.quantity, 'La cantidad');

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
    if (quantity > p.stock) throw new DomainError(`Sin stock suficiente de "${p.name}" (se necesitan ${quantity}, disponible: ${p.stock}).`);
  }

  const subtotal = orderSubtotal(items);
  const discountTotal = orderDiscountTotal(items);
  const fee = deliveryFee({ mode, subtotal: round2(subtotal - discountTotal), store });
  const total = round2(subtotal - discountTotal + fee);

  return { items, subtotal, discountTotal, deliveryFee: fee, total, stockDemand: demand };
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

export function assertTransition(from, to) {
  if (!ORDER_STATUSES.includes(to)) throw new DomainError(`Estado inválido: ${to}.`);
  if (from === to) throw new DomainError(`La orden ya está en estado ${to}.`);
  if (!canTransition(from, to)) throw new DomainError(`Transición no permitida: ${from} -> ${to}.`);
  return true;
}

// Número de orden legible para el mostrador: PK-<yyyymmdd>-<sufijo>
export function buildOrderNumber(date = new Date(), suffix) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const tail = (suffix ?? Math.random().toString(36).slice(2, 8)).toUpperCase();
  return `PK-${ymd}-${tail}`;
}
