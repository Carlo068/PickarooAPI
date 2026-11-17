// ============================================================
// UBICACIÓN DEL REPARTIDOR — reglas puras (sin Redis ni MongoDB)
//
// Mientras una orden DELIVERY está IN_DELIVERY, su repartidor asignado reporta
// su posición (la app Android, cada 3 s). Solo se guarda el ÚLTIMO punto de cada
// orden, en Redis (infrastructure/location-store.js):
//
//   driver:loc:<orderId>   STRING (JSON { lat, lng, at, seq })   TTL DRIVER_LOCATION_TTL_SECONDS
//
//   at    ISO: cuándo recibió el reporte el servidor (no el teléfono)
//   seq   milisegundos desde epoch de esa recepción. Ordena las llegadas: un
//         reporte que se retrasó (red, MongoDB) no pisa a uno más nuevo, y dos
//         reportes con menos de MIN_REPORT_INTERVAL_MS de diferencia no se
//         guardan los dos (límite de 1 por segundo por orden).
//
// Un solo reloj: `at` y `seq` salen del reloj de Redis (comando TIME), no del de
// Node, así que un reloj de la API adelantado o atrasado (o dos réplicas que no
// coinciden) no congela las escrituras ni rejuvenece un punto viejo. Estas
// funciones reciben esa hora (`nowMs`); no leen ningún reloj.
//
// No se guarda quién reportó: el repartidor es el de la orden (order.driverId).
// Lo que sale por GraphQL (DriverLocation) es solo { lat, lng, updatedAt, ageSeconds }.
// ============================================================

import { DomainError } from './errors.js';

export const LOCATION_KEY_PREFIX = 'driver:loc:';
export const locationKey = orderId => `${LOCATION_KEY_PREFIX}${orderId}`;

export const DEFAULT_LOCATION_TTL_SECONDS = 600; // 10 min
export const MAX_LOCATION_TTL_SECONDS = 86_400; // 1 día: más no tiene sentido para un punto de GPS

// DRIVER_LOCATION_TTL_SECONDS: entero entre 1 y 86400. Un valor ausente, no numérico, no entero
// o fuera de rango usa el de 600 (no se recorta): un valor enorme como 1e23 acabaría escrito como
// "1e+23" y Redis rechazaría cada SET ... EX.
export function locationTtlSeconds(value) {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_LOCATION_TTL_SECONDS
    ? seconds
    : DEFAULT_LOCATION_TTL_SECONDS;
}

// Como máximo un punto por segundo por orden; el resto se ignora sin error.
export const MIN_REPORT_INTERVAL_MS = 1000;

// Un punto con hora posterior a la de Redis por más de esto no es confiable (el reloj de Redis
// retrocedió, o alguien lo escribió a mano): no se sirve. Dentro de la tolerancia se trata como reciente.
export const FUTURE_TOLERANCE_MS = 5000;

// ---------- Coordenadas ----------
const isFiniteNumber = v => typeof v === 'number' && Number.isFinite(v);

// null si las coordenadas sirven; si no, el campo que falla: 'lat', 'lng' o 'location'
// (el par). Rechaza NaN e Infinity, lat fuera de [-90, 90], lng fuera de [-180, 180]
// y (0, 0): el valor que muchos teléfonos mandan cuando todavía no tienen posición.
export function invalidLocationField(lat, lng) {
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) return 'lat';
  if (!isFiniteNumber(lng) || lng < -180 || lng > 180) return 'lng';
  if (lat === 0 && lng === 0) return 'location';
  return null;
}

export function assertValidLocation(lat, lng) {
  const field = invalidLocationField(lat, lng);
  if (field) throw new DomainError(`Coordenadas inválidas (${field}).`, 'INVALID_LOCATION', { field });
  return true;
}

// ---------- Estado de la orden ----------
// Solo una orden DELIVERY que va en camino tiene ubicación: se reporta y se lee solo entonces.
export const isTrackable = order => order?.mode === 'DELIVERY' && order?.status === 'IN_DELIVERY';

export function assertTrackable(order) {
  if (!isTrackable(order)) {
    throw new DomainError('La orden no está en reparto: solo una orden DELIVERY en IN_DELIVERY reporta ubicación.', 'INVALID_ORDER_STATE', {
      status: order?.status ?? null,
      mode: order?.mode ?? null,
    });
  }
  return true;
}

// ---------- Punto guardado ----------
// `nowMs` es la hora de Redis (ms desde epoch) en que el servidor recibió el reporte.
export function newLocationRecord({ lat, lng, nowMs }) {
  return { lat, lng, at: new Date(nowMs).toISOString(), seq: nowMs };
}

// El punto guardado, o null si el valor falta o no tiene la forma esperada.
export function parseLocationRecord(raw) {
  if (typeof raw !== 'string') return null;
  let record;
  try { record = JSON.parse(raw); } catch { return null; }
  if (!record || typeof record !== 'object') return null;
  const { lat, lng, at, seq } = record;
  const valid = isFiniteNumber(lat) && isFiniteNumber(lng) && isFiniteNumber(seq)
    && typeof at === 'string' && !Number.isNaN(Date.parse(at));
  return valid ? { lat, lng, at, seq } : null;
}

// ¿El reporte nuevo (`seq`) reemplaza al guardado (`storedSeq`)? Debe llegar al menos
// MIN_REPORT_INTERVAL_MS después: así se descarta tanto el que llega tarde (seq menor) como el
// que llega antes de un segundo. Un punto guardado con hora posterior a la de Redis (`nowMs`) no
// frena nada: se reemplaza, para que un reloj que retrocedió no congele las escrituras hasta el TTL.
// Es la regla que aplica el script Lua de location-store.js.
export function shouldReplaceLocation(storedSeq, seq, nowMs, minIntervalMs = MIN_REPORT_INTERVAL_MS) {
  if (!isFiniteNumber(storedSeq)) return true;
  if (storedSeq > nowMs) return true;
  return seq >= storedSeq + minIntervalMs;
}

// Lo único que ve un cliente del punto: coordenadas y tiempos. `nowMs` es la hora de Redis al leer.
// null si el punto tiene hora más allá de la tolerancia en el futuro (no es confiable); si está
// dentro de la tolerancia se trata como recién llegado (ageSeconds 0).
export function locationView(record, nowMs) {
  const atMs = Date.parse(record.at);
  if (atMs - nowMs > FUTURE_TOLERANCE_MS) return null;
  return {
    lat: record.lat,
    lng: record.lng,
    updatedAt: record.at,
    ageSeconds: Math.max(0, Math.floor((nowMs - atMs) / 1000)),
  };
}
