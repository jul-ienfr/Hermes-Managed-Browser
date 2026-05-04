import { lifecycleStateForPolicy, shouldRotateManagedProfile, shouldWarmupManagedProfile } from '../../lib/managed-lifecycle.js';
import { resolveManagedBrowserProfile } from '../../lib/managed-browser-policy.js';

describe('managed browser lifecycle policy', () => {
  test('Leboncoin policies are manual warmup and manual rotation by default', () => {
    const policy = resolveManagedBrowserProfile({ profile: 'leboncoin-cim' });

    expect(policy.lifecyclePolicy).toEqual({
      warmup: { enabled: false, reason: 'manual-profile-only' },
      rotation: { mode: 'manual', maxSessionAgeMinutes: 240 },
    });
    expect(shouldWarmupManagedProfile(policy, { state: 'COLD' })).toEqual({
      shouldWarmup: false,
      reason: 'manual-profile-only',
    });
  });

  test('reports COLD READY and EXPIRED lifecycle states without side effects', () => {
    const policy = resolveManagedBrowserProfile({ profile: 'leboncoin-ge' });
    const oldReadySince = new Date(Date.now() - 241 * 60 * 1000).toISOString();

    expect(lifecycleStateForPolicy(policy)).toMatchObject({ state: 'COLD', currentTabId: null });
    expect(lifecycleStateForPolicy(policy, { currentTabId: 'tab-1', updatedAt: 'now' })).toMatchObject({
      state: 'READY',
      currentTabId: 'tab-1',
      updatedAt: 'now',
    });
    expect(lifecycleStateForPolicy(policy, { currentTabId: 'tab-1', readySince: oldReadySince })).toMatchObject({
      state: 'EXPIRED',
      currentTabId: 'tab-1',
    });
  });

  test('allows future warmup-enabled profiles to opt into cold warmup', () => {
    const policy = {
      lifecyclePolicy: {
        warmup: { enabled: true },
        rotation: { mode: 'manual', maxSessionAgeMinutes: 60 },
      },
    };

    expect(shouldWarmupManagedProfile(policy, { state: 'COLD' })).toEqual({
      shouldWarmup: true,
      reason: 'cold_profile',
    });
    expect(shouldWarmupManagedProfile(policy, { state: 'READY' })).toEqual({
      shouldWarmup: false,
      reason: 'already_ready',
    });
  });

  test('rotates only expired or explicitly forced manual lifecycle profiles', () => {
    const policy = resolveManagedBrowserProfile({ profile: 'leboncoin-cim' });

    expect(shouldRotateManagedProfile(policy, { state: 'COLD' })).toEqual({
      shouldRotate: false,
      reason: 'no_active_tab',
    });
    expect(shouldRotateManagedProfile(policy, { state: 'READY' })).toEqual({
      shouldRotate: false,
      reason: 'rotation_not_required',
    });
    expect(shouldRotateManagedProfile(policy, { state: 'EXPIRED' })).toEqual({
      shouldRotate: true,
      reason: 'expired_profile',
    });
    expect(shouldRotateManagedProfile(policy, { state: 'READY' }, { force: true })).toEqual({
      shouldRotate: true,
      reason: 'forced_rotation',
    });
  });
});
