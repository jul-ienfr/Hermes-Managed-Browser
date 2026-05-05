import { describe, expect, test } from '@jest/globals';

import { normalizeManagedNotificationResponse } from '../../lib/managed-cli-schema.js';

describe('managed notifications CLI/API schema', () => {
  test('normal notification responses always include stable no-LLM/no-action fields', () => {
    const response = normalizeManagedNotificationResponse({
      profile: 'buyer-a',
      site: 'leboncoin',
      notifications: [{ id: 'n1' }],
    });

    expect(response).toMatchObject({
      success: true,
      profile: 'buyer-a',
      site: 'leboncoin',
      llm_used: false,
      external_actions: 0,
      notifications: [{ id: 'n1' }],
    });
  });

  test('notification error responses preserve success false and required profile/site schema', () => {
    const response = normalizeManagedNotificationResponse(
      { success: false, error: 'requires_enable' },
      { profile: 'buyer-a', site: 'leboncoin' },
    );

    expect(response).toMatchObject({
      success: false,
      profile: 'buyer-a',
      site: 'leboncoin',
      llm_used: false,
      external_actions: 0,
      error: 'requires_enable',
    });
  });

  test('normal path metadata cannot be promoted to LLM usage or external actions', () => {
    const response = normalizeManagedNotificationResponse({
      success: true,
      profile: 'buyer-a',
      site: 'leboncoin',
      llm_used: true,
      external_actions: 12,
    });

    expect(response.llm_used).toBe(false);
    expect(response.external_actions).toBe(0);
  });
});
