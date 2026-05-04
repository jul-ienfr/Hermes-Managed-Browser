import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { PassThrough } from 'node:stream';

import { credentialPath, promptSecret, validateCredentialSecret, writeCredentialToPass } from '../../lib/credentials-vault.js';

function fakeSpawn(calls, exitCode = 0) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call = { cmd, args, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', exitCode)));
    return child;
  };
}

describe('Managed Browser pass-backed credential vault', () => {
  test('builds scoped pass paths without accepting path traversal segments', () => {
    expect(credentialPath({ profile: 'emploi', site: 'france-travail', kind: 'password' })).toBe('managed-browser/emploi/france-travail/password');
    expect(() => credentialPath({ profile: '../emploi', site: 'france-travail', kind: 'password' })).toThrow('Invalid --profile');
    expect(() => credentialPath({ profile: 'emploi', site: 'france/travail', kind: 'password' })).toThrow('Invalid --site');
  });

  test('writes password to pass insert via stdin and returns only redacted status', async () => {
    const calls = [];
    const secret = 'SUPER_SECRET_PASSWORD';

    const result = await writeCredentialToPass({
      profile: 'emploi',
      site: 'france-travail',
      kind: 'password',
      secret,
      spawnFn: fakeSpawn(calls),
    });

    expect(calls).toEqual([{
      cmd: 'pass',
      args: ['insert', '--force', '--multiline', 'managed-browser/emploi/france-travail/password'],
      input: secret,
    }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({
      success: true,
      kind: 'password',
      stored: true,
      redacted: true,
      llm_used: false,
    });
  });

  test('writes otp seed through pass otp insert and rejects transient six-digit codes', async () => {
    const calls = [];
    await expect(writeCredentialToPass({
      profile: 'emploi',
      site: 'france-travail',
      kind: 'otp',
      secret: '123456',
      spawnFn: fakeSpawn(calls),
    })).rejects.toThrow('not a transient 6-digit code');

    const result = await writeCredentialToPass({
      profile: 'emploi',
      site: 'france-travail',
      kind: 'otp',
      secret: 'otpauth://totp/FranceTravail:julien?secret=BASE32SECRET&issuer=FranceTravail',
      spawnFn: fakeSpawn(calls),
    });

    expect(calls[0]).toMatchObject({
      cmd: 'pass',
      args: ['otp', 'insert', '--force', 'managed-browser/emploi/france-travail/otp'],
    });
    expect(JSON.stringify(result)).not.toContain('BASE32SECRET');
  });

  test('validates durable otp seed shape before calling pass', () => {
    expect(() => validateCredentialSecret('otp', 'short')).toThrow('durable TOTP seed');
  });

  test('prompts for credentials with terminal echo disabled and restores echo afterwards', async () => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = jest.fn();
    stdin.resume = jest.fn();
    stdin.pause = jest.fn();
    const stdout = new PassThrough();
    stdout.columns = 80;
    stdout.isTTY = true;
    let output = '';
    stdout.on('data', (chunk) => { output += chunk.toString(); });

    const promise = promptSecret({ kind: 'password', stdin, stdout });
    stdin.emit('keypress', 's', { name: 's' });
    stdin.emit('keypress', '3', { name: '3' });
    stdin.emit('keypress', 'Enter', { name: 'return' });

    await expect(promise).resolves.toBe('s3');
    expect(output).toContain('password: ');
    expect(output).not.toContain('s3');
    expect(output).toContain('**');
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
