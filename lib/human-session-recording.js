const KEY_CLASSES = new Set(['letter', 'digit', 'space', 'punctuation', 'control']);
const SENSITIVE_INPUT_KINDS = new Set(['password', 'email', 'tel', 'otp', 'code', 'url', 'number']);
const SAFE_EVENT_TYPES = new Set(['mouse.move', 'mouse.down', 'mouse.up', 'wheel', 'key.type', 'key.press']);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.round(finiteNumber(value, fallback)));
}

function roundedNumber(value, fallback = 0) {
  return Math.round(finiteNumber(value, fallback));
}

function safeButton(button) {
  return ['left', 'middle', 'right'].includes(button) ? button : 'left';
}

function isSensitiveKind(inputKind) {
  return SENSITIVE_INPUT_KINDS.has(String(inputKind || '').toLowerCase());
}

export function classifyTypedCharacter(value) {
  if (KEY_CLASSES.has(value)) return value;
  if (typeof value !== 'string' || value.length !== 1) return 'control';
  if (/^\p{L}$/u.test(value)) return 'letter';
  if (/^\p{N}$/u.test(value)) return 'digit';
  if (/^\s$/u.test(value)) return 'space';
  return 'punctuation';
}

export function sanitizeRecorderEvent(event = {}) {
  const type = String(event.type || '');
  if (!SAFE_EVENT_TYPES.has(type)) return null;

  const sanitized = {
    t: nonNegativeInteger(event.t),
    type,
  };

  if (type === 'mouse.move') {
    sanitized.x = roundedNumber(event.x);
    sanitized.y = roundedNumber(event.y);
    return sanitized;
  }

  if (type === 'mouse.down' || type === 'mouse.up') {
    sanitized.button = safeButton(event.button);
    return sanitized;
  }

  if (type === 'wheel') {
    sanitized.dx = roundedNumber(event.dx);
    sanitized.dy = roundedNumber(event.dy);
    return sanitized;
  }

  if (type === 'key.type') {
    sanitized.class = classifyTypedCharacter(event.class || event.key || event.character);
    sanitized.delay = nonNegativeInteger(event.delay);
    if (isSensitiveKind(event.inputType || event.inputKind || event.fieldKind)) {
      sanitized.sensitive = true;
    }
    return sanitized;
  }

  sanitized.class = 'control';
  sanitized.delay = nonNegativeInteger(event.delay);
  return sanitized;
}

function distribution(values) {
  const safeValues = values.map((value) => Number(value)).filter(Number.isFinite);
  if (safeValues.length === 0) return { count: 0 };
  const sum = safeValues.reduce((total, value) => total + value, 0);
  return {
    count: safeValues.length,
    min: Math.min(...safeValues),
    max: Math.max(...safeValues),
    mean: Math.round(sum / safeValues.length),
  };
}

function safeStepKind(kind) {
  return ['navigate', 'click', 'type', 'press', 'scroll', 'back'].includes(kind) ? kind : 'other';
}

function safeTargetSummary(targetSummary = {}) {
  if (!targetSummary || typeof targetSummary !== 'object') return undefined;
  const safe = {};
  if (targetSummary.role) safe.role = String(targetSummary.role);
  if (targetSummary.name) safe.nameLength = String(targetSummary.name).length;
  if (targetSummary.attributes && typeof targetSummary.attributes === 'object') {
    safe.attributeKeys = Object.keys(targetSummary.attributes).sort();
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function summarizeAgentHistoryTimeline(steps = []) {
  const safeSteps = (Array.isArray(steps) ? steps : []).map((step, index) => {
    const item = {
      index: index + 1,
      kind: safeStepKind(step?.kind),
    };
    if (step?.text_redacted || step?.original_text_redacted || step?.text_parameterized) item.textRedacted = true;
    if (step?.key) item.keyClass = classifyTypedCharacter(step.key);
    if (step?.direction) item.direction = String(step.direction);
    const targetSummary = safeTargetSummary(step?.target_summary);
    if (targetSummary) item.targetSummary = targetSummary;
    return item;
  });

  const actionCounts = {};
  for (const step of safeSteps) {
    actionCounts[step.kind] = (actionCounts[step.kind] || 0) + 1;
  }

  return {
    version: 1,
    totalSteps: safeSteps.length,
    actionCounts,
    steps: safeSteps,
  };
}

export function summarizeRecorderEvents(events = []) {
  const sanitizedEvents = events.map(sanitizeRecorderEvent).filter(Boolean).sort((a, b) => a.t - b.t);
  const eventCounts = {};
  const keyClassCounts = {};
  const keyDelays = [];
  const interEventDelays = [];

  for (let index = 0; index < sanitizedEvents.length; index += 1) {
    const event = sanitizedEvents[index];
    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;

    if (event.type === 'key.type') {
      keyClassCounts[event.class] = (keyClassCounts[event.class] || 0) + 1;
      keyDelays.push(event.delay);
    }

    if (index > 0) {
      interEventDelays.push(Math.max(0, event.t - sanitizedEvents[index - 1].t));
    }
  }

  return {
    version: 1,
    eventCounts,
    keyClassCounts,
    keyDelayMs: distribution(keyDelays),
    interEventDelayMs: distribution(interEventDelays),
  };
}
