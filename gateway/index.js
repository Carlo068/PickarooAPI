import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { ApolloGateway, IntrospectAndCompose } from '@apollo/gateway';

// El Gateway actúa como agregador de los microservicios locales (subgraphs)
const gateway = new ApolloGateway({
  supergraphSdl: new IntrospectAndCompose({
    subgraphs: [
      { name: 'campamentos', url: `http://localhost:${process.env.PORT_CAMPAMENTOS || 4001}/graphql` },
    ],
  }),
});

const server = new ApolloServer({
  gateway,
});

const port = parseInt(process.env.PORT_GATEWAY) || 4000;
const { url } = await startStandaloneServer(server, {
  listen: { port },
});

console.log(`🚀 API Gateway (Supergraph) unificada y lista en: ${url}`);
