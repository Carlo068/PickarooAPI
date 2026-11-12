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
  { name: P.ORDERS_DELIVER, description: 'Llevar a domicilio y marcar como entregadas las órdenes DELIVERY de su sucursal.' },
  { name: P.STOCK_MANAGE, description: 'Ajustar el inventario de productos.' },
  { name: P.CATALOG_MANAGE, description: 'Crear y editar categorías, productos, paquetes y descuentos.' },
  { name: P.REPORTS_VIEW, description: 'Consultar los reportes de ventas y demanda.' },
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

const isOwner = (access, order) => access?.id != null && String(access.id) === String(order.userId);

// Permiso que exige mover una orden al estado `to`.
export function requiredOrderPermission(order, to) {
  if (to === 'IN_DELIVERY') return P.ORDERS_DELIVER;
  if (to === 'DELIVERED') return order.mode === 'DELIVERY' ? P.ORDERS_DELIVER : P.ORDERS_PREPARE;
  return P.ORDERS_PREPARE; // CONFIRMED, PREPARING, READY, CANCELLED
}

export function canChangeOrderStatus(access, order, to) {
  if (to === 'CANCELLED' && isOwner(access, order)) return true; // el cliente cancela la suya
  return inStoreScope(access, order.storeId) && hasPermission(access, requiredOrderPermission(order, to));
}

// Personal de la sucursal: ve las órdenes que puede operar.
export function canViewOrder(access, order) {
  if (isOwner(access, order)) return true;
  if (!inStoreScope(access, order.storeId)) return false;
  if (hasPermission(access, P.ORDERS_PREPARE)) return true;
  return hasPermission(access, P.ORDERS_DELIVER) && order.mode === 'DELIVERY';
}
