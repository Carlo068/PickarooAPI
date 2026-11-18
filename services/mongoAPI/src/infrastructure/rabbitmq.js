// ============================================================
// RABBITMQ: productor de la telemetría de seguridad (cola "eventos-seguridad")
//
// Conexión y publicación, nada más: el contenido de los eventos lo arma events.js.
// Fail-safe: publicar nunca lanza, nunca espera y nunca retrasa la petición que
// lo originó. Con el broker caído el evento se descarta con UN aviso por caída
// (no uno por evento) y la conexión se reintenta sola con espera exponencial
// (1 s, 2 s, 4 s… hasta 30 s; vuelve a 1 s al reconectar).
// Si el canal se llena (sendToQueue devuelve false) o el broker bloquea la conexión, los eventos se
// omiten, también con un solo aviso, hasta que haya espacio ('drain' / 'unblocked').
// Los mensajes son durables (cola durable + `persistent`).
// ============================================================

import amqp from 'amqplib';

// Mismo valor por omisión en el consumidor (auditAPI/src/queue.js); RABBITMQ_QUEUE lo cambia en los dos.
export const DEFAULT_QUEUE = 'eventos-seguridad';
export const queueName = (env = process.env) => env.RABBITMQ_QUEUE || DEFAULT_QUEUE;
export const EVENTS_QUEUE = queueName();

export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30000;
// Un connect que no responde (host inalcanzable) no debe retener el arranque de la API.
export const CONNECT_TIMEOUT_MS = 5000;

// Espera antes del reintento número `attempt` (0 = el primero): 1 s, 2 s, 4 s… con tope.
export const backoffDelay = (attempt, min = MIN_BACKOFF_MS, max = MAX_BACKOFF_MS) => Math.min(max, min * 2 ** Math.max(0, attempt));

const unrefTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.(); // un reintento pendiente no mantiene vivo el proceso
  return handle;
};

const reasonOf = err => err?.message || err?.code || 'sin detalle';
const noop = () => {};
// Mientras la API sigue sin conexión, el motivo del último fallo se vuelve a registrar como mucho cada minuto.
export const RETRY_LOG_INTERVAL_MS = 60000;

