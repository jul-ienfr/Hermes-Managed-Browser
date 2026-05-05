import {
  ProfileLeaseManager,
  createProfileLockedError,
  enforceManagedLease,
  ensureManagedLease,
  managedReadAllowed,
  serializeProfileLeaseError,
} from '../../lib/profile-lease-manager.js';

describe('ProfileLeaseManager', () => {
  test('allows one writer per profile and returns structured profile_locked errors', () => {
    const manager = new ProfileLeaseManager({ ttlMs: 1000, now: () => 1000, idGenerator: () => 'lease-a' });

    const lease = manager.acquire({ profile: 'leboncoin-cim', owner: 'emploi-cli' });
    expect(lease).toMatchObject({ lease_id: 'lease-a', profile: 'leboncoin-cim', owner: 'emploi-cli', expires_at: 2000 });

    expect(() => manager.acquire({ profile: 'leboncoin-cim', owner: 'resell-cli' })).toThrow(expect.objectContaining({
      code: 'profile_locked',
      statusCode: 423,
      profile: 'leboncoin-cim',
      lease_id: 'lease-a',
      owner: 'emploi-cli',
    }));
  });

  test('keeps leases independent across different profiles', () => {
    let next = 0;
    const manager = new ProfileLeaseManager({ ttlMs: 1000, now: () => 10, idGenerator: () => `lease-${++next}` });

    const ju = manager.acquire({ profile: 'leboncoin-cim', owner: 'emploi-cli' });
    const ge = manager.acquire({ profile: 'leboncoin-ge', owner: 'resell-cli' });

    expect(ju.lease_id).toBe('lease-1');
    expect(ge.lease_id).toBe('lease-2');
    expect(manager.status('leboncoin-cim')).toMatchObject({ locked: true, lease_id: 'lease-1' });
    expect(manager.status('leboncoin-ge')).toMatchObject({ locked: true, lease_id: 'lease-2' });
  });

  test('reclaims expired leases on acquire and reports unlocked status', () => {
    let now = 1000;
    let next = 0;
    const manager = new ProfileLeaseManager({ ttlMs: 100, now: () => now, idGenerator: () => `lease-${++next}` });

    const first = manager.acquire({ profile: 'example-demo', owner: 'owner-a' });
    now = 1101;

    expect(manager.status('example-demo')).toMatchObject({ profile: 'example-demo', locked: false, lease_id: null });
    const second = manager.acquire({ profile: 'example-demo', owner: 'owner-b' });

    expect(first.lease_id).toBe('lease-1');
    expect(second).toMatchObject({ lease_id: 'lease-2', owner: 'owner-b' });
  });

  test('renews and releases only with the active profile-scoped lease id', () => {
    let now = 1000;
    const manager = new ProfileLeaseManager({ ttlMs: 100, now: () => now, idGenerator: () => 'lease-a' });
    const lease = manager.acquire({ profile: 'leboncoin-cim', owner: 'emploi-cli' });

    now = 1050;
    expect(manager.renew({ profile: 'leboncoin-cim', lease_id: lease.lease_id })).toMatchObject({ expires_at: 1150 });
    expect(() => manager.release({ profile: 'leboncoin-cim', lease_id: 'wrong' })).toThrow(expect.objectContaining({ code: 'profile_locked' }));
    expect(manager.release({ profile: 'leboncoin-cim', lease_id: lease.lease_id })).toMatchObject({ ok: true, profile: 'leboncoin-cim', lease_id: lease.lease_id, released: true });
    expect(manager.status('leboncoin-cim')).toMatchObject({ locked: false });
  });
});

describe('managed lease enforcement helpers', () => {
  test('mutating managed-browser endpoints require a valid lease_id scoped to profile', () => {
    const manager = new ProfileLeaseManager({ ttlMs: 1000, now: () => 1000, idGenerator: () => 'lease-a' });
    manager.acquire({ profile: 'leboncoin-cim', owner: 'emploi-cli' });

    expect(enforceManagedLease({ profile: 'leboncoin-cim', lease_id: 'lease-a' }, manager)).toMatchObject({ ok: true, profile: 'leboncoin-cim' });
    expect(() => enforceManagedLease({ profile: 'leboncoin-cim' }, manager)).toThrow(expect.objectContaining({
      code: 'profile_locked',
      profile: 'leboncoin-cim',
      required_lease_id: true,
    }));
    expect(() => enforceManagedLease({ profile: 'leboncoin-ge', lease_id: 'lease-a' }, manager)).toThrow(expect.objectContaining({
      code: 'profile_locked',
      profile: 'leboncoin-ge',
    }));
  });

  test('read-only snapshot/status lease policy can allow or reject locked profile reads', () => {
    const manager = new ProfileLeaseManager({ ttlMs: 1000, now: () => 1000, idGenerator: () => 'lease-a' });
    manager.acquire({ profile: 'leboncoin-cim', owner: 'emploi-cli' });

    expect(managedReadAllowed({ profile: 'leboncoin-cim' }, manager, { allowLockedRead: true })).toMatchObject({ ok: true, locked: true });
    expect(() => managedReadAllowed({ profile: 'leboncoin-cim' }, manager, { allowLockedRead: false })).toThrow(expect.objectContaining({
      code: 'profile_locked',
      statusCode: 423,
      profile: 'leboncoin-cim',
    }));
  });



  test('can auto-acquire a lease for a standalone managed write request without requiring callers to prefetch lease_id', () => {
    const manager = new ProfileLeaseManager({ ttlMs: 1000, now: () => 1000, idGenerator: () => 'lease-a' });

    expect(ensureManagedLease({ profile: 'leboncoin-ge', owner: 'managed-visible-tab' }, manager)).toMatchObject({
      ok: true,
      acquired: true,
      profile: 'leboncoin-ge',
      lease_id: 'lease-a',
      owner: 'managed-visible-tab',
    });
    expect(() => ensureManagedLease({ profile: 'leboncoin-ge', owner: 'other-writer' }, manager)).toThrow(expect.objectContaining({
      code: 'profile_locked',
      required_lease_id: true,
    }));
  });

  test('createProfileLockedError exposes a structured error payload', () => {
    const err = createProfileLockedError({ profile: 'leboncoin-cim', lease: { lease_id: 'lease-a', owner: 'emploi-cli', expires_at: 2000 } });

    expect(err).toMatchObject({
      message: 'Managed browser profile "leboncoin-cim" is locked by another writer.',
      code: 'profile_locked',
      statusCode: 423,
      profile: 'leboncoin-cim',
      lease_id: 'lease-a',
      owner: 'emploi-cli',
      expires_at: 2000,
    });
    expect(serializeProfileLeaseError(err)).toMatchObject({
      error: 'Managed browser profile "leboncoin-cim" is locked by another writer.',
      code: 'profile_locked',
      profile: 'leboncoin-cim',
      lease_id: 'lease-a',
      owner: 'emploi-cli',
      expires_at: 2000,
    });
  });
});

