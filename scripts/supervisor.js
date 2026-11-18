// Supervisor de procesos de `npm start`: si uno muere (o no puede arrancar), detiene los
// demás y sale con error para que Render reinicie el servicio. Recibe `spawn` y `exit`
// para poder probarlo con procesos simulados (scripts/supervisor.test.js).
import { spawn as nodeSpawn } from 'node:child_process';

export function supervise(plan, { spawn = nodeSpawn, exit: exitProcess = process.exit, log = console.error, forceMs = 12_000, execPath = process.execPath, env = process.env } = {}) {
  let stopping = false;
  let exited = false;
  const exit = code => { if (!exited) { exited = true; exitProcess(code); } };
  const failed = new Set(); // procesos que no pudieron arrancar (no habrá evento 'exit')
  const alive = child => child.exitCode === null && child.signalCode === null && !failed.has(child);

  function stop(code) {
    if (stopping) return;
    stopping = true;
    const pending = children.filter(alive);
    for (const child of pending) child.kill('SIGTERM');
    // Margen para que cierren; si alguno no responde, se fuerza.
    const timer = setTimeout(() => {
      for (const child of children.filter(alive)) child.kill('SIGKILL');
      exit(code);
    }, forceMs);
    timer.unref?.();
    Promise.all(pending.map(child => (alive(child) ? new Promise(resolve => child.once('exit', resolve)) : null))).then(() => {
      clearTimeout(timer);
      exit(code);
    });
  }

  const children = plan.map(({ name, cwd, args }) => {
    const child = spawn(execPath, args, { cwd, stdio: 'inherit', env });
    child.on('exit', (code, signal) => {
      if (stopping) return;
      log(`[start] "${name}" terminó (${signal ?? `código ${code}`}). Deteniendo los demás procesos.`);
      stop(1);
    });
    child.on('error', err => {
      failed.add(child);
      if (stopping) return;
      log(`[start] "${name}" no pudo arrancar (${err.message}). Deteniendo los demás procesos.`);
      stop(1);
    });
    return child;
  });

  return { stop, children };
}
