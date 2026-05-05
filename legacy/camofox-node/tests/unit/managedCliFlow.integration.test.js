import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadAgentHistory,
  persistAgentHistorySteps,
  replayAgentHistory,
} from '../../lib/agent-history-memory.js';
import { normalizeManagedCliResult } from '../../lib/managed-cli-schema.js';
import { ProfileLeaseManager, serializeProfileLeaseError } from '../../lib/profile-lease-manager.js';

async function withMemoryRoot(fn) {
  const previous = process.env.CAMOFOX_BROWSER_MEMORY_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'managed-cli-flow-'));
  process.env.CAMOFOX_BROWSER_MEMORY_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.CAMOFOX_BROWSER_MEMORY_DIR;
    else process.env.CAMOFOX_BROWSER_MEMORY_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function createManagedCliHarness() {
  let nextLease = 0;
  const manager = new ProfileLeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    idGenerator: () => `lease-${++nextLease}`,
  });

  return {
    acquire(profile, owner) {
      const lease = manager.acquire({ profile, owner });
      return normalizeManagedCliResult('profiles.lease.acquire', { ok: true, ...lease }, {
        profile,
        lease_id: lease.lease_id,
      });
    },
    async replay({ profile, lease_id, siteKey, actionKey = 'default' }) {
      const lease = manager.validate({ profile, lease_id });
      const result = await replayAgentHistory(siteKey, actionKey, {
        navigate: async (step) => ({ ok: true, url: step.url, title: step.title || '' }),
        snapshot: async (step) => ({ ok: true, url: step.url, title: step.title || '', noop: true }),
      }, { profile });
      return normalizeManagedCliResult('memory.replay', {
        ok: result.ok,
        mode: 'memory.replay',
        llm_used: result.llm_used,
        siteKey,
        actionKey,
        steps: result.replayed_steps,
      }, { profile, lease_id: lease.lease_id, mode: 'memory.replay', llm_used: result.llm_used });
    },
    release(profile, lease_id) {
      const result = manager.release({ profile, lease_id });
      return normalizeManagedCliResult('release', result, { profile, lease_id });
    },
    acquireError(profile, owner) {
      try {
        manager.acquire({ profile, owner });
        return null;
      } catch (err) {
        return { status: err.statusCode, body: serializeProfileLeaseError(err) };
      }
    },
  };
}

async function persistKnownFlow({ profile, siteKey, actionKey, marker }) {
  return persistAgentHistorySteps({
    profile,
    siteKey,
    actionKey,
    owner_cli: 'emploi-cli',
    side_effect_level: 'read_only',
    safe_to_share: false,
    steps: [
      { kind: 'navigate', url: `https://${siteKey}/${marker}`, title: marker, replayable: true },
      { kind: 'snapshot', url: `https://${siteKey}/${marker}`, title: marker, checkpoint: true, noop: true, replayable: false },
    ],
  });
}

describe('managed CLI flow integration smoke', () => {
  test('one CLI owner can lease one profile, replay known memory, and release', async () => withMemoryRoot(async () => {
    await persistKnownFlow({ profile: 'emploi-main', siteKey: 'example.test', actionKey: 'read-inbox', marker: 'profile-main' });
    const cli = createManagedCliHarness();

    const lease = cli.acquire('emploi-main', 'emploi-cli');
    expect(lease).toMatchObject({ ok: true, profile: 'emploi-main', lease_id: 'lease-1' });

    const replay = await cli.replay({ profile: 'emploi-main', lease_id: lease.lease_id, siteKey: 'example.test', actionKey: 'read-inbox' });
    expect(replay).toMatchObject({
      ok: true,
      operation: 'memory.replay',
      profile: 'emploi-main',
      lease_id: 'lease-1',
      mode: 'memory.replay',
      llm_used: false,
      steps: 2,
    });

    expect(cli.release('emploi-main', lease.lease_id)).toMatchObject({ ok: true, profile: 'emploi-main', lease_id: 'lease-1', released: true });
  }));

  test('one CLI owner can operate two profiles concurrently without cross-profile memory leakage', async () => withMemoryRoot(async () => {
    await persistKnownFlow({ profile: 'emploi-alpha', siteKey: 'example.test', actionKey: 'dashboard', marker: 'alpha-only' });
    await persistKnownFlow({ profile: 'emploi-beta', siteKey: 'example.test', actionKey: 'dashboard', marker: 'beta-only' });
    const cli = createManagedCliHarness();

    const alphaLease = cli.acquire('emploi-alpha', 'emploi-cli');
    const betaLease = cli.acquire('emploi-beta', 'emploi-cli');
    expect(alphaLease.lease_id).not.toBe(betaLease.lease_id);

    const [alphaReplay, betaReplay] = await Promise.all([
      cli.replay({ profile: 'emploi-alpha', lease_id: alphaLease.lease_id, siteKey: 'example.test', actionKey: 'dashboard' }),
      cli.replay({ profile: 'emploi-beta', lease_id: betaLease.lease_id, siteKey: 'example.test', actionKey: 'dashboard' }),
    ]);
    expect(alphaReplay).toMatchObject({ ok: true, profile: 'emploi-alpha', lease_id: alphaLease.lease_id, llm_used: false });
    expect(betaReplay).toMatchObject({ ok: true, profile: 'emploi-beta', lease_id: betaLease.lease_id, llm_used: false });

    const alphaMemory = await loadAgentHistory('example.test', 'dashboard', { profile: 'emploi-alpha' });
    const betaMemory = await loadAgentHistory('example.test', 'dashboard', { profile: 'emploi-beta' });
    expect(alphaMemory.payload.hermes_meta.profile).toBe('emploi_alpha');
    expect(betaMemory.payload.hermes_meta.profile).toBe('emploi_beta');
    expect(alphaMemory.payload.hermes_meta.derived_flow.steps[0].url).toContain('/alpha-only');
    expect(betaMemory.payload.hermes_meta.derived_flow.steps[0].url).toContain('/beta-only');
  }));

  test('two owners contending for the same profile receive structured profile_locked behavior', () => {
    const cli = createManagedCliHarness();
    const first = cli.acquire('shared-profile', 'emploi-cli');
    const contention = cli.acquireError('shared-profile', 'resell-cli');

    expect(first).toMatchObject({ ok: true, profile: 'shared-profile', lease_id: 'lease-1' });
    expect(contention).toEqual({
      status: 423,
      body: expect.objectContaining({
        code: 'profile_locked',
        profile: 'shared-profile',
        lease_id: 'lease-1',
        owner: 'emploi-cli',
        reason: 'locked',
      }),
    });
  });

  test('known memory replay completes without LLM fallback and reports llm_used false', async () => withMemoryRoot(async () => {
    await persistKnownFlow({ profile: 'known-memory', siteKey: 'known.example', actionKey: 'known-flow', marker: 'known' });
    const cli = createManagedCliHarness();
    const lease = cli.acquire('known-memory', 'emploi-cli');

    const replay = await cli.replay({ profile: 'known-memory', lease_id: lease.lease_id, siteKey: 'known.example', actionKey: 'known-flow' });

    expect(replay.ok).toBe(true);
    expect(replay.operation).toBe('memory.replay');
    expect(replay.mode).toBe('memory.replay');
    expect(replay.llm_used).toBe(false);
  }));
});
