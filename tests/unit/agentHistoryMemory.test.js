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

test('preserves target_summary on recorded browser actions', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/start',
    result: { ok: true, url: 'https://example.com/start', title: 'Start' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'click',
    ref: 'e2',
    target_summary: { role: 'button', name: 'continuer' },
    result: { ok: true, url: 'https://example.com/next', title: 'Next' },
  });

  expect(tabState.agentHistorySteps[1]).toMatchObject({
    kind: 'click',
    ref: 'e2',
    target_summary: { role: 'button', name: 'continuer' },
    url: 'https://example.com/next',
    title: 'Next',
  });

  const latest = JSON.parse(await readFile(path.join(tmpDir, 'example.com', 'latest.AgentHistory.json'), 'utf8'));
  expect(latest.hermes_meta.derived_flow.steps[1].target_summary).toEqual({ role: 'button', name: 'continuer' });
});

test('preserves target_summary.dom_signature through record, persist, and load without duplication', async () => {
  const tabState = memory.createMemoryTabState();
  const domSignature = {
    tag: 'button',
    text: 'continue',
    attributes: { type: 'button', 'aria-label': 'Continue' },
    parent: { tag: 'form', text: 'Sign in' },
    siblings: ['input', 'button'],
    path: ['main', 'form', 'button'],
    depth: 3,
    index: 1,
    nearby_text: ['Email', 'Password'],
  };

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'click',
    ref: 'e2',
    target_summary: { role: 'button', name: 'Continue', dom_signature: domSignature },
    result: { ok: true, url: 'https://example.com/login', title: 'Login' },
  });

  expect(tabState.agentHistorySteps[0].target_summary.dom_signature).toEqual(domSignature);
  expect(tabState.agentHistorySteps[0].dom_signature).toBeUndefined();

  const loaded = await memory.loadAgentHistory('example.com', 'latest');
  const loadedStep = loaded.payload.hermes_meta.derived_flow.steps[0];
  expect(loadedStep.target_summary.dom_signature).toEqual(domSignature);
  expect(loadedStep.dom_signature).toBeUndefined();
  expect(loaded.payload.history[0].target_summary.dom_signature).toEqual(domSignature);
});

test('preserves direct dom_signature through record, persist, and load', async () => {
  const tabState = memory.createMemoryTabState();
  const domSignature = {
    tag: 'a',
    text: 'details',
    attributes: { href: '/items/123', title: 'Details' },
    parent: { tag: 'article' },
    path: ['main', 'article', 'a'],
    depth: 2,
    index: 0,
  };

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'click',
    ref: 'e7',
    target_summary: { role: 'link', name: 'Details' },
    dom_signature: domSignature,
    result: { ok: true, url: 'https://example.com/items' },
  });
  await memory.persistAgentHistorySteps({
    siteKey: 'example.com',
    actionKey: 'open_details',
    steps: tabState.agentHistorySteps,
  });

  expect(tabState.agentHistorySteps[0].dom_signature).toEqual(domSignature);
  const loaded = await memory.loadAgentHistory('example.com', 'open_details');
  expect(loaded.payload.hermes_meta.derived_flow.steps[0].dom_signature).toEqual(domSignature);
  expect(loaded.payload.history[0].dom_signature).toEqual(domSignature);
});

test('keeps parameterized messages redacted while preserving structural dom_signature metadata', async () => {
  const tabState = memory.createMemoryTabState();
  const domSignature = {
    tag: 'textarea',
    attributes: { placeholder: 'Message', 'aria-label': 'Message' },
    parent: { tag: 'form' },
    path: ['main', 'form', 'textarea'],
    depth: 2,
    index: 0,
  };

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    selector: 'textarea[aria-label="Message"]',
    text: 'private one-off reply with secret price 3900',
    target_summary: { role: 'textbox', name: 'Message', dom_signature: domSignature },
    dom_signature: domSignature,
    result: { ok: true, url: 'https://marketplace.example/conversations/123' },
  });

  const loaded = await memory.loadAgentHistory('marketplace.example', 'latest');
  const serialized = JSON.stringify(loaded.payload);
  expect(loaded.payload.hermes_meta.derived_flow.steps[0]).toMatchObject({
    text: '{{message}}',
    text_parameterized: true,
    original_text_redacted: true,
    target_summary: { dom_signature: domSignature },
  });
  expect(loaded.payload.hermes_meta.derived_flow.steps[0].dom_signature).toBeUndefined();
  expect(serialized).not.toContain('private one-off reply');
  expect(serialized).not.toContain('3900');
});

