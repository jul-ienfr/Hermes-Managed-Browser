import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');

describe('managed browser fingerprint guard integration', () => {
  test('server exposes read-only fingerprint doctor endpoint', () => {
    expect(serverSource).toContain("app.post('/fingerprint/doctor'");
    expect(serverSource).toContain("managedApiHandle(req, res, 'fingerprint.doctor'");
    expect(serverSource).toContain('managedApiFingerprintDoctor(identity');
    expect(serverSource).toContain('validateVncGeometry');
    expect(serverSource).toContain("vnc: { ok: vnc.ok");
    expect(serverSource).toContain('{ write: false }');
  });

  test('server refuses write/site actions when runtime fingerprint is critically incoherent', () => {
    expect(serverSource).toContain('assertManagedFingerprintCoherent');
    expect(serverSource).toContain("code: 'managed_fingerprint_incoherent'");
    expect(serverSource).toContain('validateFingerprintCoherence');
    expect(serverSource).toContain('collectBrowserFingerprintSnapshot');
    expect(serverSource).toContain('managedApiRunFlow');
    expect(serverSource).toContain('managedApiOpenOrNavigate');
  });

  test('doctor and write guard both reload persisted fingerprints before deriving expected coherence', () => {
    const doctorStart = serverSource.indexOf('async function managedApiFingerprintDoctor');
    const guardStart = serverSource.indexOf('async function assertManagedFingerprintCoherent');
    const consoleStart = serverSource.indexOf('async function managedApiConsoleEval');
    expect(doctorStart).toBeGreaterThan(-1);
    expect(guardStart).toBeGreaterThan(-1);
    expect(consoleStart).toBeGreaterThan(guardStart);

    const doctorSource = serverSource.slice(doctorStart, guardStart);
    const guardSource = serverSource.slice(guardStart, consoleStart);

    for (const source of [doctorSource, guardSource]) {
      expect(source).toContain('loadPersistedFingerprint(profileRoot, identity.userId');
      expect(source).toContain('launchProfile.persistedFingerprint = persistedFingerprint.fingerprint');
      expect(source.indexOf('loadPersistedFingerprint(profileRoot, identity.userId')).toBeLessThan(
        source.indexOf('expectedFingerprintFromLaunchProfile(launchProfile)'),
      );
    }
  });
});
