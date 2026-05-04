const DEFAULT_VNC_BOUNDS = Object.freeze({ width: 1920, height: 1080 });

const VNC_WINDOW_MARGIN = Object.freeze({ width: 0, height: 0 });

// Managed Browser has two simultaneous requirements:
// 1. every managed profile must expose a different, stable browser/window size to sites;
// 2. the human noVNC view should not show black margins around a smaller browser window.
// The VNC plugin therefore starts each profile on an Xvfb root matching this size,
// while the browser persona/window/viewport use the same per-profile dimensions.
const DEFAULT_MANAGED_PROFILE_WINDOW_SIZE = Object.freeze({ width: 1600, height: 900 });

function hashedManagedProfileWindowSize(userId) {
  const sizes = [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1600, height: 900 },
    { width: 1680, height: 945 },
  ];
  let hash = 0;
  for (const char of String(userId || '')) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
  return sizes[hash % sizes.length] || DEFAULT_MANAGED_PROFILE_WINDOW_SIZE;
}

const MANAGED_PROFILE_WINDOW_SIZES = new Map([
  ['leboncoin-cim', { width: 1920, height: 1080 }],
  ['leboncoin-ge', { width: 1680, height: 945 }],
  ['vinted-main', { width: 1440, height: 900 }],
  ['emploi-candidature', { width: 1600, height: 900 }],
  ['emploi-officiel', { width: 1440, height: 900 }],
  ['courses', { width: 1536, height: 864 }],
  ['courses-auchan', { width: 1366, height: 768 }],
  ['courses-intermarche', { width: 1600, height: 900 }],
]);

function parseDisplaySize(value, fallback = DEFAULT_VNC_BOUNDS) {
  if (value && typeof value === 'object') {
    const width = Number.parseInt(String(value.width), 10);
    const height = Number.parseInt(String(value.height), 10);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  }
  const match = String(value || '').match(/(\d{3,5})\s*x\s*(\d{3,5})/i);
  if (!match) return { ...fallback };
  return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
}

function normalizeWindowSize(size, bounds = DEFAULT_VNC_BOUNDS) {
  const parsed = parseDisplaySize(size, bounds);
  const normalizedBounds = parseDisplaySize(bounds, DEFAULT_VNC_BOUNDS);
  return {
    width: Math.min(parsed.width, normalizedBounds.width),
    height: Math.min(parsed.height, normalizedBounds.height),
  };
}

function safeManagedWindowBounds(bounds = DEFAULT_VNC_BOUNDS, margin = VNC_WINDOW_MARGIN) {
  const parsed = parseDisplaySize(bounds, DEFAULT_VNC_BOUNDS);
  const marginWidth = Math.max(0, Number.parseInt(String(margin?.width ?? 0), 10) || 0);
  const marginHeight = Math.max(0, Number.parseInt(String(margin?.height ?? 0), 10) || 0);
  return {
    width: Math.max(1, parsed.width - marginWidth),
    height: Math.max(1, parsed.height - marginHeight),
  };
}


function managedProfileWindowSize(userId, options = {}) {
  const bounds = safeManagedWindowBounds(options.vncBounds || DEFAULT_VNC_BOUNDS, options.margin || VNC_WINDOW_MARGIN);
  const configured = MANAGED_PROFILE_WINDOW_SIZES.get(String(userId)) || hashedManagedProfileWindowSize(userId);
  return normalizeWindowSize(configured, bounds);
}

function managedProfileDisplayResolution(profile, depth = 24) {
  const size = profile?.managedDisplayPolicy?.profileWindowSize || profile?.persona?.screen || profile?.contextDefaults?.viewport;
  const width = Number.parseInt(String(size?.width || ''), 10);
  const height = Number.parseInt(String(size?.height || ''), 10);
  const normalizedDepth = Number.parseInt(String(depth), 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
  return `${width}x${height}x${Number.isFinite(normalizedDepth) && normalizedDepth > 0 ? normalizedDepth : 24}`;
}

function managedProfileLaunchArgs(profile, options = {}) {
  const bounds = safeManagedWindowBounds(options.vncBounds || DEFAULT_VNC_BOUNDS, options.margin || VNC_WINDOW_MARGIN);
  const launchWindow = normalizeWindowSize({
    width: profile?.persona?.window?.outerWidth,
    height: profile?.persona?.window?.outerHeight,
  }, bounds);
  const width = Number.parseInt(String(launchWindow?.width || ''), 10);
  const height = Number.parseInt(String(launchWindow?.height || ''), 10);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];
  return [
    `--width=${width}`,
    `--height=${height}`,
    `--window-size=${width},${height}`,
  ];
}

function withManagedProfileLaunchArgs(options = {}, profile) {
  const sizingArgs = managedProfileLaunchArgs(profile);
  if (sizingArgs.length === 0) return options;
  const withoutConflictingSizeArgs = (options.args || []).filter((arg) => !/^--(?:width|height|window-size)=/.test(String(arg)));
  return {
    ...options,
    args: [...withoutConflictingSizeArgs, ...sizingArgs],
  };
}

function enforceProfileWindowBounds(profile, { userId, vncBounds = DEFAULT_VNC_BOUNDS } = {}) {
  if (!profile || typeof profile !== 'object') return profile;
  const size = managedProfileWindowSize(userId, { vncBounds });
  if (!size) return profile;

  const persona = {
    ...(profile.persona || {}),
    screen: { ...size },
    window: { outerWidth: size.width, outerHeight: size.height },
    viewport: { ...size },
    deviceScaleFactor: 1,
  };
  return {
    ...profile,
    persona,
    contextDefaults: {
      ...(profile.contextDefaults || {}),
      viewport: { ...size },
      deviceScaleFactor: 1,
    },
    managedDisplayPolicy: {
      ...(profile.managedDisplayPolicy || {}),
      profileWindowSize: { ...size },
      maxVncSize: { ...parseDisplaySize(vncBounds, DEFAULT_VNC_BOUNDS) },
      safeMaxWindowSize: { ...safeManagedWindowBounds(vncBounds, VNC_WINDOW_MARGIN) },
      margin: { ...VNC_WINDOW_MARGIN },
      invariant: 'profile_window_size_must_not_exceed_vnc_display',
    },
  };
}

export {
  DEFAULT_VNC_BOUNDS,
  MANAGED_PROFILE_WINDOW_SIZES,
  VNC_WINDOW_MARGIN,
  enforceProfileWindowBounds,
  managedProfileDisplayResolution,
  managedProfileLaunchArgs,
  managedProfileWindowSize,
  normalizeWindowSize,
  parseDisplaySize,
  safeManagedWindowBounds,
  withManagedProfileLaunchArgs,
};
