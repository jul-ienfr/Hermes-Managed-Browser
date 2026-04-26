import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

let memory;
let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'camofox-memory-'));
  process.env.CAMOFOX_BROWSER_MEMORY_DIR = tmpDir;
  memory = await import(`../../lib/agent-history-memory.js?case=${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env.CAMOFOX_BROWSER_MEMORY_DIR;
});

test('records successful browser actions as AgentHistory files for latest, default, and derived flow', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/login',
    result: { ok: true, url: 'https://example.com/login', title: 'Login - Example' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    ref: '@e1',
    text: 'julien@example.com',
    result: { ok: true, url: 'https://example.com/login', title: 'Login - Example' },
  });

  const latestPath = path.join(tmpDir, 'example.com', 'latest.AgentHistory.json');
  const defaultPath = path.join(tmpDir, 'example.com', 'default.AgentHistory.json');
  const loginPath = path.join(tmpDir, 'example.com', 'login.AgentHistory.json');

  const latest = JSON.parse(await readFile(latestPath, 'utf8'));
  await expect(readFile(defaultPath, 'utf8')).resolves.toContain('derived_flow');
  await expect(readFile(loginPath, 'utf8')).resolves.toContain('derived_flow');

  expect(latest.history).toEqual(expect.any(Array));
  expect(latest.hermes_meta.source).toBe('camofox-browser');
  expect(latest.hermes_meta.site_key).toBe('example.com');
  expect(latest.hermes_meta.action_key).toBe('latest');
  expect(latest.hermes_meta.derived_flow.steps).toMatchObject([
    { kind: 'navigate', url: 'https://example.com/login' },
    { kind: 'type', ref: '@e1', text: 'julien@example.com' },
  ]);
});

test('does not record failed browser actions', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/login',
    result: { ok: false, url: 'https://example.com/login' },
  });

  expect(tabState.agentHistorySteps).toEqual([]);
  await expect(readFile(path.join(tmpDir, 'example.com', 'latest.AgentHistory.json'), 'utf8')).rejects.toThrow();
});

test('replays AgentHistory directly through low-level browser actions without planner', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/login',
    result: { ok: true, url: 'https://example.com/login', title: 'Login - Example' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    ref: '@e1',
    text: 'hello',
    result: { ok: true, url: 'https://example.com/login', title: 'Login - Example' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'press',
    key: 'Enter',
    result: { ok: true, url: 'https://example.com/dashboard', title: 'Dashboard' },
  });

  const calls = [];
  const result = await memory.replayAgentHistory('example.com', 'login', {
    navigate: async (step) => { calls.push(['navigate', step.url]); return { ok: true }; },
    click: async (step) => { calls.push(['click', step.ref || step.selector]); return { ok: true }; },
    type: async (step) => { calls.push(['type', step.ref, step.text]); return { ok: true }; },
    press: async (step) => { calls.push(['press', step.key]); return { ok: true }; },
    scroll: async (step) => { calls.push(['scroll', step.direction]); return { ok: true }; },
    back: async () => { calls.push(['back']); return { ok: true }; },
  });

  expect(result.llm_used).toBe(false);
  expect(result.ok).toBe(true);
  expect(calls).toEqual([
    ['navigate', 'https://example.com/login'],
    ['type', '@e1', 'hello'],
    ['press', 'Enter'],
  ]);
});

test('replay fails clearly when no AgentHistory file exists', async () => {
  await expect(memory.replayAgentHistory('missing.example', 'login', {})).rejects.toThrow('No AgentHistory flow');
});
