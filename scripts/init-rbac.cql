// ============================================================
// GENERADO AUTOMÁTICAMENTE. NO EDITAR A MANO.
// Se genera con: npm run rbac:script   Verificación: npm run rbac:check
//
// init-rbac.cql — Control de Acceso Basado en Roles (RBAC) y navegación
// dinámica en Neo4j para Pickaroo. Modela:
//   (:User {id})-[:HAS_ROLE]->(:Role {name})
//   (:Role)-[:INHERITS*0..]->(:Role)              (superior)-[:INHERITS]->(inferior)
//   (:Role)-[:HAS_PERMISSION]->(:Permission {name})  permisos de operación
//   (:Role)-[:CAN_ACCESS]->(:Route {path})        solo el rol más bajo autorizado
//   (:Role)-[:CAN_VIEW_MENU]->(:MenuNode {id, title, order})
//   (:MenuNode)-[:HAS_CHILD]->(:MenuNode)
//   (:MenuNode)-[:NAVIGATES_TO]->(:Route)
//   (:User)-[:WORKS_AT]->(:Store {id})            alcance por sucursal (lo escribe la API)
//
// Es idempotente: se puede ejecutar las veces que haga falta y deja el mismo
// catálogo que escribe la API al arrancar (bootstrapRbac). No crea usuarios:
// sus ids son los _id de MongoDB y la API los enlaza en el login.
//
// Atomicidad: las secciones 1 y 2 (restricciones y migración) son comandos de
// esquema y cada uno va en su propia transacción. Las secciones 3 a 7 (el
// catálogo) van en UNA transacción (:begin / :commit de cypher-shell), así una
// API conectada nunca ve el catálogo a medias. Aun así conviene ejecutarlo con la
// API detenida: entre las secciones 1 y 2 el grafo queda un momento sin las
// restricciones anteriores o sin el menú anterior.
//
// Aplicarlo (contraseña de NEO4J_AUTH en docker-compose.yml):
//   docker exec -i pickaroo-neo4j cypher-shell -u neo4j -p <password> < scripts/init-rbac.cql
// ============================================================

// ------------------------------------------------------------
// 1. Restricciones de unicidad.
// Primero se borran las de nombre anterior: Neo4j no crea una restricción
// equivalente con otro nombre.
// ------------------------------------------------------------
DROP CONSTRAINT role_name IF EXISTS;
DROP CONSTRAINT user_id IF EXISTS;
DROP CONSTRAINT route_path IF EXISTS;
DROP CONSTRAINT menu_id IF EXISTS;
DROP CONSTRAINT permission_name IF EXISTS;
DROP CONSTRAINT store_id IF EXISTS;
CREATE CONSTRAINT unique_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT unique_role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE;
CREATE CONSTRAINT unique_route_path IF NOT EXISTS FOR (rt:Route) REQUIRE rt.path IS UNIQUE;
CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode) REQUIRE m.id IS UNIQUE;
CREATE CONSTRAINT unique_permission_name IF NOT EXISTS FOR (p:Permission) REQUIRE p.name IS UNIQUE;
CREATE CONSTRAINT unique_store_id IF NOT EXISTS FOR (s:Store) REQUIRE s.id IS UNIQUE;

// ------------------------------------------------------------
// 2. Migración: los nodos (:MenuItem) de la versión anterior son datos de
// catálogo. Se borran y se recrean abajo como (:MenuNode).
// ------------------------------------------------------------
MATCH (m:MenuItem) DETACH DELETE m;

// Desde aquí hasta :commit, una sola transacción.
:begin

// ------------------------------------------------------------
// 3. Roles con su descripción.
// ------------------------------------------------------------
MERGE (r:Role {name: 'CUSTOMER'}) SET r.description = 'Cliente: compra para recoger o a domicilio.';
MERGE (r:Role {name: 'STAFF'}) SET r.description = 'Empleado de mostrador de una sucursal.';
MERGE (r:Role {name: 'DELIVERY'}) SET r.description = 'Repartidor de una sucursal.';
MERGE (r:Role {name: 'MANAGER'}) SET r.description = 'Gerente: personal de sucursal más catálogo y reportes.';
MERGE (r:Role {name: 'ADMIN'}) SET r.description = 'Dueño / sistemas: todo, en todas las sucursales.';

