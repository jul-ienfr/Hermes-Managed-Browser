function parseResolution(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)(?:x\d+)?$/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function sizeFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const width = Number(value.width ?? value.outerWidth ?? value.innerWidth);
  const height = Number(value.height ?? value.outerHeight ?? value.innerHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function issue(key, expected, actual) {
  return { key, expected, actual };
}

function validateVncGeometry({ expected = {}, observed = {} } = {}) {
  const issues = [];
  const expectedWindow = sizeFrom(expected.profileWindowSize || expected.screen || expected.viewport);
  const expectedRoot = sizeFrom(expected.root || expectedWindow);
  const registryRoot = sizeFrom(observed.registry?.profileWindowSize) || parseResolution(observed.registry?.resolution);
  const browserViewport = sizeFrom(observed.browser?.viewport);
  const browserScreen = sizeFrom(observed.browser?.screen);
  const browserOuter = observed.browser?.viewport
    ? sizeFrom({ width: observed.browser.viewport.outerWidth, height: observed.browser.viewport.outerHeight })
    : null;

  if (expectedWindow && registryRoot && (registryRoot.width !== expectedWindow.width || registryRoot.height !== expectedWindow.height)) {
    issues.push(issue('vnc_registry_size_mismatch', expectedWindow, registryRoot));
  }
  if (expectedRoot && browserScreen) {
    const screenTooSmall = browserScreen.width < expectedRoot.width || browserScreen.height < expectedRoot.height;
    const outerTooLargeForRoot = browserOuter && (browserOuter.width > expectedRoot.width || browserOuter.height > expectedRoot.height);
    if (screenTooSmall || outerTooLargeForRoot) {
      issues.push(issue('browser_window_exceeds_vnc_root', expectedRoot, { screen: browserScreen, outer: browserOuter }));
    }
  }
  if (expectedWindow && browserViewport && (browserViewport.width > expectedWindow.width || browserViewport.height > expectedWindow.height)) {
    issues.push(issue('browser_viewport_exceeds_profile_window', expectedWindow, browserViewport));
  }
  if (expectedWindow && browserOuter && (browserOuter.width > expectedWindow.width + 16 || browserOuter.height > expectedWindow.height + 96)) {
    issues.push(issue('browser_outer_exceeds_profile_window', expectedWindow, browserOuter));
  }
  if (expectedWindow && observed.x11?.root && (observed.x11.root.width !== expectedWindow.width || observed.x11.root.height !== expectedWindow.height)) {
    issues.push(issue('x11_root_not_profile_window', expectedWindow, observed.x11.root));
  }
  if (observed.x11?.window && observed.x11?.root && (observed.x11.window.width > observed.x11.root.width || observed.x11.window.height > observed.x11.root.height)) {
    issues.push(issue('x11_window_exceeds_root', observed.x11.root, observed.x11.window));
  }
  return { ok: issues.length === 0, issues };
}

export {
  parseResolution,
  validateVncGeometry,
};
