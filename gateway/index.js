import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';

const port = parseInt(process.env.PORT_GATEWAY) || 4000;
const subgraphUrl = `http://localhost:${process.env.PORT_CAMPAMENTOS || 4001}/graphql`;

// Propaga el header Authorization (JWT) del cliente hacia el subgrafo.
class AuthenticatedDataSource extends RemoteGraphQLDataSource {
  willSendRequest({ request, context }) {
    if (context.authorization) request.http.headers.set('authorization', context.authorization);
  }
}

// El Gateway agrega los microservicios locales (subgraphs) en un supergrafo.
function buildServer() {
  return new ApolloServer({
    gateway: new ApolloGateway({
      supergraphSdl: new IntrospectAndCompose({
        subgraphs: [
          { name: 'pickaroo', url: subgraphUrl },
        ],
      }),
      buildService: ({ url }) => new AuthenticatedDataSource({ url }),
    }),
  });
}

// El subgrafo puede tardar en levantar (conexión a Mongo + seed). Reintentamos
// la composición inicial en lugar de morir si aún no responde.
const RETRIES = 15;
for (let attempt = 1; ; attempt++) {
  try {
    const { url } = await startStandaloneServer(buildServer(), {
      listen: { port },
      context: async ({ req }) => ({ authorization: req.headers.authorization }),
    });
    console.log(`🚀 API Gateway (Supergraph) unificada y lista en: ${url}`);
    break;
  } catch (err) {
    if (attempt >= RETRIES) throw err;
    console.log(`⏳ Subgrafo aún no disponible (${attempt}/${RETRIES}). Reintentando en 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }
}
