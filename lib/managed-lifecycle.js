function lifecycleStateForPolicy(policy = {}, observed = {}) {
  const currentState = observed.currentTabId ? 'READY' : 'COLD';
  const updatedAt = observed.updatedAt || null;
  const rotation = policy.lifecyclePolicy?.rotation || {};
  const maxAgeMinutes = Number(rotation.maxSessionAgeMinutes || 0);

  if (rotation.mode === 'manual' && maxAgeMinutes > 0 && observed.readySince) {
    const ageMs = Date.now() - new Date(observed.readySince).getTime();
    if (Number.isFinite(ageMs) && ageMs > maxAgeMinutes * 60 * 1000) {
      return { state: 'EXPIRED', updatedAt, currentTabId: observed.currentTabId || null };
    }
  }

  return { state: currentState, updatedAt, currentTabId: observed.currentTabId || null };
}

function shouldWarmupManagedProfile(policy = {}, lifecycle = {}) {
  const warmup = policy.lifecyclePolicy?.warmup || {};
  if (!warmup.enabled) return { shouldWarmup: false, reason: warmup.reason || 'disabled' };
  if (lifecycle.state === 'READY') return { shouldWarmup: false, reason: 'already_ready' };
  if (lifecycle.state === 'EXPIRED') return { shouldWarmup: false, reason: 'rotation_required' };
  return { shouldWarmup: true, reason: 'cold_profile' };
}

function shouldRotateManagedProfile(policy = {}, lifecycle = {}, options = {}) {
  const rotation = policy.lifecyclePolicy?.rotation || {};
  if (rotation.mode !== 'manual') return { shouldRotate: false, reason: 'rotation_disabled' };
  if (options.force === true) return { shouldRotate: true, reason: 'forced_rotation' };
  if (lifecycle.state === 'EXPIRED') return { shouldRotate: true, reason: 'expired_profile' };
  if (lifecycle.state === 'COLD') return { shouldRotate: false, reason: 'no_active_tab' };
  return { shouldRotate: false, reason: 'rotation_not_required' };
}

export { lifecycleStateForPolicy, shouldRotateManagedProfile, shouldWarmupManagedProfile };
