import { randomUUID } from 'crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function normalizeProfile(profile) {
  if (typeof profile !== 'string' || !profile.trim()) {
    throw Object.assign(new Error('profile is required for managed browser lease operations.'), {
      statusCode: 400,
      code: 'profile_required',
    });
  }
  return profile.trim();
}

function normalizeLeaseId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function createProfileLockedError({ profile, lease = null, reason = 'locked', requiredLeaseId = false } = {}) {
  const normalizedProfile = normalizeProfile(profile);
  const err = Object.assign(
    new Error(`Managed browser profile "${normalizedProfile}" is locked by another writer.`),
    {
      statusCode: 423,
      code: 'profile_locked',
      profile: normalizedProfile,
      reason,
      required_lease_id: Boolean(requiredLeaseId),
    }
  );
  if (lease) {
    err.lease_id = lease.lease_id;
    err.owner = lease.owner || null;
    err.expires_at = lease.expires_at;
  }
  return err;
}

class ProfileLeaseManager {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.idGenerator = typeof options.idGenerator === 'function' ? options.idGenerator : () => randomUUID();
    this.leases = new Map();
  }

  acquire({ profile, owner, ttlMs } = {}) {
    const normalizedProfile = normalizeProfile(profile);
    this.#purgeExpired(normalizedProfile);
    const existing = this.leases.get(normalizedProfile);
    if (existing) throw createProfileLockedError({ profile: normalizedProfile, lease: existing });

    const lease = this.#buildLease(normalizedProfile, owner, ttlMs);
    this.leases.set(normalizedProfile, lease);
    return { ...lease };
  }

  renew({ profile, lease_id: leaseId, ttlMs } = {}) {
    const normalizedProfile = normalizeProfile(profile);
    const lease = this.#requireActiveLease(normalizedProfile, leaseId);
    const renewed = {
      ...lease,
      expires_at: this.now() + this.#ttl(ttlMs),
      renewed_at: this.now(),
    };
    this.leases.set(normalizedProfile, renewed);
    return { ...renewed };
  }

  release({ profile, lease_id: leaseId } = {}) {
    const normalizedProfile = normalizeProfile(profile);
    const lease = this.#requireActiveLease(normalizedProfile, leaseId);
    this.leases.delete(normalizedProfile);
    return { ok: true, profile: normalizedProfile, lease_id: lease.lease_id, released: true };
  }

  status(profile) {
    const normalizedProfile = normalizeProfile(profile);
    this.#purgeExpired(normalizedProfile);
    const lease = this.leases.get(normalizedProfile);
    if (!lease) return { profile: normalizedProfile, locked: false, lease_id: null, owner: null, expires_at: null };
    return { profile: normalizedProfile, locked: true, lease_id: lease.lease_id, owner: lease.owner || null, expires_at: lease.expires_at };
  }

  validate({ profile, lease_id: leaseId } = {}) {
    const normalizedProfile = normalizeProfile(profile);
    const lease = this.#requireActiveLease(normalizedProfile, leaseId);
    return { ok: true, profile: normalizedProfile, lease_id: lease.lease_id, owner: lease.owner || null, expires_at: lease.expires_at };
  }

  #buildLease(profile, owner, ttlMs) {
    const createdAt = this.now();
    return {
      lease_id: this.idGenerator(),
      profile,
      owner: typeof owner === 'string' && owner.trim() ? owner.trim() : null,
      acquired_at: createdAt,
      renewed_at: createdAt,
      expires_at: createdAt + this.#ttl(ttlMs),
    };
  }

  #ttl(ttlMs) {
    return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.ttlMs;
  }

  #purgeExpired(profile) {
    const lease = this.leases.get(profile);
    if (lease && lease.expires_at <= this.now()) this.leases.delete(profile);
  }

  #requireActiveLease(profile, leaseId) {
    this.#purgeExpired(profile);
    const lease = this.leases.get(profile);
    const normalizedLeaseId = normalizeLeaseId(leaseId);
    if (!lease) throw createProfileLockedError({ profile, reason: 'missing_lease', requiredLeaseId: true });
    if (!normalizedLeaseId || lease.lease_id !== normalizedLeaseId) {
      throw createProfileLockedError({ profile, lease, reason: normalizedLeaseId ? 'lease_mismatch' : 'missing_lease', requiredLeaseId: true });
    }
    return lease;
  }
}

function enforceManagedLease(input = {}, leaseManager) {
  if (!leaseManager) throw new Error('leaseManager is required');
  return leaseManager.validate({ profile: input.profile, lease_id: input.lease_id || input.leaseId });
}

function ensureManagedLease(input = {}, leaseManager) {
  if (!leaseManager) throw new Error('leaseManager is required');
  const profile = normalizeProfile(input.profile);
  const leaseId = input.lease_id || input.leaseId;
  if (leaseId) return leaseManager.validate({ profile, lease_id: leaseId });
  try {
    const lease = leaseManager.acquire({
      profile,
      owner: input.owner || input.owner_cli || input.ownerCli || input.operation || input.action,
      ttlMs: input.ttl_ms || input.ttlMs,
    });
    return { ok: true, acquired: true, ...lease };
  } catch (err) {
    if (err?.code === 'profile_locked') err.required_lease_id = true;
    throw err;
  }
}

function managedReadAllowed(input = {}, leaseManager, options = {}) {
  if (!leaseManager) throw new Error('leaseManager is required');
  const profile = normalizeProfile(input.profile);
  const status = leaseManager.status(profile);
  const leaseId = input.lease_id || input.leaseId;
  if (status.locked && leaseId) return leaseManager.validate({ profile, lease_id: leaseId });
  if (status.locked && options.allowLockedRead === false) {
    throw createProfileLockedError({ profile, lease: status, reason: 'read_locked' });
  }
  return { ok: true, profile, locked: status.locked, lease_id: status.lease_id, owner: status.owner, expires_at: status.expires_at };
}

function serializeProfileLeaseError(err) {
  const body = { error: err?.message || 'Profile lease error' };
  for (const key of ['code', 'profile', 'lease_id', 'owner', 'expires_at', 'reason', 'required_lease_id']) {
    if (err?.[key] !== undefined) body[key] = err[key];
  }
  return body;
}

export {
  DEFAULT_TTL_MS,
  ProfileLeaseManager,
  createProfileLockedError,
  enforceManagedLease,
  ensureManagedLease,
  managedReadAllowed,
  serializeProfileLeaseError,
};
