// ============================================================
// POLÍTICA DE ACCESO (RBAC) — dominio puro
//
// Aquí se define el catálogo de roles, permisos y menús. En tiempo de
// ejecución la fuente de verdad es Neo4j: este catálogo solo se usa para
// crearlo/actualizarlo al arrancar. Las reglas (quién puede mover una orden,
// quién ve qué) se evalúan con el "access" de la sesión:
//   { id, role, permissions: [..], storeIds: [..] }
// ============================================================

export const ROLES = ['CUSTOMER', 'STAFF', 'DELIVERY', 'MANAGER', 'ADMIN'];
export const DEFAULT_ROLE = 'CUSTOMER';

export const PERMISSIONS = {
  ORDERS_PREPARE: 'orders:prepare',
  ORDERS_DELIVER: 'orders:deliver',
  STOCK_MANAGE: 'stock:manage',
  CATALOG_MANAGE: 'catalog:manage',
  REPORTS_VIEW: 'reports:view',
  STORES_MANAGE: 'stores:manage',
  USERS_MANAGE: 'users:manage',
  AUDIT_VIEW: 'audit:view',
  ALL_STORES: 'scope:all_stores',
};
const P = PERMISSIONS;

export const PERMISSION_CATALOG = [
  { name: P.ORDERS_PREPARE, description: 'Confirmar, preparar, marcar listas y cancelar órdenes de su sucursal; entregar las de recogida.' },
  { name: P.ORDERS_DELIVER, description: 'Aceptar las órdenes DELIVERY listas de su sucursal y llevar y marcar como entregadas las asignadas a él (una a la vez).' },
  { name: P.STOCK_MANAGE, description: 'Ajustar el inventario de los productos de sus sucursales.' },
  { name: P.CATALOG_MANAGE, description: 'Crear y editar productos, paquetes y descuentos de sus sucursales (categorías: además scope:all_stores).' },
  { name: P.REPORTS_VIEW, description: 'Consultar los reportes de ventas y demanda de sus sucursales.' },
  { name: P.STORES_MANAGE, description: 'Crear y editar sucursales.' },
  { name: P.USERS_MANAGE, description: 'Ver usuarios, asignar roles y sucursales.' },
  { name: P.AUDIT_VIEW, description: 'Consultar la bitácora de auditoría.' },
  { name: P.ALL_STORES, description: 'Actuar sobre todas las sucursales (sin asignación por sucursal).' },
];

// Jerarquía: ADMIN → MANAGER → STAFF → CUSTOMER ; DELIVERY → CUSTOMER.
// Los permisos efectivos de un rol incluyen los de todos los roles que hereda.
export const ROLE_CATALOG = [
  { name: 'CUSTOMER', description: 'Cliente: compra para recoger o a domicilio.', inherits: [], permissions: [] },
  { name: 'STAFF', description: 'Empleado de mostrador de una sucursal.', inherits: ['CUSTOMER'], permissions: [P.ORDERS_PREPARE, P.STOCK_MANAGE] },
  { name: 'DELIVERY', description: 'Repartidor de una sucursal.', inherits: ['CUSTOMER'], permissions: [P.ORDERS_DELIVER] },
  { name: 'MANAGER', description: 'Gerente: personal de sucursal más catálogo y reportes.', inherits: ['STAFF'], permissions: [P.CATALOG_MANAGE, P.REPORTS_VIEW] },
  { name: 'ADMIN', description: 'Dueño / sistemas: todo, en todas las sucursales.', inherits: ['MANAGER'], permissions: [P.ORDERS_DELIVER, P.STORES_MANAGE, P.USERS_MANAGE, P.AUDIT_VIEW, P.ALL_STORES] },
];

