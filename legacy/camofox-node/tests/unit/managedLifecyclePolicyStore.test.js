import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getLifecycleDefault, normalizeLifecycleClosePolicy, setLifecycleDefault } from '../../lib/managed-lifecycle-policy-store.js';

describe('Managed Browser lifecycle policy store', () => {
  test('normalizes supported close policies and rejects invalid delays', () => {
    expect(normalizeLifecycleClosePolicy({ mode: 'never' })).toEqual({ mode: 'never' });
    expect(normalizeLifecycleClosePolicy({ mode: 'after_task' })).toEqual({ mode: 'after_task' });
    expect(normalizeLifecycleClosePolicy({ mode: 'delay', delaySeconds: '90' })).toEqual({ mode: 'delay', delaySeconds: 90 });
    expect(() => normalizeLifecycleClosePolicy({ mode: 'delay', delaySeconds: '0' })).toThrow('positive integer');
    expect(() => normalizeLifecycleClosePolicy({ mode: 'sometimes' })).toThrow('Unsupported lifecycle close mode');
  });

  test('persists per-profile lifecycle defaults outside the repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-lifecycle-'));
    const filePath = path.join(dir, 'defaults.json');

    const result = setLifecycleDefault({
      profile: 'emploi-officiel',
      site: 'france-travail',
      close: { mode: 'delay', delaySeconds: 120 },
    }, { filePath });

    expect(result).toMatchObject({
      success: true,
      profile: 'emploi-officiel',
      site: 'france-travail',
      close: { mode: 'delay', delaySeconds: 120 },
      persisted: true,
    });
    expect(getLifecycleDefault({ profile: 'emploi-officiel', site: 'france-travail' }, { filePath })).toEqual({ mode: 'delay', delaySeconds: 120 });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))['emploi-officiel::france-travail']).toMatchObject({
      profile: 'emploi-officiel',
      site: 'france-travail',
      close: { mode: 'delay', delaySeconds: 120 },
    });
  });
});
