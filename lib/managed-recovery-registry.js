const CONSULTATION_KINDS = new Set(['snapshot', 'images', 'screenshot', 'vision']);

function normalizePart(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

export function buildRecoveryKey(meta = {}) {
  const parts = [];
  const userId = normalizePart(meta.userId);
  if (userId) parts.push(`user:${userId}`);
  const sessionKey = normalizePart(meta.sessionKey ?? meta.listItemId ?? meta.contextKey);
  if (sessionKey) parts.push(`session:${sessionKey}`);
  const profileDir = normalizePart(meta.profileDir);
  if (profileDir) parts.push(`profile:${profileDir}`);
  const siteKey = normalizePart(meta.siteKey);
  if (siteKey) parts.push(`site:${siteKey}`);
  const taskId = normalizePart(meta.task_id ?? meta.taskId ?? meta.contextId);
  if (taskId) parts.push(`task:${taskId}`);
  if (!parts.length) return 'default';
  return parts.join('|');
}

export function createManagedRecoveryRegistry({ now = () => Date.now() } = {}) {
  return {
    states: new Map(),
    now,
  };
}

function urlFromAction(action = {}) {
  return normalizePart(action.result?.url ?? action.url ?? action.currentUrl ?? action.lastKnownUrl);
}

function titleFromAction(action = {}) {
  return normalizePart(action.result?.title ?? action.title ?? action.lastTitle);
}

function siteKeyFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function assignMetadata(state, meta = {}) {
  const fields = ['userId', 'sessionKey', 'profileDir', 'siteKey', 'task_id', 'taskId', 'contextId'];
  for (const field of fields) {
    const value = normalizePart(meta[field]);
    if (value) state[field] = value;
  }
  if (!state.siteKey) {
    const inferredSiteKey = siteKeyFromUrl(state.lastKnownUrl || state.lastConsultedUrl);
    if (inferredSiteKey) state.siteKey = inferredSiteKey;
  }
  if (normalizePart(meta.tabId)) state.lastTabId = normalizePart(meta.tabId);
  if (meta.persona !== undefined) state.persona = meta.persona;
  if (meta.profile !== undefined) state.profile = meta.profile;
  if (meta.browserPersona !== undefined) state.browserPersona = meta.browserPersona;
  if (meta.humanProfile !== undefined) state.humanProfile = meta.humanProfile;
  if (meta.humanPersona !== undefined) state.humanPersona = meta.humanPersona;
  if (meta.policy !== undefined) state.policy = meta.policy;
}

function ensureState(registry, meta = {}) {
  if (!registry?.states || typeof registry.states.get !== 'function') {
    throw new Error('managed recovery registry required');
  }
  const key = buildRecoveryKey(meta);
  let state = registry.states.get(key);
  if (!state) {
    state = {
      key,
      lastTabId: null,
      lastConsultedUrl: null,
      lastKnownUrl: null,
      lastTitle: null,
      lastSnapshotAt: null,
      lastActionAt: null,
      profileDir: null,
      closedAt: null,
      closeReason: null,
    };
    registry.states.set(key, state);
  }
  return state;
}

export function getRecoveryState(registry, meta = {}) {
  if (!registry?.states) return null;
  return registry.states.get(buildRecoveryKey(meta)) || null;
}

export function recordRecoveryAction(registry, meta = {}, action = {}) {
  if (action?.result && action.result.ok === false) return getRecoveryState(registry, meta);
  const state = ensureState(registry, meta);
  const now = registry.now();
  assignMetadata(state, meta);

  const url = urlFromAction(action);
  if (url) state.lastKnownUrl = url;
  const title = titleFromAction(action);
  if (title !== null) state.lastTitle = title;

  if (CONSULTATION_KINDS.has(action.kind)) {
    if (url) state.lastConsultedUrl = url;
    state.lastSnapshotAt = now;
  }

  state.lastActionAt = now;
  state.closedAt = null;
  state.closeReason = null;
  return state;
}

export function markRecoveryClosed(registry, meta = {}, close = {}) {
  const state = ensureState(registry, meta);
  const now = registry.now();
  assignMetadata(state, meta);

  const url = normalizePart(close.url ?? close.result?.url);
  if (url) state.lastKnownUrl = url;
  const title = normalizePart(close.title ?? close.result?.title);
  if (title !== null) state.lastTitle = title;

  state.closedAt = now;
  state.closeReason = normalizePart(close.reason) || 'closed';
  return state;
}

export function getRecoveryTargetUrl(state, fallbackUrl = null) {
  return normalizePart(state?.lastConsultedUrl) || normalizePart(state?.lastKnownUrl) || normalizePart(fallbackUrl);
}
