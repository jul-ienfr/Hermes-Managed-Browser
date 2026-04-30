import { describe, expect, test } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function filesUnder(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) entries.push(...filesUnder(path));
    else if (/\.(js|json)$/.test(name)) entries.push(path);
  }
  return entries;
}

describe('no CAPTCHA solver runtime policy', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const sources = filesUnder(join(repoRoot, 'lib')).concat([join(repoRoot, 'server.js'), join(repoRoot, 'package.json')]);

  test('managed browser runtime does not depend on commercial solver APIs or extensions', () => {
    const forbidden = /nopecha|capmonster|2captcha|anticaptcha|anti-captcha|deathbycaptcha|captcha\s*solver/i;
    for (const file of sources) {
      expect(readFileSync(file, 'utf8')).not.toMatch(forbidden);
    }
  });
});
