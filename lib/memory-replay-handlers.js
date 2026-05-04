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

function liveCandidatesFromTabState(tabState) {
  const refs = tabState?.refs;
  if (!refs || typeof refs.entries !== 'function') return [];
  return Array.from(refs.entries()).map(([ref, node], index) => ({ ref, index, ...(node || {}) }));
}

function splitUploadPaths(paths = []) {
  return paths
    .flatMap((path) => String(path || '').split(','))
    .map((path) => path.trim())
    .filter(Boolean);
}

function locatorForStep(tabState, step = {}) {
  const activePage = tabState?.page;
  if (!activePage?.locator) return null;
  if (step.selector) return activePage.locator(step.selector);
  const refNode = step.ref && tabState?.refs?.get?.(step.ref);
  if (refNode?.selector) return activePage.locator(refNode.selector);
  if (refNode?.locator) return refNode.locator;
  return null;
}

function stepTimeout(step = {}, fallback = 10000) {
  return safeTimeout(step.timeout || step.timeoutMs || step.ms, fallback, 30000);
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
      const timeout = stepTimeout(step, 10000);
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

    type: async (step = {}) => {
      const locator = locatorForStep(tabState, step);
      const text = step.text ?? step.value;
      if (!locator) return { ok: false, error: 'Missing selector/ref for type step' };
      if (typeof text !== 'string') return { ok: false, error: 'Missing text for type step' };
      const timeout = stepTimeout(step, 10000);
      await locator.fill(text, { timeout });
      await refreshAfter(refreshRefs, 'memory_replay_type');
      return { ok: true, text, url: currentUrl(tabState) };
    },

    click: async (step = {}) => {
      const locator = locatorForStep(tabState, step);
      if (!locator) return { ok: false, error: 'Missing selector/ref for click step' };
      const timeout = stepTimeout(step, 10000);
      await locator.click({ timeout });
      await refreshAfter(refreshRefs, 'memory_replay_click');
      return { ok: true, url: currentUrl(tabState) };
    },

    file_upload: async (step = {}) => {
      const locator = locatorForStep(tabState, step);
      const paths = splitUploadPaths(step.paths || step.path || step.files || []);
      if (!locator) return { ok: false, error: 'Missing selector/ref for file_upload step' };
      if (paths.length === 0) return { ok: false, error: 'Missing paths for file_upload step' };
      await locator.setInputFiles(paths, { timeout: stepTimeout(step, 10000) });
      await refreshAfter(refreshRefs, 'memory_replay_file_upload');
      return { ok: true, uploaded: paths.length, paths, url: currentUrl(tabState) };
    },

    fileUpload: async (step = {}) => {
      const handlers = createMemoryReplayHandlers({ tabState, refreshRefs, waitForPageReady });
      return handlers.file_upload(step);
    },

    close: async () => ({ ok: true, skipped: true, destructive: false, reason: 'close_not_replayed', url: currentUrl(tabState) }),
  };
}

export { createMemoryReplayHandlers, liveCandidatesFromTabState };