test('applies learned DOM repair payloads with provenance without leaking profile metadata or secrets', async () => {
  const oldSignature = { tag: 'button', text: 'Old', path: ['main', 'button'], depth: 1, index: 0 };
  const newSignature = { tag: 'button', text: 'New', path: ['main', 'section', 'button'], depth: 2, index: 1 };
  const sourcePath = path.join(tmpDir, 'example.com', 'checkout.AgentHistory.json');

  await memory.persistAgentHistorySteps({
    siteKey: 'example.com',
    actionKey: 'checkout',
    steps: [{
      kind: 'click',
      ref: 'old-ref',
      target_summary: { role: 'button', name: 'Old', dom_signature: oldSignature },
      text: '__REDACTED__',
      text_redacted: true,
    }],
  });

  const saved = await memory.applyLearnedDomRepair({
    siteKey: 'example.com',
    actionKey: 'checkout',
    sourcePath,
    payload: {
      mode: 'dom_signature_repaired',
      old_ref: 'old-ref',
      new_ref: 'new-ref',
      original_ref: 'old-ref',
      repaired_ref: 'new-ref',
      score: 94,
      candidate: { ref: 'new-ref', role: 'button', name: 'New', dom_signature: newSignature, profile: 'personal-profile' },
      original_step: {
        kind: 'click',
        ref: 'old-ref',
        target_summary: { role: 'button', name: 'Old', dom_signature: oldSignature },
      },
      repaired_step: {
        kind: 'click',
        ref: 'new-ref',
        target_summary: { role: 'button', name: 'New', dom_signature: newSignature },
      },
    },
  });

  const serialized = JSON.stringify(saved.payload);
  const repaired = saved.payload.hermes_meta.derived_flow.steps[0];
  expect(saved.path).toBe(path.join(tmpDir, 'example.com', 'checkout.AgentHistory.json'));
  expect(repaired).toMatchObject({
    kind: 'click',
    ref: 'new-ref',
    text: '__REDACTED__',
    text_redacted: true,
    repair_provenance: {
      mode: 'dom_signature_repaired',
      old_ref: 'old-ref',
      new_ref: 'new-ref',
      original_ref: 'old-ref',
      repaired_ref: 'new-ref',
      score: 94,
      candidate: { ref: 'new-ref', role: 'button', name: 'New', dom_signature: newSignature },
      original_step: expect.objectContaining({ ref: 'old-ref' }),
      repaired_step: expect.objectContaining({ ref: 'new-ref' }),
    },
  });
  expect(saved.payload.hermes_meta.learned_from).toMatchObject({ path: sourcePath, timestamp: expect.any(String) });
  expect(serialized).not.toContain('personal-profile');
});

test('preserves learned repair metadata and dom signatures in saved flows', async () => {
  const oldSignature = { tag: 'button', text: 'Old', path: ['main', 'button'], depth: 1, index: 0 };
  const newSignature = { tag: 'button', text: 'New', path: ['main', 'section', 'button'], depth: 2, index: 1 };

  await memory.persistAgentHistorySteps({
    siteKey: 'example.com',
    actionKey: 'learned_dom_repair',
    learnedFrom: '/previous/example.com/learned_dom_repair.AgentHistory.json',
    steps: [{
      kind: 'click',
      ref: 'new-ref',
      target_summary: { role: 'button', name: 'New', dom_signature: newSignature },
      dom_signature: oldSignature,
      repair_provenance: {
        mode: 'dom_signature_repaired',
        original_ref: 'old-ref',
        repaired_ref: 'new-ref',
        score: 0.93,
      },
    }],
  });

  const loaded = await memory.loadAgentHistory('example.com', 'learned_dom_repair');
  expect(loaded.payload.hermes_meta.learned_from).toMatchObject({
    path: '/previous/example.com/learned_dom_repair.AgentHistory.json',
    timestamp: expect.any(String),
  });
  expect(loaded.payload.hermes_meta.derived_flow.steps[0]).toMatchObject({
    ref: 'new-ref',
    dom_signature: oldSignature,
    target_summary: { dom_signature: newSignature },
    repair_provenance: {
      mode: 'dom_signature_repaired',
      original_ref: 'old-ref',
      repaired_ref: 'new-ref',
      score: 0.93,
    },
  });
});

