// Procesos que levanta `npm start` (producción, un solo contenedor). Función pura:
// la usa scripts/start.js y se prueba en scripts/start-plan.test.js.
import { join } from 'node:path';
import { auditEnabled } from '../gateway/config.js';

export function startPlan(env = process.env, root = join(import.meta.dirname, '..')) {
  const plan = [
    { name: 'api', cwd: join(root, 'services', 'mongoAPI'), args: ['src/index.js'] },
  ];
  if (auditEnabled(env)) plan.push({ name: 'audit', cwd: join(root, 'services', 'auditAPI'), args: ['src/index.js'] });
  plan.push({ name: 'gateway', cwd: join(root, 'gateway'), args: ['index.js'] });
  return plan;
}