// Menú de navegación para el cliente web. Un rol ve un elemento si lo tiene
// asignado él o algún rol que hereda.
export const MENU_CATALOG = [
  { id: 'tienda', title: 'Tienda', order: 1, roles: ['CUSTOMER'], children: [
    { id: 'catalogo', title: 'Catálogo', order: 1, path: '/catalogo', roles: ['CUSTOMER'] },
    { id: 'carrito', title: 'Mi carrito', order: 2, path: '/carrito', roles: ['CUSTOMER'] },
    { id: 'mis-pedidos', title: 'Mis pedidos', order: 3, path: '/mis-pedidos', roles: ['CUSTOMER'] },
    { id: 'mis-listas', title: 'Mis listas', order: 4, path: '/mis-listas', roles: ['CUSTOMER'] },
  ] },
  { id: 'sucursal', title: 'Sucursal', order: 2, roles: ['STAFF'], children: [
    { id: 'pedidos-sucursal', title: 'Pedidos de la sucursal', order: 1, path: '/sucursal/pedidos', roles: ['STAFF'] },
    { id: 'inventario', title: 'Inventario', order: 2, path: '/sucursal/inventario', roles: ['STAFF'] },
  ] },
  { id: 'reparto', title: 'Reparto', order: 3, roles: ['DELIVERY', 'ADMIN'], children: [
    { id: 'entregas', title: 'Entregas', order: 1, path: '/reparto/entregas', roles: ['DELIVERY', 'ADMIN'] },
  ] },
  { id: 'administracion', title: 'Administración', order: 4, roles: ['MANAGER'], children: [
    { id: 'productos', title: 'Productos y paquetes', order: 1, path: '/admin/catalogo', roles: ['MANAGER'] },
    { id: 'reportes', title: 'Reportes', order: 2, path: '/admin/reportes', roles: ['MANAGER'] },
    { id: 'sucursales', title: 'Sucursales', order: 3, path: '/admin/sucursales', roles: ['ADMIN'] },
    { id: 'usuarios', title: 'Usuarios y roles', order: 4, path: '/admin/usuarios', roles: ['ADMIN'] },
    { id: 'auditoria', title: 'Auditoría', order: 5, path: '/admin/auditoria', roles: ['ADMIN'] },
  ] },
];

// Rutas del cliente web controladas por RBAC: (:Role)-[:CAN_ACCESS]->(:Route).
// Cada ruta se enlaza solo con el rol MÁS BAJO autorizado; los superiores la
// alcanzan por herencia ([:INHERITS*0..]). /reparto/entregas lleva además ADMIN,
// que no hereda de DELIVERY. Las rutas públicas (/, /login) y el armazón del
// panel (/app) no están aquí: basta con tener (o no) sesión.
export const ROUTE_CATALOG = [
  { path: '/catalogo', roles: ['CUSTOMER'] },
  { path: '/carrito', roles: ['CUSTOMER'] },
  { path: '/mis-pedidos', roles: ['CUSTOMER'] },
  { path: '/mis-listas', roles: ['CUSTOMER'] },
  { path: '/sucursal/pedidos', roles: ['STAFF'] },
  { path: '/sucursal/inventario', roles: ['STAFF'] },
  { path: '/reparto/entregas', roles: ['DELIVERY', 'ADMIN'] },
  { path: '/admin/catalogo', roles: ['MANAGER'] },
  { path: '/admin/reportes', roles: ['MANAGER'] },
  { path: '/admin/sucursales', roles: ['ADMIN'] },
  { path: '/admin/usuarios', roles: ['ADMIN'] },
  { path: '/admin/auditoria', roles: ['ADMIN'] },
];

// ------------------------------------------------------------
// Reglas
// ------------------------------------------------------------
export const isRole = name => ROLES.includes(name);

export const hasPermission = (access, permission) => Boolean(access?.permissions?.includes(permission));

// ¿La sucursal está dentro de lo que este usuario puede operar?
export function inStoreScope(access, storeId) {
  if (hasPermission(access, P.ALL_STORES)) return true;
  return storeId != null && (access?.storeIds ?? []).includes(String(storeId));
}

// ------------------------------------------------------------
// Marketplace: cada sucursal es un negocio con su catálogo y su stock
//
// Las denegaciones se devuelven (no se lanzan): null si se puede, o
// { reason, permission? | storeId? } (una razón de FORBIDDEN_REASONS) para
// que el resolver arme el FORBIDDEN.
// ------------------------------------------------------------

// catalog:manage y stock:manage aplican solo a los artículos de una sucursal
// del alcance del usuario: sus WORKS_AT, o todas con scope:all_stores.
export function storeItemDenial(access, permission, storeId) {
  if (!hasPermission(access, permission)) return { reason: 'PERMISSION_REQUIRED', permission };
  if (!inStoreScope(access, storeId)) return { reason: 'STORE_NOT_ASSIGNED', storeId: storeId == null ? null : String(storeId) };
  return null;
}

// ¿Administra el catálogo o el inventario de esta sucursal? (ve sus artículos aunque esté inactiva)
export const managesStoreItems = (access, storeId) =>
  !storeItemDenial(access, P.CATALOG_MANAGE, storeId) || !storeItemDenial(access, P.STOCK_MANAGE, storeId);

