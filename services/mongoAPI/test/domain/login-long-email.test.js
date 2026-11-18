// login (src/auth.js): un correo de más de 320 caracteres se rechaza antes de buscarlo, con el mismo error
// que cualquier credencial incorrecta. Sin bases de datos: Redis se simula y User.findOne no debe llamarse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthResolvers } from '../../src/auth.js';
import { User } from '../../src/infrastructure/models/index.js';

test('un correo de 100 KB responde INVALID_CREDENTIALS sin consultar a MongoDB', async () => {
  const resolvers = createAuthResolvers({ isReady: true });
  const original = User.findOne;
  let looked = false;
  User.findOne = () => { looked = true; throw new Error('no debe consultarse'); };
  try {
    const started = Date.now();
    await assert.rejects(
      resolvers.Mutation.login(null, { input: { email: `eyJ${'eyJ'.repeat(33_000)}@x.mx`, password: 'x' } }, { ip: '1.1.1.1' }),
      err => err.extensions?.code === 'INVALID_CREDENTIALS',
    );
    assert.ok(Date.now() - started < 500);
    assert.equal(looked, false);
  } finally {
    User.findOne = original;
  }
});
