// Procesos que levanta `npm start` (scripts/start-plan.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startPlan } from './start-plan.js';

const root = join('/app');

test('por defecto levanta mongoAPI, auditAPI y el gateway (en ese orden) sin --watch', () => {
  const plan = startPlan({}, root);
  assert.deepEqual(plan.map(p => p.name), ['api', 'audit', 'gateway']);
  assert.deepEqual(plan.map(p => p.cwd), [join(root, 'services', 'mongoAPI'), join(root, 'services', 'auditAPI'), join(root, 'gateway')]);
  assert.deepEqual(plan.map(p => p.args), [['src/index.js'], ['src/index.js'], ['index.js']]);
});

test('AUDIT_ENABLED=false no arranca auditAPI', () => {
  assert.deepEqual(startPlan({ AUDIT_ENABLED: 'false' }, root).map(p => p.name), ['api', 'gateway']);
});
