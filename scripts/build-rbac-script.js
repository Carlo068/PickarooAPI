// Genera scripts/init-rbac.cql: el catálogo RBAC de Neo4j como un script Cypher
// independiente e idempotente, para aplicarlo con cypher-shell. Sale de los mismos
// catálogos (domain/access.js) y de las mismas restricciones (infrastructure/rbac-graph.js)
// que bootstrapRbac, así el script y el código no pueden divergir.
//
//   node scripts/build-rbac-script.js           escribe scripts/init-rbac.cql
//   node scripts/build-rbac-script.js --check   falla si el archivo está desactualizado (no lo modifica)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_CATALOG, PERMISSION_CATALOG, ROUTE_CATALOG } from '../services/mongoAPI/src/domain/access.js';
import { CONSTRAINTS, LEGACY_CONSTRAINTS, LEGACY_MENU_CLEANUP, flatMenu } from '../services/mongoAPI/src/infrastructure/rbac-graph.js';
import { closeNeo4j } from '../services/mongoAPI/src/infrastructure/neo4j.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'scripts', 'init-rbac.cql');
const check = process.argv.includes('--check');

// Literal de cadena Cypher entre comillas simples.
const str = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const list = values => `[${values.map(str).join(', ')}]`;

const section = (title, lines) => [`// ------------------------------------------------------------`, ...title.map(t => `// ${t}`), `// ------------------------------------------------------------`, ...lines, ''];

const roleNames = ROLE_CATALOG.map(r => r.name);
const pairs = (rows, key) => rows.flatMap(r => r[key].map(x => [r, x]));

