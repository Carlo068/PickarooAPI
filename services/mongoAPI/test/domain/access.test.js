// Pruebas de la política de acceso (src/domain/access.js). El oráculo es la
// sección 2 del README ("Autorización" y "Reglas de órdenes").
// access.js no expone funciones de permisos efectivos ni de menú (en
// ejecución las resuelve Neo4j con [:INHERITS*0..]); aquí se reproduce esa
// resolución sobre los catálogos para verificar herencia y visibilidad.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, DEFAULT_ROLE, PERMISSIONS, PERMISSION_CATALOG, ROLE_CATALOG, MENU_CATALOG,
  isRole, hasPermission, inStoreScope, requiredOrderPermission, canChangeOrderStatus, canViewOrder, canSeeStatusActor,
  storeItemDenial, managesStoreItems, seesStoreItems, categoryDenial, reportStoreScope,
} from '../../src/domain/access.js';
import { ORDER_STATUSES, ORDER_MODES } from '../../src/domain/entities.js';

const P = PERMISSIONS;

// ---------- resolución de herencia (equivalente a [:INHERITS*0..]) ----------
const roleByName = name => ROLE_CATALOG.find(r => r.name === name);
const effectiveRoles = name => {
  const seen = new Set();
  const walk = n => { if (seen.has(n)) return; seen.add(n); roleByName(n).inherits.forEach(walk); };
  walk(name);
  return seen;
};
const effectivePermissions = name => [...new Set([...effectiveRoles(name)].flatMap(r => roleByName(r).permissions))].sort();
const menuFor = name => {
  const roles = effectiveRoles(name);
  const sees = item => item.roles.some(r => roles.has(r));
  return MENU_CATALOG.filter(sees).map(parent => ({ id: parent.id, children: parent.children.filter(sees).map(c => c.id) }));
};
const accessOf = (role, { id = 'u1', storeIds = ['S1'] } = {}) => ({ id, role, permissions: effectivePermissions(role), storeIds });

describe('catálogos', () => {
  test('roles y rol por defecto', () => {
    assert.deepEqual(ROLES, ['CUSTOMER', 'STAFF', 'DELIVERY', 'MANAGER', 'ADMIN']);
    assert.equal(DEFAULT_ROLE, 'CUSTOMER');
    assert.deepEqual(ROLE_CATALOG.map(r => r.name), ROLES);
  });
  test('isRole', () => {
    for (const r of ROLES) assert.equal(isRole(r), true);
    for (const r of ['customer', 'OWNER', '', null, undefined]) assert.equal(isRole(r), false);
  });
  test('los nombres de permiso tienen el formato recurso:acción y el catálogo los describe todos', () => {
    assert.deepEqual(PERMISSION_CATALOG.map(p => p.name).sort(), Object.values(PERMISSIONS).sort());
    for (const p of PERMISSION_CATALOG) assert.match(p.name, /^[a-z_]+:[a-z_]+$/);
    assert.equal(P.ORDERS_PREPARE, 'orders:prepare');
    assert.equal(P.ORDERS_DELIVER, 'orders:deliver');
    assert.equal(P.ALL_STORES, 'scope:all_stores');
  });
  test('todo permiso de un rol existe en el catálogo y toda herencia apunta a un rol existente', () => {
    const known = new Set(Object.values(PERMISSIONS));
    for (const r of ROLE_CATALOG) {
      for (const p of r.permissions) assert.ok(known.has(p), `${r.name}: permiso desconocido ${p}`);
      for (const parent of r.inherits) assert.ok(ROLES.includes(parent), `${r.name}: hereda de ${parent}`);
    }
  });
  test('herencia directa según el README', () => {
    assert.deepEqual(Object.fromEntries(ROLE_CATALOG.map(r => [r.name, r.inherits])), {
      CUSTOMER: [], STAFF: ['CUSTOMER'], DELIVERY: ['CUSTOMER'], MANAGER: ['STAFF'], ADMIN: ['MANAGER'],
    });
  });
  test('permisos propios según el README', () => {
    assert.deepEqual(Object.fromEntries(ROLE_CATALOG.map(r => [r.name, [...r.permissions].sort()])), {
      CUSTOMER: [],
      STAFF: [P.ORDERS_PREPARE, P.STOCK_MANAGE].sort(),
      DELIVERY: [P.ORDERS_DELIVER],
      MANAGER: [P.CATALOG_MANAGE, P.REPORTS_VIEW].sort(),
      ADMIN: [P.ORDERS_DELIVER, P.STORES_MANAGE, P.USERS_MANAGE, P.AUDIT_VIEW, P.ALL_STORES].sort(),
    });
  });
});

