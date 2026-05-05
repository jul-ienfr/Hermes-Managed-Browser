import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function routeBlock(source, method, route, endNeedle) {
  const start = source.indexOf(`app.${method}('${route}'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('managed recovery server wiring', () => {
  const repoRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
  const serverSource = readFileSync(join(repoRoot, 'server.js'), 'utf8');

  test('OpenClaw snapshot route records recovery checkpoints for cached, Google, and normal paths', () => {
    const snapshotBlock = routeBlock(serverSource, 'get', '/snapshot', '// POST /act');

    const responseCount = (snapshotBlock.match(/const response = \{/g) || []).length;
    const recordCount = (snapshotBlock.match(/recordTabAction\(tabState, \{ kind: 'snapshot'/g) || []).length;

    expect(responseCount).toBeGreaterThanOrEqual(3);
    expect(recordCount).toBeGreaterThanOrEqual(responseCount);
    expect(snapshotBlock).toMatch(/updateTabRecoveryMeta\(tabState, \{[\s\S]*sessionKey: found\.listItemId/);
  });

  test('OpenClaw act route records wait, hover, and close recovery state, not only basic actions', () => {
    const actBlock = routeBlock(serverSource, 'post', '/act', '// Periodic stats beacon');

    expect(actBlock).toMatch(/recordTabAction\(tabState, \{[\s\S]*kind: kind === 'scrollIntoView' \? 'scroll' : kind/);
    expect(actBlock).toMatch(/\['click', 'type', 'press', 'scroll', 'scrollIntoView', 'wait', 'hover'\]\.includes\(kind\)/);
    expect(actBlock).toMatch(/case 'close':[\s\S]*recordTabAction\(tabState, \{ kind: 'close'/);
  });

  test('managed recover-tab refreshes refs/snapshot after recreating a stale tab', () => {
    const recoverBlock = routeBlock(serverSource, 'post', '/managed/recover-tab', "app.post('/managed/storage-checkpoint'");

    expect(recoverBlock).toContain('const targetUrl = getRecoveryTargetUrl(state, fallbackUrl);');
    expect(recoverBlock).toMatch(/if \(!targetUrl\) \{[\s\S]*No recovery target URL available/);
    expect(recoverBlock).toMatch(/tabState\.refs = await buildRefs\(tabState\.page\)/);
    expect(recoverBlock).toMatch(/tabState\.lastSnapshot = annotatedYaml/);
    expect(recoverBlock).toMatch(/res\.json\(\{[\s\S]*snapshot: annotatedYaml/);
  });

  test('memory replay route persists learned DOM repairs through callback payloads only', () => {
    const replayBlock = routeBlock(serverSource, 'post', '/memory/replay', '// GET /tabs');

    expect(replayBlock).toContain('learnRepairs');
    expect(replayBlock).toMatch(/learnRepair: async \(payload\) =>/);
    expect(replayBlock).toMatch(/applyLearnedDomRepair\(\{[\s\S]*siteKey,[\s\S]*actionKey,[\s\S]*sourcePath: loaded\.path,[\s\S]*payload/);
    expect(replayBlock).not.toMatch(/replay\.ok && replay\.results\?\.some\(\(result\) => result\.repaired_step\)/);
  });
});
