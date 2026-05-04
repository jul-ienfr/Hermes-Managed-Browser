/**
 * VNC launcher — owns all child_process spawning and process.env reads.
 * Isolated from route handlers for OpenClaw scanner compliance.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve VNC configuration from pluginConfig + env var fallbacks.
 * All process.env reads live here — callers get a plain config object.
 */
export function resolveVncConfig(pluginConfig = {}) {
  const enabled = process.env.ENABLE_VNC === '1' || pluginConfig.enabled === true;

  const rawResolution = process.env.VNC_RESOLUTION || pluginConfig.resolution || '1920x1080';
  const resolution = rawResolution.includes('x', rawResolution.indexOf('x') + 1)
    ? rawResolution
    : `${rawResolution}x24`;

  const vncPassword = process.env.VNC_PASSWORD || pluginConfig.password || '';
  const viewOnly = process.env.VIEW_ONLY === '1' || pluginConfig.viewOnly === true;
  const vncPort = process.env.VNC_PORT || pluginConfig.vncPort || '5900';
  const novncPort = process.env.NOVNC_PORT || pluginConfig.novncPort || '6080';
  const humanOnly = process.env.CAMOFOX_VNC_HUMAN_ONLY === '0' ? false : pluginConfig.humanOnly !== false;
  const managedRegistryOnly = process.env.CAMOFOX_VNC_MANAGED_REGISTRY_ONLY === '0' ? false : pluginConfig.managedRegistryOnly !== false;
  const bind = humanOnly ? (pluginConfig.bind || '127.0.0.1') : (process.env.VNC_BIND || pluginConfig.bind || '127.0.0.1');
  const displayRegistry = process.env.CAMOFOX_VNC_DISPLAY_REGISTRY || pluginConfig.displayRegistry || '';
  const displaySelection = process.env.CAMOFOX_VNC_DISPLAY_SELECTION || pluginConfig.displaySelection || '';

  return { enabled, resolution, vncPassword, viewOnly, vncPort, novncPort, bind, humanOnly, managedRegistryOnly, displayRegistry, displaySelection };
}

/**
 * Start the vnc-watcher.sh child process.
 * Returns the spawned ChildProcess.
 */
export function startWatcher({
  resolution,
  vncPassword,
  viewOnly,
  vncPort,
  novncPort,
  bind,
  humanOnly,
  managedRegistryOnly,
  displayRegistry,
  displaySelection,
  log,
  events,
}) {
  const watcherPath = path.join(__dirname, 'vnc-watcher.sh');
  const watcher = spawn('sh', [watcherPath], {
    env: {
      ...process.env,
      VNC_PASSWORD: vncPassword,
      VNC_RESOLUTION: resolution,
      VIEW_ONLY: viewOnly ? '1' : '0',
      VNC_PORT: String(vncPort),
      NOVNC_PORT: String(novncPort),
      VNC_BIND: bind || '127.0.0.1',
      CAMOFOX_VNC_HUMAN_ONLY: humanOnly ? '1' : '0',
      CAMOFOX_VNC_MANAGED_REGISTRY_ONLY: managedRegistryOnly ? '1' : '0',
      CAMOFOX_VNC_DISPLAY_REGISTRY: displayRegistry || process.env.CAMOFOX_VNC_DISPLAY_REGISTRY || '',
      CAMOFOX_VNC_DISPLAY_SELECTION: displaySelection || process.env.CAMOFOX_VNC_DISPLAY_SELECTION || '',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });

  watcher.on('error', (err) => {
    log('error', 'vnc watcher failed to start', { error: err.message });
  });

  watcher.on('exit', (code, signal) => {
    log('warn', 'vnc watcher exited', { code, signal });
    events.emit('vnc:watcher:stopped', { code, signal });
  });

  log('info', 'vnc watcher started', { pid: watcher.pid });
  events.emit('vnc:watcher:started', { pid: watcher.pid });

  return watcher;
}