describe('permisos efectivos por rol (herencia)', () => {
  test('CUSTOMER: ninguno', () => {
    assert.deepEqual(effectivePermissions('CUSTOMER'), []);
  });
  test('STAFF: propios; hereda de CUSTOMER (sin añadir nada)', () => {
    assert.deepEqual(effectivePermissions('STAFF'), ['orders:prepare', 'stock:manage']);
  });
  test('DELIVERY: solo orders:deliver (no hereda de STAFF)', () => {
    assert.deepEqual(effectivePermissions('DELIVERY'), ['orders:deliver']);
  });
  test('MANAGER: los de STAFF más catalog:manage y reports:view; sin orders:deliver', () => {
    assert.deepEqual(effectivePermissions('MANAGER'), ['catalog:manage', 'orders:prepare', 'reports:view', 'stock:manage']);
  });
  test('ADMIN: hereda de MANAGER y STAFF y suma los propios; tiene todos los permisos', () => {
    assert.deepEqual(effectivePermissions('ADMIN'), Object.values(PERMISSIONS).sort());
  });
  test('solo ADMIN tiene scope:all_stores', () => {
    for (const r of ROLES) assert.equal(effectivePermissions(r).includes(P.ALL_STORES), r === 'ADMIN');
  });
  test('la herencia no tiene ciclos', () => {
    for (const r of ROLES) assert.ok(effectiveRoles(r).has(r)); // termina y se incluye a sí mismo
    assert.deepEqual([...effectiveRoles('ADMIN')].sort(), ['ADMIN', 'CUSTOMER', 'MANAGER', 'STAFF']);
    assert.deepEqual([...effectiveRoles('DELIVERY')].sort(), ['CUSTOMER', 'DELIVERY']);
  });
});

