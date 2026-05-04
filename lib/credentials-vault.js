import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { stdin as processStdin, stdout as processStdout } from 'node:process';

const SECRET_ARGUMENT_ERROR = 'secrets must not be passed as arguments';
const DEFAULT_STORE_PREFIX = 'managed-browser';
const ALLOWED_KINDS = new Set(['username', 'password', 'otp']);
const SIX_DIGIT_CODE = /^\d{6}$/;

class CredentialVaultError extends Error {
  constructor(message, { code = 'credential_vault_error', exitCode = 1 } = {}) {
    super(message);
    this.name = 'CredentialVaultError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function assertSafeSegment(value, label) {
  if (!value || typeof value !== 'string') {
    throw new CredentialVaultError(`Missing required ${label}`, { code: 'missing_argument', exitCode: 2 });
  }
  if (value.includes('/') || value.includes('..') || /[\u0000-\u001f]/.test(value)) {
    throw new CredentialVaultError(`Invalid ${label}`, { code: 'invalid_argument', exitCode: 2 });
  }
  return value;
}

function normalizeKind(kind) {
  if (!ALLOWED_KINDS.has(kind)) {
    throw new CredentialVaultError(`Unsupported credential kind: ${kind || ''}`.trim(), { code: 'unsupported_kind', exitCode: 2 });
  }
  return kind;
}

export function credentialPath({ profile, site, kind, prefix = DEFAULT_STORE_PREFIX }) {
  return [
    assertSafeSegment(prefix, 'vault prefix'),
    assertSafeSegment(profile, '--profile <profile>'),
    assertSafeSegment(site, '--site <site>'),
    normalizeKind(kind),
  ].join('/');
}

export function validateCredentialSecret(kind, secret) {
  normalizeKind(kind);
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new CredentialVaultError('Missing credential value on stdin', { code: 'missing_secret', exitCode: 2 });
  }
  if (kind === 'otp') {
    const trimmed = secret.trim();
    if (SIX_DIGIT_CODE.test(trimmed)) {
      throw new CredentialVaultError('credential set otp requires a durable TOTP seed or otpauth:// URI, not a transient 6-digit code', {
        code: 'transient_totp_code_rejected',
        exitCode: 2,
      });
    }
    if (!trimmed.startsWith('otpauth://') && trimmed.length < 16) {
      throw new CredentialVaultError('credential set otp requires a durable TOTP seed or otpauth:// URI', {
        code: 'invalid_totp_secret',
        exitCode: 2,
      });
    }
  }
  return secret;
}

export function redactCredentialResult({ profile, site, kind, path }) {
  return {
    ok: true,
    success: true,
    operation: `credential.set.${kind}`,
    profile,
    site,
    kind,
    path,
    stored: true,
    redacted: true,
    llm_used: false,
    external_actions: 0,
  };
}

export function runPassCommand(args, { input, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('pass', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => reject(new CredentialVaultError(`pass command unavailable: ${err.message}`, { code: 'pass_unavailable' })));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CredentialVaultError(`pass command failed with exit code ${code}`, { code: 'pass_failed' }));
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

export async function writeCredentialToPass({ profile, site, kind, secret, spawnFn }) {
  const path = credentialPath({ profile, site, kind });
  const value = validateCredentialSecret(kind, secret);
  if (kind === 'otp') {
    await runPassCommand(['otp', 'insert', '--force', path], { input: value, spawnFn });
  } else {
    await runPassCommand(['insert', '--force', '--multiline', path], { input: value, spawnFn });
  }
  return redactCredentialResult({ profile, site, kind, path });
}

export async function readSecretFromStdin(stdin = processStdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function promptSecret({ kind, stdin = processStdin, stdout = processStdout } = {}) {
  const label = kind === 'otp' ? 'TOTP seed or otpauth URI' : kind;
  const wasRaw = Boolean(stdin.isRaw);
  const canRaw = typeof stdin.setRawMode === 'function' && stdin.isTTY !== false;
  const canResume = typeof stdin.resume === 'function';
  const canPause = typeof stdin.pause === 'function';

  stdout.write(`${label}: `);
  if (canResume) stdin.resume();
  if (canRaw) stdin.setRawMode(true);
  emitKeypressEvents(stdin);

  return await new Promise((resolve, reject) => {
    let secret = '';
    let settled = false;

    const cleanup = () => {
      stdin.off('keypress', onKeypress);
      stdin.off('error', onError);
      if (canRaw) stdin.setRawMode(wasRaw);
      if (canPause && !wasRaw) stdin.pause();
      stdout.write('\n');
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(secret);
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        onError(new CredentialVaultError('Credential input cancelled', { code: 'input_cancelled', exitCode: 130 }));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        if (secret.length > 0) secret = secret.slice(0, -1);
        return;
      }
      if (typeof str === 'string' && str.length > 0 && !key.ctrl && !key.meta) {
        secret += str;
        stdout.write('*');
      }
    };

    stdin.on('keypress', onKeypress);
    stdin.on('error', onError);
  });
}

export { CredentialVaultError, SECRET_ARGUMENT_ERROR };