test('preserves expected_outcome on recorded browser actions', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'click',
    ref: 'e1',
    expected_outcome: { urlContains: '/next' },
    result: { ok: true, url: 'https://example.com/next' },
  });

  expect(tabState.agentHistorySteps[0].expected_outcome).toEqual({ urlContains: '/next' });
});

test('preserves safe metadata for wait and navigation utility steps', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'wait',
    timeout: 2500,
    waitForNetwork: false,
    result: { ok: true, ready: { domcontentloaded: true }, url: 'https://example.com/ready', title: 'Ready' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'forward',
    result: { ok: true, url: 'https://example.com/next', title: 'Next' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'refresh',
    result: { ok: true, url: 'https://example.com/next', title: 'Next Reloaded' },
  });

  expect(tabState.agentHistorySteps).toMatchObject([
    { kind: 'wait', timeout: 2500, waitForNetwork: false, url: 'https://example.com/ready', title: 'Ready' },
    { kind: 'forward', url: 'https://example.com/next', title: 'Next' },
    { kind: 'refresh', url: 'https://example.com/next', title: 'Next Reloaded' },
  ]);
});

test('records observation steps as checkpoint no-ops without image bytes or snapshots', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'snapshot',
    full: true,
    includeScreenshot: true,
    result: {
      ok: true,
      url: 'https://example.com/page',
      title: 'Page',
      snapshot: 'SECRET PAGE TEXT THAT MUST NOT BE STORED',
      refsCount: 9,
      truncated: true,
      totalChars: 12345,
      hasMore: true,
      screenshot: { data: 'base64-image-bytes', mimeType: 'image/png' },
    },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'images',
    includeData: true,
    limit: 4,
    result: {
      ok: true,
      url: 'https://example.com/page',
      images: [
        { src: 'https://example.com/a.png', alt: 'A', data: 'base64-image-bytes' },
        { src: 'https://example.com/b.png', alt: 'B', data: 'base64-image-bytes' },
      ],
    },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'screenshot',
    fullPage: true,
    result: { ok: true, url: 'https://example.com/page', title: 'Page', mimeType: 'image/png', bytes: 777, data: 'base64-image-bytes' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'vision',
    result: { ok: true, url: 'https://example.com/page', title: 'Page', model: 'local-vision', bytes: 777, data: 'base64-image-bytes' },
  });

  expect(tabState.agentHistorySteps).toMatchObject([
    { kind: 'snapshot', checkpoint: true, replayable: false, noop: true, refsCount: 9, truncated: true, totalChars: 12345, hasMore: true, hasScreenshot: true },
    { kind: 'images', checkpoint: true, replayable: false, noop: true, imageCount: 2, includeData: true, limit: 4 },
    { kind: 'screenshot', checkpoint: true, replayable: false, noop: true, fullPage: true, mimeType: 'image/png', bytes: 777 },
    { kind: 'vision', checkpoint: true, replayable: false, noop: true, model: 'local-vision', bytes: 777 },
  ]);
  const serialized = JSON.stringify(tabState.agentHistorySteps);
  expect(serialized).not.toContain('SECRET PAGE TEXT');
  expect(serialized).not.toContain('base64-image-bytes');
});

