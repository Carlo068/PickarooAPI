// ============================================================
// RBAC EN NEO4J — consultas Cypher
//
//   (:User {id})-[:HAS_ROLE]->(:Role {name})-[:INHERITS]->(:Role)
//   (:Role)-[:HAS_PERMISSION]->(:Permission {name})
//   (:User)-[:WORKS_AT]->(:Store {id})
//   (:Role)-[:CAN_VIEW_MENU]->(:MenuItem)-[:NAVIGATES_TO]->(:Route {path})
//   (:MenuItem)-[:HAS_CHILD]->(:MenuItem)
//
// El id de User y Store es el _id de MongoDB, así los dos almacenes se cruzan.
// ============================================================

import { DomainError } from '../domain/entities.js';
import { ROLE_CATALOG, PERMISSION_CATALOG, MENU_CATALOG, isRole } from '../domain/access.js';
import { readQuery, writeQuery, toNumber, isNeo4jReady } from './neo4j.js';

function assertReady() {
  if (!isNeo4jReady()) throw new DomainError('El servicio de roles (Neo4j) no está disponible. Intenta de nuevo.', 'SERVICE_UNAVAILABLE');
}

// ---------- Catálogo (idempotente: se ejecuta en cada arranque) ----------
const CONSTRAINTS = [
  'CREATE CONSTRAINT role_name IF NOT EXISTS FOR (r:Role) REQUIRE r.name IS UNIQUE',
  'CREATE CONSTRAINT permission_name IF NOT EXISTS FOR (p:Permission) REQUIRE p.name IS UNIQUE',
  'CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT store_id IF NOT EXISTS FOR (s:Store) REQUIRE s.id IS UNIQUE',
  'CREATE CONSTRAINT menu_id IF NOT EXISTS FOR (m:MenuItem) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT route_path IF NOT EXISTS FOR (r:Route) REQUIRE r.path IS UNIQUE',
];

const flatMenu = MENU_CATALOG.flatMap(parent => [
  { id: parent.id, title: parent.title, order: parent.order, path: parent.path ?? null, roles: parent.roles, parentId: null },
  ...parent.children.map(c => ({ id: c.id, title: c.title, order: c.order, path: c.path ?? null, roles: c.roles, parentId: parent.id })),
]);

export async function bootstrapRbac(stores = []) {
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

  await writeQuery(
    `MATCH (:Role)-[old:CAN_VIEW_MENU]->() DELETE old
     WITH count(*) AS cleared
     UNWIND $items AS m
     MERGE (item:MenuItem {id: m.id}) SET item.title = m.title, item.order = m.order
     WITH item, m
     OPTIONAL MATCH (item)-[oldNav:NAVIGATES_TO]->() DELETE oldNav
     WITH DISTINCT item, m
     FOREACH (x IN CASE WHEN m.path IS NULL THEN [] ELSE [1] END |
       MERGE (route:Route {path: m.path}) MERGE (item)-[:NAVIGATES_TO]->(route))
     FOREACH (roleName IN m.roles |
       MERGE (role:Role {name: roleName}) MERGE (role)-[:CAN_VIEW_MENU]->(item))
     FOREACH (x IN CASE WHEN m.parentId IS NULL THEN [] ELSE [1] END |
       MERGE (parent:MenuItem {id: m.parentId}) MERGE (parent)-[:HAS_CHILD]->(item))`,
    { items: flatMenu },
  );

  if (stores.length) await syncStores(stores);
  console.log(`🌿 Catálogo RBAC listo en Neo4j: ${ROLE_CATALOG.length} roles, ${PERMISSION_CATALOG.length} permisos, ${flatMenu.length} elementos de menú, ${stores.length} sucursal(es).`);
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

// Árbol de menú: raíces visibles para el rol (o sus heredados) con sus hijos visibles.
export async function getMenu(userId) {
  const rows = await readQuery(
    `MATCH (u:User {id: $userId})-[:HAS_ROLE]->(:Role)-[:INHERITS*0..]->(eff:Role)
     WITH collect(DISTINCT eff) AS roles
     UNWIND roles AS role
     MATCH (role)-[:CAN_VIEW_MENU]->(parent:MenuItem)
     WHERE NOT ()-[:HAS_CHILD]->(parent)
     WITH DISTINCT parent, roles
     OPTIONAL MATCH (parent)-[:NAVIGATES_TO]->(pRoute:Route)
     OPTIONAL MATCH (parent)-[:HAS_CHILD]->(child:MenuItem)
       WHERE any(r IN roles WHERE (r)-[:CAN_VIEW_MENU]->(child))
     OPTIONAL MATCH (child)-[:NAVIGATES_TO]->(cRoute:Route)
     WITH parent, pRoute, child, cRoute ORDER BY child.order
     RETURN parent.id AS id, parent.title AS title, parent.order AS menuOrder, pRoute.path AS path,
            collect(CASE WHEN child IS NULL THEN null ELSE {id: child.id, title: child.title, order: child.order, path: cRoute.path} END) AS children
     ORDER BY menuOrder`,
    { userId: String(userId) },
  );
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    order: toNumber(r.menuOrder),
    path: r.path ?? null,
    children: r.children.filter(Boolean).map(c => ({ id: c.id, title: c.title, order: toNumber(c.order), path: c.path ?? null, children: [] })),
  }));
}

// ---------- Administración ----------
export async function setRole(userId, roleName) {
  assertReady();
  if (!isRole(roleName)) throw new DomainError(`El rol "${roleName}" no existe.`);
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
  if (!row) throw new DomainError('El usuario no existe en el grafo de roles.');
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
  if (!row) throw new DomainError('El usuario o la sucursal no existen en el grafo de roles.');
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
