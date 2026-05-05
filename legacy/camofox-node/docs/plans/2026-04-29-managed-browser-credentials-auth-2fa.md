# Managed Browser Credentials + Auth/2FA Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a free/open-source credential and 2FA foundation to Managed Browser so browser-backed tools can reconnect when sessions expire without storing secrets in downstream CLIs such as `/home/jul/Emploi`.

**Architecture:** Managed Browser owns web-login credentials and auth state. Secrets are read from a local `pass`/GPG/`pass-otp` password store through a narrow provider API; CLI/API/tool surfaces return only redacted status and never passwords/TOTP secrets. Site login automation is separated from generic credential storage: phase 1 ships credential/status/auth primitives, then site-specific flows such as France Travail can call those primitives.

**Tech Stack:** Node.js ESM, Jest, existing `scripts/managed-browser.js` CLI, existing Express `server.js`, external `pass`, `gpg`, `pass-otp`, optional `oathtool`/TOTP fallback only if explicitly added later.

---

## Contexte vérifié

- Repo path: `/home/jul/tools/camofox-browser`.
- Current branch: `master`.
- Current git state is heavily dirty and diverged from upstream: `master...origin/master [ahead 4, behind 98]`, many modified/untracked files. Implementation must stage only intended files explicitly; avoid broad commits.
- Current Managed Browser CLI entrypoint: `scripts/managed-browser.js`.
- Existing CLI commands include:
  - `profile status`
  - `flow run/list/inspect`
  - `navigate`
  - `console eval`
  - `snapshot`
  - `storage checkpoint`
  - `notifications ...`
- Existing CLI tests: `tests/unit/managedBrowserCli.test.js` import `{ main, parseArgs, requestForCommand }` from `scripts/managed-browser.js`.
- Current local dependencies:
  - `gpg`: installed at `/usr/bin/gpg`
  - `pass`: not installed
  - `pass-otp`: not installed
  - `oathtool`: not installed
- Julien wants a free/open-source solution and has no YubiKey.
- Desired policy:
  - TOTP: automatic when configured.
  - Email/SMS 2FA: `human_required` in MVP; later optional automation through a dedicated approved mail/SMS provider.
  - Push/app/passkey/FranceConnect: `human_required`; Managed Browser can wait for human completion and checkpoint after success.
- Secrets must not be stored in `emploi`, SQLite app DBs, `.env`, logs, browser-flow memory, screenshots, or git-tracked fixtures.

---

## Target user-facing behavior

### Install prerequisites

```bash
sudo apt update
sudo apt install -y pass gnupg pass-extension-otp
```

If Debian/Ubuntu package name differs for `pass-otp`, detect it in docs and provide fallback instructions. Do not auto-install from product code.

### Credential paths in pass

Use stable paths:

```text
managed-browser/<site>/<profile>/username
managed-browser/<site>/<profile>/password
managed-browser/<site>/<profile>/otp
```

Example:

```text
managed-browser/france-travail/emploi/username
managed-browser/france-travail/emploi/password
managed-browser/france-travail/emploi/otp
```

### CLI commands

Read/status commands:

```bash
node scripts/managed-browser.js credential status --site france-travail --profile emploi --json
node scripts/managed-browser.js credential get-otp --site france-travail --profile emploi --json
node scripts/managed-browser.js auth status --site france-travail --profile emploi --json
node scripts/managed-browser.js auth ensure --site france-travail --profile emploi --json
```

Secure write commands are required. Do **not** pass secrets as command-line arguments because argv can leak through shell history and process listings. Support interactive prompt and stdin modes:

```bash
# Interactive prompt; password/TOTP input hidden where possible
node scripts/managed-browser.js credential set username --site france-travail --profile emploi
node scripts/managed-browser.js credential set password --site france-travail --profile emploi
node scripts/managed-browser.js credential set otp --site france-travail --profile emploi

# Non-interactive but still not argv/history; secret comes from stdin
printf '%s' "$FRANCE_TRAVAIL_USERNAME" | node scripts/managed-browser.js credential set username --site france-travail --profile emploi --stdin
printf '%s' "$FRANCE_TRAVAIL_PASSWORD" | node scripts/managed-browser.js credential set password --site france-travail --profile emploi --stdin
printf '%s' "$FRANCE_TRAVAIL_OTP_URI" | node scripts/managed-browser.js credential set otp --site france-travail --profile emploi --stdin
```

`credential set otp` stores an `otpauth://...` URI through `pass otp insert`; it must not accept a raw one-time 6-digit code as the durable secret.

### JSON status examples

Credential status should not reveal secret values:

```json
{
  "success": true,
  "ok": true,
  "operation": "credential.status",
  "site": "france-travail",
  "profile": "emploi",
  "provider": "pass",
  "available": true,
  "username": true,
  "password": true,
  "totp": true,
  "missing": [],
  "llm_used": false
}
```

OTP retrieval returns only the generated short-lived code, never the TOTP secret:

```json
{
  "success": true,
  "ok": true,
  "operation": "credential.get_otp",
  "site": "france-travail",
  "profile": "emploi",
  "provider": "pass",
  "otp": "123456",
  "expires_in_seconds": 17,
  "llm_used": false
}
```

Auth ensure MVP should be conservative:

```json
{
  "success": false,
  "ok": false,
  "operation": "auth.ensure",
  "site": "france-travail",
  "profile": "emploi",
  "status": "credentials_ready_login_flow_missing",
  "credentials": {
    "username": true,
    "password": true,
    "totp": true
  },
  "supported_2fa": {
    "totp": "automatic",
    "email": "human_required",
    "sms": "human_required",
    "push": "human_required",
    "passkey": "human_required"
  },
  "llm_used": false
}
```

Once site-specific flows are implemented, `auth.ensure` can return:

```json
{
  "success": true,
  "ok": true,
  "operation": "auth.ensure",
  "site": "france-travail",
  "profile": "emploi",
  "status": "authenticated",
  "used_credentials": true,
  "used_totp": true,
  "checkpointed": true,
  "llm_used": false
}
```

---

## Security rules

1. Never log username/password/TOTP secret. Username may be treated as sensitive by default; status only returns booleans.
2. Never print password or TOTP secret from Managed Browser CLI/API.
3. `credential get-otp` may print generated OTP because it is a short-lived 2FA code required for automation; do not persist it.
4. All errors from provider commands must be redacted. Do not include command stdout/stderr unless sanitized.
5. Use `spawnFile`/`execFile` style subprocesses, not shell interpolation.
6. Validate `site` and `profile` path components with a strict allowlist regex, e.g. `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/`; reject `..`, `/`, spaces, shell metacharacters.
7. Do not write fallback plaintext files.
8. If `pass` or `pass-otp` is missing, return `provider_unavailable` with install hints, not a stack trace.
9. Tests must use fake commands/temp dirs and must not read Julien's real password store.
10. No final submit / binding web action should be added here; auth only.

---

## Phase 0: Prepare prerequisites docs only

### Task 0.1: Document manual prerequisite install

**Objective:** Add operator docs for installing and initializing `pass`/GPG/`pass-otp` without product code auto-installing packages.

**Files:**
- Create: `docs/managed-browser-credentials-auth.md`

**Step 1: Write docs skeleton**

Content must include:

```markdown
# Managed Browser credentials and 2FA

## Backend

Managed Browser uses `pass` + GPG + `pass-otp` for the free/open-source credential backend.

## Install

```bash
sudo apt update
sudo apt install -y pass gnupg pass-extension-otp
```

## Initialize

```bash
gpg --full-generate-key
pass init <GPG_KEY_ID>
```

## Store France Travail credentials

```bash
pass insert managed-browser/france-travail/emploi/username
pass insert managed-browser/france-travail/emploi/password
pass otp insert managed-browser/france-travail/emploi/otp
```

## 2FA support policy

- TOTP: automatic.
- Email/SMS: human_required until a dedicated approved mail/SMS integration exists.
- Push/app/passkey/FranceConnect: human_required.
```

**Step 2: Verify docs render as markdown**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('docs/managed-browser-credentials-auth.md')
assert p.exists()
text = p.read_text()
assert 'pass otp insert' in text
assert 'human_required' in text
PY
```

Expected: exit code 0.

---

## Phase 1: Pass credential provider core

### Task 1.1: Add path validation tests

**Objective:** Freeze safe path component validation before writing provider code.

**Files:**
- Create: `tests/unit/credentialProvider.test.js`
- Create later: `lib/credential-provider.js`

**Step 1: Write failing tests**

```js
import { describe, expect, test } from '@jest/globals';
import { credentialPassPath, validateCredentialComponent } from '../../lib/credential-provider.js';

