import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MEMORY_DIR_ENV = 'CAMOFOX_BROWSER_MEMORY_DIR';
const REDACTED_TEXT = '__REDACTED__';

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

function normalizeInspectableText(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function targetSummaryValue(targetSummary, keys) {
  const values = [];
  const attributes = targetSummary?.attributes || {};
  for (const key of keys) {
    if (targetSummary?.[key] !== undefined) values.push(targetSummary[key]);
    if (attributes?.[key] !== undefined) values.push(attributes[key]);
  }
  return values.map(normalizeInspectableText).filter(Boolean).join(' ');
}

function containsSensitiveTargetHint(targetSummary = {}) {
  const hints = targetSummaryValue(targetSummary, ['name', 'placeholder', 'aria-label', 'label']);
  return /\b(password|mot de passe|otp|code)\b/i.test(hints);
}

function hasPasswordInputType(targetSummary = {}) {
  return normalizeInspectableText(targetSummary?.attributes?.type) === 'password';
}

function passesLuhnCheck(value) {
  let sum = 0;
  let shouldDouble = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number(value[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum > 0 && sum % 10 === 0;
}

function looksLikeCardNumber(text) {
  const compact = String(text || '').replace(/[\s-]+/g, '');
  return /^\d{13,19}$/.test(compact) && passesLuhnCheck(compact);
}

function looksLikeLongToken(text) {
  const value = String(text || '').trim();
  if (value.length < 24 || /\s/.test(value)) return false;
  return /^[A-Za-z0-9._~+/=-]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function shouldRedactTypedValue(input) {
  if (input?.kind !== 'type' || input.allow_sensitive_text === true) return false;
  if (hasPasswordInputType(input.target_summary)) return true;
  if (containsSensitiveTargetHint(input.target_summary)) return true;
  return looksLikeCardNumber(input.text) || looksLikeLongToken(input.text);
}

function looksLikeFreeFormMessageTarget(input = {}) {
  if (input.kind !== 'type' || input.allow_literal_text === true || input.allow_sensitive_text === true) return false;
  const summary = input.target_summary || {};
  const hints = targetSummaryValue(summary, ['name', 'placeholder', 'aria-label', 'label']);
  const selector = normalizeInspectableText(input.selector);
  const url = normalizeInspectableText(input.url || input.result?.url || '');
  if (/\b(search|rechercher|email|e mail|courriel|username|identifiant|login|password|mot de passe|otp|code)\b/.test(hints)) return false;
  if (/\b(message|messagerie|conversation|chat|reply|réponse|reponse|comment|commentaire|écrivez votre message|ecrire mon message|write a message)\b/.test(hints)) return true;
  if (/textarea/.test(selector) && /\b(messages?|conversation|conversations|inbox|messagerie|chat)\b/.test(url)) return true;
  return false;
}

function parameterizeTypedValueIfNeeded(step, input) {
  if (!looksLikeFreeFormMessageTarget(input)) return step;
  return {
    ...step,
    text: '{{message}}',
    text_parameterized: true,
    parameter_name: 'message',
    original_text_redacted: true,
  };
}

function redactTypedValueIfNeeded(step, input) {
  if (shouldRedactTypedValue(input)) return { ...step, text: REDACTED_TEXT, text_redacted: true };
  return parameterizeTypedValueIfNeeded(step, input);
}

function copyDefined(target, source, keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) target[key] = source[key];
  }
  return target;
}

function enrichObservationStep(step, input, result) {
  step.checkpoint = true;
  step.replayable = false;
  step.noop = true;
  if (input.kind === 'snapshot') {
    copyDefined(step, input, ['full', 'includeScreenshot', 'offset']);
    copyDefined(step, result, ['refsCount', 'truncated', 'totalChars', 'hasMore', 'nextOffset']);
    step.hasScreenshot = Boolean(result.screenshot || input.includeScreenshot);
  } else if (input.kind === 'images') {
    copyDefined(step, input, ['includeData', 'limit', 'maxBytes']);
    if (Array.isArray(result.images)) step.imageCount = result.images.length;
  } else if (input.kind === 'screenshot') {
    copyDefined(step, input, ['fullPage']);
    copyDefined(step, result, ['mimeType', 'bytes']);
  } else if (input.kind === 'vision') {
    copyDefined(step, result, ['model', 'mimeType', 'bytes']);
  }
  return step;
}

function enrichEvaluateStep(step, input, result) {
  copyDefined(step, result, ['resultType']);
  if (input.replaySafe === true || input.replay_safe === true) {
    step.expression = input.expression;
    step.replaySafe = true;
    step.replayable = true;
  } else {
    step.expression_redacted = true;
    step.replayable = false;
  }
  return step;
}

function enrichStep(input) {
  const result = input.result || {};
  let step = { kind: input.kind, expected_outcome: input.expected_outcome || {} };
  if (input.kind !== 'navigate') {
    step.url = result.url || input.url;
  }
  for (const key of ['url', 'ref', 'selector', 'text', 'key', 'direction', 'amount']) {
    if (input[key] !== undefined && input[key] !== null) step[key] = input[key];
  }
  copyDefined(step, input, ['timeout', 'waitForNetwork', 'mode', 'submit', 'pressEnter', 'clearFirst', 'reason']);
  if (!step.url && result.url) step.url = result.url;
  if (result.title) step.title = result.title;
  if (input.target_summary) step.target_summary = input.target_summary;
  if (['snapshot', 'images', 'screenshot', 'vision'].includes(input.kind)) {
    step = enrichObservationStep(step, input, result);
  } else if (input.kind === 'evaluate') {
    step = enrichEvaluateStep(step, input, result);
  } else if (input.kind === 'close') {
    step.replayable = false;
  }
  step = redactTypedValueIfNeeded(step, input);
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

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

async function persistRuntimeSteps(steps, siteKey, actionKey, aliases = [], options = {}) {
  const normalizedSite = slugify(siteKey);
  const normalizedAction = normalizeActionKey(actionKey);
  const file = flowPath(normalizedSite, normalizedAction);
  const normalizedAliases = uniqueStrings(aliases).map((alias) => normalizeActionKey(alias)).filter(Boolean);
  const labels = uniqueStrings(options.labels || []);
  await mkdir(path.dirname(file), { recursive: true });
  const payload = {
    history: steps.map((step, index) => ({ step: index + 1, action: step.kind, ...step })),
    hermes_meta: {
      source: 'camofox-browser',
      site_key: normalizedSite,
      action_key: normalizedAction,
      aliases: [...new Set(normalizedAliases)],
      labels,
      derived_flow: {
        steps,
      },
      created_at: new Date().toISOString(),
    },
  };
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { path: file, payload };
}

async function persistAgentHistorySteps({ siteKey, actionKey = 'default', steps, learnedFrom } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('No AgentHistory steps to persist');
  }
  const saved = await persistRuntimeSteps(steps, siteKey, actionKey);
  if (learnedFrom) {
    saved.payload.hermes_meta.learned_from = {
      path: learnedFrom,
      timestamp: new Date().toISOString(),
    };
    await writeFile(saved.path, `${JSON.stringify(saved.payload, null, 2)}\n`, 'utf8');
  }
  return saved;
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

async function recordFlow(tabState, siteKey, actionKey = 'default', options = {}) {
  const steps = ensureMemoryState(tabState);
  if (steps.length === 0) throw new Error('No recorded browser steps for this tab');
  return persistRuntimeSteps(steps, siteKey, actionKey, options.aliases || [], options);
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchFieldsFromPayload(payload = {}) {
  const meta = payload.hermes_meta || {};
  const steps = Array.isArray(meta.derived_flow?.steps) ? meta.derived_flow.steps : [];
  const fields = [
    meta.action_key,
    ...(Array.isArray(meta.aliases) ? meta.aliases : []),
    ...(Array.isArray(meta.labels) ? meta.labels : []),
  ];
  for (const step of steps) {
    if (step?.title) fields.push(step.title);
    if (step?.url) fields.push(step.url);
  }
  return fields.map(normalizeSearchText).filter(Boolean);
}

function flowMatchesQuery(payload, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return searchFieldsFromPayload(payload).some((field) => field.includes(normalizedQuery));
}

async function searchFlows({ siteKey, query = '' } = {}) {
  if (!siteKey) throw new Error('siteKey is required');
  const normalizedSite = slugify(siteKey);
  const siteDir = path.join(memoryRoot(), normalizedSite);
  let entries;
  try {
    entries = await readdir(siteDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.AgentHistory.json')) continue;
    const file = path.join(siteDir, entry.name);
    let payload;
    try {
      payload = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!flowMatchesQuery(payload, query)) continue;
    const meta = payload.hermes_meta || {};
    results.push({
      siteKey: meta.site_key || normalizedSite,
      actionKey: meta.action_key || entry.name.replace(/\.AgentHistory\.json$/, ''),
      labels: Array.isArray(meta.labels) ? meta.labels : [],
      aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
      path: file,
    });
  }
  return results.sort((a, b) => a.actionKey.localeCompare(b.actionKey));
}

async function deleteFlow(siteKey, actionKey = 'default') {
  const file = flowPath(siteKey, actionKey);
  try {
    await rm(file);
    return { ok: true, siteKey: slugify(siteKey), actionKey: normalizeActionKey(actionKey), path: file, deleted: true };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, siteKey: slugify(siteKey), actionKey: normalizeActionKey(actionKey), path: file, deleted: false };
    }
    throw err;
  }
}

function resolveReplayStepParameters(step, parameters = {}) {
  if (!step?.text_parameterized) return { ok: true, step };
  const parameterName = step.parameter_name || 'message';
  const value = parameters[parameterName];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, parameterName };
  }
  return {
    ok: true,
    step: {
      ...step,
      text: value,
      parameter_value_supplied: true,
    },
  };
}

async function replayAgentHistory(siteKey, actionKey = 'default', handlers = {}, options = {}) {
  const loaded = await loadAgentHistory(siteKey, actionKey);
  const steps = loaded.payload?.hermes_meta?.derived_flow?.steps || [];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`AgentHistory flow has no replayable steps for ${slugify(siteKey)}/${normalizeActionKey(actionKey)}`);
  }
  const parameters = options.parameters || {};
  const results = [];
  for (const originalStep of steps) {
    const resolved = resolveReplayStepParameters(originalStep, parameters);
    if (!resolved.ok) {
      return {
        ok: false,
        llm_used: false,
        replayed_steps: results.length,
        requires_parameters: [resolved.parameterName],
        results,
      };
    }
    const step = resolved.step;
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
  deleteFlow,
  deriveActionKeyFromSteps,
  deriveActionKeyFromUrl,
  flowPath,
  loadAgentHistory,
  normalizeActionKey,
  persistAgentHistorySteps,
  persistRuntimeSteps,
  recordFlow,
  recordSuccessfulBrowserAction,
  replayAgentHistory,
  searchFlows,
  slugify,
};
