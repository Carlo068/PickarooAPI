// ============================================================
// CATÁLOGO DE ERRORES DE LA API (dominio puro)
//
// Contrato con los clientes (Android y dashboard web): se traducen por
// `extensions.code` y los datos estructurados de `extensions`; el `message`
// (en español) es solo para bitácora y Apollo Sandbox, nunca se muestra.
//
// Cada código describe UNA regla, no una redacción. `fields` lista los campos
// de `extensions` que acompañan al código (siempre camelCase). Un campo con `?`
// al final es opcional. Los códigos con `source: 'apollo'` los genera Apollo
// Server; esta API no los lanza.
// ============================================================

export const ERROR_CODES = {
  // ---------- Sesión y permisos ----------
  UNAUTHENTICATED: { description: 'La operación requiere una sesión iniciada (falta el token o ya no es válido).', fields: [] },
  FORBIDDEN: {
    description: 'Hay sesión, pero no permiso para la operación o el recurso. `reason` indica cuál regla (ver FORBIDDEN_REASONS).',
    fields: ['reason', 'permission?', 'storeId?', 'status?'],
  },
  INVALID_CREDENTIALS: { description: 'Correo o contraseña incorrectos, o cuenta desactivada (no se distingue a propósito).', fields: [] },
  INVALID_REFRESH_TOKEN: {
    description: 'El refresh token no existe, venció, fue revocado, es de una familia ya cerrada o su cuenta está desactivada (no se distingue a propósito); hay que iniciar sesión con la contraseña.',
    fields: [],
  },
  REFRESH_TOKEN_REUSED: {
    description: 'Se presentó un refresh token ya canjeado fuera de la ventana de gracia (posible robo): se revocó su familia completa (el token vigente y sus sesiones); hay que iniciar sesión con la contraseña.',
    fields: [],
  },
  SERVICE_UNAVAILABLE: {
    description: 'Un servicio de apoyo no responde (sesiones, carrito, roles, ubicación del repartidor o bitácora); conviene reintentar.',
    fields: ['service?'],
  },

  // ---------- Validación y datos ----------
  VALIDATION_ERROR: {
    description: 'Falló la validación del modelo (Mongoose). `field` es el primer campo con error y `violations` los lista todos como [{ field, rule }].',
    fields: ['field?', 'violations'],
  },
  NOT_FOUND: { description: 'La entidad referenciada no existe.', fields: ['entity', 'id'] },
  DUPLICATE_VALUE: { description: 'Ya existe un registro con ese valor único.', fields: ['field?'] },
  EMAIL_ALREADY_REGISTERED: { description: 'Ya hay un usuario registrado con ese correo.', fields: ['field'] },
  PASSWORD_TOO_SHORT: { description: 'La contraseña es más corta que el mínimo.', fields: ['minLength'] },
  INVALID_NAME: { description: 'El nombre del producto o paquete tiene menos del mínimo de caracteres.', fields: ['entity', 'minLength'] },
  INVALID_PRICE: { description: 'El precio del producto o paquete no es un número positivo.', fields: ['entity'] },
  INVALID_STOCK: { description: 'El stock no es un entero no negativo.', fields: [] },
  INVALID_QUANTITY: {
    description: 'La cantidad no es un entero positivo (o excede el máximo del carrito). `context` indica dónde.',
    fields: ['context', 'min?', 'max?'],
  },
  INVALID_DAY_FORMAT: { description: 'El día de la consulta de auditoría no tiene el formato YYYY-MM-DD.', fields: ['field'] },

  // ---------- Paquetes ----------
  PACKAGE_SIZE_OUT_OF_RANGE: { description: 'El paquete tiene menos productos que el mínimo o más que el máximo.', fields: ['count', 'min', 'max'] },
  INVALID_PACKAGE_ITEM: { description: 'Un producto del paquete no trae productId.', fields: [] },
  DUPLICATE_PACKAGE_PRODUCT: { description: 'El paquete repite un producto.', fields: [] },
  PACKAGE_PRODUCT_NOT_FOUND: { description: 'Algún producto del paquete no existe en el catálogo.', fields: [] },
  PACKAGE_STORE_MISMATCH: {
    description: 'Un paquete solo puede contener productos de su propia sucursal (`storeId`); `productIds` son los de otra.',
    fields: ['storeId', 'productIds'],
  },

  // ---------- Disponibilidad e inventario ----------
  ITEM_UNAVAILABLE: {
    description: 'El producto o paquete está desactivado (o, en un paquete, alguno de sus productos lo está).',
    fields: ['itemType', 'id?', 'name', 'componentId?', 'componentName?'],
  },
  INSUFFICIENT_STOCK: { description: 'No alcanza el stock de un producto para la cantidad pedida.', fields: ['productId', 'name', 'requested', 'available'] },
  ITEM_WITHOUT_STORE: {
    description: 'El producto o paquete no pertenece a ninguna sucursal (dato anterior al marketplace sin migrar); no se puede comprar.',
    fields: ['itemType', 'id', 'name'],
  },

  // ---------- Carrito ----------
  INVALID_CART_LINE: { description: 'Una partida debe indicar productId o packageId, uno solo.', fields: [] },
  CART_FULL: { description: 'El carrito ya tiene el máximo de partidas.', fields: ['maxLines'] },
  CART_EMPTY: { description: 'El carrito está vacío.', fields: [] },
  CART_HAS_UNAVAILABLE_ITEMS: {
    description: 'Hay partidas del carrito que ya no se pueden comprar.',
    fields: ['unavailable'],
  },
  CART_STORE_MISMATCH: {
    description: 'El carrito ya tiene artículos de otra sucursal (`cartStoreId`); para agregar este (de `itemStoreId`) hay que vaciarlo primero.',
    fields: ['cartStoreId', 'itemStoreId'],
  },

  // ---------- Cotización y compra ----------
  QUOTE_EXPIRED: { description: 'La cotización expiró o no existe; hay que reconfirmar.', fields: ['newQuote'] },
  QUOTE_MISMATCH: { description: 'La compra ya no coincide con la cotización (productos, cantidades, sucursal o modo).', fields: ['newQuote'] },
  PRICE_CHANGED: { description: 'Los precios cambiaron desde la cotización; hay que confirmar el total nuevo.', fields: ['newQuote'] },
  INVALID_ORDER_MODE: { description: 'El modo de la orden no es PICKUP ni DELIVERY.', fields: ['mode'] },
  EMPTY_ORDER: { description: 'La orden no tiene productos.', fields: [] },
  STORE_REQUIRED: { description: 'Una orden de recogida necesita sucursal.', fields: [] },
  DELIVERY_ADDRESS_REQUIRED: { description: 'Una orden a domicilio necesita dirección de entrega.', fields: [] },
  USER_INACTIVE: { description: 'El usuario que compra está desactivado.', fields: [] },
  STORE_INACTIVE: { description: 'La sucursal de los artículos está desactivada.', fields: ['storeId', 'name'] },
  STORE_MISMATCH: {
    description: 'La sucursal indicada (`expectedStoreId`) no es la de los artículos (`itemsStoreId`): la compra es de la sucursal de sus artículos.',
    fields: ['expectedStoreId', 'itemsStoreId'],
  },
  MIXED_STORES: { description: 'La compra tiene artículos de más de una sucursal (`storeIds`, ordenados).', fields: ['storeIds'] },

  // ---------- Estados de la orden ----------
  INVALID_ORDER_STATUS: { description: 'El estado indicado no existe.', fields: ['status'] },
  ORDER_ALREADY_IN_STATUS: { description: 'La orden ya está en el estado pedido.', fields: ['status'] },
  INVALID_STATUS_TRANSITION: { description: 'La transición de estado no está permitida.', fields: ['from', 'to'] },
  PICKUP_CANNOT_BE_DELIVERED: { description: 'Una orden de recogida (PICKUP) no puede salir a reparto.', fields: [] },

  // ---------- Reparto ----------
  ORDER_NOT_AVAILABLE: {
    description: 'La orden no se puede aceptar ni liberar. `reason`: TAKEN (ya tiene repartidor), NOT_READY (aún no está lista), PICKED_UP (ya salió a reparto), NOT_DELIVERY (es de recogida), CANCELLED o DELIVERED.',
    fields: ['orderId', 'reason'],
  },
  ALREADY_DELIVERING: {
    description: 'El repartidor ya tiene una entrega activa (`activeOrderId`, READY o IN_DELIVERY asignada a él); solo puede llevar una a la vez.',
    fields: ['activeOrderId'],
  },

  INVALID_ORDER_STATE: {
    description: 'La operación no aplica al estado o modalidad actuales de la orden (p. ej. reportar la ubicación de una orden que no es DELIVERY en IN_DELIVERY). No es INVALID_ORDER_STATUS (ese estado no existe) ni INVALID_STATUS_TRANSITION (un cambio de estado no permitido).',
    fields: ['status', 'mode'],
  },
  INVALID_LOCATION: {
    description: 'Las coordenadas no son válidas: no son números finitos, `lat` está fuera de [-90, 90], `lng` fuera de [-180, 180], o ambas son exactamente 0 (valor centinela de "sin posición"). `field`: lat, lng o location (el par).',
    fields: ['field'],
  },

  // ---------- Roles y sucursales de usuarios ----------
  UNKNOWN_ROLE: { description: 'El rol indicado no existe.', fields: ['role'] },
  ROLE_GRAPH_NODE_NOT_FOUND: { description: 'El usuario o la sucursal no existen en el grafo de roles (Neo4j).', fields: ['userId', 'storeId?'] },
  USER_NOT_ASSIGNED_TO_STORE: { description: 'El usuario no está asignado a esa sucursal.', fields: ['userId', 'storeId'] },

  // ---------- Generados por Apollo Server ----------
  INTERNAL_SERVER_ERROR: { description: 'Error inesperado del servidor (no es una regla de negocio).', fields: [], source: 'apollo' },
  BAD_USER_INPUT: { description: 'Una variable o argumento no tiene un valor válido para su tipo (p. ej. un DateTime mal formado).', fields: [], source: 'apollo' },
  GRAPHQL_VALIDATION_FAILED: { description: 'La consulta no valida contra el esquema.', fields: [], source: 'apollo' },
  GRAPHQL_PARSE_FAILED: { description: 'La consulta no se puede interpretar como GraphQL.', fields: [], source: 'apollo' },
};

