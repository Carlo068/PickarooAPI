// ============================================================
// RBAC EN NEO4J — consultas Cypher
//
//   (:User {id})-[:HAS_ROLE]->(:Role {name})-[:INHERITS]->(:Role)   (superior)->(inferior)
//   (:Role)-[:HAS_PERMISSION]->(:Permission {name})
//   (:User)-[:WORKS_AT]->(:Store {id})
//   (:Role)-[:CAN_ACCESS]->(:Route {path})                         solo el rol más bajo
//   (:Role)-[:CAN_VIEW_MENU]->(:MenuNode {id, title, order})-[:NAVIGATES_TO]->(:Route)
//   (:MenuNode)-[:HAS_CHILD]->(:MenuNode)
//
// El id de User y Store es el _id de MongoDB, así los dos almacenes se cruzan.
// Las consultas de ruta y de menú están en rbac.service.js.
// ============================================================

import { DomainError } from '../domain/errors.js';
import { ROLE_CATALOG, PERMISSION_CATALOG, MENU_CATALOG, ROUTE_CATALOG, isRole } from '../domain/access.js';
import { readQuery, writeQuery, toNumber } from './neo4j.js';
import { assertRbacReady as assertReady } from './rbac.service.js';

// ---------- Catálogo (idempotente: se ejecuta en cada arranque) ----------
// Los mismos enunciados (y los mismos catálogos) generan scripts/init-rbac.cql.
export const CONSTRAINTS = [
  'CREATE CONSTRAINT unique_user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT unique_role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE',
  'CREATE CONSTRAINT unique_route_path IF NOT EXISTS FOR (rt:Route) REQUIRE rt.path IS UNIQUE',
  'CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT unique_permission_name IF NOT EXISTS FOR (p:Permission) REQUIRE p.name IS UNIQUE',
  'CREATE CONSTRAINT unique_store_id IF NOT EXISTS FOR (s:Store) REQUIRE s.id IS UNIQUE',
];

// Migración: las restricciones con los nombres anteriores. Van antes que las
// nuevas porque Neo4j no crea una restricción equivalente con otro nombre
// (IF NOT EXISTS la omitiría y luego quedaría sin ninguna al borrar la vieja).
// menu_id era la de (:MenuItem), la etiqueta anterior de MenuNode.
export const LEGACY_CONSTRAINTS = ['role_name', 'user_id', 'route_path', 'menu_id', 'permission_name', 'store_id']
  .map(name => `DROP CONSTRAINT ${name} IF EXISTS`);

// Migración: los nodos (:MenuItem) eran datos de catálogo; se recrean como (:MenuNode).
export const LEGACY_MENU_CLEANUP = 'MATCH (m:MenuItem) DETACH DELETE m';

export const flatMenu = MENU_CATALOG.flatMap(parent => [
  { id: parent.id, title: parent.title, order: parent.order, path: parent.path ?? null, roles: parent.roles, parentId: null },
  ...parent.children.map(c => ({ id: c.id, title: c.title, order: c.order, path: c.path ?? null, roles: c.roles, parentId: parent.id })),
]);

