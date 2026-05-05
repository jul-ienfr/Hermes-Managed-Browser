import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { createManagedBrowserJobQueue } from '../../lib/managed-browser-job-queue.js';

function tempQueuePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-browser-job-queue-')), 'jobs.jsonl');
}

describe('managed browser job queue', () => {
  test('enqueue appends a pending job with timestamps and managed-browser metadata', async () => {
    const queuePath = tempQueuePath();
    const queue = createManagedBrowserJobQueue({ path: queuePath, now: () => 1700000000000 });

    const job = await queue.enqueue({
      operation: 'checkout',
      profile: 'leboncoin-cim',
      site: 'leboncoin.fr',
      payload: { itemId: 'abc123', price: 42 },
      llm_used: true,
    });

    expect(job).toMatchObject({
      id: expect.any(String),
      created_at: '2023-11-14T22:13:20.000Z',
      updated_at: '2023-11-14T22:13:20.000Z',
      operation: 'checkout',
      profile: 'leboncoin-cim',
      site: 'leboncoin.fr',
      payload: { itemId: 'abc123', price: 42 },
      status: 'pending',
      result: null,
      error: null,
      llm_used: true,
    });

    await expect(queue.list()).resolves.toEqual([job]);
    expect(fs.readFileSync(queuePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('status transitions append immutable updates and list returns latest state', async () => {
    let tick = 1700000000000;
    const queue = createManagedBrowserJobQueue({ path: tempQueuePath(), now: () => tick });

    const enqueued = await queue.enqueue({ operation: 'login', profile: 'profile-a', site: 'example.com', payload: {} });

    tick += 1000;
    const running = await queue.markRunning(enqueued.id, { llm_used: true });
    expect(running).toMatchObject({
      id: enqueued.id,
      status: 'running',
      updated_at: '2023-11-14T22:13:21.000Z',
      llm_used: true,
    });

    tick += 1000;
    const succeeded = await queue.markSucceeded(enqueued.id, { ok: true, tabId: 'tab-1' });
    expect(succeeded).toMatchObject({
      id: enqueued.id,
      status: 'succeeded',
      updated_at: '2023-11-14T22:13:22.000Z',
      result: { ok: true, tabId: 'tab-1' },
      error: null,
      llm_used: true,
    });

    await expect(queue.list()).resolves.toEqual([succeeded]);
  });

  test('failed transition records normalized error details', async () => {
    const queue = createManagedBrowserJobQueue({ path: tempQueuePath(), now: () => 1700000000000 });
    const enqueued = await queue.enqueue({ operation: 'purchase', profile: 'profile-a', site: 'example.com', payload: { sku: '1' } });

    const failed = await queue.markFailed(enqueued.id, new Error('payment challenge'));

    expect(failed).toMatchObject({
      id: enqueued.id,
      status: 'failed',
      result: null,
      error: { message: 'payment challenge', name: 'Error' },
    });
    await expect(queue.list()).resolves.toEqual([failed]);
  });

  test('list tolerates missing files and preserves invalid JSONL lines with warnings', async () => {
    const queuePath = tempQueuePath();
    const missingQueue = createManagedBrowserJobQueue({ path: queuePath, now: () => 1700000000000 });
    await expect(missingQueue.list()).resolves.toEqual([]);

    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, '{not json}\n{"id":"manual","operation":"snapshot","profile":"p","site":"s","payload":{},"status":"pending","created_at":"2023-01-01T00:00:00.000Z","updated_at":"2023-01-01T00:00:00.000Z","result":null,"error":null,"llm_used":false}\n', 'utf8');

    const queue = createManagedBrowserJobQueue({ path: queuePath, now: () => 1700000000000 });
    await expect(queue.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'manual',
        operation: 'snapshot',
        status: 'pending',
        warnings: [expect.stringContaining('Ignored invalid JSONL line 1')],
      }),
    ]);
    expect(fs.readFileSync(queuePath, 'utf8')).toContain('{not json}\n');
  });
});