test('records evaluate only as a safe redacted summary unless explicitly replay safe', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'evaluate',
    expression: '() => localStorage.getItem("token")',
    result: { ok: true, url: 'https://example.com/app', title: 'App', resultType: 'string', resultSummary: 'secret-token-value' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'evaluate',
    expression: '() => document.title',
    replaySafe: true,
    result: { ok: true, url: 'https://example.com/app', title: 'App', resultType: 'string' },
  });

  expect(tabState.agentHistorySteps[0]).toMatchObject({
    kind: 'evaluate',
    url: 'https://example.com/app',
    title: 'App',
    expression_redacted: true,
    replayable: false,
    resultType: 'string',
  });
  expect(tabState.agentHistorySteps[0].expression).toBeUndefined();
  expect(tabState.agentHistorySteps[0].resultSummary).toBeUndefined();
  expect(tabState.agentHistorySteps[1]).toMatchObject({
    kind: 'evaluate',
    expression: '() => document.title',
    replaySafe: true,
    replayable: true,
  });
});

test('marks close steps as non replayable with final url and title', async () => {
  const tabState = memory.createMemoryTabState();

  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'close',
    reason: 'api_delete_tab',
    result: { ok: true, url: 'https://example.com/final', title: 'Final' },
  });

  expect(tabState.agentHistorySteps[0]).toMatchObject({
    kind: 'close',
    url: 'https://example.com/final',
    title: 'Final',
    reason: 'api_delete_tab',
    replayable: false,
  });
});

test('redacts password OTP card and token-like typed values', async () => {
  const tabState = memory.createMemoryTabState();
  const sensitiveInputs = [
    { text: 'super-secret', target_summary: { attributes: { type: 'password' } } },
    { text: '123456', target_summary: { attributes: { placeholder: 'OTP code' } } },
    { text: '4111 1111 1111 1111', target_summary: { attributes: { placeholder: 'Card number' } } },
    { text: 'tok_1234567890abcdefghijklmnopqrstuv', target_summary: { attributes: { placeholder: 'API token' } } },
  ];

  for (const input of sensitiveInputs) {
    await memory.recordSuccessfulBrowserAction(tabState, {
      kind: 'type',
      ref: 'e1',
      ...input,
      result: { ok: true, url: 'https://example.com/login' },
    });
  }

  for (const step of tabState.agentHistorySteps) {
    expect(step.text).toBe('__REDACTED__');
    expect(step.text_redacted).toBe(true);
  }
  const serialized = JSON.stringify(tabState.agentHistorySteps);
  expect(serialized).not.toContain('super-secret');
  expect(serialized).not.toContain('123456');
  expect(serialized).not.toContain('4111');
  expect(serialized).not.toContain('tok_');
});

test('keeps normal non-sensitive type actions unchanged', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    ref: 'e1',
    text: 'hello world',
    target_summary: { attributes: { type: 'text', placeholder: 'Search' } },
    result: { ok: true, url: 'https://example.com/search' },
  });

  expect(tabState.agentHistorySteps[0].text).toBe('hello world');
  expect(tabState.agentHistorySteps[0].text_redacted).toBeUndefined();
});

test('parameterizes free-form message typed values instead of persisting one-off replies', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    selector: 'textarea[aria-label="Ecrire mon message"]',
    text: 'Bonjour, je peux faire un effort à 3 900 €, pas moins. Cordialement',
    target_summary: { role: 'textbox', name: 'Ecrire mon message', attributes: { placeholder: 'Écrivez votre message' } },
    result: { ok: true, url: 'https://www.leboncoin.fr/messages/id/abc', title: 'leboncoin' },
  });

  expect(tabState.agentHistorySteps[0]).toMatchObject({
    kind: 'type',
    selector: 'textarea[aria-label="Ecrire mon message"]',
    text: '{{message}}',
    text_parameterized: true,
    parameter_name: 'message',
    original_text_redacted: true,
  });
  expect(JSON.stringify(tabState.agentHistorySteps[0])).not.toContain('3 900');

  const latest = JSON.parse(await readFile(path.join(tmpDir, 'www.leboncoin.fr', 'latest.AgentHistory.json'), 'utf8'));
  expect(latest.hermes_meta.derived_flow.steps[0].text).toBe('{{message}}');
  expect(JSON.stringify(latest)).not.toContain('3 900');
});