export async function bootstrapRbac(stores = []) {
  for (const c of LEGACY_CONSTRAINTS) await writeQuery(c);
  await writeQuery(LEGACY_MENU_CLEANUP);
  for (const c of CONSTRAINTS) await writeQuery(c);

  await writeQuery(
    `UNWIND $permissions AS p
     MERGE (perm:Permission {name: p.name}) SET perm.description = p.description`,
    { permissions: PERMISSION_CATALOG },
  );

  // El catálogo define exactamente los permisos y la herencia de cada rol:
  // se borran las aristas anteriores y se vuelven a crear.
  await writeQuery(
    `UNWIND $roles AS r
     MERGE (role:Role {name: r.name}) SET role.description = r.description
     WITH role, r
     OPTIONAL MATCH (role)-[old:HAS_PERMISSION|INHERITS]->()
     DELETE old
     WITH DISTINCT role, r
     FOREACH (pName IN r.permissions |
       MERGE (p:Permission {name: pName}) MERGE (role)-[:HAS_PERMISSION]->(p))
     FOREACH (parent IN r.inherits |
       MERGE (pr:Role {name: parent}) MERGE (role)-[:INHERITS]->(pr))`,
    { roles: ROLE_CATALOG },
  );

  // Rutas: solo las del catálogo, cada una enlazada con su rol más bajo.
  await writeQuery(
    `OPTIONAL MATCH (stale:Route) WHERE NOT stale.path IN $paths
     DETACH DELETE stale
     WITH count(*) AS removed
     OPTIONAL MATCH (:Role)-[old:CAN_ACCESS]->(:Route)
     DELETE old
     WITH count(*) AS cleared
     UNWIND $routes AS rt
     MERGE (route:Route {path: rt.path})
     FOREACH (roleName IN rt.roles |
       MERGE (role:Role {name: roleName}) MERGE (role)-[:CAN_ACCESS]->(route))`,
    { routes: ROUTE_CATALOG, paths: ROUTE_CATALOG.map(r => r.path) },
  );

  // Árbol de menú: se borran sus aristas y los nodos que ya no están en el catálogo.
  await writeQuery(
    `OPTIONAL MATCH (:Role)-[old:CAN_VIEW_MENU]->(:MenuNode)
     DELETE old
     WITH count(*) AS cleared
     OPTIONAL MATCH (:MenuNode)-[oldEdge:HAS_CHILD|NAVIGATES_TO]->()
     DELETE oldEdge
     WITH count(*) AS clearedEdges
     OPTIONAL MATCH (stale:MenuNode) WHERE NOT stale.id IN $ids
     DETACH DELETE stale
     WITH count(*) AS removed
     UNWIND $items AS m
     MERGE (item:MenuNode {id: m.id}) SET item.title = m.title, item.order = toInteger(m.order)
     WITH item, m
     FOREACH (x IN CASE WHEN m.path IS NULL THEN [] ELSE [1] END |
       MERGE (route:Route {path: m.path}) MERGE (item)-[:NAVIGATES_TO]->(route))
     FOREACH (roleName IN m.roles |
       MERGE (role:Role {name: roleName}) MERGE (role)-[:CAN_VIEW_MENU]->(item))
     FOREACH (x IN CASE WHEN m.parentId IS NULL THEN [] ELSE [1] END |
       MERGE (parent:MenuNode {id: m.parentId}) MERGE (parent)-[:HAS_CHILD]->(item))`,
    { items: flatMenu, ids: flatMenu.map(m => m.id) },
  );

  if (stores.length) await syncStores(stores);
  console.log(`🌿 Catálogo RBAC listo en Neo4j: ${ROLE_CATALOG.length} roles, ${PERMISSION_CATALOG.length} permisos, ${ROUTE_CATALOG.length} rutas, ${flatMenu.length} elementos de menú, ${stores.length} sucursal(es).`);
}

// ---------- Sucursales y usuarios (espejo mínimo de Mongo) ----------
export async function syncStores(stores) {
  await writeQuery(
    `UNWIND $stores AS s
     MERGE (store:Store {id: s.id}) SET store.name = s.name, store.isActive = s.isActive`,
    { stores: stores.map(s => ({ id: String(s._id ?? s.id), name: s.name, isActive: s.isActive !== false })) },
  );
}

// Crea/actualiza el nodo del usuario. Si no tiene rol, le asigna `fallbackRole`
// (auto-reparación al login para usuarios creados antes del grafo).
export async function ensureUser({ id, email, name }, fallbackRole) {
  await writeQuery(
    `MERGE (u:User {id: $id}) SET u.email = $email, u.name = $name
     WITH u
     WHERE NOT (u)-[:HAS_ROLE]->(:Role)
     MATCH (r:Role {name: $role})
     MERGE (u)-[:HAS_ROLE]->(r)`,
    { id: String(id), email, name, role: fallbackRole },
  );
}

