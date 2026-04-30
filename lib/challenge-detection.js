const CHALLENGE_PROVIDERS = [
  { provider: 'recaptcha', category: 'captcha', patterns: [/google\.com\/recaptcha/i, /gstatic\.com\/recaptcha/i, /recaptcha/i] },
  { provider: 'hcaptcha', category: 'captcha', patterns: [/hcaptcha\.com/i] },
  { provider: 'turnstile', category: 'managed_challenge', patterns: [/challenges\.cloudflare\.com/i, /turnstile/i] },
  { provider: 'arkose', category: 'captcha', patterns: [/arkoselabs\.com/i, /funcaptcha/i, /fc\/gc/i] },
  { provider: 'aws_waf', category: 'managed_challenge', patterns: [/awswaf/i, /token\.aws/i] },
  { provider: 'text_canvas', category: 'captcha', patterns: [/canvas captcha/i, /text captcha/i] },
  { provider: 'drag_drop', category: 'captcha', patterns: [/drag.*drop/i, /slide.*verify/i] },
  { provider: 'audio_video', category: 'captcha', patterns: [/audio challenge/i, /video challenge/i] },
];

const REAL_ACCOUNT_KINDS = new Set(['leboncoin', 'france_travail', 'banking', 'email', 'admin', 'personal']);
const SECRET_KEY_RE = /(cookie|authorization|token|secret|password|otp|code|payload|captcha|challenge)/i;

function redactUrl(value) {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_RE.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return String(value || '').replace(/([?&][^=]*(?:token|secret|key|code|payload)[^=]*=)[^&]+/gi, '$1[REDACTED]');
  }
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactObject(nested);
  }
  return out;
}

export function classifyChallengeSignal({ url = '', text = '', frameName = '' } = {}) {
  const haystack = `${url}
${text}
${frameName}`;
  for (const candidate of CHALLENGE_PROVIDERS) {
    if (candidate.patterns.some((pattern) => pattern.test(haystack))) {
      return { detected: true, provider: candidate.provider, category: candidate.category, url: redactUrl(url) };
    }
  }
  return { detected: false, provider: null, category: null, url: redactUrl(url) };
}

export function collectChallengeDiagnostics({ url = '', title = '', frames = [], headers = {}, devicePixelRatio } = {}) {
  const pageSignal = classifyChallengeSignal({ url, text: title });
  const frameDiagnostics = frames.map((frame) => {
    const signal = classifyChallengeSignal({ url: frame.url, text: frame.title || '', frameName: frame.name || '' });
    return {
      detected: signal.detected,
      provider: signal.provider,
      category: signal.category,
      url: redactUrl(frame.url || ''),
      name: frame.name || '',
      boundingBox: frame.boundingBox || null,
      devicePixelRatio,
    };
  });
  const detectedFrame = frameDiagnostics.find((frame) => frame.detected);
  return redactObject({
    detected: pageSignal.detected || Boolean(detectedFrame),
    provider: pageSignal.provider || detectedFrame?.provider || null,
    category: pageSignal.category || detectedFrame?.category || null,
    url: redactUrl(url),
    title,
    frames: frameDiagnostics,
    headers,
    devicePixelRatio,
  });
}

export function normalizeChallengeResolutionConfig(input = {}) {
  const mode = ['manual_vnc', 'disabled', 'auto_controlled_lab_only'].includes(input.mode) ? input.mode : 'manual_vnc';
  const allowlist = Array.isArray(input.allowlist) ? input.allowlist.map(String).filter(Boolean) : [];
  return { mode, allowlist };
}

function isAllowlisted(url, allowlist) {
  if (!allowlist?.length) return false;
  try {
    const host = new URL(url).hostname;
    return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
  } catch {
    return false;
  }
}

export function resolveChallengePolicy(signal = {}, config = normalizeChallengeResolutionConfig(), context = {}) {
  if (!signal.detected) return { ok: true, action: 'continue' };
  const normalized = normalizeChallengeResolutionConfig(config);
  if (normalized.mode === 'disabled') {
    return { ok: false, error: 'challenge_blocked', exposeVnc: false, retryAllowed: false, llmRepairAllowed: false, checkpointAfterHuman: false };
  }
  if (normalized.mode === 'auto_controlled_lab_only') {
    const realAccount = REAL_ACCOUNT_KINDS.has(String(context.managedAccountKind || '').toLowerCase());
    const allowed = !realAccount && isAllowlisted(signal.url || context.url || '', normalized.allowlist);
    if (allowed) return { ok: false, error: 'human_required', autoAllowed: true, controlledLabOnly: true, exposeVnc: false, retryAllowed: false, llmRepairAllowed: false };
    return { ok: false, error: 'human_required', autoAllowed: false, exposeVnc: true, retryAllowed: false, llmRepairAllowed: false, checkpointAfterHuman: true };
  }
  return { ok: false, error: 'human_required', exposeVnc: true, retryAllowed: false, llmRepairAllowed: false, checkpointAfterHuman: true };
}

export { CHALLENGE_PROVIDERS };