describe('credential provider path validation', () => {
  test('builds stable pass paths for site/profile/kind', () => {
    expect(credentialPassPath({ site: 'france-travail', profile: 'emploi', kind: 'username' }))
      .toBe('managed-browser/france-travail/emploi/username');
  });

  test.each(['../secret', 'a/b', 'with space', '', '.hidden', 'semi;colon', 'dollar$'])('rejects unsafe component %s', (value) => {
    expect(() => validateCredentialComponent(value, 'site')).toThrow(/Invalid credential site/);
  });

  test('rejects unsupported secret kinds', () => {
    expect(() => credentialPassPath({ site: 'france-travail', profile: 'emploi', kind: 'token' }))
      .toThrow(/Unsupported credential kind/);
  });
});
```

**Step 2: Run and verify RED**

Run:

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: FAIL because `lib/credential-provider.js` does not exist.

### Task 1.2: Implement path validation

**Objective:** Add minimal safe path builder.

**Files:**
- Create: `lib/credential-provider.js`

**Step 1: Implement minimal code**

```js
const SAFE_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;
const SUPPORTED_KINDS = new Set(['username', 'password', 'otp']);

export function validateCredentialComponent(value, label) {
  if (typeof value !== 'string' || !SAFE_COMPONENT.test(value)) {
    throw new Error(`Invalid credential ${label}`);
  }
  return value;
}

export function credentialPassPath({ site, profile, kind }) {
  validateCredentialComponent(site, 'site');
  validateCredentialComponent(profile, 'profile');
  if (!SUPPORTED_KINDS.has(kind)) throw new Error(`Unsupported credential kind: ${kind}`);
  return `managed-browser/${site}/${profile}/${kind}`;
}
```

**Step 2: Run GREEN**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: PASS.

---

## Phase 2: Pass command runner with redacted status

### Task 2.1: Test provider availability and non-secret status

**Objective:** Confirm status checks use injected command runner and never return secret values.

**Files:**
- Modify: `tests/unit/credentialProvider.test.js`
- Modify: `lib/credential-provider.js`

**Step 1: Add failing tests**

```js
import { createPassCredentialProvider } from '../../lib/credential-provider.js';

