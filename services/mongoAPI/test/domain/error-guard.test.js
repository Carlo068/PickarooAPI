// Guardia estática del contrato de errores. Lee el código fuente de los dos
// subgrafos (services/*/src/**/*.js, sin seed.js) y falla si alguien:
//   1. escribe `new DomainError(` sin código (o con un código que no es literal del catálogo);
//   2. usa un código literal (extensions.code, authError, forbidden) que no está en el catálogo;
//   3. crea un `new GraphQLError(` sin `code` en sus extensions;
//   4. lanza un Error plano (`throw new Error/TypeError/...`) que llegaría al cliente sin código.
//
// Cómo se distingue el código de petición del de arranque: NO se distingue. La regla es
// simple a propósito: ningún archivo de src/ lanza errores planos, porque cualquier módulo
// puede acabar dentro de un resolver. El arranque/infraestructura que necesita fallar
// rechaza una promesa o registra con console (eso no coincide con `throw new Error`) y
// seed.js, que solo corre con SEED=true al arrancar, queda fuera del escaneo.
// Lo que sí lanza un Error plano a propósito va en ALLOWLIST con su motivo.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, FORBIDDEN_REASONS } from '../../src/domain/errors.js';

const servicesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function listSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listSources(p);
    return e.name.endsWith('.js') && e.name !== 'seed.js' ? [p] : [];
  });
}

const sources = fs.readdirSync(servicesDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(servicesDir, d.name, 'src')))
  .flatMap(d => listSources(path.join(servicesDir, d.name, 'src')))
  .map(file => ({ file, rel: path.relative(servicesDir, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'utf8') }));

// Errores planos permitidos (archivo + fragmento de la línea + motivo).
const ALLOWLIST = [
  {
    rel: 'mongoAPI/src/index.js',
    line: /Fecha inválida|DateTime debe ser/,
    reason: 'parseValue/parseLiteral del escalar DateTime: Apollo los convierte en BAD_USER_INPUT / GRAPHQL_VALIDATION_FAILED (códigos del catálogo).',
  },
  {
    rel: 'mongoAPI/src/domain/errors.js',
    line: /DomainError sin código de catálogo/,
    reason: 'error de programación dentro del propio DomainError (código ausente); esta misma guardia garantiza que nunca ocurra con un literal.',
  },
];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Argumentos de nivel superior de la llamada cuyo paréntesis de apertura está en `open`.
function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  const stack = []; // comillas / plantillas abiertas
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i += 1;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '\\') i += 1;
      else if (c === '`') stack.pop();
      else if (c === '$' && text[i + 1] === '{') { stack.push('${'); i += 1; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { stack.push(c); continue; }
    if (top === '${' && c === '}') { stack.pop(); continue; }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) { args.push(text.slice(start, i).trim()); return args; }
    } else if (c === ',' && depth === 1) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  throw new Error('llamada sin cerrar');
}

const calls = (text, name) => [...text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map(m => ({
  index: m.index,
  args: callArgs(text, m.index + m[0].length - 1),
}));

const literal = arg => /^'([^'\\]*)'$/.exec(arg ?? '')?.[1] ?? null;

