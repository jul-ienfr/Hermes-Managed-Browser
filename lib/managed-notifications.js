import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DEDUPE_FIELDS = Object.freeze(['profile', 'site', 'origin', 'title', 'body', 'tag', 'url']);

function normalizeValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function notificationKey(input = {}) {
  return DEDUPE_FIELDS.map((field) => normalizeValue(input[field])).join('\u001f');
}

function notificationId(input = {}) {
  return crypto.createHash('sha256').update(notificationKey(input)).digest('hex').slice(0, 24);
}

function ensureStorageDir(storagePath) {
  const dir = path.dirname(storagePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonl(storagePath) {
  if (!storagePath) throw new Error('storagePath is required');
  if (!fs.existsSync(storagePath)) return [];
  const text = fs.readFileSync(storagePath, 'utf8');
  if (!text.trim()) return [];
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeJsonl(storagePath, records) {
  ensureStorageDir(storagePath);
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(storagePath, body ? `${body}\n` : '', 'utf8');
}

function toRecord(input = {}) {
  const record = {};
  for (const field of DEDUPE_FIELDS) record[field] = normalizeValue(input[field]);
  record.id = notificationId(record);
  record.read = Boolean(input.read);
  record.recorded_at = input.recorded_at || input.recordedAt || new Date(0).toISOString();
  return record;
}

function recordNotification(input = {}) {
  const { storagePath } = input;
  const records = readJsonl(storagePath);
  const candidate = toRecord(input);
  const existing = records.find((record) => record.id === candidate.id);
  if (existing) return { ...existing, duplicate: true };
  records.push(candidate);
  writeJsonl(storagePath, records);
  return { ...candidate, duplicate: false };
}

function listNotifications(options = {}) {
  const records = readJsonl(options.storagePath).filter((record) => {
    if (options.profile !== undefined && record.profile !== normalizeValue(options.profile)) return false;
    if (options.site !== undefined && record.site !== normalizeValue(options.site)) return false;
    if (options.origin !== undefined && record.origin !== normalizeValue(options.origin)) return false;
    if (options.unreadOnly && record.read) return false;
    return true;
  });

  const limit = Number(options.limit || 0);
  if (Number.isFinite(limit) && limit > 0) return records.slice(-limit);
  return records;
}

function markNotificationsRead(options = {}) {
  const ids = new Set((options.ids || []).map((id) => String(id)));
  const markedIds = [];
  const records = readJsonl(options.storagePath).map((record) => {
    if (ids.has(record.id) && !record.read) {
      markedIds.push(record.id);
      return { ...record, read: true };
    }
    return record;
  });
  writeJsonl(options.storagePath, records);
  return { marked: markedIds.length, ids: markedIds };
}

function readState(options = {}) {
  const records = readJsonl(options.storagePath);
  return {
    storagePath: options.storagePath,
    records,
    unread: records.filter((record) => !record.read).length,
  };
}

export {
  DEDUPE_FIELDS,
  listNotifications,
  markNotificationsRead,
  readState,
  recordNotification,
};
