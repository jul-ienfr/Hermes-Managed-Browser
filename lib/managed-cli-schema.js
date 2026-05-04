const WRITE_OPERATIONS = new Set([
  'open',
  'act',
  'memory.record',
  'memory.replay',
  'checkpoint',
  'release',
]);

const SIDE_EFFECT_LEVELS = Object.freeze([
  'read_only',
  'message_send',
  'submit_apply',
  'buy_pay',
  'delete',
  'publish',
  'account_setting',
]);

const SIDE_EFFECT_ALIASES = Object.freeze({
  read: 'read_only',
  readonly: 'read_only',
  read_only: 'read_only',
  message: 'message_send',
  send: 'message_send',
  message_send: 'message_send',
  submit: 'submit_apply',
  apply: 'submit_apply',
  submit_apply: 'submit_apply',
  buy: 'buy_pay',
  pay: 'buy_pay',
  buy_pay: 'buy_pay',
  delete: 'delete',
  publish: 'publish',
  account: 'account_setting',
  setting: 'account_setting',
  settings: 'account_setting',
  account_setting: 'account_setting',
});

function normalizeSideEffectLevel(value, fallback = 'read_only') {
  const key = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return SIDE_EFFECT_ALIASES[key] || (SIDE_EFFECT_LEVELS.includes(key) ? key : fallback);
}

function sideEffectRank(level) {
  return SIDE_EFFECT_LEVELS.indexOf(normalizeSideEffectLevel(level));
}

function sideEffectAllowed(level, maxLevel = 'read_only') {
  return sideEffectRank(level) <= sideEffectRank(maxLevel);
}

function sideEffectPolicyCheck(level, options = {}) {
  const sideEffectLevel = normalizeSideEffectLevel(level);
  const maxSideEffectLevel = normalizeSideEffectLevel(options.maxSideEffectLevel || options.max_side_effect_level || 'read_only');
  if (sideEffectAllowed(sideEffectLevel, maxSideEffectLevel)) {
    return { ok: true, side_effect_level: sideEffectLevel, max_side_effect_level: maxSideEffectLevel };
  }
  return {
    ok: false,
    mode: 'blocked',
    blocked: true,
    side_effect_level: sideEffectLevel,
    max_side_effect_level: maxSideEffectLevel,
    requires_confirmation: true,
    reason: 'side_effect_level_exceeds_policy',
  };
}

function readLeaseId(input = {}) {
  return input.lease_id || input.leaseId || null;
}

function observableStateFromResult(result = {}) {
  if (result.observable_state) return result.observable_state;
  const observable = {};
  for (const key of ['tabId', 'targetId', 'url', 'title', 'refsCount', 'currentTabId', 'persisted', 'released']) {
    if (result[key] !== undefined) observable[key] = result[key];
  }
  return Object.keys(observable).length ? observable : null;
}

function normalizeManagedCliResult(operation, result = {}, context = {}) {
  const allow_llm_fallback = context.allow_llm_fallback;
  const profile = context.profile || result.profile;
  const leaseId = context.lease_id || readLeaseId(context) || readLeaseId(result);
  const normalized = {
    ok: result.ok !== false,
    operation,
    profile,
    mode: result.mode || context.mode || 'browser',
    llm_used: Boolean(result.llm_used || result.llmUsed || result.llm_repair_used),
    ...result,
    profile,
    mode: result.mode || context.mode || 'browser',
    llm_used: Boolean(result.llm_used || result.llmUsed || result.llm_repair_used),
  };

  if (WRITE_OPERATIONS.has(operation) || leaseId) normalized.lease_id = leaseId;
  for (const key of ['requires_parameter', 'requires_secret', 'requires_confirmation', 'requires_recovery', 'blocked', 'side_effect_level']) {
    if (result[key] !== undefined) normalized[key] = result[key];
  }
  const observableState = observableStateFromResult(result);
  if (observableState) normalized.observable_state = observableState;
  return normalized;
}

function managedCliErrorFields(operation, context = {}) {
  const fields = {
    operation,
    profile: context.profile,
    mode: context.mode || 'browser',
    llm_used: Boolean(context.llm_used),
  };
  const leaseId = readLeaseId(context);
  if (WRITE_OPERATIONS.has(operation) || leaseId) fields.lease_id = leaseId;
  return fields;
}

function normalizeManagedNotificationResponse(result = {}, context = {}) {
  const success = result.success !== undefined ? Boolean(result.success) : result.ok !== false;
  return {
    success,
    profile: context.profile || result.profile,
    site: context.site || result.site,
    llm_used: false,
    external_actions: 0,
    ...result,
    success,
    profile: context.profile || result.profile,
    site: context.site || result.site,
    llm_used: false,
    external_actions: 0,
  };
}

export {
  SIDE_EFFECT_LEVELS,
  WRITE_OPERATIONS,
  managedCliErrorFields,
  normalizeManagedCliResult,
  normalizeManagedNotificationResponse,
  normalizeSideEffectLevel,
  sideEffectPolicyCheck,
};