function build() {
  const out = [
    '// ============================================================',
    '// GENERADO AUTOMÁTICAMENTE. NO EDITAR A MANO.',
    '// Se genera con: npm run rbac:script   Verificación: npm run rbac:check',
    '//',
    '// init-rbac.cql — Control de Acceso Basado en Roles (RBAC) y navegación',
    '// dinámica en Neo4j para Pickaroo. Modela:',
    '//   (:User {id})-[:HAS_ROLE]->(:Role {name})',
    '//   (:Role)-[:INHERITS*0..]->(:Role)              (superior)-[:INHERITS]->(inferior)',
    '//   (:Role)-[:HAS_PERMISSION]->(:Permission {name})  permisos de operación',
    '//   (:Role)-[:CAN_ACCESS]->(:Route {path})        solo el rol más bajo autorizado',
    '//   (:Role)-[:CAN_VIEW_MENU]->(:MenuNode {id, title, order})',
    '//   (:MenuNode)-[:HAS_CHILD]->(:MenuNode)',
    '//   (:MenuNode)-[:NAVIGATES_TO]->(:Route)',
    '//   (:User)-[:WORKS_AT]->(:Store {id})            alcance por sucursal (lo escribe la API)',
    '//',
    '// Es idempotente: se puede ejecutar las veces que haga falta y deja el mismo',
    '// catálogo que escribe la API al arrancar (bootstrapRbac). No crea usuarios:',
    '// sus ids son los _id de MongoDB y la API los enlaza en el login.',
    '//',
    '// Atomicidad: las secciones 1 y 2 (restricciones y migración) son comandos de',
    '// esquema y cada uno va en su propia transacción. Las secciones 3 a 7 (el',
    '// catálogo) van en UNA transacción (:begin / :commit de cypher-shell), así una',
    '// API conectada nunca ve el catálogo a medias. Aun así conviene ejecutarlo con la',
    '// API detenida: entre las secciones 1 y 2 el grafo queda un momento sin las',
    '// restricciones anteriores o sin el menú anterior.',
    '//',
    '// Aplicarlo (contraseña de NEO4J_AUTH en docker-compose.yml):',
    '//   docker exec -i pickaroo-neo4j cypher-shell -u neo4j -p <password> < scripts/init-rbac.cql',
    '// ============================================================',
    '',
    ...section(['1. Restricciones de unicidad.',
      'Primero se borran las de nombre anterior: Neo4j no crea una restricción',
      'equivalente con otro nombre.'], [
      ...LEGACY_CONSTRAINTS.map(c => `${c};`),
      ...CONSTRAINTS.map(c => `${c};`),
    ]),
    ...section(['2. Migración: los nodos (:MenuItem) de la versión anterior son datos de',
      'catálogo. Se borran y se recrean abajo como (:MenuNode).'], [
      `${LEGACY_MENU_CLEANUP};`,
    ]),
    '// Desde aquí hasta :commit, una sola transacción.',
    ':begin',
    '',
    ...section(['3. Roles con su descripción.'],
      ROLE_CATALOG.map(r => `MERGE (r:Role {name: ${str(r.name)}}) SET r.description = ${str(r.description)};`)),
    ...section(['4. Jerarquía de roles: (superior)-[:INHERITS]->(inferior).',
      'ADMIN → MANAGER → STAFF → CUSTOMER, y DELIVERY → CUSTOMER.',
      'El rol superior obtiene los permisos, rutas y menús del inferior.'], [
      `MATCH (r:Role)-[old:INHERITS]->(:Role) WHERE r.name IN ${list(roleNames)} DELETE old;`,
      ...pairs(ROLE_CATALOG, 'inherits').map(([r, parent]) =>
        `MATCH (sup:Role {name: ${str(r.name)}}), (inf:Role {name: ${str(parent)}}) MERGE (sup)-[:INHERITS]->(inf);`),
    ]),
    ...section(['5. Permisos de operación y [:HAS_PERMISSION] de cada rol (sin contar los heredados).'], [
      ...PERMISSION_CATALOG.map(p => `MERGE (p:Permission {name: ${str(p.name)}}) SET p.description = ${str(p.description)};`),
      `MATCH (r:Role)-[old:HAS_PERMISSION]->(:Permission) WHERE r.name IN ${list(roleNames)} DELETE old;`,
      ...pairs(ROLE_CATALOG, 'permissions').map(([r, perm]) =>
        `MATCH (r:Role {name: ${str(r.name)}}), (p:Permission {name: ${str(perm)}}) MERGE (r)-[:HAS_PERMISSION]->(p);`),
    ]),
    ...section(['6. Rutas web del sistema y [:CAN_ACCESS] SOLO con el rol más bajo autorizado.',
      'Los roles superiores llegan por transitividad de [:INHERITS*0..].',
      '/reparto/entregas lleva además ADMIN, que no hereda de DELIVERY.'], [
      `MATCH (stale:Route) WHERE NOT stale.path IN ${list(ROUTE_CATALOG.map(r => r.path))} DETACH DELETE stale;`,
      'MATCH (:Role)-[old:CAN_ACCESS]->(:Route) DELETE old;',
      ...ROUTE_CATALOG.map(r => `MERGE (:Route {path: ${str(r.path)}});`),
      ...pairs(ROUTE_CATALOG, 'roles').map(([r, role]) =>
        `MATCH (r:Role {name: ${str(role)}}), (rt:Route {path: ${str(r.path)}}) MERGE (r)-[:CAN_ACCESS]->(rt);`),
    ]),
    ...section(['7. Árbol de menú desacoplado de las rutas:',
      '(:MenuNode {id, title, order}), submenús con [:HAS_CHILD], la acción del clic',
      'con [:NAVIGATES_TO] y la visibilidad por rol con [:CAN_VIEW_MENU].'], [
      'MATCH (:Role)-[old:CAN_VIEW_MENU]->(:MenuNode) DELETE old;',
      'MATCH (:MenuNode)-[old:HAS_CHILD|NAVIGATES_TO]->() DELETE old;',
      `MATCH (stale:MenuNode) WHERE NOT stale.id IN ${list(flatMenu.map(m => m.id))} DETACH DELETE stale;`,
      ...flatMenu.map(m => `MERGE (m:MenuNode {id: ${str(m.id)}}) SET m.title = ${str(m.title)}, m.order = ${Number(m.order)};`),
      ...flatMenu.filter(m => m.parentId).map(m =>
        `MATCH (parent:MenuNode {id: ${str(m.parentId)}}), (child:MenuNode {id: ${str(m.id)}}) MERGE (parent)-[:HAS_CHILD]->(child);`),
      ...flatMenu.filter(m => m.path).map(m =>
        `MATCH (m:MenuNode {id: ${str(m.id)}}), (rt:Route {path: ${str(m.path)}}) MERGE (m)-[:NAVIGATES_TO]->(rt);`),
      ...pairs(flatMenu, 'roles').map(([m, role]) =>
        `MATCH (r:Role {name: ${str(role)}}), (m:MenuNode {id: ${str(m.id)}}) MERGE (r)-[:CAN_VIEW_MENU]->(m);`),
    ]),
    ':commit',
    '',
    ...section(['8. Usuarios: no se crean aquí. Su id es el _id de MongoDB y la API los',
      'crea en el login con el rol de MongoDB. Ejemplo para enlazar uno a mano, con',
      'los parámetros userId (el _id) y role (p. ej. CUSTOMER) definidos antes en',
      'cypher-shell con :param, y punto y coma al final:'], [
      '//   MERGE (u:User {id: $userId})',
      '//   WITH u',
      '//   MATCH (r:Role {name: $role})',
      '//   OPTIONAL MATCH (u)-[old:HAS_ROLE]->(:Role)',
      '//   DELETE old',
      '//   MERGE (u)-[:HAS_ROLE]->(r)',
    ]),
  ];
  // Un comentario nunca lleva ; ni comillas: ningún lector del script puede
  // tomarlo como el fin de un enunciado o el inicio de una cadena.
  for (const line of out) {
    if (line.startsWith('//') && /[;'"`]/.test(line)) throw new Error(`Comentario con ; o comillas en init-rbac.cql: ${line}`);
  }
  return out.join('\n').trimEnd() + '\n';
}

const expected = build();
await closeNeo4j(); // rbac-graph.js crea el driver al importarse; aquí no se conecta

if (check) {
  // Tolera CRLF: Git en Windows puede convertir los saltos de línea al extraer.
  const actual = existsSync(outFile) ? readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') : null;
  if (actual !== expected) {
    console.error('scripts/init-rbac.cql está desactualizado respecto al catálogo RBAC (domain/access.js, rbac-graph.js).');
    console.error('Ejecuta "npm run rbac:script" y agrega scripts/init-rbac.cql al mismo commit.');
    process.exit(1);
  }
  console.log('scripts/init-rbac.cql está actualizado.');
} else {
  writeFileSync(outFile, expected);
  console.log('Escrito scripts/init-rbac.cql');
}
