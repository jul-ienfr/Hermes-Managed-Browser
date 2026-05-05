import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function getUserPersistencePaths(profileDir, userId) {
  const rootDir = path.resolve(profileDir);
  const safeUserDir = crypto
    .createHash('sha256')
    .update(String(userId))
    .digest('hex')
    .slice(0, 32);

  const userDir = path.join(rootDir, safeUserDir);
  return {
    rootDir,
    userDir,
    storageStatePath: path.join(userDir, 'storage-state.json'),
    metaPath: path.join(userDir, 'meta.json'),
    browserProfilePath: path.join(userDir, 'browser-profile.json'),
    profilePolicyPath: path.join(userDir, 'profile-policy.json'),
    fingerprintPath: path.join(userDir, 'fingerprint.json'),
    fingerprintMetaPath: path.join(userDir, 'fingerprint-meta.json'),
  };
}

async function loadPersistedBrowserProfile(profileDir, userId, logger = console) {
  if (!profileDir) return undefined;

  const { browserProfilePath } = getUserPersistencePaths(profileDir, userId);

  try {
    const raw = await fs.readFile(browserProfilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    logger?.warn?.('failed to load persisted browser profile', {
      userId: String(userId),
      browserProfilePath,
      error: err?.message || String(err),
    });
    return undefined;
  }
}

async function persistBrowserProfile({ profileDir, userId, profile, logger = console }) {
  if (!profileDir || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return { persisted: false, reason: 'disabled' };
  }

  const { userDir, browserProfilePath } = getUserPersistencePaths(profileDir, userId);
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const tmpProfilePath = `${browserProfilePath}${suffix}`;

  try {
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(tmpProfilePath, JSON.stringify(profile, null, 2));
    await fs.rename(tmpProfilePath, browserProfilePath);
    return { persisted: true, userDir, browserProfilePath };
  } catch (err) {
    await fs.unlink(tmpProfilePath).catch(() => {});
    logger?.warn?.('failed to persist browser profile', {
      userId: String(userId),
      browserProfilePath,
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'error', error: err };
  }
}

async function loadPersistedProfilePolicy(profileDir, userId, logger = console) {
  if (!profileDir) return undefined;
  const { profilePolicyPath } = getUserPersistencePaths(profileDir, userId);
  try {
    const raw = await fs.readFile(profilePolicyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    logger?.warn?.('failed to load persisted profile policy', { userId: String(userId), profilePolicyPath, error: err?.message || String(err) });
    return undefined;
  }
}

async function persistProfilePolicy({ profileDir, userId, policy, logger = console }) {
  if (!profileDir || !policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { persisted: false, reason: 'disabled' };
  }
  const { userDir, profilePolicyPath } = getUserPersistencePaths(profileDir, userId);
  const tmpPolicyPath = `${profilePolicyPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(tmpPolicyPath, JSON.stringify(policy, null, 2));
    await fs.rename(tmpPolicyPath, profilePolicyPath);
    return { persisted: true, userDir, profilePolicyPath };
  } catch (err) {
    await fs.unlink(tmpPolicyPath).catch(() => {});
    logger?.warn?.('failed to persist profile policy', { userId: String(userId), profilePolicyPath, error: err?.message || String(err) });
    return { persisted: false, reason: 'error', error: err };
  }
}

async function loadPersistedFingerprint(profileDir, userId, logger = console) {
  if (!profileDir) return undefined;

  const { fingerprintPath, fingerprintMetaPath } = getUserPersistencePaths(profileDir, userId);
  try {
    const raw = await fs.readFile(fingerprintPath, 'utf8');
    const fingerprint = JSON.parse(raw);
    if (!fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) return undefined;
    let metadata = {};
    try {
      const rawMeta = await fs.readFile(fingerprintMetaPath, 'utf8');
      const parsedMeta = JSON.parse(rawMeta);
      if (parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)) metadata = parsedMeta;
    } catch (err) {
      if (err?.code !== 'ENOENT') logger?.warn?.('failed to load persisted fingerprint metadata', { userId: String(userId), fingerprintMetaPath, error: err?.message || String(err) });
    }
    return { fingerprint, metadata, fingerprintPath, fingerprintMetaPath };
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    logger?.warn?.('failed to load persisted fingerprint', { userId: String(userId), fingerprintPath, error: err?.message || String(err) });
    return undefined;
  }
}

async function persistFingerprint({ profileDir, userId, fingerprint, metadata = {}, logger = console }) {
  if (!profileDir || !fingerprint || typeof fingerprint !== 'object' || Array.isArray(fingerprint)) {
    return { persisted: false, reason: 'disabled' };
  }
  const { userDir, fingerprintPath, fingerprintMetaPath } = getUserPersistencePaths(profileDir, userId);
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const tmpFingerprintPath = `${fingerprintPath}${suffix}`;
  const tmpFingerprintMetaPath = `${fingerprintMetaPath}${suffix}`;
  try {
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(tmpFingerprintPath, JSON.stringify(fingerprint, null, 2));
    await fs.rename(tmpFingerprintPath, fingerprintPath);
    await fs.writeFile(tmpFingerprintMetaPath, JSON.stringify({ userId: String(userId), updatedAt: new Date().toISOString(), ...metadata }, null, 2));
    await fs.rename(tmpFingerprintMetaPath, fingerprintMetaPath);
    return { persisted: true, userDir, fingerprintPath, fingerprintMetaPath };
  } catch (err) {
    await fs.unlink(tmpFingerprintPath).catch(() => {});
    await fs.unlink(tmpFingerprintMetaPath).catch(() => {});
    logger?.warn?.('failed to persist fingerprint', { userId: String(userId), fingerprintPath, error: err?.message || String(err) });
    return { persisted: false, reason: 'error', error: err };
  }
}

async function loadPersistedStorageState(profileDir, userId, logger = console) {
  if (!profileDir) return undefined;

  const { storageStatePath } = getUserPersistencePaths(profileDir, userId);

  try {
    const raw = await fs.readFile(storageStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!Array.isArray(parsed.cookies)) return undefined;
    if (parsed.origins !== undefined && !Array.isArray(parsed.origins)) return undefined;
    return storageStatePath;
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    logger?.warn?.('failed to load persisted storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return undefined;
  }
}

async function persistStorageState({ profileDir, userId, context, logger = console }) {
  if (!profileDir || !context) {
    return { persisted: false, reason: 'disabled' };
  }

  const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const tmpStoragePath = `${storageStatePath}${suffix}`;
  const tmpMetaPath = `${metaPath}${suffix}`;

  try {
    await fs.mkdir(userDir, { recursive: true });
    await context.storageState({ path: tmpStoragePath });
    await fs.rename(tmpStoragePath, storageStatePath);
    await fs.writeFile(
      tmpMetaPath,
      JSON.stringify(
        {
          userId: String(userId),
          updatedAt: new Date().toISOString(),
          storageStatePath,
        },
        null,
        2
      )
    );
    await fs.rename(tmpMetaPath, metaPath);
    return { persisted: true, userDir, storageStatePath, metaPath };
  } catch (err) {
    await fs.unlink(tmpStoragePath).catch(() => {});
    await fs.unlink(tmpMetaPath).catch(() => {});
    logger?.warn?.('failed to persist storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'error', error: err };
  }
}

export {
  getUserPersistencePaths,
  loadPersistedBrowserProfile,
  loadPersistedFingerprint,
  loadPersistedProfilePolicy,
  loadPersistedStorageState,
  persistBrowserProfile,
  persistFingerprint,
  persistProfilePolicy,
  persistStorageState,
};
