import crypto from 'node:crypto';

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function policyHash(policy) {
  return crypto.createHash('sha256').update(stableStringify(policy)).digest('hex');
}

function profilePolicyFromLaunchProfile(userId, launchProfile = {}) {
  const persona = launchProfile.persona || {};
  const size = persona.screen || launchProfile.contextDefaults?.viewport || {};
  const policy = {
    version: 1,
    profile: String(userId),
    os: persona.os || launchProfile.launchConstraints?.os || null,
    locale: persona.languages || persona.locale || launchProfile.launchConstraints?.locale || null,
    timezoneId: persona.timezoneId || launchProfile.contextDefaults?.timezoneId || null,
    screen: size.width && size.height ? { width: Number(size.width), height: Number(size.height) } : null,
    window: persona.window || (size.width && size.height ? { outerWidth: Number(size.width), outerHeight: Number(size.height) } : null),
    viewport: persona.viewport || launchProfile.contextDefaults?.viewport || null,
    webglConfig: persona.webglConfig || persona.webgl_config || (persona.webgl ? [persona.webgl.vendor, persona.webgl.renderer] : null),
    firefoxUserPrefs: persona.firefoxUserPrefs || launchProfile.firefoxUserPrefs || null,
    vnc: {
      mode: 'fill-profile',
      invariant: launchProfile.managedDisplayPolicy?.invariant || 'xvfb-root-equals-window-equals-viewport',
      profileWindowSize: launchProfile.managedDisplayPolicy?.profileWindowSize || (size.width && size.height ? { width: Number(size.width), height: Number(size.height) } : null),
      maxVncSize: launchProfile.managedDisplayPolicy?.maxVncSize || null,
    },
  };
  return { ...policy, hash: policyHash(policy) };
}

function detectSensitivePolicyChange(previous = {}, next = {}) {
  if (!previous?.hash || previous.hash === next?.hash) return [];
  const sensitive = ['os', 'locale', 'timezoneId', 'screen', 'window', 'viewport', 'webglConfig'];
  return sensitive.filter((key) => stableStringify(previous[key]) !== stableStringify(next[key]));
}

export {
  detectSensitivePolicyChange,
  policyHash,
  profilePolicyFromLaunchProfile,
  stableStringify,
};