// Razones de FORBIDDEN (extensions.reason). FORBIDDEN conserva su código porque
// el plugin de auditoría clasifica los accesos denegados (ACCESS_DENIED) por él.
export const FORBIDDEN_REASONS = {
  PERMISSION_REQUIRED: 'Falta el permiso `permission` para la operación.',
  NOT_RESOURCE_OWNER: 'El recurso es de otro usuario y no se tiene users:manage.',
  ORDER_VIEW_DENIED: 'No se puede ver esa orden.',
  ORDER_STATUS_CHANGE_DENIED: 'No se puede pasar la orden al estado `status`.',
  ORDER_CANCEL_DENIED: 'No se puede cancelar esa orden.',
  STORE_NOT_ASSIGNED: 'La sucursal `storeId` no está asignada al usuario.',
  OWN_ORDERS_ONLY: 'Solo se pueden consultar las órdenes propias.',
  CANNOT_CHANGE_OWN_ROLE: 'Un usuario no puede cambiar su propio rol.',
  NOT_ASSIGNED_DRIVER: 'La orden a domicilio tiene otro repartidor asignado: solo él (o ADMIN) la recoge y la entrega, y solo él reporta su ubicación; liberarla pueden él, el personal de mostrador de la sucursal (orders:prepare) o ADMIN.',
  NO_DRIVER_ASSIGNED: 'La orden a domicilio no tiene repartidor asignado: primero hay que aceptarla (acceptDelivery). Al reintentar releaseDelivery significa que ya se liberó.',
  OWN_ORDER: 'Un repartidor no puede aceptar el reparto de una orden suya.',
};

export const isErrorCode = code => typeof code === 'string' && Object.hasOwn(ERROR_CODES, code);

// `code` viaja al cliente en extensions.code; `details` agrega datos para
// reaccionar al error o rearmar el mensaje en otro idioma (p. ej. la cotización
// nueva tras PRICE_CHANGED). El código es obligatorio y debe estar en el catálogo.
export class DomainError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    if (!isErrorCode(code)) throw new TypeError(`DomainError sin código de catálogo: ${String(code)}`);
    this.name = 'DomainError';
    this.extensions = { ...details, code };
  }
}

// ---------- NOT_FOUND ----------
export const ENTITY_LABELS = {
  USER: 'Usuario',
  STORE: 'Sucursal',
  ADDRESS: 'Dirección',
  CATEGORY: 'Categoría',
  PRODUCT: 'Producto',
  PACKAGE: 'Paquete',
  DISCOUNT: 'Descuento',
  ORDER: 'Orden',
  SHOPPING_LIST: 'Lista',
};

export const notFoundError = (entity, id) => new DomainError(
  `${ENTITY_LABELS[entity]} no encontrado${id ? ` (${id})` : ''}.`,
  'NOT_FOUND',
  { entity, id: id == null ? null : String(id) },
);
