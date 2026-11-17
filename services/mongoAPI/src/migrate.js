// npm run migrate — aplica las migraciones de datos sin arrancar la API.
// Usa el MONGODB_URI del .env de mongoAPI (o del entorno). Son las mismas
// que corren al arrancar mongoAPI e idempotentes: repetirla no cambia nada.
import 'dotenv/config';
import mongoose from 'mongoose';
import { runMigrations } from './infrastructure/migrations.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/pickaroodb';

try {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000, autoIndex: false }); // los índices los alinea el arranque (syncIndexes)
  console.log(`✅ MongoDB (${mongoose.connection.name}) conectado.`);
  await runMigrations();
} catch (err) {
  console.error('❌ La migración falló:', err.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