describe('menú por rol', () => {
  const tienda = { id: 'tienda', children: ['catalogo', 'carrito', 'mis-pedidos', 'mis-listas'] };
  const sucursal = { id: 'sucursal', children: ['pedidos-sucursal', 'inventario'] };
  const reparto = { id: 'reparto', children: ['entregas'] };

  test('CUSTOMER: solo Tienda', () => {
    assert.deepEqual(menuFor('CUSTOMER'), [tienda]);
  });
  test('STAFF: Tienda y Sucursal', () => {
    assert.deepEqual(menuFor('STAFF'), [tienda, sucursal]);
  });
  test('DELIVERY: Tienda y Reparto (no ve Sucursal)', () => {
    assert.deepEqual(menuFor('DELIVERY'), [tienda, reparto]);
  });
  test('MANAGER: Tienda, Sucursal y Administración (solo productos y reportes); sin Reparto', () => {
    assert.deepEqual(menuFor('MANAGER'), [tienda, sucursal, { id: 'administracion', children: ['productos', 'reportes'] }]);
  });
  test('ADMIN: todo', () => {
    assert.deepEqual(menuFor('ADMIN'), [
      tienda, sucursal, reparto,
      { id: 'administracion', children: ['productos', 'reportes', 'sucursales', 'usuarios', 'auditoria'] },
    ]);
  });
  test('estructura: ids únicos, rutas únicas, roles válidos y orden ascendente', () => {
    const flat = MENU_CATALOG.flatMap(p => [p, ...p.children]);
    const ids = flat.map(i => i.id);
    assert.equal(new Set(ids).size, ids.length);
    const paths = flat.map(i => i.path).filter(Boolean);
    assert.equal(new Set(paths).size, paths.length);
    for (const i of flat) for (const r of i.roles) assert.ok(ROLES.includes(r), `${i.id}: rol ${r}`);
    const orders = MENU_CATALOG.map(p => p.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    for (const p of MENU_CATALOG) {
      const o = p.children.map(c => c.order);
      assert.deepEqual(o, [...o].sort((a, b) => a - b));
    }
  });
  test('todo hijo visible para un rol tiene su padre visible para ese rol', () => {
    for (const r of ROLES) for (const entry of menuFor(r)) assert.ok(entry.id);
    for (const r of ROLES) {
      const parents = new Set(menuFor(r).map(p => p.id));
      for (const parent of MENU_CATALOG) {
        const visibleChildren = menuFor(r).find(p => p.id === parent.id)?.children ?? [];
        if (!parents.has(parent.id)) assert.equal(visibleChildren.length, 0);
      }
    }
    // Sin esa garantía un hijo quedaría huérfano en Neo4j: comprobar el catálogo directamente.
    for (const parent of MENU_CATALOG) {
      for (const child of parent.children) {
        for (const r of ROLES) {
          const roles = effectiveRoles(r);
          if (child.roles.some(x => roles.has(x))) assert.ok(parent.roles.some(x => roles.has(x)), `${r} ve ${child.id} pero no ${parent.id}`);
        }
      }
    }
  });
});

describe('hasPermission', () => {
  test('presente, ausente y accesos nulos', () => {
    const a = { permissions: ['orders:prepare'] };
    assert.equal(hasPermission(a, 'orders:prepare'), true);
    assert.equal(hasPermission(a, 'orders:deliver'), false);
    assert.equal(hasPermission(null, 'orders:prepare'), false);
    assert.equal(hasPermission(undefined, 'orders:prepare'), false);
    assert.equal(hasPermission({}, 'orders:prepare'), false);
    assert.equal(hasPermission({ permissions: [] }, 'orders:prepare'), false);
  });
});

describe('inStoreScope', () => {
  test('personal solo en sus sucursales', () => {
    const a = accessOf('STAFF', { storeIds: ['S1', 'S2'] });
    assert.equal(inStoreScope(a, 'S1'), true);
    assert.equal(inStoreScope(a, 'S2'), true);
    assert.equal(inStoreScope(a, 'S3'), false);
  });
  test('compara ids como cadena', () => {
    assert.equal(inStoreScope({ permissions: [], storeIds: ['7'] }, 7), true);
  });
  test('scope:all_stores pasa en cualquier sucursal, incluso sin storeIds', () => {
    const a = { permissions: [P.ALL_STORES], storeIds: [] };
    assert.equal(inStoreScope(a, 'cualquiera'), true);
    assert.equal(inStoreScope(a, null), true);
  });
  test('sin sucursal (null/undefined) o sin storeIds => fuera de alcance', () => {
    assert.equal(inStoreScope(accessOf('STAFF'), null), false);
    assert.equal(inStoreScope(accessOf('STAFF'), undefined), false);
    assert.equal(inStoreScope({ permissions: [] }, 'S1'), false);
    assert.equal(inStoreScope(null, 'S1'), false);
  });
});

describe('requiredOrderPermission', () => {
  test('IN_DELIVERY exige orders:deliver sin importar el modo', () => {
    for (const mode of ORDER_MODES) assert.equal(requiredOrderPermission({ mode }, 'IN_DELIVERY'), P.ORDERS_DELIVER);
  });
  test('DELIVERED: deliver en DELIVERY, prepare en PICKUP', () => {
    assert.equal(requiredOrderPermission({ mode: 'DELIVERY' }, 'DELIVERED'), P.ORDERS_DELIVER);
    assert.equal(requiredOrderPermission({ mode: 'PICKUP' }, 'DELIVERED'), P.ORDERS_PREPARE);
  });
  test('CONFIRMED, PREPARING, READY y CANCELLED exigen orders:prepare', () => {
    for (const to of ['CONFIRMED', 'PREPARING', 'READY', 'CANCELLED']) {
      for (const mode of ORDER_MODES) assert.equal(requiredOrderPermission({ mode }, to), P.ORDERS_PREPARE);
    }
  });
});

describe('canChangeOrderStatus (README: Reglas de órdenes)', () => {
  const STORE = 'S1';
  const orderOf = (mode, over = {}) => ({ id: 'O1', userId: 'cliente', storeId: STORE, mode, ...over });

  // Quién puede, según la tabla del README, para cada destino y modo.
  // prepare: STAFF, MANAGER, ADMIN. deliver: DELIVERY, ADMIN.
  const PREPARE_ROLES = ['STAFF', 'MANAGER', 'ADMIN'];
  const DELIVER_ROLES = ['DELIVERY', 'ADMIN'];
  const expectedRoles = (to, mode) => {
    if (to === 'IN_DELIVERY') return DELIVER_ROLES;
    if (to === 'DELIVERED') return mode === 'DELIVERY' ? DELIVER_ROLES : PREPARE_ROLES;
    return PREPARE_ROLES; // CONFIRMED, PREPARING, READY, CANCELLED
  };

  for (const to of ORDER_STATUSES.filter(s => s !== 'PENDING')) {
    for (const mode of ORDER_MODES) {
      test(`-> ${to} (${mode}): roles con permiso en su sucursal`, () => {
        const allowed = expectedRoles(to, mode);
        for (const role of ROLES) {
          const access = accessOf(role, { id: `staff-${role}`, storeIds: [STORE] });
          assert.equal(canChangeOrderStatus(access, orderOf(mode), to), allowed.includes(role), `${role} -> ${to} (${mode})`);
        }
      });
      test(`-> ${to} (${mode}): personal de otra sucursal es rechazado; scope:all_stores pasa`, () => {
        const allowed = expectedRoles(to, mode);
        for (const role of ROLES) {
          const outside = accessOf(role, { id: `staff-${role}`, storeIds: ['OTRA'] });
          const noStores = accessOf(role, { id: `staff-${role}`, storeIds: [] });
          const inScope = role === 'ADMIN'; // el único con scope:all_stores
          assert.equal(canChangeOrderStatus(outside, orderOf(mode), to), inScope && allowed.includes(role), `${role} fuera de sucursal -> ${to}`);
          assert.equal(canChangeOrderStatus(noStores, orderOf(mode), to), inScope && allowed.includes(role), `${role} sin sucursales -> ${to}`);
        }
      });
    }
  }

  test('un cliente (no dueño) no puede mover ninguna orden', () => {
    const c = accessOf('CUSTOMER', { id: 'otro', storeIds: [STORE] });
    for (const to of ORDER_STATUSES) for (const mode of ORDER_MODES) assert.equal(canChangeOrderStatus(c, orderOf(mode), to), false);
  });
  test('el dueño puede cancelar su orden aunque sea CUSTOMER y no tenga sucursal', () => {
    const owner = accessOf('CUSTOMER', { id: 'cliente', storeIds: [] });
    for (const mode of ORDER_MODES) assert.equal(canChangeOrderStatus(owner, orderOf(mode), 'CANCELLED'), true);
  });
  test('el dueño NO puede mover su orden a ningún otro estado', () => {
    const owner = accessOf('CUSTOMER', { id: 'cliente', storeIds: [] });
    for (const to of ORDER_STATUSES.filter(s => s !== 'CANCELLED')) {
      for (const mode of ORDER_MODES) assert.equal(canChangeOrderStatus(owner, orderOf(mode), to), false, `dueño -> ${to}`);
    }
  });
  test('el dueño compara ids como cadena y un access sin id no es dueño', () => {
    assert.equal(canChangeOrderStatus({ id: 5, permissions: [], storeIds: [] }, orderOf('PICKUP', { userId: '5' }), 'CANCELLED'), true);
    assert.equal(canChangeOrderStatus({ permissions: [], storeIds: [] }, orderOf('PICKUP', { userId: undefined }), 'CANCELLED'), false);
    assert.equal(canChangeOrderStatus({ id: null, permissions: [], storeIds: [] }, orderOf('PICKUP', { userId: null }), 'CANCELLED'), false);
  });
  test('personal que además es dueño de una orden de otra sucursal sí puede cancelarla (como cliente)', () => {
    const staff = accessOf('STAFF', { id: 'cliente', storeIds: ['OTRA'] });
    assert.equal(canChangeOrderStatus(staff, orderOf('PICKUP'), 'CANCELLED'), true);
    assert.equal(canChangeOrderStatus(staff, orderOf('PICKUP'), 'CONFIRMED'), false);
  });
  test('DELIVERY (repartidor) no puede cancelar ni confirmar; MANAGER no puede repartir', () => {
    const d = accessOf('DELIVERY');
    const m = accessOf('MANAGER');
    for (const to of ['CONFIRMED', 'PREPARING', 'READY', 'CANCELLED']) assert.equal(canChangeOrderStatus(d, orderOf('DELIVERY'), to), false);
    assert.equal(canChangeOrderStatus(m, orderOf('DELIVERY'), 'IN_DELIVERY'), false);
    assert.equal(canChangeOrderStatus(m, orderOf('DELIVERY'), 'DELIVERED'), false);
  });
  test('una orden PICKUP nunca la lleva a reparto el repartidor: DELIVERED de PICKUP lo cierra el mostrador', () => {
    assert.equal(canChangeOrderStatus(accessOf('DELIVERY'), orderOf('PICKUP'), 'DELIVERED'), false);
    assert.equal(canChangeOrderStatus(accessOf('STAFF'), orderOf('PICKUP'), 'DELIVERED'), true);
  });
  test('IN_DELIVERY para una orden PICKUP: la política de acceso no lo bloquea, lo hace assertTransition', {
    // El README dice "una orden PICKUP nunca sale a reparto" en la tabla de reglas de acceso,
    // pero canChangeOrderStatus solo mira el permiso; la prohibición vive en entities.assertTransition.
    todo: 'README (Reglas de órdenes) atribuye a canChangeOrderStatus que PICKUP nunca sale a reparto; el código solo la aplica en assertTransition.',
  }, () => {
    assert.equal(canChangeOrderStatus(accessOf('DELIVERY'), orderOf('PICKUP'), 'IN_DELIVERY'), false);
  });
  test('comportamiento actual: IN_DELIVERY de una orden PICKUP pasa la política de acceso con orders:deliver', () => {
    assert.equal(canChangeOrderStatus(accessOf('DELIVERY'), orderOf('PICKUP'), 'IN_DELIVERY'), true);
  });
  test('sin access (null/undefined) nadie puede', () => {
    for (const to of ORDER_STATUSES) {
      assert.equal(canChangeOrderStatus(null, orderOf('PICKUP'), to), false);
      assert.equal(canChangeOrderStatus(undefined, orderOf('DELIVERY'), to), false);
    }
  });
});

describe('canViewOrder', () => {
  const orderOf = (mode, over = {}) => ({ id: 'O1', userId: 'cliente', storeId: 'S1', mode, ...over });

  test('el dueño ve su orden sin importar rol ni sucursal', () => {
    for (const mode of ORDER_MODES) assert.equal(canViewOrder(accessOf('CUSTOMER', { id: 'cliente', storeIds: [] }), orderOf(mode)), true);
  });
  test('un cliente ajeno no la ve', () => {
    for (const mode of ORDER_MODES) assert.equal(canViewOrder(accessOf('CUSTOMER', { id: 'otro' }), orderOf(mode)), false);
  });
  test('STAFF y MANAGER de la sucursal ven PICKUP y DELIVERY', () => {
    for (const role of ['STAFF', 'MANAGER']) {
      for (const mode of ORDER_MODES) assert.equal(canViewOrder(accessOf(role, { id: 'p' }), orderOf(mode)), true, `${role} ${mode}`);
    }
  });
  test('el repartidor de la sucursal solo ve las DELIVERY', () => {
    const d = accessOf('DELIVERY', { id: 'p' });
    assert.equal(canViewOrder(d, orderOf('DELIVERY')), true);
    assert.equal(canViewOrder(d, orderOf('PICKUP')), false);
  });
  test('personal de otra sucursal no ve la orden', () => {
    for (const role of ['STAFF', 'DELIVERY', 'MANAGER']) {
      for (const mode of ORDER_MODES) assert.equal(canViewOrder(accessOf(role, { id: 'p', storeIds: ['OTRA'] }), orderOf(mode)), false, `${role} ${mode}`);
    }
  });
  test('ADMIN (scope:all_stores) ve todas, de cualquier sucursal y modo', () => {
    const a = accessOf('ADMIN', { id: 'admin', storeIds: [] });
    for (const mode of ORDER_MODES) {
      assert.equal(canViewOrder(a, orderOf(mode)), true);
      assert.equal(canViewOrder(a, orderOf(mode, { storeId: 'Z' })), true);
    }
  });
  test('sin access nadie ve nada', () => {
    assert.equal(canViewOrder(null, orderOf('PICKUP')), false);
    assert.equal(canViewOrder(undefined, orderOf('DELIVERY')), false);
  });
  test('una orden sin sucursal solo la ve su dueño o quien tiene scope:all_stores', () => {
    const o = orderOf('PICKUP', { storeId: null });
    assert.equal(canViewOrder(accessOf('STAFF', { id: 'p' }), o), false);
    assert.equal(canViewOrder(accessOf('CUSTOMER', { id: 'cliente' }), o), true);
    assert.equal(canViewOrder(accessOf('ADMIN', { id: 'admin' }), o), true);
  });
});

// ---------- Marketplace: catálogo, inventario y reportes por sucursal ----------
describe('storeItemDenial (catalog:manage y stock:manage por sucursal)', () => {
  const staffA = accessOf('STAFF', { storeIds: ['A'] });
  const managerA = accessOf('MANAGER', { storeIds: ['A'] });
  const admin = accessOf('ADMIN', { storeIds: [] });

  test('en una sucursal asignada (WORKS_AT): permitido', () => {
    assert.equal(storeItemDenial(staffA, P.STOCK_MANAGE, 'A'), null);
    assert.equal(storeItemDenial(managerA, P.CATALOG_MANAGE, 'A'), null);
    assert.equal(storeItemDenial(managerA, P.STOCK_MANAGE, { toString: () => 'A' }), null);
  });
  test('en otra sucursal: STORE_NOT_ASSIGNED con su storeId', () => {
    assert.deepEqual(storeItemDenial(staffA, P.STOCK_MANAGE, 'B'), { reason: 'STORE_NOT_ASSIGNED', storeId: 'B' });
    assert.deepEqual(storeItemDenial(managerA, P.CATALOG_MANAGE, 'B'), { reason: 'STORE_NOT_ASSIGNED', storeId: 'B' });
  });
  test('sin el permiso: PERMISSION_REQUIRED antes que el alcance', () => {
    assert.deepEqual(storeItemDenial(staffA, P.CATALOG_MANAGE, 'A'), { reason: 'PERMISSION_REQUIRED', permission: P.CATALOG_MANAGE });
    assert.deepEqual(storeItemDenial(accessOf('DELIVERY', { storeIds: ['A'] }), P.STOCK_MANAGE, 'B'), { reason: 'PERMISSION_REQUIRED', permission: P.STOCK_MANAGE });
    assert.deepEqual(storeItemDenial(null, P.STOCK_MANAGE, 'A'), { reason: 'PERMISSION_REQUIRED', permission: P.STOCK_MANAGE });
  });
  test('scope:all_stores (ADMIN): cualquier sucursal, también un artículo sin sucursal', () => {
    assert.equal(storeItemDenial(admin, P.CATALOG_MANAGE, 'Z'), null);
    assert.equal(storeItemDenial(admin, P.STOCK_MANAGE, null), null);
  });
  test('artículo sin sucursal (sin migrar): fuera del alcance del personal', () => {
    assert.deepEqual(storeItemDenial(managerA, P.CATALOG_MANAGE, null), { reason: 'STORE_NOT_ASSIGNED', storeId: null });
  });
  test('managesStoreItems: catálogo o inventario en esa sucursal', () => {
    assert.equal(managesStoreItems(staffA, 'A'), true);
    assert.equal(managesStoreItems(staffA, 'B'), false);
    assert.equal(managesStoreItems(admin, 'B'), true);
    assert.equal(managesStoreItems(accessOf('CUSTOMER'), 'S1'), false);
    assert.equal(managesStoreItems(null, 'A'), false);
  });
  test('seesStoreItems: quien administra la sucursal o tiene scope:all_stores', () => {
    assert.equal(seesStoreItems(staffA, 'A'), true);
    assert.equal(seesStoreItems(staffA, 'B'), false);
    assert.equal(seesStoreItems(admin, 'B'), true);
    assert.equal(seesStoreItems({ ...accessOf('CUSTOMER'), permissions: [P.ALL_STORES] }, 'B'), true);
    assert.equal(seesStoreItems(accessOf('CUSTOMER'), 'A'), false);
    assert.equal(seesStoreItems(null, 'A'), false);
  });
});

describe('categoryDenial (categorías globales)', () => {
  test('ADMIN puede crearlas', () => {
    assert.equal(categoryDenial(accessOf('ADMIN')), null);
  });
  test('MANAGER: tiene catalog:manage pero le falta scope:all_stores', () => {
    assert.deepEqual(categoryDenial(accessOf('MANAGER')), { reason: 'PERMISSION_REQUIRED', permission: P.ALL_STORES });
  });
  test('STAFF y CUSTOMER: les falta catalog:manage', () => {
    for (const role of ['STAFF', 'CUSTOMER', 'DELIVERY']) {
      assert.deepEqual(categoryDenial(accessOf(role)), { reason: 'PERMISSION_REQUIRED', permission: P.CATALOG_MANAGE });
    }
    assert.deepEqual(categoryDenial(undefined), { reason: 'PERMISSION_REQUIRED', permission: P.CATALOG_MANAGE });
  });
});

describe('reportStoreScope (reportes por sucursal)', () => {
  test('ADMIN sin storeId: todas (storeIds null); con storeId: esa', () => {
    assert.deepEqual(reportStoreScope(accessOf('ADMIN', { storeIds: [] })), { storeIds: null });
    assert.deepEqual(reportStoreScope(accessOf('ADMIN', { storeIds: [] }), 'B'), { storeIds: ['B'] });
  });
  test('MANAGER sin storeId: sus WORKS_AT (ninguna si no tiene)', () => {
    assert.deepEqual(reportStoreScope(accessOf('MANAGER', { storeIds: ['A', 'C'] })), { storeIds: ['A', 'C'] });
    assert.deepEqual(reportStoreScope(accessOf('MANAGER', { storeIds: [] })), { storeIds: [] });
  });
  test('MANAGER con storeId: la suya sí, otra STORE_NOT_ASSIGNED', () => {
    assert.deepEqual(reportStoreScope(accessOf('MANAGER', { storeIds: ['A'] }), 'A'), { storeIds: ['A'] });
    assert.deepEqual(reportStoreScope(accessOf('MANAGER', { storeIds: ['A'] }), 'B'), { denied: { reason: 'STORE_NOT_ASSIGNED', storeId: 'B' } });
  });
});

describe('canSeeStatusActor (quién ve `by` en statusHistory)', () => {
  const order = { id: 'O1', userId: 'cliente', storeId: 'S1', mode: 'PICKUP' };
  const delivery = { ...order, mode: 'DELIVERY' };

  test('el cliente de la orden nunca ve quién fue, aunque sea ADMIN', () => {
    assert.equal(canSeeStatusActor(accessOf('CUSTOMER', { id: 'cliente', storeIds: [] }), order), false);
    assert.equal(canSeeStatusActor(accessOf('ADMIN', { id: 'cliente', storeIds: [] }), order), false);
  });

  test('personal de la sucursal y ADMIN lo ven', () => {
    for (const role of ['STAFF', 'MANAGER']) assert.equal(canSeeStatusActor(accessOf(role, { id: 'x', storeIds: ['S1'] }), order), true, role);
    assert.equal(canSeeStatusActor(accessOf('ADMIN', { id: 'x', storeIds: [] }), order), true);
    assert.equal(canSeeStatusActor(accessOf('DELIVERY', { id: 'x', storeIds: ['S1'] }), delivery), true);
  });

  test('quien no puede ver la orden tampoco ve quién fue', () => {
    assert.equal(canSeeStatusActor(accessOf('STAFF', { id: 'x', storeIds: ['OTRA'] }), order), false);
    assert.equal(canSeeStatusActor(accessOf('DELIVERY', { id: 'x', storeIds: ['S1'] }), order), false); // PICKUP
    assert.equal(canSeeStatusActor(accessOf('CUSTOMER', { id: 'otro', storeIds: [] }), order), false);
    assert.equal(canSeeStatusActor(null, order), false);
  });
});
