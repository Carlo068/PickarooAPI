// La cola de eventos: productor (mongoAPI) y worker (auditAPI) deben usar el mismo nombre por omisión
// y el mismo RABBITMQ_QUEUE; si no, los eventos se publicarían en una cola que nadie consume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_QUEUE as producerDefault, queueName as producerQueue } from '../services/mongoAPI/src/infrastructure/rabbitmq.js';
import { DEFAULT_QUEUE as workerDefault, queueName as workerQueue } from '../services/auditAPI/src/queue.js';

test('el nombre por omisión es eventos-seguridad en productor y worker', () => {
  assert.equal(producerDefault, 'eventos-seguridad');
  assert.equal(workerDefault, 'eventos-seguridad');
  assert.equal(producerQueue({}), workerQueue({}));
});

test('RABBITMQ_QUEUE cambia la cola en los dos', () => {
  const env = { RABBITMQ_QUEUE: 'otra-cola' };
  assert.equal(producerQueue(env), 'otra-cola');
  assert.equal(workerQueue(env), 'otra-cola');
  assert.equal(producerQueue({ RABBITMQ_QUEUE: '' }), 'eventos-seguridad');
});

test('los .env.example y el código no conservan la cola anterior como valor', () => {
  for (const file of ['../services/mongoAPI/.env.example', '../services/auditAPI/.env.example']) {
    const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(text, /^RABBITMQ_QUEUE=eventos-seguridad$/m, file);
  }
});