test('parameterizes generic chat and message box typed values across sites', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    ref: 'e4',
    text: 'one-off customer answer',
    target_summary: { role: 'textbox', name: 'Message', attributes: { 'aria-label': 'Message' } },
    result: { ok: true, url: 'https://marketplace.example/conversations/123' },
  });

  expect(tabState.agentHistorySteps[0]).toMatchObject({
    text: '{{message}}',
    text_parameterized: true,
    parameter_name: 'message',
  });
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

test('replay refuses parameterized typed values unless runtime parameters are supplied', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    selector: 'textarea[aria-label="Message"]',
    text: 'one-off customer answer',
    target_summary: { role: 'textbox', name: 'Message' },
    result: { ok: true, url: 'https://marketplace.example/conversations/123' },
  });

  const calls = [];
  const result = await memory.replayAgentHistory('marketplace.example', 'conversations_123', {
    type: async (step) => { calls.push(['type', step.text]); return { ok: true }; },
  });

  expect(result.ok).toBe(false);
  expect(result.llm_used).toBe(false);
  expect(result.requires_parameters).toEqual(['message']);
  expect(calls).toEqual([]);
});

test('replay substitutes supplied runtime parameters for parameterized typed values', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    selector: 'textarea[aria-label="Message"]',
    text: 'one-off customer answer',
    target_summary: { role: 'textbox', name: 'Message' },
    result: { ok: true, url: 'https://marketplace.example/conversations/123' },
  });

  const calls = [];
  const result = await memory.replayAgentHistory('marketplace.example', 'conversations_123', {
    type: async (step) => { calls.push(['type', step.text]); return { ok: true }; },
  }, { parameters: { message: 'fresh approved answer' } });

  expect(result.ok).toBe(true);
  expect(calls).toEqual([['type', 'fresh approved answer']]);
});

test('replay refuses missing query location and message runtime placeholders', async () => {
  await memory.persistAgentHistorySteps({
    siteKey: 'example.com',
    actionKey: 'parameterized_search_message',
    steps: [
      { kind: 'navigate', url: 'https://example.com/search?q={{query}}&near={{location}}' },
      { kind: 'type', ref: 'e1', text: '{{message}}', text_parameterized: true, parameter_name: 'message' },
    ],
  });

  const calls = [];
  const result = await memory.replayAgentHistory('example.com', 'parameterized_search_message', {
    navigate: async (step) => { calls.push(['navigate', step.url]); return { ok: true }; },
    type: async (step) => { calls.push(['type', step.text]); return { ok: true }; },
  }, { parameters: { query: 'jobs' } });

  expect(result).toMatchObject({ ok: false, llm_used: false, requires_parameters: ['location', 'message'] });
  expect(calls).toEqual([]);
});

test('replay substitutes query location and message runtime placeholders together', async () => {
  await memory.persistAgentHistorySteps({
    siteKey: 'example.com',
    actionKey: 'parameterized_search_message',
    steps: [
      { kind: 'navigate', url: 'https://example.com/search?q={{query}}&near={{location}}' },
      { kind: 'type', ref: 'e1', text: '{{message}}', text_parameterized: true, parameter_name: 'message' },
    ],
  });

  const calls = [];
  const result = await memory.replayAgentHistory('example.com', 'parameterized_search_message', {
    navigate: async (step) => { calls.push(['navigate', step.url]); return { ok: true }; },
    type: async (step) => { calls.push(['type', step.text]); return { ok: true }; },
  }, { parameters: { query: 'jobs', location: 'Lyon', message: 'Hello' } });

  expect(result.ok).toBe(true);
  expect(calls).toEqual([
    ['navigate', 'https://example.com/search?q=jobs&near=Lyon'],
    ['type', 'Hello'],
  ]);
});

test('records side-effect-level metadata for common action classes', async () => {
  const levels = ['read_only', 'message_send', 'submit_apply', 'buy_pay', 'delete', 'publish', 'account_setting'];
  for (const level of levels) {
    const saved = await memory.persistAgentHistorySteps({
      siteKey: 'example.com',
      actionKey: `flow_${level}`,
      steps: [{ kind: 'click', ref: level, side_effect_level: level }],
      side_effect_level: level,
    });
    expect(saved.payload.hermes_meta.side_effect_level).toBe(level);
    expect(saved.payload.hermes_meta.derived_flow.steps[0].side_effect_level).toBe(level);
  }
});

