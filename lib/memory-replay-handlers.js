function safeTimeout(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), max);
}

async function refreshAfter(refreshRefs, reason) {
  if (typeof refreshRefs === 'function') {
    await refreshRefs(reason);
  }
}

function currentUrl(tabState) {
  return tabState?.page?.url?.() || '';
}

function createMemoryReplayHandlers({
  tabState,
  refreshRefs,
  waitForPageReady,
} = {}) {
  const page = () => tabState?.page;

  async function checkpoint(kind, refreshReason = `memory_replay_${kind}`) {
    await refreshAfter(refreshRefs, refreshReason);
    return { ok: true, checkpoint: true, kind, url: currentUrl(tabState) };
  }

  return {
    wait: async (step = {}) => {
      const timeout = safeTimeout(step.timeout || step.timeoutMs || step.ms, 10000, 30000);
      if (typeof waitForPageReady === 'function') {
        await waitForPageReady(page(), {
          timeout,
          waitForNetwork: step.waitForNetwork !== false,
          waitForHydration: step.waitForHydration !== false,
          settleMs: safeTimeout(step.settleMs, 200, 5000),
        });
      } else if (page()?.waitForLoadState) {
        await page().waitForLoadState(step.state || 'domcontentloaded', { timeout }).catch(() => {});
        if (step.waitForNetwork !== false) {
          await page().waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) }).catch(() => {});
        }
        const settleMs = safeTimeout(step.settleMs, 200, 5000);
        if (settleMs > 0 && page()?.waitForTimeout) await page().waitForTimeout(settleMs).catch(() => {});
      }
      return checkpoint('wait');
    },

    forward: async () => {
      await page()?.goForward?.({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await refreshAfter(refreshRefs, 'memory_replay_forward');
      return { ok: true, url: currentUrl(tabState) };
    },

    refresh: async () => {
      await page()?.reload?.({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => null);
      await refreshAfter(refreshRefs, 'memory_replay_refresh');
      return { ok: true, url: currentUrl(tabState) };
    },

    snapshot: async () => checkpoint('snapshot'),
    images: async () => checkpoint('images'),
    screenshot: async () => checkpoint('screenshot'),
    vision: async () => checkpoint('vision'),

    evaluate: async (step = {}) => {
      if (step.replay_safe !== true && step.replaySafe !== true) {
        return { ok: true, skipped: true, destructive: false, reason: 'evaluate_not_replay_safe', url: currentUrl(tabState) };
      }
      const expression = step.expression || step.script;
      if (typeof expression !== 'string' || expression.trim().length === 0) {
        return { ok: false, error: 'Missing replay-safe evaluate expression' };
      }
      const value = await page()?.evaluate?.(expression);
      await refreshAfter(refreshRefs, 'memory_replay_evaluate');
      return { ok: true, value, url: currentUrl(tabState) };
    },

    close: async () => ({ ok: true, skipped: true, destructive: false, reason: 'close_not_replayed', url: currentUrl(tabState) }),
  };
}

export { createMemoryReplayHandlers };
