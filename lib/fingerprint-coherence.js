const SECRET_KEY_RE = /(cookie|authorization|token|secret|password|otp|code|payload|captcha|challenge)/i;

export function redactFingerprintDiagnostics(value) {
  if (Array.isArray(value)) return value.map(redactFingerprintDiagnostics);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[REDACTED]' : redactFingerprintDiagnostics(nested);
  }
  return out;
}

function issue(key, expected, actual) {
  return { key, expected, actual };
}

export function validateFingerprintCoherence({ expected = {}, observed = {} } = {}) {
  const issues = [];
  const expectedLocalePrefix = String(expected.locale || '').split('-')[0];
  const languages = observed.languages || [];
  if (expected.locale && !languages.some((lang) => String(lang).toLowerCase().startsWith(expectedLocalePrefix.toLowerCase()))) {
    issues.push(issue('language_locale_mismatch', expected.locale, languages));
  }
  if (expected.timezoneId && observed.timezoneId && expected.timezoneId !== observed.timezoneId) {
    issues.push(issue('timezone_mismatch', expected.timezoneId, observed.timezoneId));
  }
  if (expected.platform && observed.platform && !String(observed.platform).toLowerCase().includes(String(expected.platform).slice(0, 3).toLowerCase())) {
    issues.push(issue('platform_mismatch', expected.platform, observed.platform));
  }
  if (observed.webdriver === true) issues.push(issue('webdriver_exposed', false, true));
  if (expected.viewport && observed.viewport) {
    const dw = Math.abs(Number(expected.viewport.width) - Number(observed.viewport.width));
    const dh = Math.abs(Number(expected.viewport.height) - Number(observed.viewport.height));
    if (dw > 2 || dh > 2) issues.push(issue('viewport_mismatch', expected.viewport, observed.viewport));
  }
  if (observed.storage && (observed.storage.cookiesEnabled === false || observed.storage.localStorageAvailable === false)) {
    issues.push(issue('storage_unavailable', true, observed.storage));
  }
  return { ok: issues.length === 0, issues: redactFingerprintDiagnostics(issues) };
}

export async function collectBrowserFingerprintSnapshot(page) {
  const viewport = page?.viewportSize?.() || null;
  const browserFields = await page.evaluate(() => {
    let localStorageAvailable = false;
    try {
      const key = '__camofox_fp_probe__';
      window.localStorage.setItem(key, '1');
      window.localStorage.removeItem(key);
      localStorageAvailable = true;
    } catch {}
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: Array.from(navigator.languages || []),
      language: navigator.language,
      webdriver: navigator.webdriver,
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      storage: { cookiesEnabled: navigator.cookieEnabled, localStorageAvailable },
      screen: { width: window.screen.width, height: window.screen.height, availWidth: window.screen.availWidth, availHeight: window.screen.availHeight },
      devicePixelRatio: window.devicePixelRatio,
    };
  });
  return redactFingerprintDiagnostics({ ...browserFields, viewport });
}
