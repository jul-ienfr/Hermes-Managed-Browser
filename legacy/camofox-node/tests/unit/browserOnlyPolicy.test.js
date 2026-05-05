import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function routeBlock(source, route, endComment) {
  const start = source.indexOf(`app.post('${route}'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endComment, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('browser-only action policy', () => {
  const repoRoot = join(fileURLToPath(new URL('../..', import.meta.url)));
  const serverSource = readFileSync(join(repoRoot, 'server.js'), 'utf8');
  const humanActionsSource = readFileSync(join(repoRoot, 'lib/human-actions.js'), 'utf8');

  test('does not use JS synthetic click dispatch for website actions', () => {
    expect(serverSource).not.toMatch(/dispatchEvent\s*\(/);
    expect(serverSource).not.toMatch(/\.evaluate\s*\([^)]*\.click\s*\(/s);
  });

  test('does not invoke raw X11 tooling from browser action implementation', () => {
    expect(serverSource).not.toMatch(/xdotool|wmctrl|xprop|xwininfo/);
  });

  test('human actions helper stays browser-only and avoids JS/OS synthetic site actions', () => {
    const forbiddenPatterns = [
      /dispatchEvent\s*\(/,
      /document\.querySelector\s*\([^)]*\)\.click\s*\(/s,
      /xdotool/,
      /cliclick/,
      /robotjs/,
    ];

    for (const pattern of forbiddenPatterns) {
      expect(humanActionsSource).not.toMatch(pattern);
    }
  });

  test('uses centralized human browser actions for click type press and scroll endpoints', () => {
    expect(serverSource).toContain("from './lib/human-actions.js'");
    expect(serverSource).toMatch(/await\s+humanClick\s*\(/);
    expect(serverSource).toMatch(/await\s+humanType\s*\(/);
    expect(serverSource).toMatch(/await\s+humanPress\s*\(/);
    expect(serverSource).toMatch(/await\s+humanScroll\s*\(/);
  });

  test('normal action endpoints call browser-only human helpers', () => {
    const clickBlock = routeBlock(serverSource, '/tabs/:tabId/click', '// Type');
    const typeBlock = routeBlock(serverSource, '/tabs/:tabId/type', '// Press key');
    const pressBlock = routeBlock(serverSource, '/tabs/:tabId/press', '// Scroll');
    const scrollBlock = routeBlock(serverSource, '/tabs/:tabId/scroll', '// Back');

    const nonGoogleClickPath = clickBlock.split(/if \(onGoogleSerp\) \{/)[1]?.split(/\}\s*else\s*\{/)[1] || '';
    expect(nonGoogleClickPath).toContain('humanPrepareTarget(tabState.page, locator');
    expect(nonGoogleClickPath).toContain('humanClick(tabState.page, locator');
    expect(nonGoogleClickPath).toContain('timeout: Math.min(5000, remainingBudget())');
    expect(typeBlock).toMatch(/await\s+(?:withActionTimeout\s*\(\s*)?humanPrepareTarget\s*\(/);
    expect(typeBlock).toMatch(/await\s+humanType\s*\(/);
    expect(typeBlock).toMatch(/await\s+humanPress\s*\(/);
    expect(pressBlock).toMatch(/await\s+humanPress\s*\(/);
    expect(scrollBlock).toMatch(/await\s+humanScroll\s*\(/);
  });

  test('force click is allowed only in the explicit Google SERP branch', () => {
    const forceMatches = [...serverSource.matchAll(/force:\s*true/g)];
    expect(forceMatches).toHaveLength(1);

    const clickBlock = routeBlock(serverSource, '/tabs/:tabId/click', '// Type');
    expect(clickBlock).toMatch(/const\s+onGoogleSerp\s*=\s*isGoogleSerp\(tabState\.page\.url\(\)\)/);
    expect(clickBlock).toMatch(/if\s*\(onGoogleSerp\)\s*\{[\s\S]*?locator\.click\s*\(\s*\{[^}]*force:\s*true[\s\S]*?\}\s*\)\s*;[\s\S]*?\}\s*else\s*\{/);

    const nonGoogleClickPath = clickBlock.split(/if \(onGoogleSerp\) \{/)[1]?.split(/\}\s*else\s*\{/)[1] || '';
    expect(nonGoogleClickPath).not.toMatch(/force:\s*true/);
  });

  test('click endpoint wires persistent human cursor state', () => {
    const clickBlock = routeBlock(serverSource, '/tabs/:tabId/click', '// Type');

    expect(clickBlock).toMatch(/getHumanCursor\(tabState\.humanSession\)/);
    expect(clickBlock).toMatch(/updateHumanCursor\(tabState\.humanSession/);
  });

  test('click and type endpoints prepare targets before human actions', () => {
    const clickBlock = routeBlock(serverSource, '/tabs/:tabId/click', '// Type');
    const typeBlock = routeBlock(serverSource, '/tabs/:tabId/type', '// Press key');

    expect(clickBlock.indexOf('humanPrepareTarget')).toBeGreaterThanOrEqual(0);
    expect(clickBlock.indexOf('humanPrepareTarget')).toBeLessThan(clickBlock.indexOf('humanClick'));
    expect(typeBlock.indexOf('humanPrepareTarget')).toBeGreaterThanOrEqual(0);
    expect(typeBlock.indexOf('humanPrepareTarget')).toBeLessThan(typeBlock.indexOf('humanType'));
  });

  test('human preparation makes off-screen or newly-visible targets actionable before clicking', () => {
    expect(humanActionsSource).toMatch(/locator\.waitFor\s*\(\s*\{\s*state:\s*'visible'/);
    expect(humanActionsSource).toMatch(/if \(!box\) \{[\s\S]*locator\.scrollIntoViewIfNeeded\s*\(/);
    expect(humanActionsSource).toMatch(/Element not visible after scroll/);
  });

  test('human mouse moves are capped so long pages do not exceed action locks', () => {
    expect(humanActionsSource).toMatch(/clamp\(jitter\(120 \+ distance \* 1\.7[\s\S]*80, 3500\)/);
  });

  test('human click low-level mouse actions are individually bounded', () => {
    expect(humanActionsSource).toContain('boundedMouseMove');
    expect(humanActionsSource).toContain('Promise.race');
    expect(humanActionsSource).toContain('moveTimeout = 1000');
    expect(humanActionsSource).toContain('mouse down timed out');
    expect(humanActionsSource).toContain('mouse up timed out');
    expect(humanActionsSource).toContain('options.mouseTimeout ?? 2000');
  });

  test('auto consent dismissal covers Leboncoin refusal button before accepting fallbacks', () => {
    const refusal = serverSource.indexOf('button:has-text("Continuer sans accepter")');
    const accept = serverSource.indexOf('button:has-text("Accept")');
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(accept).toBeGreaterThan(refusal);
  });

  test('memory replay handlers use human helpers instead of synthetic browser actions', () => {
    const replayStart = serverSource.indexOf("app.post('/memory/replay'");
    const replayEnd = serverSource.indexOf("// GET /tabs - List all tabs", replayStart);
    expect(replayStart).toBeGreaterThanOrEqual(0);
    expect(replayEnd).toBeGreaterThan(replayStart);
    const replayBlock = serverSource.slice(replayStart, replayEnd);

    expect(replayBlock).toMatch(/await\s+humanPrepareTarget\s*\(/);
    expect(replayBlock).toMatch(/await\s+humanClick\s*\(/);
    expect(replayBlock).toMatch(/await\s+humanType\s*\(/);
    expect(replayBlock).toMatch(/await\s+humanPress\s*\(/);
    expect(replayBlock).toMatch(/await\s+humanScroll\s*\(/);
    expect(replayBlock).toMatch(/updateHumanCursor\(tabState\.humanSession/);
    expect(replayBlock).not.toMatch(/locator\.click\s*\(/);
    expect(replayBlock).not.toMatch(/\.fill\s*\(/);
    expect(replayBlock).not.toMatch(/keyboard\.press\s*\(/);
    expect(replayBlock).not.toMatch(/mouse\.wheel\s*\(/);
  });

  test('OpenClaw /act endpoint also uses human helpers instead of synthetic fill or hover', () => {
    const actBlock = routeBlock(serverSource, '/act', '// Periodic stats beacon');

    expect(actBlock).toMatch(/await\s+humanPrepareTarget\s*\(/);
    expect(actBlock).toMatch(/await\s+humanClick\s*\(/);
    expect(actBlock).toMatch(/await\s+humanType\s*\(/);
    expect(actBlock).toMatch(/await\s+humanPress\s*\(/);
    expect(actBlock).toMatch(/await\s+humanScroll\s*\(/);
    expect(actBlock).toMatch(/await\s+humanMove\s*\(/);
    expect(actBlock).toMatch(/updateHumanCursor\(tabState\.humanSession/);
    expect(actBlock).not.toMatch(/\.fill\s*\(/);
    expect(actBlock).not.toMatch(/\.hover\s*\(/);
    expect(actBlock).not.toMatch(/scrollIntoViewIfNeeded\s*\(/);
  });

  test('browser automation never performs a double click in a single action', () => {
    const actBlock = routeBlock(serverSource, '/act', '// Periodic stats beacon');

    expect(serverSource).not.toMatch(/dblclick/i);
    expect(serverSource).not.toMatch(/clickCount\s*:\s*2/);
    expect(actBlock).not.toMatch(/doubleClick/);
    expect(actBlock).not.toMatch(/secondClick/);
    expect(humanActionsSource.match(/page\.mouse\.down\s*\(/g) || []).toHaveLength(1);
    expect(humanActionsSource.match(/page\.mouse\.up\s*\(/g) || []).toHaveLength(1);
  });
});