// ¿Ve los artículos ocultos de esta sucursal (los de una sucursal inactiva y
// los productos o paquetes desactivados)? Quien los administra o scope:all_stores.
export const seesStoreItems = (access, storeId) => hasPermission(access, P.ALL_STORES) || managesStoreItems(access, storeId);

// Las categorías son globales, compartidas por todas las sucursales: crearlas
// exige catalog:manage y además scope:all_stores (ADMIN).
export function categoryDenial(access) {
  if (!hasPermission(access, P.CATALOG_MANAGE)) return { reason: 'PERMISSION_REQUIRED', permission: P.CATALOG_MANAGE };
  if (!hasPermission(access, P.ALL_STORES)) return { reason: 'PERMISSION_REQUIRED', permission: P.ALL_STORES };
  return null;
}

// Sucursales que cubre un reporte. Con storeId: esa, si está en el alcance.
// Sin storeId: todas las del alcance ({ storeIds: null } = todas, con scope:all_stores).
export function reportStoreScope(access, storeId) {
  if (storeId != null) {
    return inStoreScope(access, storeId) ? { storeIds: [String(storeId)] } : { denied: { reason: 'STORE_NOT_ASSIGNED', storeId: String(storeId) } };
  }
  if (hasPermission(access, P.ALL_STORES)) return { storeIds: null };
  return { storeIds: (access?.storeIds ?? []).map(String) };
}

const isOwner = (access, order) => access?.id != null && String(access.id) === String(order.userId);

// Permiso que exige mover una orden al estado `to`.
export function requiredOrderPermission(order, to) {
  if (to === 'IN_DELIVERY') return P.ORDERS_DELIVER;
  if (to === 'DELIVERED') return order.mode === 'DELIVERY' ? P.ORDERS_DELIVER : P.ORDERS_PREPARE;
  return P.ORDERS_PREPARE; // CONFIRMED, PREPARING, READY, CANCELLED
}

// ------------------------------------------------------------
// Reparto: la orden DELIVERY la lleva su repartidor asignado (order.driverId)
// ------------------------------------------------------------
export const isAssignedDriver = (access, order) =>
  access?.id != null && order.driverId != null && String(access.id) === String(order.driverId);

// El repartidor asignado que sigue siendo repartidor (orders:deliver). No exige la
// sucursal: si lo cambian de sucursal con una entrega en curso, la puede terminar.
// Si deja de ser repartidor (p. ej. vuelve a CUSTOMER), ya no ve ni mueve la orden.
const isActingDriver = (access, order) => isAssignedDriver(access, order) && hasPermission(access, P.ORDERS_DELIVER);

// ADMIN reparte en cualquier sucursal sin estar asignado (orders:deliver + scope:all_stores).
const deliversAnywhere = access => hasPermission(access, P.ORDERS_DELIVER) && hasPermission(access, P.ALL_STORES);

// Recogerla (READY → IN_DELIVERY) y entregarla (IN_DELIVERY → DELIVERED) en una
// orden a domicilio. READY → DELIVERED no es un paso de la ruta: en DELIVERY lo
// rechaza assertTransition (INVALID_STATUS_TRANSITION).
const isRouteStep = (order, to) =>
  order.mode === 'DELIVERY' && (to === 'IN_DELIVERY' || (to === 'DELIVERED' && order.status === 'IN_DELIVERY'));

// Lista para que un repartidor la acepte: DELIVERY, READY y sin repartidor.
const isOpenDelivery = order => order.mode === 'DELIVERY' && order.status === 'READY' && order.driverId == null;

// Personal que opera órdenes en esa sucursal (mostrador o reparto).
const isStoreCrew = (access, storeId) =>
  inStoreScope(access, storeId) && (hasPermission(access, P.ORDERS_PREPARE) || hasPermission(access, P.ORDERS_DELIVER));

// null si puede pasar la orden a `to`; si no, { reason, status } (una razón de FORBIDDEN_REASONS).
// Los pasos de la ruta de una orden DELIVERY son de su repartidor asignado. Invariante:
// una orden IN_DELIVERY siempre tiene repartidor, así que recogerla sin repartidor
// es NO_DRIVER_ASSIGNED para todos, ADMIN incluido (ADMIN la acepta primero). ADMIN sí
// puede recoger o entregar la de otro repartidor, y entregar una IN_DELIVERY sin
// repartidor anterior a esta regla. El resto del personal de la sucursal recibe
// NOT_ASSIGNED_DRIVER (o NO_DRIVER_ASSIGNED); quien no es de la sucursal no se entera.
export function orderStatusDenial(access, order, to) {
  if (to === 'CANCELLED' && isOwner(access, order)) return null; // el cliente cancela la suya
  if (isRouteStep(order, to)) {
    if (isActingDriver(access, order)) return null;
    if (!isStoreCrew(access, order.storeId)) return { reason: 'ORDER_STATUS_CHANGE_DENIED', status: to };
    if (deliversAnywhere(access) && (order.driverId != null || to === 'DELIVERED')) return null;
    return { reason: order.driverId == null ? 'NO_DRIVER_ASSIGNED' : 'NOT_ASSIGNED_DRIVER', status: to };
  }
  if (inStoreScope(access, order.storeId) && hasPermission(access, requiredOrderPermission(order, to))) return null;
  return { reason: 'ORDER_STATUS_CHANGE_DENIED', status: to };
}

