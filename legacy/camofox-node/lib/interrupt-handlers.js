function normalizeStateValue(value) {
  return String(value || '').toLowerCase();
}

function detectInterrupt(state = {}) {
  const haystack = [state.url, state.title, state.text].map(normalizeStateValue).join(' ');

  if (/captcha|êtes humain|human verification|security check|cloudflare/.test(haystack)) {
    return { type: 'human_verification', requires_human: true };
  }

  if (/cookies|accepter.*cookies|manage consent|préférences/.test(haystack)) {
    return { type: 'cookie_banner', requires_human: false };
  }

  if (/rate limit|too many requests|trop de requêtes|réessayez plus tard|429/.test(haystack)) {
    return { type: 'rate_limited', requires_human: false };
  }

  if (/connectez-vous|se connecter|login|connexion requise/.test(haystack)) {
    return { type: 'login_required', requires_human: false };
  }

  return null;
}

function adaptivePacingForInterrupt(interrupt, state = {}) {
  if (!interrupt) return { action: 'continue', delayMs: 0, reason: 'no_interrupt' };

  const profile = normalizeStateValue(state.profile || 'medium');
  const profileFactor = profile === 'slow' ? 1.35 : profile === 'fast' ? 0.75 : 1;
  const consecutive = Math.max(0, Number(state.consecutiveInterrupts || 0));
  const multiplier = Math.min(3, 1 + consecutive * 0.5);

  const scaled = (baseMs) => Math.round(baseMs * profileFactor * multiplier);

  if (interrupt.type === 'human_verification') {
    return { action: 'pause_for_human', delayMs: scaled(45000), reason: 'human_verification' };
  }

  if (interrupt.type === 'rate_limited') {
    return { action: 'backoff', delayMs: scaled(30000), reason: 'rate_limited' };
  }

  if (interrupt.type === 'login_required') {
    return { action: 'pause_for_login', delayMs: scaled(15000), reason: 'login_required' };
  }

  if (interrupt.type === 'cookie_banner') {
    return { action: 'handle_interrupt', delayMs: scaled(1500), reason: 'cookie_banner' };
  }

  return { action: 'backoff', delayMs: scaled(5000), reason: interrupt.type || 'unknown_interrupt' };
}

function chooseCookieConsentCandidate(candidates = []) {
  const preferences = [
    /continuer sans accepter/,
    /refuser/,
    /reject/,
    /tout refuser/,
    /accepter/,
    /accept/,
  ];

  for (const preference of preferences) {
    const match = (candidates || []).find((candidate) => {
      const label = normalizeStateValue(candidate?.name || candidate?.text);
      return preference.test(label);
    });

    if (match) {
      return match;
    }
  }

  return null;
}

export { adaptivePacingForInterrupt, chooseCookieConsentCandidate, detectInterrupt };
