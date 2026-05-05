import {
  listSharedManagedFlows,
  sharedManagedFlowAvailability,
  seedSharedManagedFlows,
} from '../../lib/shared-managed-flows.js';
import { loadAgentHistory } from '../../lib/agent-history-memory.js';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');

async function withMemoryRoot(fn) {
  const previous = process.env.CAMOFOX_BROWSER_MEMORY_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shared-managed-flows-'));
  process.env.CAMOFOX_BROWSER_MEMORY_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CAMOFOX_BROWSER_MEMORY_DIR;
    else process.env.CAMOFOX_BROWSER_MEMORY_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('shared managed flows', () => {
  test('server seeds shared flows before running the resell-compatible flow endpoint', () => {
    expect(serverSource).toContain('seedSharedManagedFlows');
    expect(serverSource).toContain('sharedManagedFlowAvailability');
    const start = serverSource.indexOf('async function managedApiRunFlow');
    const end = serverSource.indexOf("app.post('/profile/status'", start);
    const section = serverSource.slice(start, end);
    expect(section).toContain('seedSharedManagedFlows');
    expect(section).toContain('flow_availability');
  });

  test('declares the six Leboncoin shared flows needed for no-LLM replay', () => {
    expect(listSharedManagedFlows('leboncoin').map((flow) => flow.actionKey).sort()).toEqual([
      'checkpoint_storage',
      'open_conversation',
      'open_messaging',
      'prepare_reply',
      'read_last_message',
      'send_prepared_reply',
    ]);
  });

  test('seeds safe shared Leboncoin flows with side-effect metadata and message parameter', async () => withMemoryRoot(async () => {
    const seeded = await seedSharedManagedFlows({ siteKey: 'leboncoin' });

    expect(seeded).toMatchObject({ ok: true, siteKey: 'leboncoin', seeded: 6, total: 6 });
    await expect(sharedManagedFlowAvailability({ siteKey: 'leboncoin' })).resolves.toMatchObject({
      ok: true,
      siteKey: 'leboncoin',
      flows_available: 6,
      flows_total: 6,
      missing: [],
    });

    const reply = await loadAgentHistory('leboncoin', 'prepare_reply', { profile: 'leboncoin-cim' });
    expect(reply.payload.hermes_meta.safe_to_share).toBe(true);
    expect(reply.payload.hermes_meta.side_effect_level).toBe('message_send');
    expect(reply.payload.hermes_meta.parameters).toEqual(['message']);
    expect(reply.payload.hermes_meta.derived_flow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'type', text: '{{message}}', text_parameterized: true, parameter_name: 'message' }),
    ]));

    const send = await loadAgentHistory('leboncoin', 'send_prepared_reply', { profile: 'leboncoin-ge' });
    expect(send.payload.hermes_meta.side_effect_level).toBe('message_send');
    expect(send.payload.hermes_meta.derived_flow.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'click', requires_confirmation: true }),
    ]));
  }));
});
