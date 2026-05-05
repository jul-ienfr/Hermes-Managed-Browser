import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('snapshot cache policy', () => {
  const repoRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
  const serverSource = readFileSync(join(repoRoot, 'server.js'), 'utf8');

  test('reuses last snapshot only for non-screenshot first-page requests on the same URL', () => {
    expect(serverSource).toContain('const includeScreenshot = req.query.includeScreenshot === \'true\';');
    expect(serverSource).toContain('const currentUrl = tabState.page.url();');
    expect(serverSource).toContain('!includeScreenshot && offset === 0 && tabState.lastSnapshot && tabState.lastSnapshotUrl === currentUrl');
    expect(serverSource).toContain("log('info', 'snapshot (cached)'");
  });

  test('records snapshot URL and invalidates cache after page-changing actions', () => {
    expect(serverSource).toContain('lastSnapshotUrl: null');
    expect(serverSource).toContain('function invalidateTabSnapshot(tabState)');
    expect(serverSource).toContain('tabState.lastSnapshotUrl = pageUrl');
    expect(serverSource).toContain('tabState.lastSnapshotUrl = tabState.page.url()');
    expect(serverSource).toMatch(/navigateCurrentPage[\s\S]*invalidateTabSnapshot\(tabState\)/);
    expect(serverSource).toMatch(/app\.post\('\/tabs\/:tabId\/click'[\s\S]*invalidateTabSnapshot\(tabState\)/);
  });
});
