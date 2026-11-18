// RBAC en Neo4j (PIC-116): forma del grafo (restricciones, MenuNode, CAN_ACCESS),
// canAccessRoute y myMenu por rol a través del gateway, rbacService directo contra
// Neo4j, y que scripts/init-rbac.cql deja exactamente el catálogo de bootstrapRbac
// (README, "Modelo RBAC en Neo4j").
//
// El catálogo RBAC de Neo4j es compartido con el dev: aplicar el script o
// bootstrapRbac lo vuelve a escribir igual, no cambia nada.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gql, ok, fails, session } from './client.js';
import { loadConfig, withNeo4j } from './stack.js';
import { ROLES, ROLE_CATALOG, MENU_CATALOG, ROUTE_CATALOG } from '../../services/mongoAPI/src/domain/access.js';
import { initNeo4j, closeNeo4j } from '../../services/mongoAPI/src/infrastructure/neo4j.js';
import { rbacService } from '../../services/mongoAPI/src/infrastructure/rbac.service.js';
import { bootstrapRbac } from '../../services/mongoAPI/src/infrastructure/rbac-graph.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const neo4j = createRequire(path.join(ROOT, 'services', 'mongoAPI', 'package.json'))('neo4j-driver');
const config = loadConfig();
const query = (cypher, params = {}) => withNeo4j(config, async q => (await q(cypher, params)).records.map(r => r.toObject()));

after(() => closeNeo4j());

// ---------- Oráculo: los catálogos con la herencia resuelta en JS ----------
const effectiveRoles = name => {
  const seen = new Set();
  const walk = n => { if (seen.has(n)) return; seen.add(n); ROLE_CATALOG.find(r => r.name === n).inherits.forEach(walk); };
  walk(name);
  return seen;
};
const canAccess = (role, p) => (ROUTE_CATALOG.find(r => r.path === p)?.roles ?? []).some(r => effectiveRoles(role).has(r));
const expectedMenu = role => {
  const sees = item => item.roles.some(r => effectiveRoles(role).has(r));
  return MENU_CATALOG.filter(sees).map(p => `${p.id}:${p.children.filter(sees).map(c => c.id).join(',')}`);
};
const menuIds = menu => menu.map(m => `${m.id}:${m.children.map(c => c.id).join(',')}`);

const CAN_ACCESS_ROUTE = 'query($path: String!) { canAccessRoute(path: $path) }';
const MY_MENU = '{ myMenu { id title order path children { id title order path children { id } } } }';

// ---------- Forma del grafo ----------
test('the four spec uniqueness constraints exist and the legacy names are gone', async () => {
  const names = (await query('SHOW CONSTRAINTS YIELD name RETURN name')).map(r => r.name);
  for (const n of ['unique_user_id', 'unique_role_name', 'unique_route_path', 'unique_menu_id']) assert.ok(names.includes(n), `missing constraint ${n}`);
  for (const n of ['role_name', 'user_id', 'route_path', 'menu_id']) assert.ok(!names.includes(n), `legacy constraint ${n} still exists`);
});

test('there are no MenuItem nodes; MenuNode has HAS_CHILD, NAVIGATES_TO and CAN_VIEW_MENU', async () => {
  const [row] = await query(
    `OPTIONAL MATCH (legacy:MenuItem) WITH count(legacy) AS legacy
     OPTIONAL MATCH (m:MenuNode) WITH legacy, count(m) AS nodes
     OPTIONAL MATCH (:MenuNode)-[c:HAS_CHILD]->(:MenuNode) WITH legacy, nodes, count(c) AS children
     OPTIONAL MATCH (:MenuNode)-[n:NAVIGATES_TO]->(:Route) WITH legacy, nodes, children, count(n) AS navigates
     OPTIONAL MATCH (:Role)-[v:CAN_VIEW_MENU]->(:MenuNode)
     RETURN legacy, nodes, children, navigates, count(v) AS views`,
  );
  const flat = MENU_CATALOG.flatMap(p => [p, ...p.children]);
  assert.equal(row.legacy.toNumber(), 0);
  assert.equal(row.nodes.toNumber(), flat.length);
  assert.equal(row.children.toNumber(), MENU_CATALOG.reduce((n, p) => n + p.children.length, 0));
  assert.equal(row.navigates.toNumber(), flat.filter(i => i.path).length);
  assert.equal(row.views.toNumber(), flat.reduce((n, i) => n + i.roles.length, 0));
});

