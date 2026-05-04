import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const pluginPath = path.join(rootDir, 'plugin.ts');
const managedPolicyPath = path.join(rootDir, 'lib/managed-browser-policy.js');
const pluginSource = fs.readFileSync(pluginPath, 'utf-8');
const managedPolicySource = fs.readFileSync(managedPolicyPath, 'utf-8');

describe('managed browser tool compatibility', () => {
  test('plugin registers managed browser tool surface', () => {
    for (const name of [
      'managed_browser_bind_existing_tab',
      'managed_browser_launch_visible_window',
      'managed_browser_checkpoint_storage',
      'managed_browser_navigate',
      'managed_browser_snapshot',
      'managed_browser_click',
      'managed_browser_type',
      'managed_browser_press',
      'managed_browser_scroll',
      'managed_browser_back',
      'managed_browser_console',
      'managed_browser_get_images',
      'managed_browser_vision',
      'managed_browser_profile_status',
      'managed_browser_warmup',
      'managed_browser_rotate',
      'managed_browser_click_smart',
      'managed_browser_type_smart',
      'managed_browser_record_flow',
      'managed_browser_run_memory',
      'managed_browser_list_memory',
      'managed_browser_inspect_memory',
      'managed_browser_delete_memory',
      'managed_browser_run_flow',
    ]) {
      expect(pluginSource).toContain(`name: "${name}"`);
    }
  });

  test('managed policy exposes only the active CIM profile', () => {
    expect(managedPolicySource).toContain("'leboncoin-cim'");
    expect(managedPolicySource).toContain("profile: 'leboncoin-cim'");
    expect(managedPolicySource).toContain("userId: 'leboncoin-cim'");
    expect(managedPolicySource).toContain("sessionKey: 'managed:leboncoin-cim'");
    expect(managedPolicySource).toContain("profileDir: '/home/jul/.vnc-browser-profiles/leboncoin-cim'");
  });

  test('managed tools require explicit profile and resolve managed policy', () => {
    expect(pluginSource).toContain('resolveManagedBrowserProfile');
    expect(pluginSource).toContain('managedBrowserContextKey');

    for (const toolName of [
      'managed_browser_bind_existing_tab',
      'managed_browser_launch_visible_window',
      'managed_browser_checkpoint_storage',
      'managed_browser_navigate',
      'managed_browser_snapshot',
      'managed_browser_click',
      'managed_browser_type',
      'managed_browser_press',
      'managed_browser_scroll',
      'managed_browser_back',
      'managed_browser_console',
      'managed_browser_get_images',
      'managed_browser_vision',
      'managed_browser_profile_status',
      'managed_browser_warmup',
      'managed_browser_rotate',
      'managed_browser_click_smart',
      'managed_browser_type_smart',
      'managed_browser_record_flow',
      'managed_browser_run_memory',
      'managed_browser_list_memory',
      'managed_browser_inspect_memory',
      'managed_browser_delete_memory',
      'managed_browser_run_flow',
    ]) {
      const start = pluginSource.indexOf(`name: "${toolName}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
      const section = pluginSource.slice(start, nextTool === -1 ? undefined : nextTool);
      expect(section).toContain('required: ["profile"');
      expect(section).toContain('resolveManagedBrowserProfile');
    }
  });

  test('managed snapshot is DOM/accessibility-first and vision is explicit screenshot fallback', () => {
    const snapshotStart = pluginSource.indexOf('name: "managed_browser_snapshot"');
    const snapshotEnd = pluginSource.indexOf('name: "managed_browser_click"');
    const snapshotSection = pluginSource.slice(snapshotStart, snapshotEnd);
    expect(snapshotSection).toContain('includeScreenshot=false');
    expect(snapshotSection).not.toContain('type: "image"');

    const visionStart = pluginSource.indexOf('name: "managed_browser_vision"');
    const visionEnd = pluginSource.indexOf('name: "browser_navigate"');
    const visionSection = pluginSource.slice(visionStart, visionEnd);
    expect(visionSection).toContain('/screenshot?userId=${policy.userId}');
  });

  test('managed interactive tools route to humanized tab endpoints and pass humanProfile', () => {
    const expectations = {
      managed_browser_click: '/click',
      managed_browser_type: '/type',
      managed_browser_press: '/press',
      managed_browser_scroll: '/scroll',
    };

    for (const [toolName, endpoint] of Object.entries(expectations)) {
      const start = pluginSource.indexOf(`name: "${toolName}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
      const section = pluginSource.slice(start, nextTool === -1 ? undefined : nextTool);
      expect(section).toContain(endpoint);
      expect(section).toContain('managedHumanPayload');
      expect(pluginSource).toContain('resolveManagedHumanProfile(humanProfile, policy.defaultHumanProfile)');
    }
  });

  test('managed current tabs are isolated from Hermes generic current tabs', () => {
    expect(pluginSource).toContain('const currentHermesTabsByContext = new Map<string, string>();');
    expect(pluginSource).toContain('const currentManagedTabsByContext = new Map<string, string>();');
    expect(pluginSource).toContain('const managedLifecycleByContext');
    expect(pluginSource).toContain('rememberManagedTab');
    expect(pluginSource).toContain('resolveManagedTabId');
    expect(pluginSource).toContain('No active managed browser tab for profile');
  });

  test('managed navigation forwards persona keys into tab creation', () => {
    const start = pluginSource.indexOf('name: "managed_browser_navigate"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);
    expect(section).toContain('managedTabCreatePayload(policy, targetUrl)');
    expect(pluginSource).toContain('profileDir: policy.profileDir');
    expect(pluginSource).toContain('browserPersonaKey: policy.browserPersonaKey');
    expect(pluginSource).toContain('humanPersonaKey: policy.humanPersonaKey');
    expect(pluginSource).toContain('humanProfile: resolveManagedHumanProfile(humanProfile, policy.defaultHumanProfile)');
  });

  test('managed binding attaches existing tabs without creating raw tabs', () => {
    const bindStart = pluginSource.indexOf('name: "managed_browser_bind_existing_tab"');
    const bindEnd = pluginSource.indexOf('name: "managed_browser_launch_visible_window"');
    const bindSection = pluginSource.slice(bindStart, bindEnd);
    expect(bindSection).toContain('appendQuery("/tabs", { userId: policy.userId })');
    expect(bindSection).toContain('firstManagedTabId(tabsResult, tabId)');
    expect(bindSection).toContain('No server-owned managed browser tab found');
    expect(bindSection).not.toContain('External VNC windows');
    expect(bindSection).toContain('managed_browser_launch_visible_window');
    expect(bindSection).toContain('managed_browser_navigate');
    expect(bindSection).toContain('rememberManagedTab(ctx, policy, { tabId: resolvedTabId })');
    expect(bindSection).not.toContain('fetchApi(baseUrl, "/tabs"');
  });

  test('managed visible launch creates server-owned bindable tabs through explicit endpoint', () => {
    const start = pluginSource.indexOf('name: "managed_browser_launch_visible_window"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);
    expect(section).toContain('allowServerOwnedVisibleLaunch');
    expect(section).toContain('/managed/visible-tab');
    expect(section).toContain('managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile)');
    expect(section).toContain('if (policy.displayPolicy?.display) payload.display = policy.displayPolicy.display');
    expect(section).toContain('rememberManagedTab(ctx, policy, result)');
  });

  test('managed storage checkpoint persists active managed sessions explicitly', () => {
    const start = pluginSource.indexOf('name: "managed_browser_checkpoint_storage"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);
    expect(section).toContain('/managed/storage-checkpoint');
    expect(section).toContain('profileDir: policy.profileDir');
    expect(section).toContain('reason: reason || "manual_checkpoint"');
  });

  test('managed navigation uses managed-marked tab creation and keeps existing-window guard available', () => {
    const navigateStart = pluginSource.indexOf('name: "managed_browser_navigate"');
    const navigateEnd = pluginSource.indexOf('name: "managed_browser_snapshot"');
    const navigateSection = pluginSource.slice(navigateStart, navigateEnd);
    expect(managedPolicySource).toContain("mode: 'managed-autonomous'");
    expect(managedPolicySource).not.toContain('requiresExistingWindow: true');
    expect(pluginSource).toContain('const assertManagedBrowserCanOpenTab');
    expect(pluginSource).toContain('managedBrowser: true');
    expect(navigateSection).toContain('assertManagedBrowserCanOpenTab(policy, tabId)');
    expect(navigateSection).toContain('`/tabs/${tabId}/navigate`');
    expect(navigateSection).toContain('fetchApi(baseUrl, "/tabs"');
  });

  test('managed smart and memory tools use managed siteKey and avoid console fallback parameters', () => {
    for (const toolName of [
      'managed_browser_click_smart',
      'managed_browser_type_smart',
      'managed_browser_record_flow',
      'managed_browser_run_memory',
      'managed_browser_list_memory',
      'managed_browser_inspect_memory',
      'managed_browser_delete_memory',
      'managed_browser_run_flow',
    ]) {
      const start = pluginSource.indexOf(`name: "${toolName}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
      const section = pluginSource.slice(start, nextTool === -1 ? undefined : nextTool);
      expect(section).toContain('policy.siteKey');
      expect(section).not.toContain('browser_console');
      expect(section).not.toContain('allow_console_fallback');
    }
  });

  test('managed profile status reports policy and remembered tab without opening a browser', () => {
    const start = pluginSource.indexOf('name: "managed_browser_profile_status"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);
    expect(pluginSource).toContain('const managedStatusSnapshot');
    expect(pluginSource).toContain('currentManagedTabsByContext.get');
    expect(section).toContain('profileDir: policy.profileDir');
    expect(section).toContain('displayPolicy: policy.displayPolicy');
    expect(section).toContain('lifecyclePolicy: policy.lifecyclePolicy');
    expect(section).toContain('securityPolicy: policy.securityPolicy');
    expect(pluginSource).toContain('lifecycleStateForPolicy');
    expect(pluginSource).toContain('shouldWarmupManagedProfile');
    expect(pluginSource).toContain('shouldRotateManagedProfile');
    expect(section).toContain('lifecycle');
    expect(section).toContain('warmup');
    expect(section).toContain('rotation');
    expect(section).toContain('diagnostics');
    expect(pluginSource).toContain("nextRecommendedAction: rotation.shouldRotate ? 'managed_browser_rotate'");
    expect(pluginSource).toContain("managedControlPath");
    expect(pluginSource).not.toContain("externalVncAttachment");
    expect(pluginSource).toContain("primaryStateTool: 'managed_browser_snapshot'");
    expect(section).toContain('timeline: summarizeAgentHistoryTimeline([])');
    expect(pluginSource).toContain('import { summarizeAgentHistoryTimeline }');
    expect(pluginSource).toContain('updateManagedLifecycle(ctx, policy, "READY", tabId)');
    expect(section).not.toContain('fetchApi');
  });

  test('managed warmup is explicit and gated by lifecycle policy', () => {
    const start = pluginSource.indexOf('name: "managed_browser_warmup"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);
    expect(section).toContain('shouldWarmup');
    expect(section).toContain('started: false');
    expect(section).toContain('assertManagedBrowserCanOpenTab(policy, undefined)');
    expect(section).toContain('managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile)');
    expect(section).toContain('rememberManagedTab(ctx, policy, result)');
    expect(section.indexOf('if (!before.warmup.shouldWarmup)')).toBeLessThan(section.indexOf('assertManagedBrowserCanOpenTab'));
    expect(section.indexOf('assertManagedBrowserCanOpenTab')).toBeLessThan(section.indexOf('fetchApi'));
  });

  test('managed rotation is explicit and gated by lifecycle expiry or force', () => {
    const start = pluginSource.indexOf('name: "managed_browser_rotate"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);
    expect(section).toContain('shouldRotateManagedProfile(policy, before.lifecycle, { force })');
    expect(section).toContain('if (!rotation.shouldRotate)');
    expect(section).toContain('rotated: false');
    expect(section).toContain('rotated: true');
    expect(section).toContain('previousTabId');
    expect(section).toContain('assertManagedBrowserCanOpenTab(policy, undefined)');
    expect(section).toContain('managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile)');
    expect(section).toContain('rememberManagedTab(ctx, policy, result)');
    expect(section.indexOf('if (!rotation.shouldRotate)')).toBeLessThan(section.indexOf('assertManagedBrowserCanOpenTab'));
    expect(section.indexOf('assertManagedBrowserCanOpenTab')).toBeLessThan(section.indexOf('fetchApi'));
  });
});