describe('pass credential provider status', () => {
  test('returns provider_unavailable when pass is missing', async () => {
    const provider = createPassCredentialProvider({
      runCommand: async () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
    });

    await expect(provider.status({ site: 'france-travail', profile: 'emploi' })).resolves.toMatchObject({
      provider: 'pass',
      available: false,
      reason: 'provider_unavailable',
      username: false,
      password: false,
      totp: false,
    });
  });

  test('reports booleans for configured username/password/totp without returning values', async () => {
    const calls = [];
    const provider = createPassCredentialProvider({
      runCommand: async (cmd, args) => {
        calls.push([cmd, args]);
        const path = args.at(-1);
        if (path.endsWith('/username') || path.endsWith('/password') || path.endsWith('/otp')) {
          return { exitCode: 0, stdout: 'SECRET_VALUE\n', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'missing' };
      },
    });

    const status = await provider.status({ site: 'france-travail', profile: 'emploi' });

    expect(status).toMatchObject({ available: true, username: true, password: true, totp: true, missing: [] });
    expect(JSON.stringify(status)).not.toContain('SECRET_VALUE');
    expect(calls.map(([cmd]) => cmd)).toEqual(['pass', 'pass', 'pass']);
  });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: FAIL because `createPassCredentialProvider` is missing.

### Task 2.2: Implement status provider

**Objective:** Add injected command runner and redacted booleans.

**Files:**
- Modify: `lib/credential-provider.js`

**Implementation notes:**

- Use `child_process.execFile` via `node:child_process` and `node:util.promisify` for default runner.
- For status, check:
  - `pass show <path>/username`
  - `pass show <path>/password`
  - `pass show <path>/otp`
- Do not keep stdout.
- Treat `exitCode === 127` / `ENOENT` as provider unavailable.
- Missing individual entries should not be provider unavailable if `pass` exists.

Add code like:

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultRunCommand(command, args) {
  try {
    const { stdout = '', stderr = '' } = await execFileAsync(command, args, { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    return {
      exitCode: typeof err.code === 'number' ? err.code : (err.code === 'ENOENT' ? 127 : 1),
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

function isUnavailable(result) {
  return result.exitCode === 127;
}

export function createPassCredentialProvider({ runCommand = defaultRunCommand } = {}) {
  async function checkKind(site, profile, kind) {
    const path = credentialPassPath({ site, profile, kind });
    const result = await runCommand('pass', ['show', path]);
    if (isUnavailable(result)) return { configured: false, unavailable: true };
    return { configured: result.exitCode === 0, unavailable: false };
  }

  return {
    provider: 'pass',
    async status({ site, profile }) {
      validateCredentialComponent(site, 'site');
      validateCredentialComponent(profile, 'profile');
      const username = await checkKind(site, profile, 'username');
      if (username.unavailable) return { provider: 'pass', available: false, reason: 'provider_unavailable', username: false, password: false, totp: false, missing: ['username', 'password', 'otp'] };
      const password = await checkKind(site, profile, 'password');
      const otp = await checkKind(site, profile, 'otp');
      const missing = [];
      if (!username.configured) missing.push('username');
      if (!password.configured) missing.push('password');
      if (!otp.configured) missing.push('otp');
      return { provider: 'pass', available: true, username: username.configured, password: password.configured, totp: otp.configured, missing };
    },
  };
}
```

**Step 2: Run GREEN**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: PASS.

---

## Phase 3: OTP retrieval without exposing TOTP secret

### Task 3.1: Test `pass otp` retrieval

**Objective:** Add generated OTP retrieval via `pass otp <path>` only.

**Files:**
- Modify: `tests/unit/credentialProvider.test.js`
- Modify: `lib/credential-provider.js`

**Step 1: Add failing tests**

```js
describe('pass credential provider otp', () => {
  test('returns generated otp from pass otp and rough expiry without exposing secret', async () => {
    const provider = createPassCredentialProvider({
      now: () => new Date('2026-04-29T22:31:13Z'),
      runCommand: async (cmd, args) => {
        expect(cmd).toBe('pass');
        expect(args).toEqual(['otp', 'managed-browser/france-travail/emploi/otp']);
        return { exitCode: 0, stdout: '123456\n', stderr: '' };
      },
    });

    await expect(provider.getOtp({ site: 'france-travail', profile: 'emploi' })).resolves.toMatchObject({
      provider: 'pass',
      otp: '123456',
      expires_in_seconds: 17,
    });
  });

  test('rejects malformed otp output', async () => {
    const provider = createPassCredentialProvider({
      runCommand: async () => ({ exitCode: 0, stdout: 'otpauth://totp/SECRET\n', stderr: '' }),
    });

    await expect(provider.getOtp({ site: 'france-travail', profile: 'emploi' })).rejects.toThrow(/Invalid OTP output/);
  });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: FAIL because `getOtp` is missing.

### Task 3.2: Implement `getOtp`

**Objective:** Call `pass otp` and validate code shape.

**Files:**
- Modify: `lib/credential-provider.js`

**Implementation notes:**

```js
function secondsUntilTotpExpiry(now = new Date()) {
  const seconds = Math.floor(now.getTime() / 1000);
  const rem = seconds % 30;
  return rem === 0 ? 30 : 30 - rem;
}
```

Inside provider:

```js
async getOtp({ site, profile }) {
  const path = credentialPassPath({ site, profile, kind: 'otp' });
  const result = await runCommand('pass', ['otp', path]);
  if (isUnavailable(result)) {
    const err = new Error('Credential provider unavailable: pass or pass-otp is not installed');
    err.code = 'provider_unavailable';
    throw err;
  }
  if (result.exitCode !== 0) {
    const err = new Error('OTP credential missing or unreadable');
    err.code = 'credential_missing';
    throw err;
  }
  const otp = String(result.stdout || '').trim().split(/\s+/)[0];
  if (!/^\d{6,8}$/.test(otp)) throw new Error('Invalid OTP output from credential provider');
  return { provider: 'pass', otp, expires_in_seconds: secondsUntilTotpExpiry(now()) };
}
```

**Step 2: Run GREEN**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: PASS.

---

## Phase 3.5: Secure credential write commands

### Task 3.5.1: Test secure set operations avoid argv secrets

**Objective:** Add Managed Browser CLI commands to store username/password/TOTP URI in `pass` without putting secret values in command-line args, shell history, logs, or JSON output.

**Files:**
- Modify: `tests/unit/credentialProvider.test.js`
- Modify: `lib/credential-provider.js`
- Modify later: `tests/unit/managedBrowserCli.test.js`
- Modify later: `scripts/managed-browser.js`

**Step 1: Add failing provider tests**

```js
describe('pass credential provider set operations', () => {
  test('stores username using pass insert --multiline without returning the value', async () => {
    const calls = [];
    const provider = createPassCredentialProvider({
      runCommand: async (cmd, args, options = {}) => {
        calls.push([cmd, args, options.stdin]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await provider.setSecret({
      site: 'france-travail',
      profile: 'emploi',
      kind: 'username',
      value: 'julien@example.test',
    });

    expect(result).toEqual({ provider: 'pass', kind: 'username', stored: true });
    expect(calls).toEqual([[
      'pass',
      ['insert', '--force', '--multiline', 'managed-browser/france-travail/emploi/username'],
      'julien@example.test\n',
    ]]);
    expect(JSON.stringify(result)).not.toContain('julien@example.test');
  });

  test('stores password without returning the value', async () => {
    const calls = [];
    const provider = createPassCredentialProvider({
      runCommand: async (cmd, args, options = {}) => {
        calls.push([cmd, args, options.stdin]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await provider.setSecret({
      site: 'france-travail',
      profile: 'emploi',
      kind: 'password',
      value: 'super-secret',
    });

    expect(result).toEqual({ provider: 'pass', kind: 'password', stored: true });
    expect(calls[0][1]).toEqual(['insert', '--force', '--multiline', 'managed-browser/france-travail/emploi/password']);
    expect(calls[0][2]).toBe('super-secret\n');
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  test('stores TOTP URI via pass otp insert and rejects raw 6 digit codes', async () => {
    const calls = [];
    const provider = createPassCredentialProvider({
      runCommand: async (cmd, args, options = {}) => {
        calls.push([cmd, args, options.stdin]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await expect(provider.setSecret({
      site: 'france-travail',
      profile: 'emploi',
      kind: 'otp',
      value: '123456',
    })).rejects.toThrow(/otpauth URI/);

    const result = await provider.setSecret({
      site: 'france-travail',
      profile: 'emploi',
      kind: 'otp',
      value: 'otpauth://totp/FranceTravail:julien?secret=ABC&issuer=FranceTravail',
    });

    expect(result).toEqual({ provider: 'pass', kind: 'otp', stored: true });
    expect(calls[0][0]).toBe('pass');
    expect(calls[0][1]).toEqual(['otp', 'insert', '--force', 'managed-browser/france-travail/emploi/otp']);
  });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: FAIL because `setSecret` and stdin-capable runner are missing.

### Task 3.5.2: Implement provider set operations with stdin

**Objective:** Write secrets into `pass` using stdin, never argv.

**Files:**
- Modify: `lib/credential-provider.js`

**Implementation rules:**

- Extend `runCommand(command, args, { stdin })` to support writing to subprocess stdin.
- For `username` and `password`, call:

```js
runCommand('pass', ['insert', '--force', '--multiline', path], { stdin: `${value}\n` })
```

- For `otp`, require `value.startsWith('otpauth://')`, then call:

```js
runCommand('pass', ['otp', 'insert', '--force', path], { stdin: `${value}\n` })
```

- Return only `{ provider: 'pass', kind, stored: true }`.
- On failure, return/throw redacted errors only.

**Step 2: Run GREEN**

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
```

Expected: PASS.

### Task 3.5.3: Add CLI parser tests for secure setters

**Objective:** Add `credential set <kind>` commands that read value from hidden prompt or stdin, not argv.

**Files:**
- Modify: `tests/unit/managedBrowserCli.test.js`
- Modify: `scripts/managed-browser.js`

**Step 1: Add failing parser tests**

```js
test('credential set commands select credential write endpoint without argv secret values', () => {
  expect(requestForCommand(parseArgs(['credential', 'set', 'password', '--profile', 'emploi', '--site', 'france-travail', '--stdin', '--json']))).toEqual({
    endpoint: '/credentials/set',
    operation: 'credential.set',
    payload: { profile: 'emploi', site: 'france-travail', kind: 'password', input: 'stdin' },
  });

  expect(() => parseArgs(['credential', 'set', 'password', '--profile', 'emploi', '--site', 'france-travail', '--value', 'secret']))
    .toThrow(/secrets must not be passed as arguments/);
});
```

**Step 2: Implement parser**

- Allow `credential set username|password|otp`.
- Allow `--stdin`.
- Do not support `--value`. If supplied, throw a clear error.
- Without `--stdin`, CLI should prompt interactively. For `password` and `otp`, hide input where possible.

**Step 3: Implement transport**

For `--stdin`, `main()` reads from `process.stdin` and posts payload:

```json
{ "profile": "emploi", "site": "france-travail", "kind": "password", "value": "..." }
```

This value is in request body to local daemon only, not argv. Do not log request body.

For interactive mode, read prompt input and send the same body.

**Step 4: Run GREEN**

```bash
npm test -- tests/unit/managedBrowserCli.test.js --runInBand
```

Expected: PASS.

### Task 3.5.4: Add server route for credential writes

**Objective:** Expose local-only API to store credentials through provider while returning redacted JSON.

**Files:**
- Modify: `tests/unit/credentialRoutes.test.js`
- Modify: `server.js` or `lib/credential-routes.js`

**Route:** `POST /credentials/set`

Payload:

```json
{
  "site": "france-travail",
  "profile": "emploi",
  "kind": "password",
  "value": "secret from stdin/prompt"
}
```

Response:

```json
{
  "success": true,
  "ok": true,
  "operation": "credential.set",
  "site": "france-travail",
  "profile": "emploi",
  "provider": "pass",
  "kind": "password",
  "stored": true,
  "llm_used": false
}
```

**Rules:**

- Never echo `value`.
- Reject missing/empty `value`.
- Reject invalid `kind`.
- Reject `otp` values that are not `otpauth://...`.
- Redact provider errors.

---

## Phase 4: Server API routes

### Task 4.1: Locate existing route test style

**Objective:** Identify how this repo starts the Express app in tests before adding endpoints.

**Files:**
- Read: `tests/helpers/startServer.js`
- Read any existing route tests: `tests/unit/managedNotificationsRoutes.test.js`, `tests/unit/vncProfileRoutes.test.js`, etc.

**Step 1: Inspect files**

```bash
sed -n '1,220p' tests/helpers/startServer.js
sed -n '1,220p' tests/unit/managedNotificationsRoutes.test.js
```

Use `read_file` instead of `sed` if using Hermes tools.

### Task 4.2: Add API route tests

**Objective:** Define HTTP contract for credential/auth endpoints.

**Files:**
- Create: `tests/unit/credentialRoutes.test.js`
- Modify later: `server.js` or route module if server has modular routes.

**Tests to add:**

1. `POST /credentials/status` with `{ site, profile }` returns redacted booleans.
2. `POST /credentials/otp` returns generated OTP but not secret.
3. `POST /auth/status` returns credential readiness and supported 2FA policy.
4. `POST /auth/ensure` returns `credentials_ready_login_flow_missing` until site login flow exists.
5. Unsafe `site`/`profile` returns 400.
6. Provider unavailable returns success false/status `provider_unavailable` without stack/stderr.

**Implementation hint:** If the current server cannot easily inject a fake provider, add a tiny exported factory/helper rather than coupling tests to real `pass`.

Expected RED: endpoints 404 or module missing.

### Task 4.3: Implement credential/auth route helpers

**Objective:** Add minimal routes without site-specific browser login.

**Files:**
- Modify: `server.js` or create `lib/credential-routes.js` and wire it from `server.js`.
- Modify: `lib/credential-provider.js` if needed.

**Recommended route payloads:**

`POST /credentials/status`

```js
{
  site: string,
  profile: string
}
```

`POST /credentials/otp`

```js
{
  site: string,
  profile: string
}
```

`POST /auth/status` and `/auth/ensure`:

```js
{
  site: string,
  profile: string
}
```

**Shared 2FA policy:**

```js
export const SUPPORTED_2FA_POLICY = Object.freeze({
  totp: 'automatic',
  email: 'human_required',
  sms: 'human_required',
  push: 'human_required',
  passkey: 'human_required',
});
```

**Route behavior:**

- Always include `llm_used: false`.
- Always include `profile` and `site` echoed after validation.
- Do not include command stderr/stdout.
- `auth.ensure` for MVP does not drive browser login; it reports readiness/future flow status.

**Step 2: Run route tests**

```bash
npm test -- tests/unit/credentialRoutes.test.js --runInBand
```

Expected: PASS.

---

## Phase 5: CLI surface

### Task 5.1: Add CLI parser/request tests

**Objective:** Extend `scripts/managed-browser.js` without contacting daemon in parser tests.

**Files:**
- Modify: `tests/unit/managedBrowserCli.test.js`
- Modify later: `scripts/managed-browser.js`

**Step 1: Add failing tests**

Add to `describe('managed-browser CLI argument parsing and request selection', ...)`:

```js
test('credential status and get-otp select credential endpoints', () => {
  expect(requestForCommand(parseArgs(['credential', 'status', '--profile', 'emploi', '--site', 'france-travail', '--json']))).toEqual({
    endpoint: '/credentials/status',
    operation: 'credential.status',
    payload: { profile: 'emploi', site: 'france-travail' },
  });

  expect(requestForCommand(parseArgs(['credential', 'get-otp', '--profile', 'emploi', '--site', 'france-travail', '--json']))).toEqual({
    endpoint: '/credentials/otp',
    operation: 'credential.get_otp',
    payload: { profile: 'emploi', site: 'france-travail' },
  });
});

test('auth status and ensure select auth endpoints', () => {
  expect(requestForCommand(parseArgs(['auth', 'status', '--profile', 'emploi', '--site', 'france-travail', '--json']))).toEqual({
    endpoint: '/auth/status',
    operation: 'auth.status',
    payload: { profile: 'emploi', site: 'france-travail' },
  });

  expect(requestForCommand(parseArgs(['auth', 'ensure', '--profile', 'emploi', '--site', 'france-travail', '--json']))).toEqual({
    endpoint: '/auth/ensure',
    operation: 'auth.ensure',
    payload: { profile: 'emploi', site: 'france-travail' },
  });
});
```

**Step 2: Verify RED**

```bash
npm test -- tests/unit/managedBrowserCli.test.js --runInBand
```

Expected: FAIL unknown command.

### Task 5.2: Implement CLI commands

**Objective:** Add parse/request support and usage lines.

**Files:**
- Modify: `scripts/managed-browser.js`

**Implementation notes:**

Add usage lines:

```text
node scripts/managed-browser.js credential status --profile <profile> [--site <site>] [--json]
node scripts/managed-browser.js credential get-otp --profile <profile> [--site <site>] [--json]
node scripts/managed-browser.js auth status --profile <profile> [--site <site>] [--json]
node scripts/managed-browser.js auth ensure --profile <profile> [--site <site>] [--json]
```

Add parse branches after profile/flow branches:

```js
if (command === 'credential') {
  const action = subcommand;
  const allowed = new Set(['status', 'get-otp']);
  if (!allowed.has(action)) throw new CliUsageError(`Unknown credential command: ${action || ''}`.trim());
  const parsed = parseCommonOptions(argv, 2, { command: `credential ${action}`, json: false });
  requireProfile(parsed);
  return parsed;
}

if (command === 'auth') {
  const action = subcommand;
  const allowed = new Set(['status', 'ensure']);
  if (!allowed.has(action)) throw new CliUsageError(`Unknown auth command: ${action || ''}`.trim());
  const parsed = parseCommonOptions(argv, 2, { command: `auth ${action}`, json: false });
  requireProfile(parsed);
  return parsed;
}
```

Add request branches:

```js
if (parsed.command === 'credential status') return { endpoint: '/credentials/status', payload, operation: 'credential.status' };
if (parsed.command === 'credential get-otp') return { endpoint: '/credentials/otp', payload, operation: 'credential.get_otp' };
if (parsed.command === 'auth status') return { endpoint: '/auth/status', payload, operation: 'auth.status' };
if (parsed.command === 'auth ensure') return { endpoint: '/auth/ensure', payload, operation: 'auth.ensure' };
```

**Step 2: Run GREEN**

```bash
npm test -- tests/unit/managedBrowserCli.test.js --runInBand
```

Expected: PASS.

---

## Phase 6: Hermes plugin tool surface

### Task 6.1: Add plugin contract tests for auth tools

**Objective:** Expose managed auth to Hermes as tools without exposing secrets.

**Files:**
- Modify: `tests/unit/hermesOriginalTools.test.js` or create `tests/unit/managedAuthTools.test.js` depending existing pattern.
- Modify later: `plugin.ts`.

**Tools to register:**

- `managed_browser_credential_status`
- `managed_browser_credential_get_otp` (optional; consider not exposing to general agents unless needed)
- `managed_browser_auth_status`
- `managed_browser_auth_ensure`

**Safer default:** expose `credential_status`, `auth_status`, and `auth_ensure`. Avoid exposing `credential_get_otp` to Hermes unless the auth flow implementation needs it internally. If exposed, description must say it returns a short-lived OTP and should never be logged.

**Expected RED:** tools not registered.

### Task 6.2: Implement plugin wrappers

**Objective:** Add wrappers calling server endpoints with same identity policy as other `managed_browser_*` tools.

**Files:**
- Modify: `plugin.ts`

**Rules:**

- Use existing managed profile normalization/payload helpers if present.
- Keep `profile` required.
- `site` optional only where existing managed tools allow optional site; if omitted, backend still validates any provided site.
- Do not add raw password/username tools.

**Verification:**

```bash
npm test -- tests/unit/hermesOriginalTools.test.js --runInBand
npm run typecheck
```

---

## Phase 7: Optional Emploi wrapper command

### Task 7.1: Add emploi CLI wrapper only after Managed Browser API is green

**Objective:** Add `emploi browser auth-status` / `emploi browser ensure-login` as thin wrappers that never read secrets.

**Files:**
- Repo: `/home/jul/Emploi`
- Follow `emploi-cli-maintenance` skill.
- Tests first in Emploi repo.

**Commands:**

```bash
PYTHONPATH=. python3 -m emploi.cli browser auth-status --site france-travail --profile emploi --json
PYTHONPATH=. python3 -m emploi.cli browser ensure-login --site france-travail --profile emploi --json
```

**Behavior:** Calls Managed Browser CLI:

```bash
node /home/jul/tools/camofox-browser/scripts/managed-browser.js auth status --site france-travail --profile emploi --json
node /home/jul/tools/camofox-browser/scripts/managed-browser.js auth ensure --site france-travail --profile emploi --json
```

**Rule:** Emploi must not implement credential storage or parse password/TOTP values.

---

## Phase 8: Manual operator setup and smoke test

### Task 8.1: Install packages manually

**Objective:** Prepare host for pass/GPG/pass-otp.

Run only with Julien's approval/sudo session:

```bash
sudo apt update
sudo apt install -y pass gnupg pass-extension-otp
```

Verify:

```bash
command -v pass
command -v gpg
pass otp --help >/dev/null
```

### Task 8.2: Initialize pass if needed

**Objective:** Create a local GPG-backed password store.

```bash
gpg --list-secret-keys --keyid-format=long
```

If no suitable key exists:

```bash
gpg --full-generate-key
```

Recommended identity:

```text
Name: Julien Managed Browser Automation
Email: managed-browser@local
```

Then:

```bash
pass init <GPG_KEY_ID>
```

### Task 8.3: Store France Travail entries

**Objective:** Store initial credentials without shell history leaks.

```bash
pass insert managed-browser/france-travail/emploi/username
pass insert managed-browser/france-travail/emploi/password
pass otp insert managed-browser/france-travail/emploi/otp
```

If no TOTP exists for France Travail, skip OTP and status should show `totp: false`.

### Task 8.4: Smoke test Managed Browser status

```bash
MANAGED_BROWSER_URL=http://127.0.0.1:9377 node scripts/managed-browser.js credential status --site france-travail --profile emploi --json
MANAGED_BROWSER_URL=http://127.0.0.1:9377 node scripts/managed-browser.js auth status --site france-travail --profile emploi --json
```

If OTP configured:

```bash
MANAGED_BROWSER_URL=http://127.0.0.1:9377 node scripts/managed-browser.js credential get-otp --site france-travail --profile emploi --json
```

Expected: status JSON only, no password/TOTP secret.

---

## Phase 9: France Travail login flow, later task

Do not bundle into the credential MVP unless the provider/API/CLI are already green.

Future site-specific flow:

1. `auth.ensure` checks current browser snapshot for logged-in indicators.
2. If logged in: returns `authenticated`.
3. If login page: retrieves username/password internally from provider.
4. Types credentials using managed browser DOM tools.
5. If TOTP screen: calls provider `getOtp` internally and fills it.
6. If email/SMS/push/passkey/FranceConnect screen: returns `human_required` with reason and maybe a human view URL.
7. After human or automated success: calls storage checkpoint.
8. Returns `authenticated`, `used_credentials`, `used_totp`, `checkpointed`.

Add this only with TDD and a fake France Travail page/fixture first.

---

## Final verification checklist

Run from `/home/jul/tools/camofox-browser`:

```bash
npm test -- tests/unit/credentialProvider.test.js --runInBand
npm test -- tests/unit/credentialRoutes.test.js --runInBand
npm test -- tests/unit/managedBrowserCli.test.js --runInBand
npm test -- tests/unit/hermesOriginalTools.test.js --runInBand
npm run typecheck
node --check server.js
node --check scripts/managed-browser.js
```

Security checks:

```bash
git diff --stat
git diff --check
git diff -- . ':(exclude)docs/plans/2026-04-29-managed-browser-credentials-auth-2fa.md' | grep -Ei 'password|totp|secret|otp|credential' || true
```

Manual smoke only after package/pass setup:

```bash
MANAGED_BROWSER_URL=http://127.0.0.1:9377 node scripts/managed-browser.js credential status --site france-travail --profile emploi --json
MANAGED_BROWSER_URL=http://127.0.0.1:9377 node scripts/managed-browser.js auth status --site france-travail --profile emploi --json
```

Expected:
- All tests pass.
- No secret values in diffs/logs.
- CLI returns redacted JSON.
- `llm_used: false` on credential/auth calls.

---

## Commit strategy

Because the repo is already dirty/diverged, commit only intended files explicitly if Julien asks to commit/push:

```bash
git add docs/managed-browser-credentials-auth.md \
  docs/plans/2026-04-29-managed-browser-credentials-auth-2fa.md \
  lib/credential-provider.js \
  tests/unit/credentialProvider.test.js \
  tests/unit/credentialRoutes.test.js \
  scripts/managed-browser.js \
  tests/unit/managedBrowserCli.test.js \
  plugin.ts \
  tests/unit/hermesOriginalTools.test.js \
  server.js

git diff --cached --check
npm test -- tests/unit/credentialProvider.test.js tests/unit/credentialRoutes.test.js tests/unit/managedBrowserCli.test.js --runInBand
npm run typecheck

git commit -m "feat: add managed browser credential auth foundation"
```

Do not use `git add .`.