// Rol directo + permisos efectivos (incluye los heredados) + sucursales asignadas.
// null si el usuario no tiene nodo o rol en el grafo.
export async function getAccess(userId) {
  const [row] = await readQuery(
    `MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
     OPTIONAL MATCH (r)-[:INHERITS*0..]->(:Role)-[:HAS_PERMISSION]->(p:Permission)
     WITH u, r, collect(DISTINCT p.name) AS permissions
     OPTIONAL MATCH (u)-[:WORKS_AT]->(s:Store)
     RETURN r.name AS role, permissions, collect(DISTINCT s.id) AS storeIds,
            collect(DISTINCT {id: s.id, name: s.name}) AS stores
     LIMIT 1`,
    { userId: String(userId) },
  );
  if (!row) return null;
  return {
    role: row.role,
    permissions: [...row.permissions].sort(),
    storeIds: row.storeIds,
    stores: row.stores.filter(s => s.id),
  };
}

// ---------- Administración ----------
export async function setRole(userId, roleName) {
  assertReady();
  if (!isRole(roleName)) throw new DomainError(`El rol "${roleName}" no existe.`, 'UNKNOWN_ROLE', { role: String(roleName) });
  const [row] = await writeQuery(
    `MATCH (u:User {id: $userId})
     MATCH (r:Role {name: $role})
     OPTIONAL MATCH (u)-[old:HAS_ROLE]->(prev:Role)
     WITH u, r, old, prev.name AS previous
     DELETE old
     MERGE (u)-[:HAS_ROLE]->(r)
     RETURN previous`,
    { userId: String(userId), role: roleName },
  );
  if (!row) throw new DomainError('El usuario no existe en el grafo de roles.', 'ROLE_GRAPH_NODE_NOT_FOUND', { userId: String(userId) });
  return row.previous ?? null;
}

export async function assignStore(userId, storeId) {
  assertReady();
  const [row] = await writeQuery(
    `MATCH (u:User {id: $userId}) MATCH (s:Store {id: $storeId})
     MERGE (u)-[:WORKS_AT]->(s)
     RETURN s.name AS store`,
    { userId: String(userId), storeId: String(storeId) },
  );
  if (!row) throw new DomainError('El usuario o la sucursal no existen en el grafo de roles.', 'ROLE_GRAPH_NODE_NOT_FOUND', { userId: String(userId), storeId: String(storeId) });
  return row.store;
}

export async function removeStore(userId, storeId) {
  assertReady();
  const [row] = await writeQuery(
    `MATCH (u:User {id: $userId})-[w:WORKS_AT]->(s:Store {id: $storeId})
     DELETE w
     RETURN s.name AS store`,
    { userId: String(userId), storeId: String(storeId) },
  );
  return row?.store ?? null;
}

export async function listRoles() {
  assertReady();
  const rows = await readQuery(
    `MATCH (r:Role)
     OPTIONAL MATCH (r)-[:INHERITS]->(parent:Role)
     OPTIONAL MATCH (r)-[:HAS_PERMISSION]->(own:Permission)
     WITH r, collect(DISTINCT parent.name) AS inherits, collect(DISTINCT own.name) AS permissions
     OPTIONAL MATCH (r)-[:INHERITS*0..]->(:Role)-[:HAS_PERMISSION]->(eff:Permission)
     OPTIONAL MATCH (u:User)-[:HAS_ROLE]->(r)
     RETURN r.name AS name, r.description AS description, inherits, permissions,
            collect(DISTINCT eff.name) AS effectivePermissions, count(DISTINCT u) AS userCount`,
  );
  const order = ROLE_CATALOG.map(r => r.name);
  return rows
    .map(r => ({ ...r, permissions: r.permissions.sort(), effectivePermissions: r.effectivePermissions.sort(), userCount: toNumber(r.userCount) }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}