test('persists profile-scoped AgentHistory flows with managed-browser metadata', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/dashboard',
    result: { ok: true, url: 'https://example.com/dashboard', title: 'Dashboard' },
  });

  const saved = await memory.recordFlow(tabState, 'example.com', 'open_dashboard', {
    profile: 'Buyer Profile',
    owner_cli: 'resell-cli',
    domain: 'resale',
    side_effect_level: 'read_only',
    safe_to_share: false,
    created_by: 'managed-browser-cli',
    parameters: { query: '{{query}}' },
  });

  expect(saved.path).toBe(path.join(tmpDir, 'profiles', 'buyer_profile', 'example.com', 'open_dashboard.AgentHistory.json'));
  const payload = JSON.parse(await readFile(saved.path, 'utf8'));
  expect(payload.hermes_meta).toMatchObject({
    profile: 'buyer_profile',
    owner_cli: 'resell-cli',
    domain: 'resale',
    side_effect_level: 'read_only',
    safe_to_share: false,
    created_by: 'managed-browser-cli',
    parameters: { query: '{{query}}' },
  });
});

test('loads profile-specific AgentHistory before shared safe templates', async () => {
  const sharedState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(sharedState, {
    kind: 'navigate',
    url: 'https://example.com/shared',
    result: { ok: true, url: 'https://example.com/shared' },
  });
  await memory.recordFlow(sharedState, 'example.com', 'open_dashboard', { safe_to_share: true });

  const profileState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(profileState, {
    kind: 'navigate',
    url: 'https://example.com/profile-specific',
    result: { ok: true, url: 'https://example.com/profile-specific' },
  });
  await memory.recordFlow(profileState, 'example.com', 'open_dashboard', { profile: 'buyer' });

  const loaded = await memory.loadAgentHistory('example.com', 'open_dashboard', { profile: 'buyer' });

  expect(loaded.path).toBe(path.join(tmpDir, 'profiles', 'buyer', 'example.com', 'open_dashboard.AgentHistory.json'));
  expect(loaded.payload.hermes_meta.derived_flow.steps[0].url).toBe('https://example.com/profile-specific');
});

test('falls back from profile lookup only to shared flows explicitly marked safe_to_share', async () => {
  const unsafeState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(unsafeState, {
    kind: 'navigate',
    url: 'https://example.com/private-template',
    result: { ok: true, url: 'https://example.com/private-template' },
  });
  await memory.recordFlow(unsafeState, 'example.com', 'private_action');

  await expect(memory.loadAgentHistory('example.com', 'private_action', { profile: 'seller' }))
    .rejects.toThrow('not marked safe_to_share');

  const sharedState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(sharedState, {
    kind: 'navigate',
    url: 'https://example.com/shared-template',
    result: { ok: true, url: 'https://example.com/shared-template' },
  });
  await memory.recordFlow(sharedState, 'example.com', 'shared_action', { safe_to_share: true });

  const loaded = await memory.loadAgentHistory('example.com', 'shared_action', { profile: 'seller' });
  expect(loaded.path).toBe(path.join(tmpDir, 'example.com', 'shared_action.AgentHistory.json'));
  expect(loaded.payload.hermes_meta.safe_to_share).toBe(true);
});

test('profile lookup never falls through to another profile-specific learned flow', async () => {
  const sellerState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(sellerState, {
    kind: 'navigate',
    url: 'https://example.com/seller-private',
    result: { ok: true, url: 'https://example.com/seller-private' },
  });
  await memory.recordFlow(sellerState, 'example.com', 'private_action', { profile: 'seller' });

  await expect(memory.loadAgentHistory('example.com', 'private_action', { profile: 'buyer' }))
    .rejects.toThrow('No AgentHistory flow');
});

