import crypto from 'node:crypto';
import { managedProfileWindowSize } from './managed-browser-display-size.js';

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
const PERSONA_HARDWARE_CONCURRENCY = [4, 6, 8, 10, 12, 16];
const PERSONA_DEVICE_MEMORY_GB = [4, 8, 12, 16, 24, 32];
const PERSONA_DEVICE_SCALE_FACTORS = [1, 1.25, 1.5, 2];
const MANAGED_LEBONCOIN_VISIBLE_DISPLAY = Object.freeze({ width: 1920, height: 1080 });
const FRENCH_RESIDENTIAL_LOCALE_PROFILE = Object.freeze({
  locale: 'fr-FR',
  languages: ['fr-FR', 'fr', 'en-US', 'en'],
  timezoneId: 'Europe/Paris',
  // Coherent with Julien's home region / French-residential use case.
  geolocation: { latitude: 46.2044, longitude: 6.1432 },
});
const MANAGED_BROWSER_PERSONAS = new Map([
  ['leboncoin-cim', { screen: { width: 1920, height: 1080 }, hardwareConcurrency: 8, deviceMemory: 16 }],
  ['leboncoin-ge', { screen: { width: 1680, height: 945 }, hardwareConcurrency: 6, deviceMemory: 12 }],
  ['vinted-main', { screen: { width: 1440, height: 900 }, hardwareConcurrency: 8, deviceMemory: 16 }],
  ['emploi-candidature', { screen: { width: 1600, height: 900 }, hardwareConcurrency: 8, deviceMemory: 16 }],
  ['emploi-officiel', { screen: { width: 1440, height: 900 }, hardwareConcurrency: 6, deviceMemory: 12 }],
  ['courses', { screen: { width: 1536, height: 864 }, hardwareConcurrency: 8, deviceMemory: 16 }],
  ['courses-auchan', { screen: { width: 1366, height: 768 }, hardwareConcurrency: 6, deviceMemory: 12 }],
  ['courses-intermarche', { screen: { width: 1600, height: 900 }, hardwareConcurrency: 8, deviceMemory: 16 }],
]);
const FRENCH_RESIDENTIAL_WEBGL = Object.freeze({
  vendor: 'Google Inc. (Intel)',
  renderer: 'ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0), or similar',
});

function clampScreen(screen, bounds = MANAGED_LEBONCOIN_VISIBLE_DISPLAY) {
  return {
    width: Math.min(screen.width, bounds.width),
    height: Math.min(screen.height, bounds.height),
  };
}

function buildManagedBrowserPersona(userId) {
  const profile = MANAGED_BROWSER_PERSONAS.get(String(userId));
  if (!profile) return null;
  return {
    os: 'windows',
    localeProfile: FRENCH_RESIDENTIAL_LOCALE_PROFILE,
    screen: managedProfileWindowSize(userId, { vncBounds: MANAGED_LEBONCOIN_VISIBLE_DISPLAY }) || clampScreen(profile.screen),
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: profile.deviceMemory,
    deviceScaleFactor: 1,
    webgl: FRENCH_RESIDENTIAL_WEBGL,
  };
}

function deterministicIndex(userId, salt, size) {
  const digest = crypto.createHash('sha256').update(`${salt}:${String(userId)}`).digest();
  return digest.readUInt32BE(0) % size;
}

function buildBrowserPersona(userId) {
  const fixed = buildManagedBrowserPersona(userId);
  const os = fixed?.os || PERSONA_OS[deterministicIndex(userId, 'os', PERSONA_OS.length)];
  const localeProfile = fixed?.localeProfile || PERSONA_LOCALES[deterministicIndex(userId, 'locale', PERSONA_LOCALES.length)];
  const screen = fixed?.screen || PERSONA_SCREENS[deterministicIndex(userId, 'screen', PERSONA_SCREENS.length)];
  const hardwareConcurrency = fixed?.hardwareConcurrency || PERSONA_HARDWARE_CONCURRENCY[deterministicIndex(userId, 'hardware-concurrency', PERSONA_HARDWARE_CONCURRENCY.length)];
  const deviceMemory = fixed?.deviceMemory || PERSONA_DEVICE_MEMORY_GB[deterministicIndex(userId, 'device-memory', PERSONA_DEVICE_MEMORY_GB.length)];
  const deviceScaleFactor = fixed?.deviceScaleFactor || PERSONA_DEVICE_SCALE_FACTORS[deterministicIndex(userId, 'device-scale-factor', PERSONA_DEVICE_SCALE_FACTORS.length)];
  const languages = localeProfile.languages || [localeProfile.locale, localeProfile.locale.split('-')[0]];
  const webgl = fixed?.webgl || null;

  return {
    version: 2,
    os,
    locale: localeProfile.locale,
    languages,
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
    deviceScaleFactor,
    hardwareConcurrency,
    deviceMemory,
    ...(webgl ? { webgl, webglConfig: [webgl.vendor, webgl.renderer] } : {}),
    firefoxUserPrefs: {
      'browser.startup.page': 0,
      'browser.sessionstore.resume_from_crash': true,
      'privacy.resistFingerprinting': false,
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
