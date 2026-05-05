import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  listNotifications,
  markNotificationsRead,
  readState,
  recordNotification,
} from '../../lib/managed-notifications.js';

const tmpRoots = [];

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-notifications-'));
  tmpRoots.push(dir);
  return path.join(dir, 'notifications.jsonl');
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed notification JSONL store', () => {
  test('deduplicates notifications by profile/site/origin/title/body/tag/url', () => {
    const storagePath = tmpStorePath();
    const first = recordNotification({
      storagePath,
      profile: 'buyer-a',
      site: 'leboncoin',
      origin: 'https://www.leboncoin.fr',
      title: 'New message',
      body: 'Hello',
      tag: 'thread-1',
      url: 'https://www.leboncoin.fr/messages/1',
    });
    const duplicate = recordNotification({
      storagePath,
      profile: 'buyer-a',
      site: 'leboncoin',
      origin: 'https://www.leboncoin.fr',
      title: 'New message',
      body: 'Hello',
      tag: 'thread-1',
      url: 'https://www.leboncoin.fr/messages/1',
    });
    const differentProfile = recordNotification({
      storagePath,
      profile: 'buyer-b',
      site: 'leboncoin',
      origin: 'https://www.leboncoin.fr',
      title: 'New message',
      body: 'Hello',
      tag: 'thread-1',
      url: 'https://www.leboncoin.fr/messages/1',
    });

    expect(first.id).toBe(duplicate.id);
    expect(duplicate.duplicate).toBe(true);
    expect(differentProfile.id).not.toBe(first.id);
    expect(readState({ storagePath }).records).toHaveLength(2);
  });

  test('lists notifications with unread filtering and deterministic limits', () => {
    const storagePath = tmpStorePath();
    const first = recordNotification({ storagePath, profile: 'p', site: 's', origin: 'o', title: 'A', body: '1', tag: '', url: 'u1' });
    const second = recordNotification({ storagePath, profile: 'p', site: 's', origin: 'o', title: 'B', body: '2', tag: '', url: 'u2' });
    const third = recordNotification({ storagePath, profile: 'p', site: 's', origin: 'o', title: 'C', body: '3', tag: '', url: 'u3' });
    markNotificationsRead({ storagePath, ids: [second.id] });

    expect(listNotifications({ storagePath, profile: 'p', site: 's' }).map((n) => n.id)).toEqual([first.id, second.id, third.id]);
    expect(listNotifications({ storagePath, profile: 'p', site: 's', unreadOnly: true }).map((n) => n.id)).toEqual([first.id, third.id]);
    expect(listNotifications({ storagePath, profile: 'p', site: 's', limit: 1 }).map((n) => n.id)).toEqual([third.id]);
  });

  test('marks notifications read by id and persists state', () => {
    const storagePath = tmpStorePath();
    const first = recordNotification({ storagePath, profile: 'p', site: 's', origin: 'o', title: 'A', body: '1', tag: '', url: 'u1' });
    const second = recordNotification({ storagePath, profile: 'p', site: 's', origin: 'o', title: 'B', body: '2', tag: '', url: 'u2' });

    const result = markNotificationsRead({ storagePath, ids: [first.id, 'missing-id'] });
    expect(result).toEqual({ marked: 1, ids: [first.id] });

    const state = readState({ storagePath });
    expect(state.records.find((record) => record.id === first.id).read).toBe(true);
    expect(state.records.find((record) => record.id === second.id).read).toBe(false);
    expect(listNotifications({ storagePath, unreadOnly: true }).map((n) => n.id)).toEqual([second.id]);
  });
});
