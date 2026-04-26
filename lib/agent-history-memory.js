import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MEMORY_DIR_ENV = 'CAMOFOX_BROWSER_MEMORY_DIR';

function memoryRoot() {
  return process.env[MEMORY_DIR_ENV] || path.join(process.env.HOME || process.cwd(), '.hermes', 'browser_memory');
}

function slugify(value, fallback = 'default') {
  const raw = String(value || '').trim().toLowerCase();
  const hostLike = raw.includes('.') && !raw.includes('/') && !raw.includes(' ');
  const pattern = hostLike ? /[^a-z0-9.-]+/g : /[^a-z0-9]+/g;
  const slug = raw
    .replace(pattern, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return slug || fallback;
}

function siteKeyFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function latestUrlFromSteps(steps) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.url) return steps[i].url;
  }
  return '';
}

function deriveActionKeyFromUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean).slice(0, 3);
    return slugify(parts.join('_'), 'home');
  } catch {
    return 'default';
  }
}

function deriveActionKeyFromSteps(steps) {
  const firstNavigate = steps.find((step) => step?.kind === 'navigate' && step.url);
  if (firstNavigate) return deriveActionKeyFromUrl(firstNavigate.url);
  const latest = latestUrlFromSteps(steps);
  return deriveActionKeyFromUrl(latest);
}

function normalizeActionKey(actionKey) {
  return slugify(actionKey, 'default');
}

function flowPath(siteKey, actionKey) {
  return path.join(memoryRoot(), slugify(siteKey), `${normalizeActionKey(actionKey)}.AgentHistory.json`);
}

function isSuccessfulResult(result) {
  return Boolean(result && result.ok !== false && !result.error);
}

function enrichStep(input) {
  const result = input.result || {};
  const step = { kind: input.kind, expected_outcome: {} };
  if (input.kind !== 'navigate') {
    step.url = result.url || input.url;
  }
  for (const key of ['url', 'ref', 'selector', 'text', 'key', 'direction', 'amount']) {
    if (input[key] !== undefined && input[key] !== null) step[key] = input[key];
  }
  if (!step.url && result.url) step.url = result.url;
  if (result.title) step.title = result.title;
  if (input.target_summary) step.target_summary = input.target_summary;
  return step;
}

function createMemoryTabState() {
  return {
    agentHistorySteps: [],
  };
}

function ensureMemoryState(tabState) {
  if (!Array.isArray(tabState.agentHistorySteps)) tabState.agentHistorySteps = [];
  return tabState.agentHistorySteps;
}

async function persistRuntimeSteps(steps, siteKey, actionKey, aliases = []) {
  const normalizedSite = slugify(siteKey);
  const normalizedAction = normalizeActionKey(actionKey);
  const file = flowPath(normalizedSite, normalizedAction);
  await mkdir(path.dirname(file), { recursive: true });
  const payload = {
    history: steps.map((step, index) => ({ step: index + 1, action: step.kind, ...step })),
    hermes_meta: {
      source: 'camofox-browser',
      site_key: normalizedSite,
      action_key: normalizedAction,
      aliases: [...new Set(aliases.map((alias) => normalizeActionKey(alias)).filter(Boolean))],
      derived_flow: {
        steps,
      },
      created_at: new Date().toISOString(),
    },
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: file, payload };
}

async function autoPersist(tabState) {
  const steps = ensureMemoryState(tabState);
  const siteUrl = steps.find((step) => step?.kind === 'navigate' && step.url)?.url || latestUrlFromSteps(steps);
  const siteKey = siteKeyFromUrl(siteUrl);
  if (!siteKey) return null;
  const derived = deriveActionKeyFromSteps(steps);
  await persistRuntimeSteps(steps, siteKey, 'latest', [derived]);
  await persistRuntimeSteps(steps, siteKey, 'default', [derived]);
  if (derived && derived !== 'latest' && derived !== 'default') {
    await persistRuntimeSteps(steps, siteKey, derived, []);
  }
  return { siteKey, actionKey: derived };
}

async function recordSuccessfulBrowserAction(tabState, action) {
  if (!tabState || !isSuccessfulResult(action?.result)) return null;
  const steps = ensureMemoryState(tabState);
  const step = enrichStep(action);
  if (!step.kind) return null;
  steps.push(step);
  return autoPersist(tabState);
}

async function loadAgentHistory(siteKey, actionKey = 'default') {
  const direct = flowPath(siteKey, actionKey);
  try {
    const raw = await readFile(direct, 'utf8');
    return { path: direct, payload: JSON.parse(raw) };
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    throw new Error(`No AgentHistory flow for ${slugify(siteKey)}/${normalizeActionKey(actionKey)}`);
  }
}

async function recordFlow(tabState, siteKey, actionKey = 'default') {
  const steps = ensureMemoryState(tabState);
  if (steps.length === 0) throw new Error('No recorded browser steps for this tab');
  return persistRuntimeSteps(steps, siteKey, actionKey);
}

async function replayAgentHistory(siteKey, actionKey = 'default', handlers = {}) {
  const loaded = await loadAgentHistory(siteKey, actionKey);
  const steps = loaded.payload?.hermes_meta?.derived_flow?.steps || [];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`AgentHistory flow has no replayable steps for ${slugify(siteKey)}/${normalizeActionKey(actionKey)}`);
  }
  const results = [];
  for (const step of steps) {
    const handler = handlers[step.kind];
    if (!handler) throw new Error(`No replay handler for AgentHistory step kind: ${step.kind}`);
    const result = await handler(step);
    results.push({ step, result });
    if (result?.ok === false || result?.error) {
      return { ok: false, llm_used: false, replayed_steps: results.length, results };
    }
  }
  return { ok: true, llm_used: false, replayed_steps: results.length, results };
}

export {
  createMemoryTabState,
  deriveActionKeyFromSteps,
  deriveActionKeyFromUrl,
  flowPath,
  loadAgentHistory,
  normalizeActionKey,
  persistRuntimeSteps,
  recordFlow,
  recordSuccessfulBrowserAction,
  replayAgentHistory,
  slugify,
};
