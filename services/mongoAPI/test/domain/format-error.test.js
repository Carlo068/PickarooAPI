// formatApiError (infrastructure/format-error.js): el único lugar donde los errores de
// dominio, de validación de Mongoose y de clave duplicada se convierten en extensions.code.
// Usa los modelos de Mongoose solo para validar en memoria: no abre ninguna conexión.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import { formatApiError } from '../../src/infrastructure/format-error.js';
import { DomainError, notFoundError, isErrorCode } from '../../src/domain/errors.js';
import { Product, Package } from '../../src/infrastructure/models/index.js';

const formatted = { message: 'genérico', path: ['op'], extensions: { code: 'INTERNAL_SERVER_ERROR' } };
const run = original => formatApiError(formatted, { originalError: original });

describe('formatApiError', () => {
  test('DomainError: mensaje, path y extensions tal cual (con sus detalles)', () => {
    const err = new DomainError('Los precios cambiaron.', 'PRICE_CHANGED', { newQuote: { total: 5 } });
    assert.deepEqual(run(err), { message: 'Los precios cambiaron.', path: ['op'], extensions: { code: 'PRICE_CHANGED', newQuote: { total: 5 } } });
    assert.deepEqual(run(notFoundError('USER', 'u1')).extensions, { code: 'NOT_FOUND', entity: 'USER', id: 'u1' });
  });

  test('GraphQLError con código propio pasa sin cambios (FORBIDDEN, UNAUTHENTICATED, INVALID_CREDENTIALS…)', () => {
    const err = new GraphQLError('No', { extensions: { code: 'FORBIDDEN', reason: 'PERMISSION_REQUIRED', permission: 'x' } });
    const f = { message: 'No', extensions: err.extensions };
    assert.equal(formatApiError(f, { originalError: err }), f);
  });

  test('error desconocido pasa sin cambios', () => {
    assert.equal(formatApiError(formatted, { originalError: new Error('boom') }), formatted);
  });

  test('ValidationError real de Mongoose: VALIDATION_ERROR con field y violations, mensaje unido', async () => {
    const doc = new Product({});
    const err = await doc.validate().then(() => null, e => e);
    assert.equal(err?.name, 'ValidationError');
    const out = run(err);
    assert.equal(out.extensions.code, 'VALIDATION_ERROR');
    assert.ok(out.extensions.field);
    assert.ok(out.extensions.violations.length >= 1);
    for (const v of out.extensions.violations) assert.ok(v.field && v.rule, JSON.stringify(v));
    assert.ok(out.extensions.violations.some(v => v.rule === 'required'));
    assert.equal(out.message, Object.values(err.errors).map(e => e.message).join(' '));
  });

  test('regla de dominio dentro de un hook de Mongoose: la violación trae el código de dominio como rule', async () => {
    const doc = new Product({ name: 'Arrachera', price: 10, categoryId: '507f1f77bcf86cd799439011', stock: -3 });
    const err = await doc.validate().then(() => null, e => e);
    const rules = run(err).extensions.violations.map(v => v.rule);
    assert.ok(rules.includes('INVALID_STOCK'), rules.join());
    for (const rule of rules.filter(r => /^[A-Z_]+$/.test(r))) assert.ok(isErrorCode(rule), rule);
  });

  test('regla de dominio en el hook del paquete', async () => {
    const doc = new Package({ name: 'Combo', price: 10, items: [] });
    const err = await doc.validate().then(() => null, e => e);
    const out = run(err);
    assert.equal(out.extensions.code, 'VALIDATION_ERROR');
    assert.ok(out.extensions.violations.some(v => v.field === 'items'));
  });

  test('E11000 sobre email: EMAIL_ALREADY_REGISTERED', () => {
    const err = Object.assign(new Error('E11000 duplicate key error collection: pickaroo.users index: email_1'), { code: 11000, keyPattern: { email: 1 }, keyValue: { email: 'a@b.c' } });
    const out = run(err);
    assert.deepEqual(out.extensions, { code: 'EMAIL_ALREADY_REGISTERED', field: 'email' });
    assert.equal(out.path[0], 'op');
    assert.ok(!out.message.includes('E11000'), 'no se filtran detalles internos de Mongo');
  });

  test('E11000 sobre otro campo: DUPLICATE_VALUE con field', () => {
    const err = Object.assign(new Error('E11000 ...'), { code: 11000, keyPattern: { name: 1 } });
    assert.deepEqual(run(err).extensions, { code: 'DUPLICATE_VALUE', field: 'name' });
    assert.deepEqual(run(Object.assign(new Error('E11000'), { code: 11000 })).extensions, { code: 'DUPLICATE_VALUE', field: null });
  });

  test('Neo4j sin respuesta: SERVICE_UNAVAILABLE', () => {
    const out = run(Object.assign(new Error('Neo4j no respondió a tiempo.'), { code: 'ServiceUnavailable' }));
    assert.deepEqual(out.extensions, { code: 'SERVICE_UNAVAILABLE', service: 'RBAC' });
    assert.equal(out.message, 'Neo4j no respondió a tiempo.');
  });

  test('sin originalError usa el propio error', () => {
    assert.equal(formatApiError(formatted, new DomainError('x', 'CART_EMPTY')).extensions.code, 'CART_EMPTY');
    assert.equal(formatApiError(formatted, undefined), formatted);
  });
});
