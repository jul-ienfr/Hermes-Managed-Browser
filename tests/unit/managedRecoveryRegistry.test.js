import { describe, expect, test } from '@jest/globals';
import {
  buildRecoveryKey,
  createManagedRecoveryRegistry,
  getRecoveryState,
  markRecoveryClosed,
  recordRecoveryAction,
} from '../../lib/managed-recovery-registry.js';

describe('managed recovery registry', () => {
  test('builds stable keys from user, session, profile, site, and task context', () => {
    const key = buildRecoveryKey({
      userId: 'jul',
      sessionKey: 'task-session',
      profileDir: '/tmp/profile',
      siteKey: 'example.com',
      task_id: 'task-1',
    });

    expect(key).toBe('user:jul|session:task-session|profile:/tmp/profile|site:example.com|task:task-1');
  });

  test('records successful action state with tab, URL, title, timestamps, profile, and persona metadata', () => {
    const registry = createManagedRecoveryRegistry({ now: () => 1000 });

    const state = recordRecoveryAction(registry, {
      userId: 'jul',
      sessionKey: 'session-a',
      tabId: 'tab-1',
      profileDir: '/profiles/jul',
      siteKey: 'example.com',
      persona: { userAgent: 'test-agent' },
      humanProfile: 'fast',
    }, {
      kind: 'click',
      result: { ok: true, url: 'https://example.com/next', title: 'Next' },
    });

    expect(state).toMatchObject({
      key: 'user:jul|session:session-a|profile:/profiles/jul|site:example.com',
      userId: 'jul',
      sessionKey: 'session-a',
      profileDir: '/profiles/jul',
      siteKey: 'example.com',
      lastTabId: 'tab-1',
      lastKnownUrl: 'https://example.com/next',
      lastTitle: 'Next',
      lastActionAt: 1000,
      persona: { userAgent: 'test-agent' },
      humanProfile: 'fast',
      closedAt: null,
      closeReason: null,
    });
    expect(getRecoveryState(registry, { userId: 'jul', sessionKey: 'session-a', profileDir: '/profiles/jul', siteKey: 'example.com' })).toEqual(state);
  });

  test('consultation URL takes precedence for recovery target without being overwritten by later action-only URLs', () => {
    let tick = 10;
    const registry = createManagedRecoveryRegistry({ now: () => tick++ });
    const meta = { userId: 'jul', sessionKey: 'session-a', profileDir: '/profiles/jul', siteKey: 'example.com', tabId: 'tab-1' };

    recordRecoveryAction(registry, meta, {
      kind: 'navigate',
      result: { ok: true, url: 'https://example.com/start', title: 'Start' },
    });
    recordRecoveryAction(registry, meta, {
      kind: 'snapshot',
      result: { ok: true, url: 'https://example.com/consulted', title: 'Consulted' },
    });
    const state = recordRecoveryAction(registry, meta, {
      kind: 'click',
      result: { ok: true, url: 'https://example.com/action-after-consult', title: 'After Action' },
    });

    expect(state.lastConsultedUrl).toBe('https://example.com/consulted');
    expect(state.lastKnownUrl).toBe('https://example.com/action-after-consult');
    expect(state.lastSnapshotAt).toBe(11);
    expect(state.lastActionAt).toBe(12);
  });

  test('close marks state closed but preserves last consulted URL', () => {
    const registry = createManagedRecoveryRegistry({ now: () => 5000 });
    const meta = { userId: 'jul', sessionKey: 'session-a', profileDir: '/profiles/jul', siteKey: 'example.com', tabId: 'tab-1' };

    recordRecoveryAction(registry, meta, {
      kind: 'snapshot',
      result: { ok: true, url: 'https://example.com/final', title: 'Final' },
    });
    const closed = markRecoveryClosed(registry, meta, { reason: 'api_delete_tab', url: 'https://example.com/closed-url', title: 'Closed' });

    expect(closed).toMatchObject({
      lastTabId: 'tab-1',
      lastConsultedUrl: 'https://example.com/final',
      lastKnownUrl: 'https://example.com/closed-url',
      lastTitle: 'Closed',
      closedAt: 5000,
      closeReason: 'api_delete_tab',
    });
  });
});
