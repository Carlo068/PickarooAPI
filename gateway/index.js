import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';

const port = parseInt(process.env.PORT_GATEWAY) || 4000;
const subgraphs = [
  // Catálogo, órdenes, carrito, sesiones y roles (MongoDB + Redis + Neo4j).
  { name: 'pickaroo', url: `http://localhost:${process.env.PORT_CAMPAMENTOS || 4001}/graphql` },
  // Bitácora de auditoría (ScyllaDB, alimentada por RabbitMQ).
  { name: 'auditoria', url: `http://localhost:${process.env.PORT_AUDITORIA || 4003}/graphql` },
];

// Propaga al subgrafo el JWT del cliente y, para la bitácora, su IP y User-Agent.
class AuthenticatedDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }) {
    if (context.authorization) request.http.headers.set('authorization', context.authorization);
    if (context.clientIp) request.http.headers.set('x-forwarded-for', context.clientIp);
    if (context.userAgent) request.http.headers.set('user-agent', context.userAgent);
  }
}

const clientContext = async ({ req }) => ({
  authorization: req.headers.authorization,
  clientIp: String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress,
  userAgent: req.headers['user-agent'],
});

// El Gateway agrega los microservicios locales (subgraphs) en un supergrafo.
function buildServer() {
  return new ApolloServer({
    gateway: new ApolloGateway({
      supergraphSdl: new IntrospectAndCompose({ subgraphs }),
      buildService: ({ url }) => new AuthenticatedDataSource({ url }),
    }),
  });
}

// Los subgrafos pueden tardar en levantar (conexiones + seed). Reintentamos
// la composición inicial en lugar de morir si aún no responden.
const RETRIES = 15;
for (let attempt = 1; ; attempt++) {
  try {
    const { url } = await startStandaloneServer(buildServer(), { listen: { port }, context: clientContext });
    console.log(`🚀 API Gateway (Supergraph) unificada y lista en: ${url}`);
    break;
  } catch (err) {
    if (attempt >= RETRIES) throw err;
    console.log(`⏳ Subgrafos aún no disponibles (${attempt}/${RETRIES}). Reintentando en 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }
}
