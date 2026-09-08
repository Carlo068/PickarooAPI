import 'dotenv/config';
import { ApolloServer } from '@apollo/server';
import { startStandaloneServer } from '@apollo/server/standalone';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import amqp from 'amqplib';
import { CampamentoModel } from './infrastructure/mongoose-models.js';
import { Campamento } from './domain/entities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = parse(fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8'));

// Conectar a MongoDB
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/resistencia';
mongoose.connect(mongoUri)
  .then(() => console.log("MongoDB (Campamentos Domain) conectado de forma exitosa."))
  .catch(err => console.error("Error al conectar a MongoDB:", err));

// Inicializar conexión con el Broker de Mensajería (RabbitMQ)
let rabbitChannel;
async function initRabbit() {
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672');
    rabbitChannel = await conn.createChannel();
    await rabbitChannel.assertQueue('transmisiones-auditoria', { durable: true });
    console.log("RabbitMQ conectado. Canal listo para el dominio de Campamentos.");
  } catch (err) {
    console.error("No se pudo establecer conexión con RabbitMQ:", err.message);
  }
}
initRabbit();

const resolvers = {
  Query: {
    verCampamento: async (_, { id }) => {
      const doc = await CampamentoModel.findById(id);
      return doc ? { id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad, suministros: doc.suministros } : null;
    },
    allCampamentos: async () => {
      const docs = await CampamentoModel.find({});
      return docs.map(doc => ({ id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad }));
    },
    reporteGlobalArsenal: async () => {
        try {
          // Ejecución del pipeline de agregación física en la base de datos
          const resultado = await CampamentoModel.aggregate([
            // Etapa 1: Aplanar el arreglo de suministros incrustados
            {
              $unwind: "$suministros"
            },
            // Etapa 2: Agrupar por categoría y realizar cálculos métricos
            {
              $group: {
                _id: "$suministros.categoria", // Llave de agrupación obligatoria
                totalSuministros: { $sum: "$suministros.cantidad" }, // Acumulador matemático
                campamentosAsociados: { $addToSet: "$nombre" } // Acumulador de valores únicos
              }
            },
            // Etapa 3: Ordenar los resultados por volumen de forma descendente
            {
              $sort: { totalSuministros: -1 }
            }
          ]);

          // Mapear los datos de salida del pipeline (_id) al contrato tipado de GraphQL
          return resultado.map(item => ({
            categoria: item._id, // El _id de la agregación contiene la categoría
            totalSuministros: item.totalSuministros,
            campamentosAsociados: item.campamentosAsociados
          }));

        } catch (err) {
          console.error("❌ Error catastrófico en el pipeline analítico:", err.message);
          throw new Error("No se pudo compilar el reporte del arsenal en el Tártaro.");
        }
    },
  },
  Mutation: {
    registrarCampamento: async (_, { nombre, ubicacion, capacidad }) => {
      // Aplicación de DDD: Validar reglas de negocio utilizando la clase pura del dominio
      const campamentoDominio = new Campamento(null, nombre, ubicacion, capacidad);
      campamentoDominio.validarUbicacionSegura();

      // Guardar en la persistencia transaccional
      const nuevoCampamento = new CampamentoModel({ nombre, ubicacion, capacidad });
      const doc = await nuevoCampamento.save();

      // Enviar de forma asíncrona un Evento de Dominio a la cola de mensajería (RabbitMQ) para auditoría
      if (rabbitChannel) {
        const event = {
          event: "CAMPAMENTO_REGISTRADO",
          payload: { id: doc._id, nombre: doc.nombre, fecha: new Date() }
        };
        rabbitChannel.sendToQueue('transmisiones-auditoria', Buffer.from(JSON.stringify(event)), { persistent: true });
        console.log("Evento 'CAMPAMENTO_REGISTRADO' enviado asíncronamente al broker.");
      }

      return { id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad };
    },

    registrarSuministro: async (_, { campamentoId, nombre, cantidad, categoria }) => {
      // 1. Buscar el campamento padre por ID
      const campamento = await CampamentoModel.findById(campamentoId);
      if (!campamento) {
        throw new Error("El campamento de destino no existe en el Tártaro.");
      }

      // 2. Crear el objeto del subdocumento
      const nuevoSuministro = {
        nombre,
        cantidad,
        categoria
      };

      // 3. Insertar el suministro directamente al arreglo incrustado
      campamento.suministros.push(nuevoSuministro);

      // 4. Guardar el documento padre de forma asíncrona
      const campamentoActualizado = await campamento.save();

      // 5. Obtener el suministro recién guardado (para retornar su _id generado por Mongo)
      const suministroGuardado = campamentoActualizado.suministros[campamentoActualizado.suministros.length - 1];

      return {
        id: suministroGuardado._id,
        nombre: suministroGuardado.nombre,
        cantidad: suministroGuardado.cantidad,
        categoria: suministroGuardado.categoria
      };
    }
  },
  Campamento: {
    __resolveReference: async (reference) => {
      const doc = await CampamentoModel.findById(reference.id);
      return doc ? { id: doc._id, nombre: doc.nombre, ubicacion: doc.ubicacion, capacidad: doc.capacidad } : null;
    }
  }
};

const server = new ApolloServer({
  schema: buildSubgraphSchema([{ typeDefs, resolvers }])
});

const port = parseInt(process.env.PORT_CAMPAMENTOS) || 4001;
const { url } = await startStandaloneServer(server, {
  listen: { port }
});

console.log(`🏕️ Subgrafo de Campamentos levantado exitosamente en: ${url}`);

async function testPersistencia() {
  try {
    // 1. Escritura: Forjado de un nuevo campamento
    const nuevoCampamiento = new CampamentoModel({
      nombre: "Búnker de las Parcas",
      ubicacion: "Coordenadas Subterráneas S-3",
      capacidad: 85
    });

    // Guardado físico asíncrono
    const campamentoGuardado = await nuevoCampamiento.save();
    console.log("💾 Campamento guardado con éxito en los Tomos:", campamentoGuardado._id);

    // 2. Lectura: Verificación del documento escrito
    const campamentoPersistido = await CampamentoModel.findOne({ _id: campamentoGuardado._id });
    console.log("🔍 Campamento recuperado de MongoDB:", campamentoPersistido.nombre);

  } catch (err) {
    console.error("❌ Error de validación o persistencia:", err.message);
  }
}
testPersistencia();