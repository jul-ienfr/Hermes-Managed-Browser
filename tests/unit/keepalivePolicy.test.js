import { shouldStartKeepalive } from '../../lib/keepalive-policy.js';

describe('shouldStartKeepalive', () => {
  test('does not start Leboncoin manual keepalive while JU is the selected VNC profile', () => {
    expect(shouldStartKeepalive({
      keepaliveUserId: 'leboncoin-manual',
      selectedUserId: 'leboncoin-cim',
    })).toBe(false);
  });

  test('does not start Leboncoin manual keepalive while GE is the selected VNC profile', () => {
    expect(shouldStartKeepalive({
      keepaliveUserId: 'leboncoin-manual',
      selectedUserId: 'leboncoin-ge',
    })).toBe(false);
  });

  test('starts keepalive when no managed Leboncoin VNC profile is selected', () => {
    expect(shouldStartKeepalive({
      keepaliveUserId: 'leboncoin-manual',
      selectedUserId: '',
    })).toBe(true);
  });

  test('does not start Vinted manual keepalive while Vinted managed profile is selected', () => {
    expect(shouldStartKeepalive({
      keepaliveUserId: 'vinted-manual',
      selectedUserId: 'vinted-main',
    })).toBe(false);
  });

  test('starts Leboncoin keepalive while Vinted managed profile is selected', () => {
    expect(shouldStartKeepalive({
      keepaliveUserId: 'leboncoin-manual',
      selectedUserId: 'vinted-main',
    })).toBe(true);
  });

  test('starts non-Leboncoin keepalive even when JU is selected', () => {
    expect(shouldStartKeepalive({
      keepaliveUserId: 'other-manual',
      selectedUserId: 'leboncoin-cim',
    })).toBe(true);
  });
});
