import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_REGISTRY_PATH = path.join(os.tmpdir(), 'camofox-vnc-displays.json');
const DEFAULT_SELECTION_PATH = path.join(os.tmpdir(), 'camofox-vnc-selected-display.json');

function resolveRegistryPath(registryPath = process.env.CAMOFOX_VNC_DISPLAY_REGISTRY) {
  return registryPath || DEFAULT_REGISTRY_PATH;
}

function resolveSelectionPath(selectionPath = process.env.CAMOFOX_VNC_DISPLAY_SELECTION) {
  return selectionPath || DEFAULT_SELECTION_PATH;
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function writeJsonObject(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readDisplayRegistry(registryPath) {
  return readJsonObject(resolveRegistryPath(registryPath));
}

function writeDisplayRegistry(registry, registryPath) {
  writeJsonObject(resolveRegistryPath(registryPath), registry);
}

function recordVncDisplay({ userId, display, pid = process.pid, registryPath, resolution, profileWindowSize } = {}) {
  if (!userId || !display) return;
  const key = String(userId);
  const registry = readDisplayRegistry(registryPath);
  registry[key] = {
    userId: key,
    display: String(display),
    pid,
    resolution: resolution || null,
    profileWindowSize: profileWindowSize || null,
    updatedAt: new Date().toISOString(),
  };
  writeDisplayRegistry(registry, registryPath);
}

function removeVncDisplay(userId, registryPath) {
  if (!userId) return;
  const key = String(userId);
  const registry = readDisplayRegistry(registryPath);
  if (!Object.prototype.hasOwnProperty.call(registry, key)) return;
  delete registry[key];
  writeDisplayRegistry(registry, registryPath);
}

function isSelectableVncDisplay(entry) {
  if (!entry || !entry.userId || !entry.display) return false;
  if (String(entry.userId) === 'default') return false;
  const pid = Number(entry.pid || 0);
  if (pid > 0) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      return false;
    }
  }
  return true;
}

function listVncDisplays(registryPath) {
  return Object.values(readDisplayRegistry(registryPath))
    .filter(isSelectableVncDisplay)
    .sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
}

function selectVncDisplay(userId, { registryPath, selectionPath } = {}) {
  const key = String(userId || '');
  const entry = readDisplayRegistry(registryPath)[key];
  if (!isSelectableVncDisplay(entry)) {
    throw new Error(`No VNC display registered for userId="${key}"`);
  }
  const selected = {
    userId: String(entry.userId || key),
    display: String(entry.display),
    pid: entry.pid,
    selectedAt: new Date().toISOString(),
  };
  writeJsonObject(resolveSelectionPath(selectionPath), selected);
  return selected;
}

function readSelectedVncUserId(selectionPath) {
  const selected = readJsonObject(resolveSelectionPath(selectionPath));
  return selected.userId ? String(selected.userId) : '';
}

function getSelectedVncDisplay({ registryPath, selectionPath } = {}) {
  const registry = readDisplayRegistry(registryPath);
  const selectedUserId = readSelectedVncUserId(selectionPath);
  if (selectedUserId && registry[selectedUserId]?.display) {
    return {
      ...registry[selectedUserId],
      selected: true,
    };
  }
  if (selectedUserId.startsWith('leboncoin-')) {
    return null;
  }
  return listVncDisplays(registryPath)[0] || null;
}

export {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_SELECTION_PATH,
  getSelectedVncDisplay,
  listVncDisplays,
  readDisplayRegistry,
  readSelectedVncUserId,
  recordVncDisplay,
  removeVncDisplay,
  resolveRegistryPath,
  resolveSelectionPath,
  selectVncDisplay,
};
