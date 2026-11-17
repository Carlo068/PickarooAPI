// ============================================================
// MIGRACIONES DE DATOS — decisiones puras (sin Mongoose)
//
// La infraestructura (infrastructure/migrations.js) cuenta los documentos y
// aplica lo que se decide aquí. Toda migración es idempotente: correrla de
// nuevo sobre datos ya migrados no cambia nada.
// ============================================================

const time = d => {
  const t = d == null ? NaN : new Date(d).getTime();
  return Number.isNaN(t) ? Infinity : t; // sin fecha: al final
};

// Marketplace: cada producto y paquete pertenece a una sucursal. Los que no
// tienen storeId (anteriores al marketplace) se asignan a la sucursal ACTIVA
// más antigua por createdAt (empate: el id menor). Si hay sucursales pero
// ninguna activa, a la más antigua (storeActive: false: sus artículos quedan
// ocultos hasta reactivarla).
//
// stores:  [{ _id | id, name, createdAt, isActive }]
// pending: { products, packages }  documentos sin storeId
// Devuelve:
//   { action: 'NONE' }                                   nada pendiente
//   { action: 'ASSIGN', storeId, storeName, storeActive, products, packages }
//   { action: 'NO_STORE', products, packages }           no hay sucursal: se quedan sin listar
export function planCatalogStoreBackfill({ stores = [], pending = {} } = {}) {
  const products = Number(pending.products) || 0;
  const packages = Number(pending.packages) || 0;
  if (!products && !packages) return { action: 'NONE' };
  if (!stores.length) return { action: 'NO_STORE', products, packages };
  const idOf = s => String(s._id ?? s.id);
  const isActive = s => s.isActive !== false;
  const active = stores.filter(isActive);
  const [oldest] = [...(active.length ? active : stores)].sort((a, b) => time(a.createdAt) - time(b.createdAt) || idOf(a).localeCompare(idOf(b)));
  return { action: 'ASSIGN', storeId: idOf(oldest), storeName: oldest.name ?? null, storeActive: isActive(oldest), products, packages };
}

// Historial de estados: las órdenes anteriores a PIC-78 no lo tienen. Se
// sintetiza PENDING en createdAt y, si ya cambió de estado, el estado actual en
// updatedAt (la única fecha que se conserva). Las entradas van `inferred: true`
// y sin autor. Una orden cuyo historial no empieza en PENDING (un cambio de estado
// llegó antes de la migración) recibe solo el PENDING inferido al inicio.
// Devuelve las entradas a anteponer, o null si el historial ya está completo (idempotente).
export function planStatusHistoryBackfill(order) {
  const existing = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
  if (existing.length && existing[0]?.status === 'PENDING') return null;
  const createdAt = order.createdAt ?? order.updatedAt ?? new Date(0);
  const history = [{ status: 'PENDING', at: createdAt, byUserId: null, byRole: null, inferred: true }];
  if (existing.length) return history;
  if (order.status && order.status !== 'PENDING') {
    history.push({ status: order.status, at: order.updatedAt ?? createdAt, byUserId: null, byRole: null, inferred: true });
  }
  return history;
}
