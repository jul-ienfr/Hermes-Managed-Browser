import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCamoufoxLaunchOptionsInput,
  expectedFingerprintFromLaunchProfile,
  generateCanonicalFingerprint,
} from '../../lib/camoufox-launch-profile.js';
import {
  getUserPersistencePaths,
  loadPersistedFingerprint,
  persistFingerprint,
} from '../../lib/persistence.js';

describe('Camoufox managed launch profile', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-launch-profile-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('builds canonical high-level Camoufox options from persisted persona', () => {
    const launchProfile = {
      persona: {
        os: 'windows',
        locale: ['fr-FR', 'fr', 'en-US', 'en'],
        screen: { width: 1600, height: 900 },
        window: { outerWidth: 1600, outerHeight: 900 },
        webglConfig: ['Intel Inc.', 'Intel Iris OpenGL Engine'],
        firefoxUserPrefs: { 'privacy.donottrackheader.enabled': false },
      },
      launchConstraints: { os: 'windows', locale: ['fr-FR', 'fr', 'en-US', 'en'] },
      contextDefaults: { timezoneId: 'Europe/Paris', viewport: { width: 1600, height: 900 } },
    };

    const options = buildCamoufoxLaunchOptionsInput(launchProfile, {
      headless: false,
      virtualDisplay: ':1115',
      humanize: true,
    });

    expect(options).toMatchObject({
      headless: false,
      os: 'windows',
      locale: ['fr-FR', 'fr', 'en-US', 'en'],
      screen: { minWidth: 1600, maxWidth: 1600, minHeight: 900, maxHeight: 900 },
      window: [1600, 900],
      webgl_config: ['Intel Inc.', 'Intel Iris OpenGL Engine'],
      humanize: true,
      virtual_display: ':1115',
      firefox_user_prefs: { 'privacy.donottrackheader.enabled': false },
    });
    expect(options).not.toHaveProperty('args');
    expect(options).not.toHaveProperty('headers');
  });

  test('generates a canonical BrowserForge fingerprint before launchOptions when none is persisted', () => {
    const launchProfile = {
      persona: {
        os: 'windows',
        screen: { width: 1366, height: 768 },
        window: { outerWidth: 1366, outerHeight: 768 },
      },
      launchConstraints: { os: 'windows' },
    };

    const fingerprint = generateCanonicalFingerprint(launchProfile);
    expect(fingerprint.navigator.platform).toBe('Win32');
    expect(fingerprint.screen).toMatchObject({ width: 1366, height: 768 });
  });

  test('reuses a persisted Camoufox fingerprint instead of regenerating for same profile', async () => {
    const fingerprint = {
      navigator: { userAgent: 'Mozilla/5.0', platform: 'Win32' },
      screen: { width: 1600, height: 900 },
    };
    const saved = await persistFingerprint({
      profileDir: tmpDir,
      userId: 'courses-intermarche',
      fingerprint,
      metadata: { source: 'camoufox-js', camoufoxVersion: '0.8.5' },
    });

    expect(saved.persisted).toBe(true);
    const loaded = await loadPersistedFingerprint(tmpDir, 'courses-intermarche');
    expect(loaded.fingerprint).toEqual(fingerprint);
    expect(loaded.metadata).toMatchObject({ source: 'camoufox-js', camoufoxVersion: '0.8.5' });

    const options = buildCamoufoxLaunchOptionsInput({
      persona: { os: 'windows', locale: 'fr-FR', screen: { width: 1600, height: 900 } },
      persistedFingerprint: loaded.fingerprint,
    });
    expect(options.fingerprint).toEqual(fingerprint);
    expect(options.screen).toBeUndefined();
  });

  test('persistence paths include fingerprint files under per-user profile directory', () => {
    const paths = getUserPersistencePaths(tmpDir, 'agent/profile:default');
    expect(paths.fingerprintPath).toBe(path.join(paths.userDir, 'fingerprint.json'));
    expect(paths.fingerprintMetaPath).toBe(path.join(paths.userDir, 'fingerprint-meta.json'));
  });

  test('derives expected coherence fingerprint from persona and context defaults', () => {
    const expected = expectedFingerprintFromLaunchProfile({
      persona: {
        locale: ['fr-FR', 'fr', 'en-US', 'en'],
        platform: 'Win32',
        screen: { width: 1600, height: 900 },
        viewport: { width: 1600, height: 900 },
        webglConfig: ['Intel Inc.', 'Intel Iris OpenGL Engine'],
        doNotTrack: '0',
      },
      contextDefaults: { timezoneId: 'Europe/Paris' },
    });

    expect(expected).toMatchObject({
      locale: 'fr-FR',
      languages: ['fr-FR', 'fr', 'en-US', 'en'],
      timezoneId: 'Europe/Paris',
      platform: 'Win32',
      screen: { width: 1600, height: 900 },
      viewport: { width: 1600, height: 900 },
      doNotTrack: '0',
    });
  });
});
