// ============================================================
// DOMINIO PICKAROO (modelo de negocio puro — sin Mongoose ni GraphQL)
// ============================================================

export const ORDER_MODES = ['PICKUP', 'DELIVERY'];
export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED'];
export const UNITS = ['UNIDAD', 'KG', 'GRAMO', 'LITRO', 'PAQUETE'];
export const USER_ROLES = ['CUSTOMER', 'ADMIN'];

// SIMPLE  = un producto suelto (1 kg de arrachera, un six de refresco...)
// PAQUETE = combo que agrupa varios productos; el principal de CARNYFRUT
//           (paquetes para carne asada / parrillada). Su contenido se
//           incrusta como subdocumentos (components[]).
export const PRODUCT_KINDS = ['SIMPLE', 'PAQUETE'];

// Reglas de composición de un paquete.
export const PACKAGE_MIN_COMPONENTS = 2;
export const PACKAGE_MAX_COMPONENTS = 40;

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

// ------------------------------------------------------------
// Descuentos de producto (product_discounts)
// ------------------------------------------------------------
export function isDiscountActive(discount, at = new Date()) {
  if (!discount || discount.isActive === false) return false;
  const starts = discount.startsAt ? new Date(discount.startsAt) : null;
  const ends = discount.endsAt ? new Date(discount.endsAt) : null;
  if (starts && at < starts) return false;
  if (ends && at > ends) return false;
  return true;
}

// Regla de negocio: no se acumulan promociones del mismo producto.
// Se elige la de mayor porcentaje entre las vigentes.
export function bestDiscountPercentage(discounts = [], at = new Date()) {
  const active = discounts.filter(d => isDiscountActive(d, at));
  if (!active.length) return 0;
  return Math.max(...active.map(d => Number(d.discountPercentage) || 0));
}

export function applyDiscount(unitPrice, percentage) {
  const pct = Math.min(Math.max(Number(percentage) || 0, 0), 100);
  return round2(Number(unitPrice) * (1 - pct / 100));
}

// ------------------------------------------------------------
// Reglas de negocio del catálogo (DDD)
//
// `assertProductPersistable` es la guarda que se ejecuta ANTES de persistir
// un producto (la usa el hook pre-validate de Mongoose y los resolvers):
// precio estrictamente positivo, stock entero no negativo y, si es PAQUETE,
// una composición coherente.
// ------------------------------------------------------------
export function assertProductPersistable(data = {}) {
  const name = String(data.name ?? '').trim();
  if (name.length < 2) throw new DomainError('El producto necesita un nombre de al menos 2 caracteres.');

  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new DomainError('El precio del producto debe ser un número positivo.');

  const stock = data.stock ?? 0;
  if (!Number.isInteger(stock) || stock < 0) throw new DomainError('El stock debe ser un entero no negativo.');

  const kind = data.kind ?? 'SIMPLE';
  if (!PRODUCT_KINDS.includes(kind)) throw new DomainError(`Tipo de producto inválido: ${kind}.`);

  const components = data.components ?? [];
  if (kind === 'SIMPLE' && components.length > 0) {
    throw new DomainError('Un producto simple no puede tener componentes; usa kind: PAQUETE.');
  }
  if (kind === 'PAQUETE') {
    if (components.length < PACKAGE_MIN_COMPONENTS) {
      throw new DomainError(`Un paquete debe incluir al menos ${PACKAGE_MIN_COMPONENTS} productos.`);
    }
    if (components.length > PACKAGE_MAX_COMPONENTS) {
      throw new DomainError(`Un paquete no puede tener más de ${PACKAGE_MAX_COMPONENTS} productos.`);
    }
    for (const c of components) {
      if (!c || c.productId == null) throw new DomainError('Cada componente del paquete necesita un productId.');
      if (!Number.isInteger(c.quantity) || c.quantity <= 0) {
        throw new DomainError('Cada componente del paquete necesita una cantidad entera positiva.');
      }
      if (data.id && String(c.productId) === String(data.id)) {
        throw new DomainError('Un paquete no puede contenerse a sí mismo.');
      }
    }
    const ids = components.map(c => String(c.productId));
    if (new Set(ids).size !== ids.length) throw new DomainError('El paquete tiene componentes duplicados.');
  }
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
    this.unit = doc.unit ?? null;
    this.isActive = doc.isActive !== false;
    this.discounts = doc.discounts ?? [];
    this.kind = doc.kind ?? 'SIMPLE';
    this.components = (doc.components ?? []).map(c => ({ productId: String(c.productId ?? c.product?.id ?? c.product?._id), quantity: Number(c.quantity) }));
  }

  get isPackage() {
    return this.kind === 'PAQUETE';
  }

  // Regla de negocio previa a persistir (precio positivo, composición, etc.).
  assertValidForSale() {
    return assertProductPersistable(this);
  }

  assertPurchasable(quantity, at = new Date()) {
    if (!this.isActive) throw new DomainError(`El producto "${this.name}" no está disponible.`);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new DomainError('La cantidad debe ser un entero positivo.');
    if (quantity > this.stock) throw new DomainError(`Sin stock suficiente de "${this.name}" (disponible: ${this.stock}).`);
    return true;
  }

  currentDiscountPercentage(at = new Date()) {
    return bestDiscountPercentage(this.discounts, at);
  }

  effectiveUnitPrice(at = new Date()) {
    return applyDiscount(this.price, this.currentDiscountPercentage(at));
  }

  // Contenido del paquete como snapshot ligero para la orden.
  componentSnapshot() {
    return this.components.map(c => ({ productId: c.productId, quantity: c.quantity }));
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
// Cotización / armado de la orden
//
// lines: [{ product: <Product|doc>, quantity: <int> }]
// Devuelve las partidas con copia (snapshot) del precio y los totales.
// ------------------------------------------------------------
export function priceOrder({ mode, store, deliveryAddress, lines, requireAddress = false, at = new Date() }) {
  assertModeConsistency({ mode, store, deliveryAddress, requireAddress });
  if (!Array.isArray(lines) || lines.length === 0) throw new DomainError('La orden no tiene productos.');

  const items = lines.map(({ product, quantity }) => {
    const p = product instanceof Product ? product : new Product(product);
    p.assertPurchasable(quantity, at);

    const discountPercentage = p.currentDiscountPercentage(at);
    const unitPrice = round2(p.price);
    const discountedUnitPrice = applyDiscount(unitPrice, discountPercentage);
    const lineTotal = round2(discountedUnitPrice * quantity);
    const lineDiscount = round2((unitPrice - discountedUnitPrice) * quantity);

    return {
      productId: p.id,
      name: p.name,
      kind: p.kind,
      unit: p.unit,
      quantity,
      unitPrice,
      discountApplied: discountPercentage,
      lineDiscount,
      lineTotal,
      // Un paquete guarda su desglose al momento de la compra para poder
      // explotarlo después en los reportes de agregación.
      components: p.isPackage ? p.componentSnapshot() : [],
    };
  });

  const subtotal = sumMoney(items.map(i => round2(i.unitPrice * i.quantity)));
  const discountTotal = sumMoney(items.map(i => i.lineDiscount));
  const fee = deliveryFee({ mode, subtotal: round2(subtotal - discountTotal), store });
  const total = round2(subtotal - discountTotal + fee);

  return { items, subtotal, discountTotal, deliveryFee: fee, total };
}

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

// Número de orden legible: PK-<yyyymmdd>-<sufijo>
export function buildOrderNumber(date = new Date(), suffix) {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const tail = (suffix ?? Math.random().toString(36).slice(2, 8)).toUpperCase();
  return `PK-${ymd}-${tail}`;
}