// ------------------------------------------------------------
// 4. Jerarquía de roles: (superior)-[:INHERITS]->(inferior).
// ADMIN → MANAGER → STAFF → CUSTOMER, y DELIVERY → CUSTOMER.
// El rol superior obtiene los permisos, rutas y menús del inferior.
// ------------------------------------------------------------
MATCH (r:Role)-[old:INHERITS]->(:Role) WHERE r.name IN ['CUSTOMER', 'STAFF', 'DELIVERY', 'MANAGER', 'ADMIN'] DELETE old;
MATCH (sup:Role {name: 'STAFF'}), (inf:Role {name: 'CUSTOMER'}) MERGE (sup)-[:INHERITS]->(inf);
MATCH (sup:Role {name: 'DELIVERY'}), (inf:Role {name: 'CUSTOMER'}) MERGE (sup)-[:INHERITS]->(inf);
MATCH (sup:Role {name: 'MANAGER'}), (inf:Role {name: 'STAFF'}) MERGE (sup)-[:INHERITS]->(inf);
MATCH (sup:Role {name: 'ADMIN'}), (inf:Role {name: 'MANAGER'}) MERGE (sup)-[:INHERITS]->(inf);

// ------------------------------------------------------------
// 5. Permisos de operación y [:HAS_PERMISSION] de cada rol (sin contar los heredados).
// ------------------------------------------------------------
MERGE (p:Permission {name: 'orders:prepare'}) SET p.description = 'Confirmar, preparar, marcar listas y cancelar órdenes de su sucursal; entregar las de recogida.';
MERGE (p:Permission {name: 'orders:deliver'}) SET p.description = 'Aceptar las órdenes DELIVERY listas de su sucursal y llevar y marcar como entregadas las asignadas a él (una a la vez).';
MERGE (p:Permission {name: 'stock:manage'}) SET p.description = 'Ajustar el inventario de los productos de sus sucursales.';
MERGE (p:Permission {name: 'catalog:manage'}) SET p.description = 'Crear y editar productos, paquetes y descuentos de sus sucursales (categorías: además scope:all_stores).';
MERGE (p:Permission {name: 'reports:view'}) SET p.description = 'Consultar los reportes de ventas y demanda de sus sucursales.';
MERGE (p:Permission {name: 'stores:manage'}) SET p.description = 'Crear y editar sucursales.';
MERGE (p:Permission {name: 'users:manage'}) SET p.description = 'Ver usuarios, asignar roles y sucursales.';
MERGE (p:Permission {name: 'audit:view'}) SET p.description = 'Consultar la bitácora de auditoría.';
MERGE (p:Permission {name: 'scope:all_stores'}) SET p.description = 'Actuar sobre todas las sucursales (sin asignación por sucursal).';
MATCH (r:Role)-[old:HAS_PERMISSION]->(:Permission) WHERE r.name IN ['CUSTOMER', 'STAFF', 'DELIVERY', 'MANAGER', 'ADMIN'] DELETE old;
MATCH (r:Role {name: 'STAFF'}), (p:Permission {name: 'orders:prepare'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'STAFF'}), (p:Permission {name: 'stock:manage'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'DELIVERY'}), (p:Permission {name: 'orders:deliver'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'MANAGER'}), (p:Permission {name: 'catalog:manage'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'MANAGER'}), (p:Permission {name: 'reports:view'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'ADMIN'}), (p:Permission {name: 'orders:deliver'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'ADMIN'}), (p:Permission {name: 'stores:manage'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'ADMIN'}), (p:Permission {name: 'users:manage'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'ADMIN'}), (p:Permission {name: 'audit:view'}) MERGE (r)-[:HAS_PERMISSION]->(p);
MATCH (r:Role {name: 'ADMIN'}), (p:Permission {name: 'scope:all_stores'}) MERGE (r)-[:HAS_PERMISSION]->(p);

