// Semilla de datos demo para CARNYFRUT (carnicería + frutería).
// Aditiva e idempotente: si un registro ya existe (match por nombre o correo)
// no se toca, así re-ejecutarla nunca pisa stock, precios ni órdenes.
// Se ejecuta al arrancar con SEED=true.

import { hashPassword } from './passwords.js';

async function ensure(Model, filter, doc) {
  const existing = await Model.findOne(filter);
  if (existing) return existing;
  return Model.create({ ...filter, ...doc });
}

export async function seed({ User, Category, Product, Package, Store }) {
  console.log('🌱 SEED=true — verificando datos demo de CARNYFRUT...');

  const store = await ensure(Store, { name: 'CARNYFRUT Centro' }, {
    address: { street: 'Av. Universidad 1200, Col. Centro', city: 'Chihuahua', state: 'Chihuahua', zipCode: '31000' },
    phone: '614-000-0000',
    schedule: 'Lun-Sáb 8:00-20:00',
    deliveryFee: 35,
    freeDeliveryThreshold: 400,
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
    prod[p.name] = await ensure(Product, { name: p.name }, { ...p, categoryId: cats[cat]._id });
  }

  // El producto estrella de CARNYFRUT: el paquete para carne asada. Sin stock
  // propio: se pueden armar tantos como alcance su producto más escaso.
  await ensure(Package, { name: 'Paquete Carne Asada Familiar (6 personas)' }, {
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

  const [products, packages] = await Promise.all([Product.countDocuments(), Package.countDocuments()]);
  console.log(`🌱 Seed OK: ${products} productos, ${packages} paquete/s, sucursal "${store.name}", usuarios ${admin.email} / ${cliente.email}.`);
}
