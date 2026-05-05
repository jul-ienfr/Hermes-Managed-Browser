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

function screenMismatch(expectedScreen, observedScreen, tolerance = 2) {
  if (!expectedScreen || !observedScreen) return false;
  const expectedWidth = Number(expectedScreen.width);
  const expectedHeight = Number(expectedScreen.height);
  const observedWidth = Number(observedScreen.width);
  const observedHeight = Number(observedScreen.height);
  return Math.abs(expectedWidth - observedWidth) > tolerance || Math.abs(expectedHeight - observedHeight) > tolerance;
}

function expectedWebglFrom(value) {
  if (!value) return null;
  if (Array.isArray(value)) return { vendor: value[0], renderer: value[1] };
  return value;
}

export function validateFingerprintCoherence({ expected = {}, observed = {} } = {}) {
  const issues = [];
  const expectedLocalePrefix = String(expected.locale || '').split('-')[0];
  const languages = observed.languages || [];
  if (expected.locale && !languages.some((lang) => String(lang).toLowerCase().startsWith(expectedLocalePrefix.toLowerCase()))) {
    issues.push(issue('language_locale_mismatch', expected.locale, languages));
  }
  if (Array.isArray(expected.languages) && expected.languages.length > 0) {
    const primaryExpected = String(expected.languages[0] || '').toLowerCase();
    const primaryObserved = String(languages[0] || '').toLowerCase();
    const missingLanguages = expected.languages.filter((lang) => !languages.includes(lang));
    if (missingLanguages.length > 0 && primaryExpected !== primaryObserved) issues.push(issue('languages_mismatch', expected.languages, languages));
  }
  if (expected.timezoneId && observed.timezoneId && expected.timezoneId !== observed.timezoneId) {
    issues.push(issue('timezone_mismatch', expected.timezoneId, observed.timezoneId));
  }
  if (expected.platform && observed.platform && !String(observed.platform).toLowerCase().includes(String(expected.platform).slice(0, 3).toLowerCase())) {
    issues.push(issue('platform_mismatch', expected.platform, observed.platform));
  }
  if (observed.webdriver === true) issues.push(issue('webdriver_exposed', false, true));
  if (expected.viewport && observed.viewport) {
    const actualWidth = Number(observed.viewport.outerWidth || observed.viewport.width);
    const actualHeight = Number(observed.viewport.outerHeight || observed.viewport.height);
    const dw = Math.abs(Number(expected.viewport.width) - actualWidth);
    const dh = Math.abs(Number(expected.viewport.height) - actualHeight);
    if (dw > 2 || dh > 2) issues.push(issue('viewport_mismatch', expected.viewport, observed.viewport));
  }
  if (screenMismatch(expected.screen, observed.screen)) issues.push(issue('screen_mismatch', expected.screen, observed.screen));
  if (observed.screen && observed.viewport) {
    const viewportTooLarge = Number(observed.viewport.width) > Number(observed.screen.width) || Number(observed.viewport.height) > Number(observed.screen.height);
    if (viewportTooLarge) issues.push(issue('viewport_exceeds_screen', observed.screen, observed.viewport));
  }
  const expectedWebgl = expectedWebglFrom(expected.webgl || expected.webglConfig);
  if (expectedWebgl && observed.webgl) {
    const vendorMismatch = expectedWebgl.vendor && observed.webgl.vendor && expectedWebgl.vendor !== observed.webgl.vendor;
    const rendererMismatch = expectedWebgl.renderer && observed.webgl.renderer && expectedWebgl.renderer !== observed.webgl.renderer;
    if (vendorMismatch || rendererMismatch) issues.push(issue('webgl_mismatch', expectedWebgl, observed.webgl));
  }
  if (expected.doNotTrack !== undefined && observed.doNotTrack !== undefined && String(expected.doNotTrack) !== String(observed.doNotTrack)) {
    issues.push(issue('donottrack_mismatch', expected.doNotTrack, observed.doNotTrack));
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
      viewport: { width: window.innerWidth, height: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight },
      doNotTrack: navigator.doNotTrack,
      devicePixelRatio: window.devicePixelRatio,
      webgl: (() => {
        try {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          const debug = gl?.getExtension?.('WEBGL_debug_renderer_info');
          if (!gl || !debug) return null;
          return {
            vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
            renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
          };
        } catch {
          return null;
        }
      })(),
    };
  });
  return redactFingerprintDiagnostics({ ...browserFields, playwrightViewport: viewport });
}
