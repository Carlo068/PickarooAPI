// Nombre de la cola de eventos y tamaño de prefetch del consumidor.
// El productor (mongoAPI/src/infrastructure/rabbitmq.js) usa el mismo valor por omisión:
// RABBITMQ_QUEUE lo cambia en los dos servicios a la vez (scripts/queue-name.test.js lo comprueba).

export const DEFAULT_QUEUE = 'eventos-seguridad';
export const queueName = (env = process.env) => env.RABBITMQ_QUEUE || DEFAULT_QUEUE;

// Mensajes sin confirmar que RabbitMQ entrega a la vez a este consumidor.
export const DEFAULT_PREFETCH = 50;
// Solo enteros decimales positivos (1 a 65535); cualquier otra cosa ("0x10", "1e2", " 5", "2.5", "-3") usa 50 y avisa una vez.
export function prefetchCount(env = process.env, warn = console.warn) {
  const raw = env.RABBITMQ_PREFETCH;
  if (raw === undefined || raw === '') return DEFAULT_PREFETCH;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  warn(`⚠️  RABBITMQ_PREFETCH inválido ("${String(raw).slice(0, 20)}"): se usa ${DEFAULT_PREFETCH}. Debe ser un entero de 1 a 65535.`);
  return DEFAULT_PREFETCH;
}
