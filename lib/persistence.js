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
  loadPersistedStorageState,
  persistBrowserProfile,
  persistStorageState,
};
