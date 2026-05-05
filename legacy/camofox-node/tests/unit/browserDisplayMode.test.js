import { jest } from '@jest/globals';
import { resolveBrowserDisplayMode } from '../../lib/browser-display-mode.js';

describe('resolveBrowserDisplayMode', () => {
  test('uses an explicit shared X display only for explicitly allowed userIds', () => {
    const createVirtualDisplay = jest.fn(() => ({ get: () => ':777' }));

    const mode = resolveBrowserDisplayMode({
      platform: 'linux',
      userId: 'leboncoin-cim',
      sharedDisplay: ' :99 ',
      sharedDisplayUserIds: ['leboncoin-cim'],
      createVirtualDisplay,
    });

    expect(createVirtualDisplay).not.toHaveBeenCalled();
    expect(mode.display).toBe(':99');
    expect(mode.virtualDisplay).toBeNull();
    expect(mode.usesSharedDisplay).toBe(true);
    expect(mode.headless).toBe(false);
  });

  test('does not put unlisted userIds on the shared VNC display', () => {
    const virtualDisplay = { get: jest.fn(() => ':777') };
    const createVirtualDisplay = jest.fn(() => virtualDisplay);

    const mode = resolveBrowserDisplayMode({
      platform: 'linux',
      userId: 'leboncoin-manual',
      sharedDisplay: ':99',
      sharedDisplayUserIds: ['leboncoin-cim'],
      createVirtualDisplay,
    });

    expect(createVirtualDisplay).toHaveBeenCalledTimes(1);
    expect(mode).toEqual({
      display: ':777',
      virtualDisplay,
      usesSharedDisplay: false,
      headless: false,
    });
  });

  test('creates a private virtual display on linux when no shared display is configured', () => {
    const virtualDisplay = { get: jest.fn(() => ':123') };
    const createVirtualDisplay = jest.fn(() => virtualDisplay);

    const mode = resolveBrowserDisplayMode({
      platform: 'linux',
      sharedDisplay: '',
      createVirtualDisplay,
    });

    expect(createVirtualDisplay).toHaveBeenCalledTimes(1);
    expect(mode).toEqual({
      display: ':123',
      virtualDisplay,
      usesSharedDisplay: false,
      headless: false,
    });
  });

  test('stays headless on non-linux when no shared display is configured', () => {
    const createVirtualDisplay = jest.fn();

    const mode = resolveBrowserDisplayMode({
      platform: 'darwin',
      sharedDisplay: '',
      createVirtualDisplay,
    });

    expect(createVirtualDisplay).not.toHaveBeenCalled();
    expect(mode).toEqual({
      display: undefined,
      virtualDisplay: null,
      usesSharedDisplay: false,
      headless: true,
    });
  });
});