describe('managed lease server route wiring', () => {
  let serverSource;

  beforeAll(async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
    serverSource = readFileSync(join(repoRoot, 'server.js'), 'utf8');
  });

  function routeBlock(method, route, endNeedle) {
    const start = serverSource.indexOf(`app.${method}('${route}'`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = serverSource.indexOf(endNeedle, start);
    expect(end).toBeGreaterThan(start);
    return serverSource.slice(start, end);
  }

  test('exposes acquire, renew, and release lease endpoints with structured profile lease responses', () => {
    const acquireBlock = routeBlock('post', '/managed/profiles/lease/acquire', "app.post('/managed/profiles/lease/renew'");
    const renewBlock = routeBlock('post', '/managed/profiles/lease/renew', "app.post('/managed/profiles/lease/release'");
    const releaseBlock = routeBlock('post', '/managed/profiles/lease/release', 'function managedObservedState');

    expect(acquireBlock).toMatch(/requireManagedBrowserProfileIdentity\(req\.body, \{ operation: 'profiles\.lease\.acquire' \}\)/);
    expect(acquireBlock).toMatch(/managedProfileLeases\.acquire/);
    expect(acquireBlock).toMatch(/res\.json\(\{ ok: true, profile: identity\.profile, \.\.\.lease \}\)/);

    expect(renewBlock).toMatch(/managedProfileLeases\.renew/);
    expect(renewBlock).toMatch(/lease_id: req\.body\?\.lease_id \|\| req\.body\?\.leaseId/);
    expect(renewBlock).toMatch(/res\.json\(\{ ok: true, profile: identity\.profile, \.\.\.lease \}\)/);

    expect(releaseBlock).toMatch(/managedProfileLeases\.release/);
    expect(releaseBlock).toMatch(/lease_id: req\.body\?\.lease_id \|\| req\.body\?\.leaseId/);
    expect(releaseBlock).toMatch(/res\.json\(\{ ok: true, profile: identity\.profile, \.\.\.result \}\)/);
  });

  test('managed mutating endpoints enforce profile-scoped lease ids after identity resolution', () => {
    for (const [route, endNeedle] of [
      ['/managed/recover-tab', "app.post('/managed/storage-checkpoint'"],
      ['/managed/storage-checkpoint', "app.post('/tabs'"],
    ]) {
      const block = routeBlock('post', route, endNeedle);
      expect(block).toMatch(/const identity = requireManagedBrowserProfileIdentity\(req\.body/);
      expect(block).toMatch(/enforceManagedLease\(\{ \.\.\.req\.body, profile: identity\.profile \}, managedProfileLeases\)/);
    }

    const visibleTabBlock = routeBlock('post', '/managed/visible-tab', "app.post('/managed/recover-tab'");
    expect(visibleTabBlock).toMatch(/requireManagedBrowserProfileIdentity\(visibleTabIdentityInput\(req\.body \|\| \{\}\)/);
    expect(visibleTabBlock).toContain('ensureManagedLease');
    expect(visibleTabBlock).toContain("owner: payload.owner || payload.owner_cli || payload.ownerCli || 'managed.visible-tab'");
    expect(visibleTabBlock).toContain('lease_id: lease.lease_id');
  });

  test('managed status and ensure include lease status and enforce locked-read policy', () => {
    const statusBlock = routeBlock('get', '/managed/profiles/:profile/status', "app.post('/managed/profiles/ensure'");
    const ensureBlock = routeBlock('post', '/managed/profiles/ensure', "app.post('/managed/profiles/lease/acquire'");

    for (const block of [statusBlock, ensureBlock]) {
      expect(block).toMatch(/managedReadAllowed\([\s\S]*managedProfileLeases,[\s\S]*allowLockedRead: CONFIG\.managedProfileAllowLockedReads/);
      expect(block).toMatch(/const lease = managedProfileLeases\.status\(status\.profile\)/);
      expect(block).toMatch(/res\.json\(\{ \.\.\.status, lease \}\)/);
    }
  });
});
