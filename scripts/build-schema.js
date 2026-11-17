// Genera schema/api.graphql: el esquema que ven los clientes a través del gateway.
// Compone offline los SDL de los subgrafos (sin servidores ni bases de datos) y
// descarta la maquinaria de federación.
//
//   node scripts/build-schema.js           escribe schema/api.graphql
//   node scripts/build-schema.js --check   falla si el archivo está desactualizado (no lo modifica)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeServices } from '@apollo/composition';
import { Supergraph } from '@apollo/federation-internals';
import { parse, printSchema } from 'graphql';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'schema', 'api.graphql');
const check = process.argv.includes('--check');

// Mismo orden y nombres que gateway/index.js.
const subgraphFiles = [
  { name: 'pickaroo', file: 'services/mongoAPI/src/schema.graphql' },
  { name: 'auditoria', file: 'services/auditAPI/src/schema.graphql' },
];

const HEADER = `# GENERADO AUTOMÁTICAMENTE. NO EDITAR A MANO.
# Esquema GraphQL que ven los clientes a través del gateway (sin directivas de federación).
# Se genera a partir de los subgrafos con: npm run schema:build
# Verificación (CI/local): npm run schema:check
# Regenerar y commitear este archivo en el mismo commit que cambie un schema.graphql de un subgrafo.

`;

function build() {
  const services = subgraphFiles.map(({ name, file }) => ({
    name,
    typeDefs: parse(readFileSync(join(root, file), 'utf8')),
  }));
  const result = composeServices(services);
  if (result.errors) {
    console.error('Error al componer los subgrafos:');
    for (const e of result.errors) console.error(`  - [${e.extensions?.code ?? 'ERROR'}] ${e.message}`);
    process.exit(1);
  }
  const apiSchema = Supergraph.build(result.supergraphSdl).apiSchema().toGraphQLJSSchema();
  return HEADER + printSchema(apiSchema).trimEnd() + '\n';
}

const expected = build();

if (check) {
  // Tolera CRLF: Git en Windows puede convertir los saltos de línea al extraer.
  const actual = existsSync(outFile) ? readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') : null;
  if (actual !== expected) {
    console.error('schema/api.graphql está desactualizado respecto a los schemas de los subgrafos.');
    console.error('Ejecuta "npm run schema:build" y agrega schema/api.graphql al mismo commit.');
    process.exit(1);
  }
  console.log('schema/api.graphql está actualizado.');
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, expected);
  console.log('Escrito schema/api.graphql');
}
