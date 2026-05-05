import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '../..');
const pluginPath = path.join(rootDir, 'plugin.ts');
const pluginSource = fs.readFileSync(pluginPath, 'utf-8');

describe('Hermes original browser tool compatibility', () => {
  test('plugin registers the canonical Hermes browser tool surface, not only camofox-specific names', () => {
    for (const name of [
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_press',
      'browser_back',
      'browser_console',
      'browser_get_images',
      'browser_vision',
      'browser_click_smart',
      'browser_type_smart',
      'browser_record_flow',
      'browser_run_memory',
      'browser_list_memory',
      'browser_inspect_memory',
      'browser_delete_memory',
      'browser_run_flow',
    ]) {
      expect(pluginSource).toContain(`name: "${name}"`);
    }
  });

  test('browser_snapshot is DOM/accessibility-first and does not request screenshots by default', () => {
    expect(pluginSource).toContain('name: "browser_snapshot"');
    expect(pluginSource).toContain('/snapshot?userId=${userId}&includeScreenshot=false');
  });

  test('browser_vision is the only canonical tool that explicitly requests screenshot-based state', () => {
    const canonicalVisionSection = pluginSource.slice(pluginSource.indexOf('name: "browser_vision"'));
    expect(canonicalVisionSection).toContain('/screenshot?userId=${userId}');

    const snapshotSection = pluginSource.slice(
      pluginSource.indexOf('name: "browser_snapshot"'),
      pluginSource.indexOf('name: "browser_click"'),
    );
    expect(snapshotSection).toContain('includeScreenshot=false');
    expect(snapshotSection).not.toContain('type: "image"');
  });

  test('canonical tools route to the same backend primitives as Hermes original', () => {
    const expectations = {
      browser_click: '/click',
      browser_type: '/type',
      browser_press: '/press',
      browser_scroll: '/scroll',
      browser_console: '/evaluate',
      browser_get_images: '/images',
      browser_click_smart: '/click',
      browser_type_smart: '/type',
      browser_record_flow: '/memory/record',
      browser_run_memory: '/memory/replay',
      browser_list_memory: '/memory/search',
      browser_inspect_memory: '/memory/search',
      browser_delete_memory: '/memory/delete',
      browser_run_flow: '/memory/replay',
    };

    for (const [toolName, endpoint] of Object.entries(expectations)) {
      const start = pluginSource.indexOf(`name: "${toolName}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
      const section = pluginSource.slice(start, nextTool === -1 ? undefined : nextTool);
      expect(section).toContain(endpoint);
    }
  });

  test('Hermes canonical tools are stateful after browser_navigate and do not require tabId', () => {
    expect(pluginSource).toContain('const currentHermesTabsByContext = new Map<string, string>();');
    expect(pluginSource).toContain('const rememberHermesTab');
    expect(pluginSource).toContain('const resolveHermesTabId');

    for (const toolName of [
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_scroll',
      'browser_back',
      'browser_console',
      'browser_get_images',
      'browser_vision',
      'browser_click_smart',
      'browser_type_smart',
      'browser_record_flow',
    ]) {
      const start = pluginSource.indexOf(`name: "${toolName}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
      const section = pluginSource.slice(start, nextTool === -1 ? undefined : nextTool);
      expect(section).toContain('resolveHermesTabId');
      expect(section).not.toMatch(/required:\s*\[[^\]]*"tabId"/);
    }
  });

  test('browser_navigate stores the created or navigated tab as the current Hermes tab', () => {
    const start = pluginSource.indexOf('name: "browser_navigate"');
    const nextTool = pluginSource.indexOf('api.registerTool', start + 1);
    const section = pluginSource.slice(start, nextTool);

    expect(section).toContain('rememberHermesTab(ctx, result');
    expect(section).toContain('sessionKey');
    expect(section).toContain('agentId');
  });
});
