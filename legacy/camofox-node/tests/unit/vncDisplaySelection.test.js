import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getSelectedVncDisplay,
  listVncDisplays,
  recordVncDisplay,
  selectVncDisplay,
} from '../../lib/vnc-display-registry.js';

describe('vnc display profile selection', () => {
  let dir;
  let registryPath;
  let selectionPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnc-selection-test-'));
    registryPath = path.join(dir, 'registry.json');
    selectionPath = path.join(dir, 'selected.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('selects an existing profile display for the VNC watcher', () => {
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', registryPath });
    recordVncDisplay({ userId: 'leboncoin-cim', display: ':102', registryPath });

    const selected = selectVncDisplay('leboncoin-cim', { registryPath, selectionPath });

    expect(selected).toMatchObject({ userId: 'leboncoin-cim', display: ':102', pid: process.pid });
    expect(getSelectedVncDisplay({ registryPath, selectionPath })).toMatchObject({
      userId: 'leboncoin-cim',
      display: ':102',
    });
    expect(listVncDisplays(registryPath)).toHaveLength(2);
  });

  test('rejects selecting an unknown profile without mutating the current selection', () => {
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', registryPath });
    selectVncDisplay('leboncoin-ge', { registryPath, selectionPath });

    expect(() => selectVncDisplay('missing-profile', { registryPath, selectionPath })).toThrow(
      'No VNC display registered for userId="missing-profile"'
    );
    expect(getSelectedVncDisplay({ registryPath, selectionPath })).toMatchObject({
      userId: 'leboncoin-ge',
      display: ':101',
    });
  });

  test('falls back to the first active display when the selection file is missing or stale', () => {
    recordVncDisplay({ userId: 'a-profile', display: ':201', registryPath });
    recordVncDisplay({ userId: 'b-profile', display: ':202', registryPath });
    fs.writeFileSync(selectionPath, JSON.stringify({ userId: 'gone-profile' }), 'utf8');

    expect(getSelectedVncDisplay({ registryPath, selectionPath })).toMatchObject({
      userId: 'a-profile',
      display: ':201',
    });
  });

  test('does not fall back from an active Leboncoin JU selection to Leboncoin GE', () => {
    recordVncDisplay({ userId: 'leboncoin-ge', display: ':101', registryPath });
    fs.writeFileSync(selectionPath, JSON.stringify({ userId: 'leboncoin-cim' }), 'utf8');

    expect(getSelectedVncDisplay({ registryPath, selectionPath })).toBeNull();
  });
});
