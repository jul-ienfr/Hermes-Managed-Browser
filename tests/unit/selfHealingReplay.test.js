import { describe, expect, test } from '@jest/globals';
import { replayStepSelfHealing, replayStepsSelfHealing } from '../../lib/self-healing-replay.js';
import { createMemoryReplayHandlers } from '../../lib/memory-replay-handlers.js';
import { explicitAllowLlmRepair, unavailablePlannerFallback } from '../../lib/managed-llm-repair.js';

describe('self-healing replay', () => {
  test('uses exact handler first', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1' },
      {
        handlers: {
          click: async (step) => {
            calls.push(step.ref);
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'exact' });
    expect(calls).toEqual(['e1']);
  });

  test('repairs stale refs locally and retries once', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1', target_summary: { role: 'button', name: 'continuer' } },
      {
        handlers: {
          click: async (step) => {
            calls.push(step.ref);
            if (step.ref === 'e1') return { ok: false, error: 'stale ref' };
            return { ok: true };
          },
        },
        refreshRefs: async () => {},
        getCandidates: () => [{ ref: 'e9', role: 'button', name: 'continuer' }],
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'repaired' });
    expect(calls).toEqual(['e1', 'e9']);
  });

  test('returns repaired_step with improved ref after successful repair', async () => {
    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'old', target_summary: { role: 'button', name: 'continuer' } },
      {
        handlers: {
          click: async (step) => {
            if (step.ref === 'old') return { ok: false, error: 'stale ref' };
            return { ok: true };
          },
        },
        getCandidates: () => [{ ref: 'new', role: 'button', name: 'continuer' }],
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      mode: 'repaired',
      repaired_step: { kind: 'click', ref: 'new', target_summary: { role: 'button', name: 'continuer' } },
    });
  });

  test('stops safely when human verification is detected', async () => {
    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1' },
      {
        detectInterrupt: async () => ({ type: 'human_verification', requires_human: true }),
        handlers: {
          click: async () => ({ ok: true }),
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({
      ok: false,
      mode: 'blocked',
      requires_human: true,
      interrupt: { type: 'human_verification', requires_human: true },
    });
  });

  test('resolves non-human interruptions before running the action', async () => {
    const events = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1' },
      {
        detectInterrupt: async () => ({ type: 'cookie_banner', requires_human: false }),
        resolveInterrupt: async (interrupt) => {
          events.push(`resolved:${interrupt.type}`);
          return { ok: true };
        },
        handlers: {
          click: async () => {
            events.push('clicked');
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'exact' });
    expect(events).toEqual(['resolved:cookie_banner', 'clicked']);
  });

  test('applies adaptive pacing before resolving non-human interruptions', async () => {
    const events = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1' },
      {
        detectInterrupt: async () => ({ type: 'rate_limited', requires_human: false }),
        adaptivePacing: () => ({ action: 'backoff', delayMs: 2500, reason: 'rate_limited' }),
        waitForPacing: async (delayMs, pacing) => events.push(`wait:${delayMs}:${pacing.reason}`),
        resolveInterrupt: async (interrupt) => {
          events.push(`resolved:${interrupt.type}`);
          return { ok: true };
        },
        handlers: {
          click: async () => {
            events.push('clicked');
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'exact' });
    expect(events).toEqual(['wait:2500:rate_limited', 'resolved:rate_limited', 'clicked']);
  });

  test('returns pacing metadata when human verification blocks replay', async () => {
    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'e1' },
      {
        detectInterrupt: async () => ({ type: 'human_verification', requires_human: true }),
        adaptivePacing: () => ({ action: 'pause_for_human', delayMs: 45000, reason: 'human_verification' }),
        handlers: {
          click: async () => ({ ok: true }),
        },
      }
    );

    expect(result).toMatchObject({
      ok: false,
      mode: 'blocked',
      pacing: { action: 'pause_for_human', delayMs: 45000, reason: 'human_verification' },
      requires_human: true,
    });
  });

  test('does not type redacted placeholders and requires a secret', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'type', ref: 'e1', text: '__REDACTED__', text_redacted: true },
      {
        handlers: {
          type: async (step) => {
            calls.push(step);
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: false, mode: 'requires_secret', requires_secret: true });
    expect(calls).toEqual([]);
  });

  test('parameterized typed steps require runtime values before replaying', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'type', ref: 'e1', text: '{{message}}', text_parameterized: true, parameter_name: 'message' },
      {
        handlers: {
          type: async (step) => {
            calls.push(step.text);
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: false, mode: 'requires_parameter', requires_parameters: ['message'] });
    expect(calls).toEqual([]);
  });

  test('parameterized typed steps use supplied runtime values', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'type', ref: 'e1', text: '{{message}}', text_parameterized: true, parameter_name: 'message' },
      {
        parameters: { message: 'fresh answer' },
        handlers: {
          type: async (step) => {
            calls.push(step.text);
            return { ok: true };
          },
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'exact' });
    expect(calls).toEqual(['fresh answer']);
  });

  test('replayStepsSelfHealing reports mode for public replay responses', async () => {
    const replay = await replayStepsSelfHealing(
      [{ kind: 'click', ref: 'e1' }],
      {
        handlers: {
          click: async () => ({ ok: true }),
        },
        validate: async () => ({ ok: true }),
      }
    );

    expect(replay).toMatchObject({ ok: true, llm_used: false, replayed_steps: 1 });
    expect(replay.results[0].mode).toBeDefined();
  });

  test('does not use planner fallback unless explicitly allowed', async () => {
    let planned = false;

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'missing' },
      {
        handlers: { click: async () => ({ ok: false }) },
        getCandidates: async () => [],
        validate: async () => ({ ok: true }),
        plannerFallback: async () => {
          planned = true;
          return { ok: true };
        },
        allowLlmFallback: false,
      }
    );

    expect(planned).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('uses planner fallback only when allowed and executes the proposed step through local handlers', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'missing' },
      {
        handlers: {
          click: async (step) => {
            calls.push(step.ref);
            return step.ref === 'e99' ? { ok: true } : { ok: false, error: 'stale ref' };
          },
        },
        getCandidates: async () => [],
        validate: async () => ({ ok: true }),
        plannerFallback: async () => ({ ok: true, repaired_step: { kind: 'click', ref: 'e99' } }),
        allowLlmFallback: true,
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'llm_fallback', llm_used: true, repaired_step: { kind: 'click', ref: 'e99' } });
    expect(calls).toEqual(['missing', 'e99']);
  });

  test('does not treat planner output as browser action success unless a local handler succeeds', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'missing' },
      {
        handlers: {
          click: async (step) => {
            calls.push(step.ref);
            return { ok: false, error: 'still stale' };
          },
        },
        getCandidates: async () => [],
        validate: async () => ({ ok: true }),
        plannerFallback: async () => ({ ok: true, action: { kind: 'click', ref: 'e99' } }),
        allowLlmFallback: true,
      }
    );

    expect(result).toMatchObject({ ok: false, mode: 'llm_fallback_handler_failed', llm_used: true });
    expect(calls).toEqual(['missing', 'e99']);
  });

  test('reports unavailable LLM fallback clearly without marking llm_used', async () => {
    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'missing' },
      {
        handlers: { click: async () => ({ ok: false, error: 'stale ref' }) },
        getCandidates: async () => [],
        validate: async () => ({ ok: true }),
        plannerFallback: async () => ({ ok: false, mode: 'llm_unavailable', llm_used: false, error: 'No server-side LLM client is configured for memory replay repair.' }),
        allowLlmFallback: true,
      }
    );

    expect(result).toMatchObject({ ok: false, mode: 'llm_unavailable', llm_used: false });
  });

  test('tries planner fallback after local repair validation fails', async () => {
    const calls = [];

    const result = await replayStepSelfHealing(
      { kind: 'click', ref: 'old', target_summary: { role: 'button', name: 'continue' } },
      {
        handlers: {
          click: async (step) => {
            calls.push(step.ref);
            return step.ref === 'old' ? { ok: false, error: 'stale ref' } : { ok: true };
          },
        },
        getCandidates: async () => [{ ref: 'local', role: 'button', name: 'continue' }],
        validate: async (_expected, step) => ({ ok: step.ref === 'llm', reason: 'wrong target' }),
        plannerFallback: async () => ({ ok: true, repaired_step: { kind: 'click', ref: 'llm', target_summary: { role: 'button', name: 'continue' } } }),
        allowLlmFallback: true,
      }
    );

    expect(result).toMatchObject({ ok: true, mode: 'llm_fallback', llm_used: true, repaired_step: { ref: 'llm' } });
    expect(calls).toEqual(['old', 'local', 'llm']);
  });

  test('memory replay LLM repair flag must be explicitly true', () => {
    expect(explicitAllowLlmRepair({})).toBe(false);
    expect(explicitAllowLlmRepair({ allowLlmRepair: false, allow_llm_repair: true })).toBe(false);
    expect(explicitAllowLlmRepair({ allow_llm_repair: true })).toBe(true);
    expect(explicitAllowLlmRepair({ allowLlmRepair: true })).toBe(true);
    expect(explicitAllowLlmRepair({ allowLlmRepair: 'true' })).toBe(false);
  });

  test('server-side unavailable planner fallback reports clear non-LLM failure', async () => {
    const result = await unavailablePlannerFallback({ kind: 'click', ref: 'e1' });
    expect(result).toMatchObject({ ok: false, mode: 'llm_unavailable', llm_used: false });
    expect(result.error).toMatch(/No server-side LLM client is configured/);
  });

  test('memory replay handlers support wait and observation checkpoints without DOM actions', async () => {
    const calls = [];
    const tabState = {
      page: {
        url: () => 'https://example.test/current',
        waitForLoadState: async (state) => calls.push(`load:${state}`),
        waitForTimeout: async (ms) => calls.push(`timeout:${ms}`),
      },
    };

    const handlers = createMemoryReplayHandlers({
      tabState,
      refreshRefs: async (reason) => calls.push(`refresh:${reason}`),
      waitForPageReady: async () => calls.push('ready'),
    });

    await expect(handlers.wait({ timeout: 1234 })).resolves.toMatchObject({ ok: true, checkpoint: true });
    await expect(handlers.snapshot({})).resolves.toMatchObject({ ok: true, checkpoint: true, kind: 'snapshot' });
    await expect(handlers.images({})).resolves.toMatchObject({ ok: true, checkpoint: true, kind: 'images' });
    await expect(handlers.screenshot({})).resolves.toMatchObject({ ok: true, checkpoint: true, kind: 'screenshot' });
    await expect(handlers.vision({})).resolves.toMatchObject({ ok: true, checkpoint: true, kind: 'vision' });

    expect(calls).toEqual([
      'ready',
      'refresh:memory_replay_wait',
      'refresh:memory_replay_snapshot',
      'refresh:memory_replay_images',
      'refresh:memory_replay_screenshot',
      'refresh:memory_replay_vision',
    ]);
  });

  test('memory replay navigation handlers go forward/reload then refresh refs', async () => {
    const calls = [];
    const tabState = {
      page: {
        url: () => 'https://example.test/after',
        goForward: async (options) => calls.push(['forward', options]),
        reload: async (options) => calls.push(['reload', options]),
      },
    };
    const handlers = createMemoryReplayHandlers({
      tabState,
      refreshRefs: async (reason) => calls.push(['refresh', reason]),
    });

    await expect(handlers.forward({})).resolves.toMatchObject({ ok: true, url: 'https://example.test/after' });
    await expect(handlers.refresh({})).resolves.toMatchObject({ ok: true, url: 'https://example.test/after' });

    expect(calls).toEqual([
      ['forward', { timeout: 10000, waitUntil: 'domcontentloaded' }],
      ['refresh', 'memory_replay_forward'],
      ['reload', { timeout: 10000, waitUntil: 'domcontentloaded' }],
      ['refresh', 'memory_replay_refresh'],
    ]);
  });

  test('memory replay evaluate and close are safe by default', async () => {
    const calls = [];
    const tabState = {
      page: {
        url: () => 'https://example.test/current',
        evaluate: async () => calls.push('evaluate'),
        close: async () => calls.push('close'),
      },
    };
    const handlers = createMemoryReplayHandlers({
      tabState,
      refreshRefs: async (reason) => calls.push(`refresh:${reason}`),
    });

    await expect(handlers.evaluate({ expression: 'document.body.remove()' })).resolves.toMatchObject({
      ok: true,
      skipped: true,
      destructive: false,
    });
    await expect(handlers.close({})).resolves.toMatchObject({ ok: true, skipped: true, destructive: false });

    expect(calls).toEqual([]);
  });

  test('memory replay evaluate only executes expressions explicitly marked replay-safe', async () => {
    const calls = [];
    const tabState = {
      page: {
        url: () => 'https://example.test/current',
        evaluate: async (expression) => {
          calls.push(expression);
          return 'ok';
        },
      },
    };
    const handlers = createMemoryReplayHandlers({
      tabState,
      refreshRefs: async (reason) => calls.push(`refresh:${reason}`),
    });

    await expect(handlers.evaluate({ expression: 'document.title', replay_safe: true })).resolves.toMatchObject({
      ok: true,
      value: 'ok',
    });

    expect(calls).toEqual(['document.title', 'refresh:memory_replay_evaluate']);
  });
});