test('managed non-Leboncoin site keys record, search, replay, and delete independently', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/demo',
    result: { ok: true, url: 'https://example.com/demo', title: 'Example Demo' },
  });
  await memory.recordFlow(tabState, 'example', 'demo_flow', {
    aliases: ['safe_demo'],
    labels: ['managed-profile-fixture'],
  });

  await expect(memory.searchFlows({ siteKey: 'example', query: 'safe demo' })).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ siteKey: 'example', actionKey: 'demo_flow' }),
  ]));

  const calls = [];
  await expect(memory.replayAgentHistory('example', 'demo_flow', {
    navigate: async (step) => { calls.push(['navigate', step.url]); return { ok: true }; },
  })).resolves.toMatchObject({ ok: true, llm_used: false, replayed_steps: 1 });
  expect(calls).toEqual([['navigate', 'https://example.com/demo']]);

  await expect(memory.deleteFlow('example', 'demo_flow')).resolves.toMatchObject({ ok: true, deleted: true });
  await expect(memory.searchFlows({ siteKey: 'example', query: 'demo_flow' })).resolves.toEqual([]);
});

test('replay fails clearly when no AgentHistory file exists', async () => {
  await expect(memory.replayAgentHistory('missing.example', 'login', {})).rejects.toThrow('No AgentHistory flow');
});

test('persists learned repaired steps to the same AgentHistory action with provenance', async () => {
  const saved = await memory.persistAgentHistorySteps({
    siteKey: 'example.com',
    actionKey: 'login',
    steps: [
      { kind: 'navigate', url: 'https://example.com/login' },
      { kind: 'click', ref: 'new', target_summary: { role: 'button', name: 'continuer' } },
    ],
    learnedFrom: '/previous/example.com/login.AgentHistory.json',
  });

  expect(saved.path).toBe(path.join(tmpDir, 'example.com', 'login.AgentHistory.json'));
  const learned = JSON.parse(await readFile(saved.path, 'utf8'));
  expect(learned.hermes_meta.site_key).toBe('example.com');
  expect(learned.hermes_meta.action_key).toBe('login');
  expect(learned.hermes_meta.derived_flow.steps[1]).toMatchObject({
    kind: 'click',
    ref: 'new',
    target_summary: { role: 'button', name: 'continuer' },
  });
  expect(learned.hermes_meta.learned_from).toMatchObject({
    path: '/previous/example.com/login.AgentHistory.json',
  });
  expect(learned.hermes_meta.learned_from.timestamp).toEqual(expect.any(String));
});

test('persists semantic labels in metadata', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/account',
    result: { ok: true, url: 'https://example.com/account' },
  });

  const saved = await memory.recordFlow(tabState, 'example.com', 'open_my_account', {
    labels: ['account', 'listings'],
  });

  expect(saved.payload.hermes_meta.labels).toEqual(['account', 'listings']);
});

test('searchFlows finds flows by action key, alias, label, title, and url without exposing typed text', async () => {
  const tabState = memory.createMemoryTabState();
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'navigate',
    url: 'https://example.com/account',
    result: { ok: true, url: 'https://example.com/account', title: 'Account overview' },
  });
  await memory.recordSuccessfulBrowserAction(tabState, {
    kind: 'type',
    ref: 'e1',
    text: 'super-secret-value',
    result: { ok: true, url: 'https://example.com/account', title: 'Account overview' },
  });

  await memory.recordFlow(tabState, 'example.com', 'open_my_account', {
    aliases: ['my_profile'],
    labels: ['account', 'listings'],
  });

  await expect(memory.searchFlows({ siteKey: 'example.com', query: 'account' })).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({
      siteKey: 'example.com',
      actionKey: 'open_my_account',
      labels: ['account', 'listings'],
      aliases: ['my_profile'],
      path: expect.stringContaining('open_my_account.AgentHistory.json'),
    }),
  ]));
  await expect(memory.searchFlows({ siteKey: 'example.com', query: 'my profile' })).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ actionKey: 'open_my_account' }),
  ]));
  await expect(memory.searchFlows({ siteKey: 'example.com', query: 'overview' })).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ actionKey: 'open_my_account' }),
  ]));
  await expect(memory.searchFlows({ siteKey: 'example.com', query: 'super-secret-value' })).resolves.toEqual([]);

  const [result] = await memory.searchFlows({ siteKey: 'example.com', query: 'account' });
  expect(JSON.stringify(result)).not.toContain('super-secret-value');
  expect(result).not.toHaveProperty('steps');
});
