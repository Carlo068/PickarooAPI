import 'dotenv/config';
import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloGateway, IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';
import { gatewayPort, subgraphList, includeStacktrace, corsOptions, composeRetries } from './config.js';

const port = gatewayPort();
// Catálogo/órdenes (mongoAPI) y, si AUDIT_ENABLED no es false, la bitácora (auditAPI).
const subgraphs = subgraphList();

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
function buildServer(httpServer) {
  return new ApolloServer({
    gateway: new ApolloGateway({
      supergraphSdl: new IntrospectAndCompose({ subgraphs }),
      buildService: ({ url }) => new AuthenticatedDataSource({ url }),
    }),
    includeStacktraceInErrorResponses: includeStacktrace(),
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });
}

// Los subgrafos pueden tardar en levantar (conexiones + seed). Reintentamos
// la composición inicial en lugar de morir si aún no responden.
const RETRIES = composeRetries();
const httpServer = http.createServer();
let server;
for (let attempt = 1; ; attempt++) {
  try {
    server = buildServer(httpServer);
    await server.start();
    break;
  } catch (err) {
    if (attempt >= RETRIES) throw err;
    console.log(`⏳ Subgrafos aún no disponibles (${attempt}/${RETRIES}). Reintentando en 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }
}

const app = express();
// Health check sin autenticación ni dependencias (Render lo consulta con un GET simple).
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// GraphQL en la raíz, igual que antes (los clientes apuntan a http://host:4000/).
app.use('/', cors(corsOptions()), express.json({ limit: '50mb' }), expressMiddleware(server, { context: clientContext }));
httpServer.on('request', app);

await new Promise(resolve => httpServer.listen({ port }, resolve));
console.log(`🚀 API Gateway (Supergraph) unificada y lista en: http://localhost:${port}/ (${subgraphs.map(s => s.name).join(', ')})`);