// Todo lo externo es inyectable para probarlo sin broker: `connect`, temporizadores, reloj y consola.
export function createPublisher({
  url = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
  queue = EVENTS_QUEUE,
  connect = amqp.connect,
  setTimer = unrefTimer,
  clearTimer = clearTimeout,
  now = Date.now,
  minDelayMs = MIN_BACKOFF_MS,
  maxDelayMs = MAX_BACKOFF_MS,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  log = console.log,
  warn = console.warn,
} = {}) {
  let conn = null;
  let channel = null;
  let attempts = 0;      // fallos seguidos desde la última conexión buena
  let retryTimer = null;
  let connecting = false;
  let stopped = false;
  let outageWarned = false;   // ya se avisó de esta caída
  let lastReasonLogAt = 0;    // última vez que se registró el motivo de un fallo
  let paused = false;         // sendToQueue devolvió false: no se publica hasta 'drain'
  let backpressureWarned = false;
  let blocked = false;        // el broker bloqueó la conexión (alarma de memoria o disco)
  let blockedWarned = false;

  // UN aviso por caída: el siguiente solo después de volver a conectar.
  function warnOutage(reason) {
    if (outageWarned) return;
    outageWarned = true;
    lastReasonLogAt = now();
    warn(`⚠️  RabbitMQ no disponible (${reason}). Los eventos de seguridad se omiten hasta reconectar; la API sigue funcionando.`);
  }

  // Un reintento fallido: el motivo se repite, como mucho, una vez por minuto.
  function noteRetryFailure(reason) {
    if (!outageWarned) return warnOutage(reason);
    if (now() - lastReasonLogAt < RETRY_LOG_INTERVAL_MS) return;
    lastReasonLogAt = now();
    warn(`⚠️  RabbitMQ sigue sin responder (${reason}). Se reintenta cada ${maxDelayMs / 1000} s como máximo.`);
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const delay = backoffDelay(attempts, minDelayMs, maxDelayMs);
    attempts += 1;
    retryTimer = setTimer(() => { retryTimer = null; void attempt(); }, delay);
  }

  function resetFlow() {
    paused = false; backpressureWarned = false; blocked = false; blockedWarned = false;
  }

  // La conexión o el canal dejaron de servir: se descarta y se reintenta.
  function markDown(reason, closing) {
    const dead = conn;
    conn = null;
    channel = null;
    resetFlow();
    if (closing && dead) Promise.resolve().then(() => dead.close()).catch(noop);
    if (stopped) return;
    warnOutage(reason);
    scheduleReconnect();
  }

  // Abre conexión y canal. true = lista y en uso; false = no sirvió (se cerró mientras se preparaba o venció el plazo).
  // `ctl.abandoned`: el intento venció por tiempo. `session.closed` lo ponen los 'close' de la conexión y del
  // canal: una conexión cerrada durante assertQueue nunca se da por conectada.
  async function open(ctl) {
    const c = await connect(url);
    c.on('error', noop); // antes de cualquier otra cosa (incluido close): un 'error' sin oyente tumbaría el proceso
    if (ctl.abandoned) { Promise.resolve().then(() => c.close()).catch(noop); return false; }
    const session = { closed: false };
    c.on('error', err => { if (conn === c) warnOutage(reasonOf(err)); });
    c.on('close', () => { session.closed = true; if (conn === c) markDown('conexión cerrada'); });
    c.on('blocked', reason => {
      if (conn !== c) return;
      blocked = true;
      if (!blockedWarned) { blockedWarned = true; warn(`⚠️  RabbitMQ bloqueó la conexión (${reason || 'alarma del broker'}): los eventos se omiten hasta que la libere.`); }
    });
    c.on('unblocked', () => { if (conn === c) { blocked = false; blockedWarned = false; } });
    try {
      const ch = await c.createChannel();
      ch.on('error', noop); // el 'close' que sigue se encarga
      ch.on('close', () => { session.closed = true; if (conn === c) markDown('canal cerrado', true); });
      ch.on('drain', () => { if (channel === ch) { paused = false; backpressureWarned = false; } });
      await ch.assertQueue(queue, { durable: true });
      if (ctl.abandoned || session.closed) { Promise.resolve().then(() => c.close()).catch(noop); return false; }
      conn = c;
      channel = ch;
      resetFlow();
      return true;
    } catch (err) {
      Promise.resolve().then(() => c.close()).catch(noop);
      throw err;
    }
  }

  async function attempt() {
    if (stopped || connecting || channel) return;
    connecting = true;
    const ctl = { abandoned: false };
    let timer;
    try {
      const ok = await Promise.race([
        open(ctl),
        new Promise((_, reject) => { timer = setTimer(() => { ctl.abandoned = true; reject(new Error('tiempo de espera agotado')); }, connectTimeoutMs); }),
      ]);
      clearTimer(timer);
      if (stopped) { await stop(); return; }
      if (!ok) {
        noteRetryFailure('la conexión se cerró al prepararla');
        scheduleReconnect();
        return;
      }
      const recovered = attempts > 0 || outageWarned;
      attempts = 0;
      outageWarned = false;
      log(`${recovered ? '🔁 RabbitMQ reconectado' : '✅ RabbitMQ conectado'}. Cola "${queue}" lista.`);
    } catch (err) {
      clearTimer(timer);
      noteRetryFailure(reasonOf(err));
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  // Primer intento; nunca lanza. Devuelve cuando el intento terminó (con o sin éxito).
  const start = () => { stopped = false; return attempt(); };

  async function stop() {
    stopped = true;
    if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
    const c = conn;
    conn = null;
    channel = null;
    if (c) await c.close().catch(noop);
  }

  // `message` es un objeto JSON-able. Fire-and-forget: sin broker, no hace nada salvo el aviso único.
  // Devuelve true solo si el mensaje quedó aceptado por el canal sin presión de escritura.
  function publish(message) {
    if (!channel) { warnOutage('sin conexión'); return false; }
    if (blocked) return false; // ya se avisó al bloquearse
    if (paused) {
      if (!backpressureWarned) { backpressureWarned = true; warn('⚠️  RabbitMQ no da abasto (buffer lleno): los eventos se omiten hasta que se vacíe.'); }
      return false;
    }
    try {
      const accepted = channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: 'application/json' });
      if (accepted === false) { // el buffer del canal se llenó: se deja de publicar hasta 'drain'
        paused = true;
        backpressureWarned = true;
        warn('⚠️  RabbitMQ no da abasto (buffer lleno): los eventos se omiten hasta que se vacíe.');
        return false;
      }
      return true;
    } catch (err) {
      markDown(reasonOf(err), true);
      return false;
    }
  }

  return { start, stop, publish, isConnected: () => Boolean(channel), queue };
}

// Productor de la API (uno por proceso).
const publisher = createPublisher();
export const startPublisher = () => publisher.start();
export const publish = message => publisher.publish(message);
export const isConnected = () => publisher.isConnected();
