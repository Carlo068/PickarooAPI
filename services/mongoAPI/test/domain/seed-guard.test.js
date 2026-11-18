// Guardia del seed (infrastructure/seed-guard.js): en producción no se siembran usuarios
// con las contraseñas públicas de demostración.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seedPasswords, seedBlockedBy, SEED_PASSWORD_DEFAULTS } from '../../src/infrastructure/seed-guard.js';

const allSet = () => Object.fromEntries(Object.keys(SEED_PASSWORD_DEFAULTS).map(k => [k, `prod-${k}`]));

describe('seedBlockedBy', () => {
  test('fuera de producción nunca bloquea (se usan las contraseñas de demostración)', () => {
    assert.deepEqual(seedBlockedBy({}), []);
    assert.deepEqual(seedBlockedBy({ NODE_ENV: 'development' }), []);
  });

  test('en producción sin ninguna SEED_*_PASSWORD bloquea y las lista todas', () => {
    assert.deepEqual(seedBlockedBy({ NODE_ENV: 'production' }), Object.keys(SEED_PASSWORD_DEFAULTS));
  });

  test('en producción lista solo las que faltan (una vacía cuenta como faltante)', () => {
    const env = { NODE_ENV: 'production', ...allSet(), SEED_STAFF_PASSWORD: '' };
    delete env.SEED_ADMIN_PASSWORD;
    assert.deepEqual(seedBlockedBy(env), ['SEED_ADMIN_PASSWORD', 'SEED_STAFF_PASSWORD']);
  });

  test('en producción con todas definidas no bloquea', () => {
    assert.deepEqual(seedBlockedBy({ NODE_ENV: 'production', ...allSet() }), []);
  });
});

describe('seedPasswords', () => {
  test('usa el valor del entorno o, si falta, el de demostración de siempre', () => {
    const { passwords, unset } = seedPasswords({ SEED_ADMIN_PASSWORD: 'otra' });
    assert.equal(passwords.SEED_ADMIN_PASSWORD, 'otra');
    assert.equal(passwords.SEED_CUSTOMER_PASSWORD, 'Cliente1234');
    assert.equal(passwords.SEED_DELIVERY2_PASSWORD, 'Delivery1234');
    assert.ok(!unset.includes('SEED_ADMIN_PASSWORD') && unset.includes('SEED_CUSTOMER_PASSWORD'));
  });

  test('seed.js solo lee contraseñas de la tabla de la guardia (ninguna se escapa del chequeo)', () => {
    const src = fs.readFileSync(new URL('../../src/infrastructure/seed.js', import.meta.url), 'utf8');
    assert.ok(!/process\.env\.SEED_/.test(src) && !/process\.env\[`SEED_/.test(src));
  });
});
