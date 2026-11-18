// `npm start` / `node scripts/start.js`: levanta mongoAPI, auditAPI (salvo AUDIT_ENABLED=false)
// y el gateway en el mismo contenedor, sin --watch. La lógica está en supervisor.js.
import { startPlan } from './start-plan.js';
import { supervise } from './supervisor.js';

const { stop } = supervise(startPlan());
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stop(0));