export const canChangeOrderStatus = (access, order, to) => orderStatusDenial(access, order, to) === null;

// Aceptar una entrega: orders:deliver en la sucursal de la orden, y que no sea
// una orden propia (nadie se reparte a sí mismo).
export function acceptDeliveryDenial(access, order) {
  if (!hasPermission(access, P.ORDERS_DELIVER)) return { reason: 'PERMISSION_REQUIRED', permission: P.ORDERS_DELIVER };
  if (!inStoreScope(access, order.storeId)) return { reason: 'STORE_NOT_ASSIGNED', storeId: order.storeId == null ? null : String(order.storeId) };
  if (isOwner(access, order)) return { reason: 'OWN_ORDER' };
  return null;
}

// Liberar una entrega: su repartidor asignado (si sigue siendo repartidor), el
// personal de mostrador de la sucursal (orders:prepare) o ADMIN. Otro repartidor:
// NOT_ASSIGNED_DRIVER, o NO_DRIVER_ASSIGNED si ya está libre.
export function releaseDeliveryDenial(access, order) {
  if (isActingDriver(access, order)) return null;
  const prepares = hasPermission(access, P.ORDERS_PREPARE);
  if (!prepares && !hasPermission(access, P.ORDERS_DELIVER)) return { reason: 'PERMISSION_REQUIRED', permission: P.ORDERS_DELIVER };
  if (!inStoreScope(access, order.storeId)) return { reason: 'STORE_NOT_ASSIGNED', storeId: order.storeId == null ? null : String(order.storeId) };
  if (prepares) return null;
  return { reason: order.driverId == null ? 'NO_DRIVER_ASSIGNED' : 'NOT_ASSIGNED_DRIVER' };
}

// Reportar la ubicación (reportDriverLocation): solo su repartidor asignado, mientras
// siga teniendo orders:deliver. Otro repartidor de la sucursal o ADMIN: NOT_ASSIGNED_DRIVER,
// o NO_DRIVER_ASSIGNED si nadie la ha aceptado. Quien no es de la sucursal no se entera de
// la asignación (STORE_NOT_ASSIGNED). Esto va antes que el estado de la orden: la app se
// detiene ante "no es tuya" y también ante "ya no está en reparto".
export function reportLocationDenial(access, order) {
  if (!hasPermission(access, P.ORDERS_DELIVER)) return { reason: 'PERMISSION_REQUIRED', permission: P.ORDERS_DELIVER };
  if (isAssignedDriver(access, order)) return null;
  if (!inStoreScope(access, order.storeId)) return { reason: 'STORE_NOT_ASSIGNED', storeId: order.storeId == null ? null : String(order.storeId) };
  return { reason: order.driverId == null ? 'NO_DRIVER_ASSIGNED' : 'NOT_ASSIGNED_DRIVER' };
}

// Quién ve una orden: su cliente, su repartidor asignado (mientras siga siendo
// repartidor, de la sucursal que sea), el personal de mostrador de la sucursal,
// ADMIN, y el resto de repartidores de la sucursal solo mientras está libre para aceptarla.
export function canViewOrder(access, order) {
  if (isOwner(access, order) || isActingDriver(access, order)) return true;
  if (!inStoreScope(access, order.storeId)) return false;
  if (hasPermission(access, P.ORDERS_PREPARE)) return true;
  return hasPermission(access, P.ORDERS_DELIVER) && isOpenDelivery(order);
}

// Quién hizo un cambio de estado (`by` en el historial): lo ve quien puede ver
// la orden y NO es su cliente (personal de la sucursal o ADMIN). El cliente ve
// solo el rol (byRole), nunca la identidad del empleado.
export const canSeeStatusActor = (access, order) => !isOwner(access, order) && canViewOrder(access, order);