test('every Route has exactly the CAN_ACCESS roles of the catalog', async () => {
  const rows = await query(
    `MATCH (rt:Route) OPTIONAL MATCH (r:Role)-[:CAN_ACCESS]->(rt)
     WITH rt, r ORDER BY r.name
     RETURN rt.path AS path, collect(r.name) AS roles ORDER BY path`,
  );
  const expected = ROUTE_CATALOG.map(r => ({ path: r.path, roles: [...r.roles].sort() })).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(rows, expected);
});

// ---------- canAccessRoute y myMenu a través del gateway ----------
for (const role of ROLES) {
  test(`canAccessRoute as ${role} matches the catalog for every route`, async () => {
    const { token } = await session(role);
    for (const { path: p } of ROUTE_CATALOG) {
      const { canAccessRoute } = await ok(CAN_ACCESS_ROUTE, { path: p }, token);
      assert.equal(canAccessRoute, canAccess(role, p), `${role} → ${p}`);
    }
    for (const p of ['/no-existe', '/app', '/login', '/', '/catalogo/', '/CATALOGO']) {
      assert.equal((await ok(CAN_ACCESS_ROUTE, { path: p }, token)).canAccessRoute, false, `${role} → ${p} (not registered)`);
    }
  });

  test(`myMenu as ${role} lists exactly the items of the catalog, in order`, async () => {
    const { token } = await session(role);
    const { myMenu } = await ok(MY_MENU, {}, token);
    assert.deepEqual(menuIds(myMenu), expectedMenu(role));
    for (const parent of myMenu) {
      const orders = parent.children.map(c => c.order);
      assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
      for (const c of parent.children) {
        assert.deepEqual(c.children, []);
        if (c.path) assert.equal((await ok(CAN_ACCESS_ROUTE, { path: c.path }, token)).canAccessRoute, true, `${role} sees ${c.id} but cannot open ${c.path}`);
      }
    }
  });
}

test('the cases of the spec through the gateway', async () => {
  const can = async (role, p) => (await ok(CAN_ACCESS_ROUTE, { path: p }, (await session(role)).token)).canAccessRoute;
  assert.equal(await can('CUSTOMER', '/sucursal/pedidos'), false);
  assert.equal(await can('STAFF', '/catalogo'), true);
  assert.equal(await can('DELIVERY', '/reparto/entregas'), true);
  assert.equal(await can('DELIVERY', '/catalogo'), true);
  assert.equal(await can('DELIVERY', '/sucursal/pedidos'), false);
  assert.equal(await can('MANAGER', '/reparto/entregas'), false);
  assert.equal(await can('ADMIN', '/reparto/entregas'), true);
  assert.equal(await can('ADMIN', '/admin/auditoria'), true);
});

test('canAccessRoute without a session is UNAUTHENTICATED', async () => {
  await fails('UNAUTHENTICATED', CAN_ACCESS_ROUTE, { path: '/catalogo' });
  const res = await gql(CAN_ACCESS_ROUTE, { path: '/catalogo' }, 'not-a-token');
  assert.equal(res.errors?.[0]?.extensions?.code, 'UNAUTHENTICATED');
});

// ---------- rbacService directo contra Neo4j ----------
test('rbacService fails closed with SERVICE_UNAVAILABLE (RBAC) before Neo4j is connected', async () => {
  for (const call of [() => rbacService.validarAccesoRuta('x', '/catalogo'), () => rbacService.obtenerMenuUsuario('x')]) {
    await assert.rejects(call, err => err.extensions?.code === 'SERVICE_UNAVAILABLE' && err.extensions?.service === 'RBAC');
  }
});

test('rbacService.validarAccesoRuta and obtenerMenuUsuario against Neo4j', async () => {
  await initNeo4j();
  const staff = await session('STAFF');
  assert.equal(await rbacService.validarAccesoRuta(staff.user.id, '/sucursal/pedidos'), true);
  assert.equal(await rbacService.validarAccesoRuta(staff.user.id, '/catalogo'), true); // por herencia
  assert.equal(await rbacService.validarAccesoRuta(staff.user.id, '/admin/catalogo'), false);
  assert.equal(await rbacService.validarAccesoRuta(staff.user.id, '/no-existe'), false);
  assert.equal(await rbacService.validarAccesoRuta('000000000000000000000000', '/catalogo'), false); // sin nodo User
  const menu = await rbacService.obtenerMenuUsuario(staff.user.id);
  assert.deepEqual(menu, (await ok(MY_MENU, {}, staff.token)).myMenu);
});

