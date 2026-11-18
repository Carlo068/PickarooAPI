// Contraseñas del seed y su guardia de producción (funciones puras, sin conexiones).
// Sin SEED_*_PASSWORD el seed usa contraseñas públicas de demostración (están en el
// README); eso solo es aceptable fuera de producción.

// Variable de entorno -> contraseña de demostración que se usa si no está definida.
export const SEED_PASSWORD_DEFAULTS = {
  SEED_ADMIN_PASSWORD: 'Admin1234',
  SEED_CUSTOMER_PASSWORD: 'Cliente1234',
  SEED_MANAGER_PASSWORD: 'Manager1234',
  SEED_STAFF_PASSWORD: 'Staff1234',
  SEED_DELIVERY_PASSWORD: 'Delivery1234',
  SEED_DELIVERY2_PASSWORD: 'Delivery1234',
  SEED_HUERTA_MANAGER_PASSWORD: 'Manager1234',
  SEED_HUERTA_STAFF_PASSWORD: 'Staff1234',
};

// Contraseña efectiva de cada variable y las que no estaban definidas.
export function seedPasswords(env = process.env) {
  const passwords = {};
  const unset = [];
  for (const [name, fallback] of Object.entries(SEED_PASSWORD_DEFAULTS)) {
    const value = env[name];
    if (value) passwords[name] = value;
    else { passwords[name] = fallback; unset.push(name); }
  }
  return { passwords, unset };
}

// Variables que faltan y bloquean el seed: solo con NODE_ENV=production.
export const seedBlockedBy = (env = process.env) => (env.NODE_ENV === 'production' ? seedPasswords(env).unset : []);
