import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listVncDisplays,
  readDisplayRegistry,
  recordVncDisplay,
  removeVncDisplay,
} from '../../lib/vnc-display-registry.js';

describe('vnc display registry', () => {
  let dir;
  let registryPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnc-registry-test-'));
    registryPath = path.join(dir, 'registry.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('records one display per profile userId', () => {
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', pid: 111, registryPath });
    recordVncDisplay({ userId: 'leboncoin-cim', display: ':102', pid: 222, registryPath });

    expect(readDisplayRegistry(registryPath)).toMatchObject({
      'leboncoin-ge': { userId: 'leboncoin-ge', display: ':101', pid: 111 },
      'leboncoin-cim': { userId: 'leboncoin-cim', display: ':102', pid: 222 },
    });
  });

  test('updates an existing profile display instead of duplicating it', () => {
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', pid: process.pid, registryPath });
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':201', pid: process.pid, registryPath });

    expect(listVncDisplays(registryPath)).toHaveLength(1);
    expect(listVncDisplays(registryPath)[0]).toMatchObject({
      userId: 'leboncoin-ge',
      display: ':201',
      pid: process.pid,
    });
  });

  test('removes a profile when its browser session is destroyed', () => {
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', registryPath });
    recordVncDisplay({ userId: 'leboncoin-cim', display: ':102', registryPath });

    removeVncDisplay('leboncoin-ge', registryPath);

    expect(readDisplayRegistry(registryPath)).toMatchObject({
      'leboncoin-cim': { display: ':102' },
    });
    expect(readDisplayRegistry(registryPath)).not.toHaveProperty('leboncoin-ge');
  });

  test('lists only selectable human VNC displays', () => {
    recordVncDisplay({ userId: 'default', display: ':100', pid: process.pid, registryPath });
    recordVncDisplay({ userId: 'stale-profile', display: ':101', pid: 99999999, registryPath });
    recordVncDisplay({ userId: 'leboncoin-cim', display: ':102', pid: process.pid, registryPath });

    expect(listVncDisplays(registryPath)).toEqual([
      expect.objectContaining({ userId: 'leboncoin-cim', display: ':102' }),
    ]);
  });

  test('ignores malformed registry files safely', () => {
    fs.writeFileSync(registryPath, 'not-json', 'utf8');

    expect(listVncDisplays(registryPath)).toEqual([]);
  });
});
