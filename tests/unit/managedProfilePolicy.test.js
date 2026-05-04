import {
  detectSensitivePolicyChange,
  profilePolicyFromLaunchProfile,
} from '../../lib/managed-profile-policy.js';

describe('managed profile policy', () => {
  test('builds a stable per-profile policy with fill-profile VNC invariant', () => {
    const policy = profilePolicyFromLaunchProfile('courses-intermarche', {
      persona: {
        version: 2,
        os: 'windows',
        languages: ['fr-FR', 'fr'],
        timezoneId: 'Europe/Paris',
        screen: { width: 1600, height: 900 },
        window: { outerWidth: 1600, outerHeight: 900 },
        viewport: { width: 1600, height: 900 },
        webglConfig: ['Intel', 'Intel(R) HD Graphics, or similar'],
      },
      managedDisplayPolicy: {
        invariant: 'xvfb-root-equals-window-equals-viewport',
        profileWindowSize: { width: 1600, height: 900 },
        maxVncSize: { width: 1920, height: 1080 },
      },
    });

    expect(policy).toMatchObject({
      version: 1,
      profile: 'courses-intermarche',
      os: 'windows',
      screen: { width: 1600, height: 900 },
      vnc: {
        mode: 'fill-profile',
        invariant: 'xvfb-root-equals-window-equals-viewport',
        profileWindowSize: { width: 1600, height: 900 },
      },
    });
    expect(policy.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('detects sensitive changes requiring explicit profile migration', () => {
    const oldPolicy = { hash: 'old', os: 'windows', screen: { width: 1366, height: 768 }, locale: ['fr-FR'] };
    const nextPolicy = { hash: 'next', os: 'windows', screen: { width: 1600, height: 900 }, locale: ['fr-FR'] };
    expect(detectSensitivePolicyChange(oldPolicy, nextPolicy)).toEqual(['screen']);
  });
});
