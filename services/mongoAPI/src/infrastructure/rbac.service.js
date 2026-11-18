// ============================================================
// SERVICIO RBAC — las dos consultas declarativas del modelo
//
//   validarAccesoRuta(userId, path)  ¿el rol del usuario (o uno que hereda)
//                                    tiene [:CAN_ACCESS] a la ruta?
//   obtenerMenuUsuario(userId)       árbol de MenuNode visible para el rol
//                                    (o sus heredados), ordenado por `order`.
//
// Las dos corren en una sesión de LECTURA. Fallan cerrado: sin Neo4j lanzan
// SERVICE_UNAVAILABLE (service RBAC); nadie entra a una ruta sin el grafo.
// ============================================================

import { DomainError } from '../domain/errors.js';
import { readQuery, toNumber, isNeo4jReady } from './neo4j.js';

export function assertRbacReady() {
  if (!isNeo4jReady()) throw new DomainError('El servicio de roles (Neo4j) no está disponible. Intenta de nuevo.', 'SERVICE_UNAVAILABLE', { service: 'RBAC' });
}

// true si algún rol efectivo del usuario tiene CAN_ACCESS a la ruta exacta.
// Una ruta sin registrar, o un usuario sin nodo o sin rol, da false.
async function validarAccesoRuta(userId, path) {
  assertRbacReady();
  const [row] = await readQuery(
    `MATCH (u:User {id: $userId})-[:HAS_ROLE]->(r:Role)
     MATCH (r)-[:INHERITS*0..]->(effectiveRole:Role)-[:CAN_ACCESS]->(rt:Route {path: $path})
     RETURN count(rt) > 0 AS autorizado`,
    { userId: String(userId), path: String(path) },
  );
  return Boolean(row?.autorizado);
}

// Raíces visibles para el rol (o sus heredados) con sus hijos visibles.
async function obtenerMenuUsuario(userId) {
  assertRbacReady();
  const rows = await readQuery(
    `MATCH (u:User {id: $userId})-[:HAS_ROLE]->(:Role)-[:INHERITS*0..]->(eff:Role)
     WITH collect(DISTINCT eff) AS roles
     UNWIND roles AS role
     MATCH (role)-[:CAN_VIEW_MENU]->(parent:MenuNode)
     WHERE NOT ()-[:HAS_CHILD]->(parent)
     WITH DISTINCT parent, roles
     OPTIONAL MATCH (parent)-[:NAVIGATES_TO]->(pRoute:Route)
     OPTIONAL MATCH (parent)-[:HAS_CHILD]->(child:MenuNode)
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

export const rbacService = { validarAccesoRuta, obtenerMenuUsuario };
