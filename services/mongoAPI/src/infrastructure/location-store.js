// ============================================================
// ÚLTIMA UBICACIÓN DEL REPARTIDOR EN REDIS (ver domain/driver-location.js)
//
//   driver:loc:<orderId>   STRING (JSON { lat, lng, at, seq })   TTL DRIVER_LOCATION_TTL_SECONDS (600)
//
// Un solo punto por orden: cada escritura reemplaza al anterior, no hay
// historial. El TTL se renueva con cada punto guardado, así que si el
// repartidor deja de reportar la posición caduca sola (y `driverLocation` pasa
// a null); además se borra al entregar o cancelar la orden (clear).
//
// Un solo reloj: la hora de cada punto (`at`, `seq`) la da Redis (`now()`, el
// comando TIME), no Node. Un reloj de la API adelantado, o dos réplicas que no
// coinciden, no puede dejar guardado un `seq` del futuro que congele las
// escrituras ni hacer que un punto viejo parezca reciente. El script de
// escritura y el de lectura también leen TIME dentro de Redis (TIME en un script
// exige Redis 5 o más; el Compose usa redis-stack).
//
// Atomicidad: guardar es un script Lua. Redis lo ejecuta completo sin
// intercalar otro comando, así que comparar con el punto guardado y escribir
// no se pueden separar. El script guarda el punto solo si su `seq` (cuándo lo
// recibió el servidor, tomado al empezar la petición, antes de esperar a MongoDB)
// es al menos MIN_REPORT_INTERVAL_MS mayor que el del guardado. Eso resuelve dos
// casos con una sola regla:
//   · un reporte que llegó tarde (seq menor: su petición esperó en la red o en
//     MongoDB mientras otro más nuevo ya se guardó) nunca pisa a uno más nuevo;
//   · dos reportes con menos de un segundo de diferencia no se guardan los dos:
//     el segundo se ignora (límite de 1 por segundo por orden, sin error).
// Excepción: un punto guardado con hora posterior a la de Redis ahora mismo no es
// confiable (el reloj de Redis retrocedió, o se escribió a mano) y se reemplaza,
// en lugar de congelar la clave hasta que venza su TTL.
// Sin el script, un GET seguido de un SET dejaría que dos peticiones en vuelo
// leyeran el mismo punto viejo y la más lenta ganara; SET a secas no compara.
// El script solo toca la clave que recibe: sirve también en Redis Cluster.
//
// Redis caído (no listo, o falla a mitad): SERVICE_UNAVAILABLE con
// `service: LOCATION`. Ojo: con Redis caído por completo el contexto de
// autenticación ya no puede verificar la sesión y la petición llega como
// UNAUTHENTICATED antes de llegar aquí (ver auth.js); LOCATION aparece cuando
// Redis falla a mitad de la operación. Borrar al terminar la entrega nunca
// lanza: si falla, se registra y el TTL limpia (la lectura además exige que la
// orden siga IN_DELIVERY).
// ============================================================

import { DomainError } from '../domain/errors.js';
import { locationKey, parseLocationRecord, MIN_REPORT_INTERVAL_MS } from '../domain/driver-location.js';

// ARGV: 1 punto (JSON), 2 seq del punto (ms, reloj de Redis), 3 TTL en segundos, 4 intervalo mínimo en ms.
// Devuelve 1 si lo guardó, 0 si lo ignoró. Mismo criterio que shouldReplaceLocation (dominio).
// Un valor guardado ilegible, o con hora posterior a la de Redis, se sobrescribe.
export const WRITE_LOCATION_SCRIPT = `
local stored = redis.call('GET', KEYS[1])
if stored then
  local ok, last = pcall(cjson.decode, stored)
  if ok and type(last) == 'table' and type(last.seq) == 'number' then
    local t = redis.call('TIME')
    local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
    if last.seq <= now and tonumber(ARGV[2]) < last.seq + tonumber(ARGV[4]) then
      return 0
    end
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;

// El valor guardado (o '') y la hora de Redis en el mismo paso: { valor, segundos, microsegundos }.
export const READ_LOCATION_SCRIPT = `
local stored = redis.call('GET', KEYS[1])
local t = redis.call('TIME')
return { stored or '', t[1], t[2] }
`;

const toMs = (seconds, microseconds) => Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);

export const locationUnavailable = () => new DomainError(
  'La ubicación del repartidor no está disponible en este momento. Intenta de nuevo.',
  'SERVICE_UNAVAILABLE',
  { service: 'LOCATION' },
);

// `redis` es el cliente de node-redis ya creado (en pruebas, uno propio).
export function createLocationStore(redis, { ttlSeconds }) {
  // Redis no listo o fallando a mitad de la operación llega como SERVICE_UNAVAILABLE (LOCATION).
  async function guard(fn) {
    if (!redis.isReady) throw locationUnavailable();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DomainError) throw err;
      console.warn('⚠️  Redis falló a mitad de una operación de ubicación:', err?.message ?? err);
      throw locationUnavailable();
    }
  }

  return {
    ttlSeconds,

    // La hora de Redis ahora, en ms desde epoch. Es el `nowMs` de newLocationRecord: se toma
    // al recibir el reporte, antes de esperar a MongoDB, para que `seq` refleje el orden de llegada.
    now: () => guard(async () => {
      const [seconds, microseconds] = await redis.sendCommand(['TIME']);
      return toMs(seconds, microseconds);
    }),

    // `record` viene de newLocationRecord. true si quedó guardado; false si se ignoró
    // (llegó más de una vez por segundo o después de uno más nuevo).
    save: (orderId, record) => guard(async () => {
      const saved = await redis.eval(WRITE_LOCATION_SCRIPT, {
        keys: [locationKey(orderId)],
        arguments: [JSON.stringify(record), String(record.seq), String(ttlSeconds), String(MIN_REPORT_INTERVAL_MS)],
      });
      return Number(saved) === 1;
    }),

    // { record, nowMs }: el punto guardado (null si no hay: nunca se reportó o venció el TTL, o el
    // valor es ilegible) y la hora de Redis al leerlo, con la que se calcula su edad.
    get: orderId => guard(async () => {
      const [stored, seconds, microseconds] = await redis.eval(READ_LOCATION_SCRIPT, { keys: [locationKey(orderId)] });
      return { record: parseLocationRecord(stored), nowMs: toMs(seconds, microseconds) };
    }),

    // Borra el punto. Nunca lanza ni rechaza: devuelve false si no pudo (el TTL lo limpiará).
    // El que lo llama no necesita esperarla.
    async clear(orderId) {
      try {
        if (!redis.isReady) throw locationUnavailable();
        await redis.del(locationKey(orderId));
        return true;
      } catch (err) {
        console.warn(`⚠️  No se pudo borrar la ubicación de la orden ${orderId} (caducará por su TTL):`, err?.message ?? err);
        return false;
      }
    },
  };
}
