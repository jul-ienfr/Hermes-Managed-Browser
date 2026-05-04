import { managedAuthEnsure, managedAuthStatus } from '../../lib/managed-auth.js';

describe('Managed Browser auth status', () => {
  test('returns status-only data without credentials or secrets', () => {
    const result = managedAuthStatus({ profile: 'emploi', site: 'france-travail' });
    const body = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: true,
      status: 'unknown',
      profile: 'emploi',
      site: 'france-travail',
      login_required: true,
      human_required: false,
      credential_values_exposed: false,
      llm_used: false,
      external_actions: 0,
    });
    expect(body).not.toMatch(/password|secret|otp_uri|totp_secret/i);
  });

  test('ensure is safe MVP status that requests human login flow without exposing secrets', async () => {
    const result = await managedAuthEnsure({ profile: 'emploi', site: 'france-travail' });
    const body = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: true,
      status: 'login_required',
      profile: 'emploi',
      site: 'france-travail',
      login_required: true,
      human_required: true,
      next_action: 'login_flow_not_implemented',
      credential_values_exposed: false,
      llm_used: false,
      external_actions: 0,
    });
    expect(body).not.toMatch(/password|secret|otp_uri|totp_secret/i);
  });

  test('ensure can run an injected automatic login strategy without exposing secrets', async () => {
    const steps = [];
    const result = await managedAuthEnsure(
      { profile: 'leboncoin-cim', site: 'leboncoin' },
      {
        strategy: async ({ profile, site }) => {
          steps.push(`${site}:${profile}`);
          return { ok: true, status: 'authenticated', login_required: false, checkpoint_saved: true };
        },
      },
    );
    const body = JSON.stringify(result);

    expect(steps).toEqual(['leboncoin:leboncoin-cim']);
    expect(result).toMatchObject({
      ok: true,
      status: 'authenticated',
      profile: 'leboncoin-cim',
      site: 'leboncoin',
      login_required: false,
      human_required: false,
      checkpoint_saved: true,
      credential_values_exposed: false,
      llm_used: false,
      external_actions: 0,
    });
    expect(body).not.toMatch(/password|secret|otp_uri|totp_secret/i);
  });
});
