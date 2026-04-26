import crypto from 'node:crypto';

const PERSONA_OS = ['windows', 'macos', 'linux'];
const PERSONA_LOCALES = [
  { locale: 'en-US', timezoneId: 'America/New_York', geolocation: { latitude: 40.7128, longitude: -74.006 } },
  { locale: 'fr-FR', timezoneId: 'Europe/Paris', geolocation: { latitude: 48.8566, longitude: 2.3522 } },
  { locale: 'en-GB', timezoneId: 'Europe/London', geolocation: { latitude: 51.5074, longitude: -0.1278 } },
  { locale: 'de-DE', timezoneId: 'Europe/Berlin', geolocation: { latitude: 52.52, longitude: 13.405 } },
];
// Keep this list restricted to screen sizes that camoufox-js can satisfy
// across all supported persona OSes when exact screen constraints are used.
const PERSONA_SCREENS = [
  { width: 1536, height: 864 },
  { width: 1728, height: 1117 },
  { width: 1920, height: 1080 },
];

function deterministicIndex(userId, salt, size) {
  const digest = crypto.createHash('sha256').update(`${salt}:${String(userId)}`).digest();
  return digest.readUInt32BE(0) % size;
}

function buildBrowserPersona(userId) {
  const os = PERSONA_OS[deterministicIndex(userId, 'os', PERSONA_OS.length)];
  const localeProfile = PERSONA_LOCALES[deterministicIndex(userId, 'locale', PERSONA_LOCALES.length)];
  const screen = PERSONA_SCREENS[deterministicIndex(userId, 'screen', PERSONA_SCREENS.length)];

  return {
    version: 1,
    os,
    locale: localeProfile.locale,
    timezoneId: localeProfile.timezoneId,
    geolocation: localeProfile.geolocation,
    screen,
    window: {
      outerWidth: screen.width,
      outerHeight: screen.height,
    },
    viewport: {
      width: screen.width,
      height: screen.height,
    },
    launchScreenConstraints: {
      minWidth: screen.width,
      maxWidth: screen.width,
      minHeight: screen.height,
      maxHeight: screen.height,
    },
  };
}

export {
  buildBrowserPersona,
};
