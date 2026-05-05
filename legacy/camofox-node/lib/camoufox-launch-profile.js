import { generateFingerprint } from 'camoufox-js/dist/fingerprints.js';

function normalizedLocale(locale) {
  if (Array.isArray(locale)) return locale.filter(Boolean);
  if (locale) return [locale];
  return [];
}

function exactScreenConstraint(screen) {
  // Already in {minWidth, maxWidth, minHeight, maxHeight} constraint format
  if (screen && typeof screen === 'object' && 'minWidth' in screen) {
    const { minWidth, maxWidth, minHeight, maxHeight } = screen;
    if (Number.isFinite(minWidth) && Number.isFinite(maxWidth) && Number.isFinite(minHeight) && Number.isFinite(maxHeight) &&
        minWidth >= 0 && maxWidth > 0 && minHeight >= 0 && maxHeight > 0) {
      return { minWidth, maxWidth, minHeight, maxHeight };
    }
    return undefined;
  }
  // {width, height} format from persona
  const width = Number.parseInt(String(screen?.width || ''), 10);
  const height = Number.parseInt(String(screen?.height || ''), 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
  return { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height };
}

function exactWindowTuple(windowLike) {
  if (Array.isArray(windowLike) && windowLike.length >= 2) {
    const width = Number.parseInt(String(windowLike[0]), 10);
    const height = Number.parseInt(String(windowLike[1]), 10);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return [width, height];
  }
  const width = Number.parseInt(String(windowLike?.outerWidth ?? windowLike?.width ?? ''), 10);
  const height = Number.parseInt(String(windowLike?.outerHeight ?? windowLike?.height ?? ''), 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return undefined;
  return [width, height];
}

function webglTuple(value) {
  if (Array.isArray(value) && value.length >= 2) return [value[0], value[1]];
  if (value?.vendor && value?.renderer) return [value.vendor, value.renderer];
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function resolveFingerprintGeneratorConfig(launchProfile = {}) {
  const persona = launchProfile.persona || {};
  const constraints = launchProfile.launchConstraints || {};
  const os = firstDefined(constraints.os, persona.os);
  const screen = exactScreenConstraint(firstDefined(constraints.screen, persona.screen));
  const window = exactWindowTuple(firstDefined(constraints.window, persona.window));
  const config = {};
  if (screen) config.screen = screen;
  if (os) config.operatingSystems = Array.isArray(os) ? os : [os];
  return { window, config };
}

function generateCanonicalFingerprint(launchProfile = {}) {
  const { window, config } = resolveFingerprintGeneratorConfig(launchProfile);
  const originalScreen = config?.screen;
  const osOnlyConfig = { operatingSystems: config?.operatingSystems };

  // Progressively relax the screen constraint if exact fails, never drop it.
  // Dropping the screen falls back to BrowserForge defaults (e.g. 1920×1080)
  // which then gets persisted as the canonical fingerprint, causing a permanent
  // window.screen vs persona mismatch on subsequent launches.
  const attempts = [];
  if (originalScreen) {
    // Exact
    attempts.push([window, config]);
    attempts.push([undefined, config]);
    // Relaxed by 100px, 200px, 400px
    for (const tol of [100, 200, 400]) {
      const relaxed = {
        minWidth: Math.max(0, originalScreen.minWidth - tol),
        maxWidth: originalScreen.maxWidth + tol,
        minHeight: Math.max(0, originalScreen.minHeight - tol),
        maxHeight: originalScreen.maxHeight + tol,
      };
      attempts.push([window, { ...config, screen: relaxed }]);
      attempts.push([undefined, { ...config, screen: relaxed }]);
    }
  }
  // Last resort: drop screen entirely (only when there was no constraint to begin with)
  // When a screen constraint exists, we already tried exact + 3 relax levels above,
  // so this last-resort path is extremely unlikely.
  attempts.push([window, osOnlyConfig]);
  attempts.push([undefined, osOnlyConfig]);

  let lastError;
  for (const [candidateWindow, candidateConfig] of attempts) {
    try {
      const compactConfig = Object.fromEntries(Object.entries(candidateConfig || {}).filter(([, value]) => value !== undefined));
      return generateFingerprint(candidateWindow, compactConfig);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function buildCamoufoxLaunchOptionsInput(launchProfile = {}, options = {}) {
  const persona = launchProfile.persona || {};
  const constraints = launchProfile.launchConstraints || {};
  const persistedFingerprint = launchProfile.persistedFingerprint || options.persistedFingerprint;
  const out = {};

  if (options.headless !== undefined) out.headless = options.headless;
  const os = firstDefined(constraints.os, persona.os);
  if (os) out.os = os;

  const locale = firstDefined(constraints.locale, persona.locale);
  if (locale) out.locale = Array.isArray(locale) ? locale : locale;

  if (persistedFingerprint) {
    out.fingerprint = persistedFingerprint;
  } else {
    const screen = exactScreenConstraint(firstDefined(constraints.screen, persona.screen));
    if (screen) out.screen = screen;
  }

  const windowTuple = exactWindowTuple(firstDefined(constraints.window, persona.window));
  if (windowTuple) out.window = windowTuple;

  const explicitWebgl = firstDefined(constraints.webglConfig, constraints.webgl_config, persona.webglConfig, persona.webgl_config);
  const webgl = webglTuple(explicitWebgl);
  if (webgl && out.os) out.webgl_config = webgl;

  const firefoxUserPrefs = firstDefined(constraints.firefoxUserPrefs, constraints.firefox_user_prefs, launchProfile.firefoxUserPrefs, persona.firefoxUserPrefs);
  if (firefoxUserPrefs && typeof firefoxUserPrefs === 'object') out.firefox_user_prefs = firefoxUserPrefs;
  if (options.humanize !== undefined) out.humanize = options.humanize;
  if (options.virtualDisplay) out.virtual_display = options.virtualDisplay;
  if (options.proxy) out.proxy = options.proxy;
  if (options.geoip !== undefined) out.geoip = options.geoip;
  return out;
}

function expectedFingerprintFromLaunchProfile(launchProfile = {}) {
  const persona = launchProfile.persona || {};
  const constraints = launchProfile.launchConstraints || {};
  const contextDefaults = launchProfile.contextDefaults || {};
  const persisted = launchProfile.persistedFingerprint;
  const nav = persisted?.navigator || {};
  const fpLanguages = Array.isArray(nav.languages) ? nav.languages : undefined;
  const personaLanguages = normalizedLocale(persona.languages || persona.locale || contextDefaults.locale);
  const locale = persona.locale || contextDefaults.locale || fpLanguages?.[0] || personaLanguages[0];
  const fingerprintScreen = persisted?.screen?.width && persisted?.screen?.height
    ? { width: persisted.screen.width, height: persisted.screen.height }
    : undefined;
  const windowTuple = exactWindowTuple(firstDefined(constraints.window, persona.window, contextDefaults.viewport));
  const expected = {};
  if (locale) expected.locale = Array.isArray(locale) ? locale[0] : locale;
  if (personaLanguages.length) expected.languages = personaLanguages;
  else if (fpLanguages?.length) expected.languages = fpLanguages;
  if (contextDefaults.timezoneId || persona.timezoneId || constraints.timezoneId) expected.timezoneId = contextDefaults.timezoneId || persona.timezoneId || constraints.timezoneId;
  if (persona.platform || nav.platform) expected.platform = persona.platform || nav.platform;
  if (fingerprintScreen || persona.screen) expected.screen = fingerprintScreen || persona.screen;
  if (windowTuple) expected.viewport = { width: windowTuple[0], height: windowTuple[1] };
  else if (persona.viewport || contextDefaults.viewport) expected.viewport = persona.viewport || contextDefaults.viewport;
  const explicitWebgl = webglTuple(firstDefined(constraints.webglConfig, constraints.webgl_config, persona.webglConfig, persona.webgl_config));
  const fpWebgl = webglTuple(persisted?.webGlBasics || persisted?.webgl || persisted?.webglBasics);
  const webgl = fpWebgl || explicitWebgl;
  if (webgl) expected.webgl = { vendor: webgl[0], renderer: webgl[1] };
  if (persona.doNotTrack !== undefined) expected.doNotTrack = persona.doNotTrack;
  return expected;
}

export {
  buildCamoufoxLaunchOptionsInput,
  expectedFingerprintFromLaunchProfile,
  generateCanonicalFingerprint,
  resolveFingerprintGeneratorConfig,
};
