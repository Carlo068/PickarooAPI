// Semilla de datos demo para CARNYFRUT (carnicería + frutería).
// Aditiva e idempotente: si un registro ya existe (match por slug / email /
// name) no se toca. Las dos búsquedas con alias heredado solo corrigen el
// nombre CARNYFRUT y el correo carnyfrut, sin alterar stock, precios ni órdenes.
// Se ejecuta al arrancar con SEED=true.

async function ensure(Model, filter, doc) {
  const existing = await Model.findOne(filter);
  if (existing) return existing;
  return Model.create({ ...filter, ...doc });
}

export async function seed({ User, Category, Product, Store }) {
  console.log('🌱 SEED=true — verificando datos demo de CARNYFRUT...');

  const legacyStore = await Store.findOneAndUpdate(
    { name: 'Carnyfruit Centro' },
    { $set: { name: 'CARNYFRUT Centro' } },
    { new: true },
  );
  const store = legacyStore || await ensure(Store, { name: 'CARNYFRUT Centro' }, {
    address: 'Av. Universidad 1200, Col. Centro',
    city: 'Chihuahua',
    phone: '614-000-0000',
    schedule: 'Lun-Sáb 8:00-20:00',
    isActive: true,
    deliveryFee: 35,
    freeDeliveryThreshold: 400,
  });

  const legacyAdmin = await User.findOneAndUpdate(
    { email: 'admin@carnyfruit.mx' },
    { $set: { email: 'admin@carnyfrut.mx', name: 'Admin CARNYFRUT' } },
    { new: true, runValidators: true },
  );
  const admin = legacyAdmin || await ensure(User, { email: 'admin@carnyfrut.mx' }, { name: 'Admin CARNYFRUT', role: 'ADMIN', isActive: true });

  const cliente = await ensure(User, { email: 'cliente@demo.mx' }, {
    name: 'Cliente Demo', role: 'CUSTOMER', isActive: true,
    addresses: [{ label: 'Casa', street: 'Calle Falsa 123', city: 'Chihuahua', state: 'Chihuahua', zipCode: '31000', isDefault: true }],
  });

  const cats = {};
  for (const c of [
    { slug: 'paquetes', name: 'Paquetes', icon: 'package', sortOrder: 0 },
    { slug: 'carnes', name: 'Carnes', icon: 'beef', sortOrder: 1 },
    { slug: 'frutas', name: 'Frutas', icon: 'apple', sortOrder: 2 },
    { slug: 'verduras', name: 'Verduras', icon: 'carrot', sortOrder: 3 },
    { slug: 'abarrotes', name: 'Abarrotes', icon: 'shopping-basket', sortOrder: 4 },
  ]) {
    cats[c.slug] = await ensure(Category, { slug: c.slug }, c);
  }

  const productos = [
    { cat: 'carnes', name: 'Arrachera marinada', price: 289.0, unit: 'KG', stock: 50 },
    { cat: 'carnes', name: 'Chorizo argentino', price: 159.0, unit: 'KG', stock: 40 },
    { cat: 'carnes', name: 'Costilla de cerdo', price: 149.9, unit: 'KG', stock: 45 },
    { cat: 'carnes', name: 'Bistec de res', price: 189.9, unit: 'KG', stock: 40 },
    { cat: 'carnes', name: 'Pechuga de pollo', price: 129.5, unit: 'KG', stock: 60 },
    { cat: 'frutas', name: 'Limón con sal', price: 29.9, unit: 'KG', stock: 80 },
    { cat: 'frutas', name: 'Plátano', price: 19.9, unit: 'KG', stock: 150, discounts: [{ discountPercentage: 15, label: 'Precio especial', isActive: true }] },
    { cat: 'verduras', name: 'Cebolla blanca', price: 22.5, unit: 'KG', stock: 80 },
    { cat: 'verduras', name: 'Nopales limpios', price: 34.9, unit: 'KG', stock: 35 },
    { cat: 'verduras', name: 'Tortillas de maíz (kg)', price: 24.0, unit: 'KG', stock: 100 },
    { cat: 'abarrotes', name: 'Carbón 3 kg', price: 89.0, unit: 'PAQUETE', stock: 60 },
  ];
  const prod = {};
  for (const p of productos) {
    const { cat, ...rest } = p;
    prod[p.name] = await ensure(Product, { name: p.name }, { ...rest, categoryId: cats[cat]._id, isActive: true });
  }

  // El producto estrella de CARNYFRUT: paquetes para carne asada (kind: PAQUETE).
  await ensure(Product, { name: 'Paquete Carne Asada Familiar (6 personas)' }, {
    categoryId: cats['paquetes']._id,
    description: 'Todo para tu carne asada: arrachera, chorizo, costilla, cebollitas, nopales, tortillas, limones y carbón.',
    price: 979.0, // vs ~1087 comprando cada cosa por separado
    unit: 'PAQUETE',
    stock: 20,
    isActive: true,
    kind: 'PAQUETE',
    components: [
      { productId: prod['Arrachera marinada']._id, quantity: 2 },
      { productId: prod['Chorizo argentino']._id, quantity: 1 },
      { productId: prod['Costilla de cerdo']._id, quantity: 1 },
      { productId: prod['Cebolla blanca']._id, quantity: 1 },
      { productId: prod['Nopales limpios']._id, quantity: 1 },
      { productId: prod['Tortillas de maíz (kg)']._id, quantity: 1 },
      { productId: prod['Limón con sal']._id, quantity: 1 },
      { productId: prod['Carbón 3 kg']._id, quantity: 1 },
    ],
  });

  const total = await Product.countDocuments();
  const paquetes = await Product.countDocuments({ kind: 'PAQUETE' });
  console.log(`🌱 Seed OK: ${total} productos (${paquetes} paquete/s), sucursal "${store.name}", usuarios ${admin.email} / ${cliente.email}.`);
}