describe('guardia del contrato de errores', () => {
  test('encuentra los archivos de los dos subgrafos', () => {
    const rels = sources.map(s => s.rel);
    for (const expected of ['mongoAPI/src/index.js', 'mongoAPI/src/domain/entities.js', 'auditAPI/src/index.js']) assert.ok(rels.includes(expected), expected);
    assert.ok(!rels.some(r => r.endsWith('seed.js')));
  });

  test('todo `new DomainError(` lleva un código literal del catálogo como segundo argumento', () => {
    let total = 0;
    for (const { rel, text } of sources) {
      for (const { index, args } of calls(text, 'new DomainError')) {
        total += 1;
        const where = `${rel}:${lineOf(text, index)}`;
        assert.ok(args.length >= 2, `${where}: DomainError sin código`);
        const code = literal(args[1]);
        assert.ok(code, `${where}: el código debe ser un literal entre comillas simples, no ${args[1]}`);
        assert.ok(Object.hasOwn(ERROR_CODES, code), `${where}: ${code} no está en el catálogo`);
      }
    }
    assert.ok(total > 20, `se esperaban muchas llamadas, hay ${total}`); // evita una guardia vacía
  });

  test('todo `extensions: { ... code: \'X\' }` usa un código del catálogo', () => {
    let total = 0;
    for (const { rel, text } of sources) {
      for (const m of text.matchAll(/extensions\s*:\s*\{[^}]*?\bcode\s*:\s*'([^']*)'/g)) {
        total += 1;
        assert.ok(Object.hasOwn(ERROR_CODES, m[1]), `${rel}:${lineOf(text, m.index)}: ${m[1]} no está en el catálogo`);
      }
    }
    assert.ok(total >= 3, `hay ${total}`);
  });

  test('authError(mensaje, código) usa un código del catálogo', () => {
    let total = 0;
    for (const { rel, text } of sources) {
      for (const { index, args } of calls(text, 'authError')) {
        total += 1;
        const code = literal(args[1]);
        assert.ok(code && Object.hasOwn(ERROR_CODES, code), `${rel}:${lineOf(text, index)}: código inválido ${args[1]}`);
      }
    }
    assert.ok(total >= 3, `hay ${total}`);
  });

  test('forbidden(mensaje, razón) usa una razón de FORBIDDEN_REASONS', () => {
    let total = 0;
    for (const { rel, text } of sources) {
      for (const { index, args } of calls(text, 'forbidden')) {
        total += 1;
        const reason = literal(args[1]);
        assert.ok(reason && Object.hasOwn(FORBIDDEN_REASONS, reason), `${rel}:${lineOf(text, index)}: razón inválida ${args[1]}`);
      }
    }
    assert.ok(total >= 5, `hay ${total}`);
  });

  test('todo `new GraphQLError(` declara su code en extensions', () => {
    for (const { rel, text } of sources) {
      for (const { index, args } of calls(text, 'new GraphQLError')) {
        const extensions = args[1] ?? '';
        assert.match(extensions, /\bcode\b/, `${rel}:${lineOf(text, index)}: GraphQLError sin extensions.code`);
      }
    }
  });

  test('nadie lanza un Error plano (salvo la lista permitida)', () => {
    const offenders = [];
    const used = new Set();
    for (const { rel, text } of sources) {
      for (const m of text.matchAll(/throw\s+new\s+(Error|TypeError|RangeError|SyntaxError|ReferenceError)\s*\(/g)) {
        const lineText = text.split('\n')[lineOf(text, m.index) - 1];
        const allowed = ALLOWLIST.findIndex(a => a.rel === rel && a.line.test(lineText));
        if (allowed >= 0) used.add(allowed);
        else offenders.push(`${rel}:${lineOf(text, m.index)}: ${lineText.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], 'estos errores llegarían al cliente como INTERNAL_SERVER_ERROR; usa DomainError/GraphQLError con código del catálogo');
    ALLOWLIST.forEach((a, i) => assert.ok(used.has(i), `entrada de la lista permitida sin uso (bórrala): ${a.line}`));
    ALLOWLIST.forEach(a => assert.ok(a.reason.length > 10));
  });

  test('domain/access.js no lanza: las reglas de acceso devuelven booleano', () => {
    const access = sources.find(s => s.rel === 'mongoAPI/src/domain/access.js');
    assert.ok(access);
    assert.doesNotMatch(access.text, /\bthrow\b/);
  });

  test('el plugin de auditoría solo clasifica por códigos del catálogo y no por texto del mensaje', () => {
    const events = sources.find(s => s.rel === 'mongoAPI/src/infrastructure/events.js');
    const denied = /const DENIED = new Set\(\[([^\]]*)\]\)/.exec(events.text);
    assert.ok(denied, 'DENIED no encontrado');
    const codes = [...denied[1].matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
    assert.deepEqual(codes.sort(), ['FORBIDDEN', 'UNAUTHENTICATED']);
    for (const code of codes) assert.ok(Object.hasOwn(ERROR_CODES, code));
    assert.doesNotMatch(events.text, /DOMAIN_RULE_VIOLATION/);
    assert.doesNotMatch(events.text, /\.message\.(includes|match|startsWith)|message\s*===/);
  });

  test('el escáner entiende plantillas anidadas y comas dentro de argumentos', () => {
    const src = 'new DomainError(`a ${f(1, `x${y}`)} b`, \'CART_EMPTY\', { n: [1, 2] })';
    const [call] = calls(src, 'new DomainError');
    assert.equal(call.args.length, 3);
    assert.equal(literal(call.args[1]), 'CART_EMPTY');
  });
});
