export function managedAuthStatus({ profile, site } = {}) {
  return {
    ok: true,
    success: true,
    status: 'unknown',
    profile,
    site,
    login_required: true,
    human_required: false,
    credential_values_exposed: false,
    factors: {
      username: 'unknown',
      passphrase: 'unknown',
      totp: 'unknown',
      email_sms: 'human_required_if_challenged',
    },
    llm_used: false,
    external_actions: 0,
  };
}

function redactedAuthResult({ profile, site, result = {} }) {
  return {
    ...managedAuthStatus({ profile, site }),
    ...result,
    ok: Boolean(result.ok ?? result.success ?? false),
    success: Boolean(result.success ?? result.ok ?? false),
    profile,
    site,
    credential_values_exposed: false,
    llm_used: false,
    external_actions: 0,
  };
}

export async function managedAuthEnsure({ profile, site } = {}, { strategy } = {}) {
  if (typeof strategy === 'function') {
    try {
      const result = await strategy({ profile, site });
      return redactedAuthResult({ profile, site, result });
    } catch (err) {
      return redactedAuthResult({
        profile,
        site,
        result: {
          ok: false,
          success: false,
          status: 'auth_ensure_failed',
          login_required: true,
          human_required: false,
          next_action: 'fix_automatic_login_flow',
          reason: err?.message || String(err),
        },
      });
    }
  }
  return {
    ...managedAuthStatus({ profile, site }),
    status: 'login_required',
    login_required: true,
    human_required: true,
    next_action: 'login_flow_not_implemented',
  };
}
