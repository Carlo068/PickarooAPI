// Semilla de datos demo del marketplace: dos negocios independientes, cada
// uno con su catálogo y su stock (productos y paquetes con storeId):
//   · CARNYFRUT Centro (carnicería + frutería)
//   · Frutería La Huerta (frutas y verduras)
// Las categorías son globales y las comparten.
// Aditiva e idempotente: si un registro ya existe (match por nombre o correo;
// productos y paquetes por nombre dentro de su sucursal) no se toca, así
// re-ejecutarla nunca pisa stock, precios ni órdenes.
// Se ejecuta al arrancar con SEED=true (después de las migraciones).
//
// En Neo4j crea los nodos de los usuarios demo con su rol y asigna el
// personal a su sucursal (WORKS_AT). Un rol ya existente en el grafo no se
// cambia: manda lo que haya asignado un administrador.

import { hashPassword } from './passwords.js';
import { isNeo4jReady } from './neo4j.js';
import * as rbac from './rbac-graph.js';

async function ensure(Model, filter, doc) {
  const existing = await Model.findOne(filter);
  if (existing) return existing;
  return Model.create({ ...filter, ...doc });
}

export async function seed({ User, Category, Product, Package, Store }) {
  console.log('🌱 SEED=true — verificando datos demo (CARNYFRUT Centro y Frutería La Huerta)...');

  const store = await ensure(Store, { name: 'CARNYFRUT Centro' }, {
    address: { street: 'Av. Universidad 1200, Col. Centro', city: 'Chihuahua', state: 'Chihuahua', zipCode: '31000' },
    phone: '614-000-0000',
    schedule: 'Lun-Sáb 8:00-20:00',
    deliveryFee: 35,
    freeDeliveryThreshold: 400,
  });

  // Segundo negocio, independiente de CARNYFRUT: su propio catálogo, stock y política de reparto.
  const huerta = await ensure(Store, { name: 'Frutería La Huerta' }, {
    address: { street: 'Calle Libertad 450, Col. Obrera', city: 'Chihuahua', state: 'Chihuahua', zipCode: '31350' },
    phone: '614-111-2233',
    schedule: 'Lun-Dom 7:00-19:00',
    deliveryFee: 25,
    freeDeliveryThreshold: 250,
  });

  // Contraseñas de la demo (solo desarrollo). Se asignan únicamente si el usuario no tiene una.
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin1234';
  const clientePassword = process.env.SEED_CUSTOMER_PASSWORD || 'Cliente1234';
  const ensurePassword = async (user, password) => {
    const withHash = await User.findById(user._id).select('+passwordHash');
    if (withHash.passwordHash) return;
    withHash.passwordHash = hashPassword(password);
    await withHash.save();
  };

  const admin = await ensure(User, { email: 'admin@carnyfrut.mx' }, { name: 'Admin CARNYFRUT', role: 'ADMIN' });
  await ensurePassword(admin, adminPassword);

  let cliente = await User.findOne({ email: 'cliente@demo.mx' });
  if (!cliente) {
    cliente = new User({
      name: 'Cliente Demo', email: 'cliente@demo.mx',
      addresses: [{ label: 'Casa', street: 'Calle Falsa 123', city: 'Chihuahua', state: 'Chihuahua', zipCode: '31000' }],
    });
    cliente.defaultAddressId = cliente.addresses[0]._id;
    await cliente.save();
  }
  await ensurePassword(cliente, clientePassword);

  // Personal de la sucursal (contraseñas solo de desarrollo). `key` nombra la
  // variable cuando hay dos usuarios con el mismo rol (SEED_DELIVERY2_PASSWORD).
  const staffPassword = (role, key = role) => process.env[`SEED_${key}_PASSWORD`] || `${role[0]}${role.slice(1).toLowerCase()}1234`;
  const staff = [];
  for (const { email, name, role, key } of [
    { email: 'gerente@carnyfrut.mx', name: 'Gerente CARNYFRUT Centro', role: 'MANAGER' },
    { email: 'empleado@carnyfrut.mx', name: 'Empleado de mostrador', role: 'STAFF' },
    { email: 'repartidor@carnyfrut.mx', name: 'Repartidor Centro', role: 'DELIVERY' },
    // Segundo repartidor: para ver dos aceptaciones de la misma orden (solo una gana).
    { email: 'repartidor2@carnyfrut.mx', name: 'Repartidor Centro 2', role: 'DELIVERY', key: 'DELIVERY2' },
  ]) {
    const user = await ensure(User, { email }, { name, role });
    await ensurePassword(user, staffPassword(role, key));
    staff.push(user);
  }

  // Personal de Frutería La Huerta (contraseñas solo de desarrollo, mismo patrón).
  const huertaPassword = role => process.env[`SEED_HUERTA_${role}_PASSWORD`] || `${role[0]}${role.slice(1).toLowerCase()}1234`;
  const huertaStaff = [];
  for (const { email, name, role } of [
    { email: 'gerente@lahuerta.mx', name: 'Gerente La Huerta', role: 'MANAGER' },
    { email: 'empleado@lahuerta.mx', name: 'Empleado La Huerta', role: 'STAFF' },
  ]) {
    const user = await ensure(User, { email }, { name, role });
    await ensurePassword(user, huertaPassword(role));
    huertaStaff.push(user);
  }

  const cats = {};
  for (const [i, c] of [
    { name: 'Carnes', icon: 'beef' },
    { name: 'Frutas', icon: 'apple' },
    { name: 'Verduras', icon: 'carrot' },
    { name: 'Abarrotes', icon: 'shopping-basket' },
  ].entries()) {
    cats[c.name] = await ensure(Category, { name: c.name }, { ...c, sortOrder: i });
  }

  const productos = [
    { cat: 'Carnes', name: 'Arrachera marinada', price: 289.0, unit: 'KG', stock: 50 },
    { cat: 'Carnes', name: 'Chorizo argentino', price: 159.0, unit: 'KG', stock: 40 },
    { cat: 'Carnes', name: 'Costilla de cerdo', price: 149.9, unit: 'KG', stock: 45 },
    { cat: 'Carnes', name: 'Bistec de res', price: 189.9, unit: 'KG', stock: 40 },
    { cat: 'Carnes', name: 'Pechuga de pollo', price: 129.5, unit: 'KG', stock: 60 },
    { cat: 'Frutas', name: 'Limón con sal', price: 29.9, unit: 'KG', stock: 80 },
    { cat: 'Frutas', name: 'Plátano', price: 19.9, unit: 'KG', stock: 150, discounts: [{ percent: 15, label: 'Precio especial' }] },
    { cat: 'Verduras', name: 'Cebolla blanca', price: 22.5, unit: 'KG', stock: 80 },
    { cat: 'Verduras', name: 'Nopales limpios', price: 34.9, unit: 'KG', stock: 35 },
    { cat: 'Abarrotes', name: 'Tortillas de maíz', price: 24.0, unit: 'KG', stock: 100 },
    { cat: 'Abarrotes', name: 'Carbón 3 kg', price: 89.0, unit: 'UNIDAD', stock: 60 },
  ];
  const prod = {};
  for (const { cat, ...p } of productos) {
    prod[p.name] = await ensure(Product, { name: p.name, storeId: store._id }, { ...p, categoryId: cats[cat]._id });
  }

  // El producto estrella de CARNYFRUT: el paquete para carne asada. Sin stock
  // propio: se pueden armar tantos como alcance su producto más escaso.
  await ensure(Package, { name: 'Paquete Carne Asada Familiar (6 personas)', storeId: store._id }, {
    description: 'Todo para tu carne asada: arrachera, chorizo, costilla, cebollitas, nopales, tortillas, limones y carbón.',
    price: 979.0, // vs ~1087 comprando cada cosa por separado
    items: [
      { productId: prod['Arrachera marinada']._id, quantity: 2 },
      { productId: prod['Chorizo argentino']._id, quantity: 1 },
      { productId: prod['Costilla de cerdo']._id, quantity: 1 },
      { productId: prod['Cebolla blanca']._id, quantity: 1 },
      { productId: prod['Nopales limpios']._id, quantity: 1 },
      { productId: prod['Tortillas de maíz']._id, quantity: 1 },
      { productId: prod['Limón con sal']._id, quantity: 1 },
      { productId: prod['Carbón 3 kg']._id, quantity: 1 },
    ],
  });

  const productosHuerta = [
    { cat: 'Frutas', name: 'Manzana roja', price: 44.9, unit: 'KG', stock: 70 },
    { cat: 'Frutas', name: 'Naranja para jugo', price: 18.5, unit: 'KG', stock: 120 },
    { cat: 'Frutas', name: 'Aguacate Hass', price: 69.0, unit: 'KG', stock: 40 },
    { cat: 'Verduras', name: 'Jitomate saladet', price: 27.9, unit: 'KG', stock: 90 },
    { cat: 'Verduras', name: 'Chile jalapeño', price: 32.0, unit: 'KG', stock: 30 },
    { cat: 'Verduras', name: 'Papa blanca', price: 24.5, unit: 'KG', stock: 100 },
  ];
  const prodHuerta = {};
  for (const { cat, ...p } of productosHuerta) {
    prodHuerta[p.name] = await ensure(Product, { name: p.name, storeId: huerta._id }, { ...p, categoryId: cats[cat]._id });
  }
  await ensure(Package, { name: 'Canasta para guacamole y salsa', storeId: huerta._id }, {
    description: 'Aguacate, jitomate y chile jalapeño para la botana.',
    price: 159.0, // vs ~198 comprando cada cosa por separado
    items: [
      { productId: prodHuerta['Aguacate Hass']._id, quantity: 2 },
      { productId: prodHuerta['Jitomate saladet']._id, quantity: 1 },
      { productId: prodHuerta['Chile jalapeño']._id, quantity: 1 },
    ],
  });

  // Roles y sucursales en el grafo.
  const people = [admin, cliente, ...staff, ...huertaStaff];
  if (isNeo4jReady()) {
    await rbac.syncStores([store, huerta]);
    for (const u of people) await rbac.ensureUser({ id: u._id, email: u.email, name: u.name }, u.role);
    for (const u of staff) await rbac.assignStore(u._id, store._id);
    for (const u of huertaStaff) await rbac.assignStore(u._id, huerta._id);
    console.log(`🌿 Seed Neo4j: ${people.length} usuarios con rol; ${staff.length} asignados a "${store.name}" y ${huertaStaff.length} a "${huerta.name}".`);
  } else {
    console.warn('⚠️  Seed sin Neo4j: los usuarios tomarán su rol al iniciar sesión, pero el personal quedará sin sucursal hasta volver a correr el seed con Neo4j arriba.');
  }

  const [products, packages] = await Promise.all([Product.countDocuments(), Package.countDocuments()]);
  console.log(`🌱 Seed OK: ${products} productos, ${packages} paquete/s, sucursales "${store.name}" y "${huerta.name}", usuarios ${people.map(u => u.email).join(', ')}.`);
}
