import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const serverSource = fs.readFileSync(path.join(rootDir, 'server.js'), 'utf-8');
const schemaSource = fs.readFileSync(path.join(rootDir, 'lib/managed-cli-schema.js'), 'utf-8');

describe('managed CLI profile-scoped API surface', () => {
  test('server exposes stable CLI endpoints for managed browser operations', () => {
    for (const route of [
      "app.post('/managed/cli/open'",
      "app.post('/managed/cli/snapshot'",
      "app.post('/managed/cli/act'",
      "app.post('/managed/cli/memory/record'",
      "app.post('/managed/cli/memory/replay'",
      "app.post('/managed/cli/checkpoint'",
      "app.post('/managed/cli/release'",
      "app.post('/lifecycle/open'",
      "app.post('/lifecycle/close'",
      "app.post('/lifecycle/default'",
    ]) {
      expect(serverSource).toContain(route);
    }
  });

  test('server exposes resell-compatible local ManagedBrowser API aliases', () => {
    for (const route of [
      "app.post('/profile/status'",
      "app.post('/navigate'",
      "app.post('/console/eval'",
      "app.post('/file-upload'",
      "app.post('/storage/checkpoint'",
      "app.post('/flow/run'",
      "app.post('/flow/list'",
      "app.post('/flow/inspect'",
      'managedApiHandle',
      'managedApiOpenOrNavigate',
      'managedApiConsoleEval',
      'managedApiFileUpload',
      'setInputFiles',
      'managedApiCheckpointStorage',
      'managedApiRunFlow',
      'replayStepsSelfHealing(steps',
      'file_upload: async (step)',
      'parameters: body.params || body.parameters || {}',
      "max_side_effect_level: body.max_side_effect_level || body.maxSideEffectLevel || 'publish'",
      'success: Boolean(result.ok)',
    ]) {
      expect(serverSource).toContain(route);
    }
  });

  test('managed API navigate refuses implicit current-tab navigation for sensitive managed profiles', () => {
    const start = serverSource.indexOf('function explicitManagedNavigateRestore');
    const end = serverSource.indexOf('async function managedApiConsoleEval', start);
    const section = serverSource.slice(start, end);

    expect(section).toContain('assertManagedNavigateAllowed');
    expect(section).toContain('allowCurrentTabNavigate');
    expect(section).toContain('restoreCurrentTab');
    expect(section).toContain('current_tab_navigation_blocked');
    expect(section).toContain('refusing to navigate existing managed tab without explicit restoreCurrentTab');
    expect(section).toMatch(/if \(!tabId\)[\s\S]*createServerOwnedTab/);
  });

  test('CLI routes fail closed on missing profile and require lease_id for writes', () => {
    const handlerStart = serverSource.indexOf('async function managedCliHandle');
    const handlerEnd = serverSource.indexOf('async function managedCliFindTab', handlerStart);
    const handlerSection = serverSource.slice(handlerStart, handlerEnd);
    expect(handlerSection).toContain('requireManagedBrowserProfileIdentity');
    expect(handlerSection).toContain('managedCliLease');
    expect(handlerSection).toContain('managedReadAllowed');

    for (const route of [
      "app.post('/managed/cli/open'",
      "app.post('/managed/cli/act'",
      "app.post('/managed/cli/memory/record'",
      "app.post('/managed/cli/memory/replay'",
      "app.post('/managed/cli/checkpoint'",
      "app.post('/managed/cli/release'",
    ]) {
      const start = serverSource.indexOf(route);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextRoute = serverSource.indexOf('\napp.', start + 1);
      const section = serverSource.slice(start, nextRoute === -1 ? undefined : nextRoute);
      expect(section).toContain('managedCliHandle');
      expect(section).not.toContain('write: false');
    }

    const snapshotStart = serverSource.indexOf("app.post('/managed/cli/snapshot'");
    const snapshotEnd = serverSource.indexOf('\napp.', snapshotStart + 1);
    const snapshotSection = serverSource.slice(snapshotStart, snapshotEnd);
    expect(snapshotSection).toContain('managedCliHandle');
    expect(snapshotSection).toContain('write: false');
  });

  test('structured CLI schema includes stable fields and preserves requires fields', () => {
    for (const token of [
      'normalizeManagedCliResult',
      'operation',
      'ok',
      'profile',
      'lease_id',
      'mode',
      'llm_used',
      'observable_state',
      'requires_parameter',
      'requires_secret',
    ]) {
      expect(schemaSource).toContain(token);
    }
  });

  test('schema exposes side-effect policy metadata and explicit LLM fallback fields', () => {
    for (const token of [
      'SIDE_EFFECT_LEVELS',
      'read_only',
      'message_send',
      'submit_apply',
      'buy_pay',
      'delete',
      'publish',
      'account_setting',
      'side_effect_level',
      'blocked',
      'requires_confirmation',
      'allow_llm_fallback',
    ]) {
      expect(schemaSource).toContain(token);
    }
    expect(serverSource).toContain('explicitAllowLlmRepair(req.body || {})');
    expect(serverSource).toContain('allow_llm_fallback');
  });
});