// ------------------------------------------------------------
// 6. Rutas web del sistema y [:CAN_ACCESS] SOLO con el rol más bajo autorizado.
// Los roles superiores llegan por transitividad de [:INHERITS*0..].
// /reparto/entregas lleva además ADMIN, que no hereda de DELIVERY.
// ------------------------------------------------------------
MATCH (stale:Route) WHERE NOT stale.path IN ['/catalogo', '/carrito', '/mis-pedidos', '/mis-listas', '/sucursal/pedidos', '/sucursal/inventario', '/reparto/entregas', '/admin/catalogo', '/admin/reportes', '/admin/sucursales', '/admin/usuarios', '/admin/auditoria'] DETACH DELETE stale;
MATCH (:Role)-[old:CAN_ACCESS]->(:Route) DELETE old;
MERGE (:Route {path: '/catalogo'});
MERGE (:Route {path: '/carrito'});
MERGE (:Route {path: '/mis-pedidos'});
MERGE (:Route {path: '/mis-listas'});
MERGE (:Route {path: '/sucursal/pedidos'});
MERGE (:Route {path: '/sucursal/inventario'});
MERGE (:Route {path: '/reparto/entregas'});
MERGE (:Route {path: '/admin/catalogo'});
MERGE (:Route {path: '/admin/reportes'});
MERGE (:Route {path: '/admin/sucursales'});
MERGE (:Route {path: '/admin/usuarios'});
MERGE (:Route {path: '/admin/auditoria'});
MATCH (r:Role {name: 'CUSTOMER'}), (rt:Route {path: '/catalogo'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'CUSTOMER'}), (rt:Route {path: '/carrito'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'CUSTOMER'}), (rt:Route {path: '/mis-pedidos'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'CUSTOMER'}), (rt:Route {path: '/mis-listas'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'STAFF'}), (rt:Route {path: '/sucursal/pedidos'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'STAFF'}), (rt:Route {path: '/sucursal/inventario'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'DELIVERY'}), (rt:Route {path: '/reparto/entregas'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'ADMIN'}), (rt:Route {path: '/reparto/entregas'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'MANAGER'}), (rt:Route {path: '/admin/catalogo'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'MANAGER'}), (rt:Route {path: '/admin/reportes'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'ADMIN'}), (rt:Route {path: '/admin/sucursales'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'ADMIN'}), (rt:Route {path: '/admin/usuarios'}) MERGE (r)-[:CAN_ACCESS]->(rt);
MATCH (r:Role {name: 'ADMIN'}), (rt:Route {path: '/admin/auditoria'}) MERGE (r)-[:CAN_ACCESS]->(rt);