// ---------- scripts/init-rbac.cql = bootstrapRbac ----------
// Separa los enunciados por ';' fuera de cadenas y comentarios (como cypher-shell).
// Los comandos de cypher-shell (:begin, :commit) ocupan su línea, sin ';'.
function splitCypher(text) {
  const statements = [];
  let current = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const next = text[i + 1];
    if (c === ':' && !current.trim()) {
      const end = text.indexOf('\n', i);
      statements.push(text.slice(i, end === -1 ? text.length : end).trim());
      i = end === -1 ? text.length : end;
      current = '';
      continue;
    }
    if (c === '/' && next === '/') { const end = text.indexOf('\n', i); i = end === -1 ? text.length : end; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' && c !== '`' ? 2 : 1;
      current += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ';') { if (current.trim()) statements.push(current.trim()); current = ''; i++; continue; }
    current += c;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

// Foto del catálogo: nodos por etiqueta con todas sus propiedades (Integer y Float
// se distinguen) y las aristas del modelo, con repeticiones.
const plain = v => (neo4j.isInt(v) ? `int:${v.toString()}` : typeof v === 'number' ? `float:${v}` : Array.isArray(v) ? v.map(plain) : v);
const sortedJson = rows => rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).sort().map(([k, v]) => [k, plain(v)])))).sort();

async function catalogSnapshot() {
  const snap = {};
  for (const label of ['Role', 'Permission', 'Route', 'MenuNode', 'MenuItem']) {
    snap[label] = sortedJson((await query(`MATCH (n:${label}) RETURN properties(n) AS p`)).map(r => r.p));
  }
  for (const type of ['INHERITS', 'HAS_PERMISSION', 'CAN_ACCESS', 'CAN_VIEW_MENU', 'HAS_CHILD', 'NAVIGATES_TO']) {
    snap[type] = (await query(
      `MATCH (a)-[:${type}]->(b)
       RETURN labels(a)[0] + ':' + coalesce(a.name, a.path, a.id) + ' -> ' + labels(b)[0] + ':' + coalesce(b.name, b.path, b.id) AS edge`,
    )).map(r => r.edge).sort();
  }
  snap.constraints = (await query('SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties RETURN name, labelsOrTypes, properties')).map(r => JSON.stringify(r)).sort();
  return snap;
}

test('scripts/init-rbac.cql leaves the same catalog as bootstrapRbac, and is idempotent', async () => {
  const statements = splitCypher(fs.readFileSync(path.join(ROOT, 'scripts', 'init-rbac.cql'), 'utf8'));
  assert.ok(statements.length > 50, `only ${statements.length} statements`);
  assert.ok(statements.some(s => s.startsWith('CREATE CONSTRAINT unique_menu_id IF NOT EXISTS FOR (m:MenuNode)')));
  assert.ok(!statements.some(s => /:User\s*\{/.test(s) && /^(MERGE|CREATE)/.test(s)), 'the script must not create User nodes');

  const fromCode = await catalogSnapshot();
  assert.equal(fromCode.MenuItem.length, 0);
  assert.equal(fromCode.Route.length, ROUTE_CATALOG.length);

  // Como cypher-shell: cada enunciado en su transacción, salvo lo que va entre :begin y :commit.
  assert.deepEqual(statements.filter(s => s.startsWith(':')), [':begin', ':commit']);
  const begin = statements.indexOf(':begin');
  const commit = statements.indexOf(':commit');
  assert.ok(statements.slice(begin + 1, commit).every(s => !/^(CREATE|DROP) CONSTRAINT/.test(s)), 'schema commands outside the transaction');
  assert.ok(statements.slice(0, begin).some(s => s.startsWith('MATCH (m:MenuItem)')), 'the migration runs before the transaction');
  const apply = async () => {
    const driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password));
    const s = driver.session({ database: 'neo4j' });
    try {
      let tx = null;
      for (const statement of statements) {
        if (statement === ':begin') tx = s.beginTransaction();
        else if (statement === ':commit') { await tx.commit(); tx = null; } else await (tx ?? s).run(statement);
      }
      assert.equal(tx, null, 'unterminated :begin');
    } finally {
      await s.close();
      await driver.close();
    }
  };
  await apply();
  assert.deepEqual(await catalogSnapshot(), fromCode, 'first run of the script');
  await apply();
  assert.deepEqual(await catalogSnapshot(), fromCode, 'second run of the script');

  // Y al revés: bootstrapRbac sobre lo que dejó el script no cambia nada.
  await initNeo4j();
  await bootstrapRbac();
  assert.deepEqual(await catalogSnapshot(), fromCode, 'bootstrapRbac after the script');
});

// ---------- Migración desde el estado anterior (MenuItem y restricciones viejas) ----------
// Solo toca el catálogo compartido (restricciones y un MenuItem propio de la prueba);
// al final bootstrapRbac lo deja como estaba, pase lo que pase.
const LEGACY = {
  role_name: 'CREATE CONSTRAINT role_name FOR (r:Role) REQUIRE r.name IS UNIQUE',
  user_id: 'CREATE CONSTRAINT user_id FOR (u:User) REQUIRE u.id IS UNIQUE',
  route_path: 'CREATE CONSTRAINT route_path FOR (r:Route) REQUIRE r.path IS UNIQUE',
  menu_id: 'CREATE CONSTRAINT menu_id FOR (m:MenuItem) REQUIRE m.id IS UNIQUE',
  permission_name: 'CREATE CONSTRAINT permission_name FOR (p:Permission) REQUIRE p.name IS UNIQUE',
  store_id: 'CREATE CONSTRAINT store_id FOR (s:Store) REQUIRE s.id IS UNIQUE',
};
const NEW_NAMES = ['unique_user_id', 'unique_role_name', 'unique_route_path', 'unique_menu_id', 'unique_permission_name', 'unique_store_id'];

test('bootstrapRbac migrates the legacy state: old constraint names and MenuItem nodes', async () => {
  const before = await catalogSnapshot();
  const legacyId = `it-legacy-${Date.now()}`;
  try {
    // Estado de antes de PIC-116: las restricciones con los nombres viejos (Neo4j no
    // admite dos equivalentes, así que primero se quitan las nuevas) y un MenuItem
    // con sus aristas.
    for (const name of NEW_NAMES) await query(`DROP CONSTRAINT ${name} IF EXISTS`);
    for (const create of Object.values(LEGACY)) await query(create);
    await query(
      `MATCH (r:Role {name: 'CUSTOMER'}) MATCH (rt:Route {path: '/catalogo'})
       CREATE (parent:MenuItem {id: $parentId, title: 'Legacy', order: 9})-[:HAS_CHILD]->(child:MenuItem {id: $id, title: 'Legacy child', order: 1})
       CREATE (r)-[:CAN_VIEW_MENU]->(parent), (r)-[:CAN_VIEW_MENU]->(child), (child)-[:NAVIGATES_TO]->(rt)`,
      { id: legacyId, parentId: `${legacyId}-parent` },
    );
    const legacyNames = (await query('SHOW CONSTRAINTS YIELD name RETURN name')).map(r => r.name);
    for (const n of Object.keys(LEGACY)) assert.ok(legacyNames.includes(n), `legacy constraint ${n} was not created`);
    assert.equal((await query('MATCH (m:MenuItem) RETURN count(m) AS n'))[0].n.toNumber(), 2);

    await initNeo4j();
    await bootstrapRbac();

    const names = (await query('SHOW CONSTRAINTS YIELD name RETURN name')).map(r => r.name);
    for (const n of NEW_NAMES) assert.ok(names.includes(n), `missing constraint ${n}`);
    for (const n of Object.keys(LEGACY)) assert.ok(!names.includes(n), `legacy constraint ${n} still exists`);
    assert.equal((await query('MATCH (m:MenuItem) RETURN count(m) AS n'))[0].n.toNumber(), 0);
    assert.deepEqual(await catalogSnapshot(), before, 'the catalog after the migration');
    // Y una segunda vez no hay nada que migrar.
    await bootstrapRbac();
    assert.deepEqual(await catalogSnapshot(), before, 'a second bootstrapRbac');
  } finally {
    await query('MATCH (m:MenuItem) WHERE m.id STARTS WITH $prefix DETACH DELETE m', { prefix: legacyId });
    await initNeo4j();
    await bootstrapRbac();
  }
});