// ------------------------------------------------------------
// 7. Árbol de menú desacoplado de las rutas:
// (:MenuNode {id, title, order}), submenús con [:HAS_CHILD], la acción del clic
// con [:NAVIGATES_TO] y la visibilidad por rol con [:CAN_VIEW_MENU].
// ------------------------------------------------------------
MATCH (:Role)-[old:CAN_VIEW_MENU]->(:MenuNode) DELETE old;
MATCH (:MenuNode)-[old:HAS_CHILD|NAVIGATES_TO]->() DELETE old;
MATCH (stale:MenuNode) WHERE NOT stale.id IN ['tienda', 'catalogo', 'carrito', 'mis-pedidos', 'mis-listas', 'sucursal', 'pedidos-sucursal', 'inventario', 'reparto', 'entregas', 'administracion', 'productos', 'reportes', 'sucursales', 'usuarios', 'auditoria'] DETACH DELETE stale;
MERGE (m:MenuNode {id: 'tienda'}) SET m.title = 'Tienda', m.order = 1;
MERGE (m:MenuNode {id: 'catalogo'}) SET m.title = 'Catálogo', m.order = 1;
MERGE (m:MenuNode {id: 'carrito'}) SET m.title = 'Mi carrito', m.order = 2;
MERGE (m:MenuNode {id: 'mis-pedidos'}) SET m.title = 'Mis pedidos', m.order = 3;
MERGE (m:MenuNode {id: 'mis-listas'}) SET m.title = 'Mis listas', m.order = 4;
MERGE (m:MenuNode {id: 'sucursal'}) SET m.title = 'Sucursal', m.order = 2;
MERGE (m:MenuNode {id: 'pedidos-sucursal'}) SET m.title = 'Pedidos de la sucursal', m.order = 1;
MERGE (m:MenuNode {id: 'inventario'}) SET m.title = 'Inventario', m.order = 2;
MERGE (m:MenuNode {id: 'reparto'}) SET m.title = 'Reparto', m.order = 3;
MERGE (m:MenuNode {id: 'entregas'}) SET m.title = 'Entregas', m.order = 1;
MERGE (m:MenuNode {id: 'administracion'}) SET m.title = 'Administración', m.order = 4;
MERGE (m:MenuNode {id: 'productos'}) SET m.title = 'Productos y paquetes', m.order = 1;
MERGE (m:MenuNode {id: 'reportes'}) SET m.title = 'Reportes', m.order = 2;
MERGE (m:MenuNode {id: 'sucursales'}) SET m.title = 'Sucursales', m.order = 3;
MERGE (m:MenuNode {id: 'usuarios'}) SET m.title = 'Usuarios y roles', m.order = 4;
MERGE (m:MenuNode {id: 'auditoria'}) SET m.title = 'Auditoría', m.order = 5;
MATCH (parent:MenuNode {id: 'tienda'}), (child:MenuNode {id: 'catalogo'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'tienda'}), (child:MenuNode {id: 'carrito'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'tienda'}), (child:MenuNode {id: 'mis-pedidos'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'tienda'}), (child:MenuNode {id: 'mis-listas'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'sucursal'}), (child:MenuNode {id: 'pedidos-sucursal'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'sucursal'}), (child:MenuNode {id: 'inventario'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'reparto'}), (child:MenuNode {id: 'entregas'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'administracion'}), (child:MenuNode {id: 'productos'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'administracion'}), (child:MenuNode {id: 'reportes'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'administracion'}), (child:MenuNode {id: 'sucursales'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'administracion'}), (child:MenuNode {id: 'usuarios'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (parent:MenuNode {id: 'administracion'}), (child:MenuNode {id: 'auditoria'}) MERGE (parent)-[:HAS_CHILD]->(child);
MATCH (m:MenuNode {id: 'catalogo'}), (rt:Route {path: '/catalogo'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'carrito'}), (rt:Route {path: '/carrito'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'mis-pedidos'}), (rt:Route {path: '/mis-pedidos'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'mis-listas'}), (rt:Route {path: '/mis-listas'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'pedidos-sucursal'}), (rt:Route {path: '/sucursal/pedidos'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'inventario'}), (rt:Route {path: '/sucursal/inventario'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'entregas'}), (rt:Route {path: '/reparto/entregas'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'productos'}), (rt:Route {path: '/admin/catalogo'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'reportes'}), (rt:Route {path: '/admin/reportes'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'sucursales'}), (rt:Route {path: '/admin/sucursales'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'usuarios'}), (rt:Route {path: '/admin/usuarios'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (m:MenuNode {id: 'auditoria'}), (rt:Route {path: '/admin/auditoria'}) MERGE (m)-[:NAVIGATES_TO]->(rt);
MATCH (r:Role {name: 'CUSTOMER'}), (m:MenuNode {id: 'tienda'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'CUSTOMER'}), (m:MenuNode {id: 'catalogo'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'CUSTOMER'}), (m:MenuNode {id: 'carrito'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'CUSTOMER'}), (m:MenuNode {id: 'mis-pedidos'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'CUSTOMER'}), (m:MenuNode {id: 'mis-listas'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'STAFF'}), (m:MenuNode {id: 'sucursal'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'STAFF'}), (m:MenuNode {id: 'pedidos-sucursal'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'STAFF'}), (m:MenuNode {id: 'inventario'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'DELIVERY'}), (m:MenuNode {id: 'reparto'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'ADMIN'}), (m:MenuNode {id: 'reparto'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'DELIVERY'}), (m:MenuNode {id: 'entregas'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'ADMIN'}), (m:MenuNode {id: 'entregas'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'MANAGER'}), (m:MenuNode {id: 'administracion'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'MANAGER'}), (m:MenuNode {id: 'productos'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'MANAGER'}), (m:MenuNode {id: 'reportes'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'ADMIN'}), (m:MenuNode {id: 'sucursales'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'ADMIN'}), (m:MenuNode {id: 'usuarios'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);
MATCH (r:Role {name: 'ADMIN'}), (m:MenuNode {id: 'auditoria'}) MERGE (r)-[:CAN_VIEW_MENU]->(m);

:commit

// ------------------------------------------------------------
// 8. Usuarios: no se crean aquí. Su id es el _id de MongoDB y la API los
// crea en el login con el rol de MongoDB. Ejemplo para enlazar uno a mano, con
// los parámetros userId (el _id) y role (p. ej. CUSTOMER) definidos antes en
// cypher-shell con :param, y punto y coma al final:
// ------------------------------------------------------------
//   MERGE (u:User {id: $userId})
//   WITH u
//   MATCH (r:Role {name: $role})
//   OPTIONAL MATCH (u)-[old:HAS_ROLE]->(:Role)
//   DELETE old
//   MERGE (u)-[:HAS_ROLE]->(r)
