import { Camoufox, launchOptions } from 'camoufox-js';
import { VirtualDisplay } from 'camoufox-js/dist/virtdisplay.js';
import { firefox } from 'playwright-core';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveVncConfig } from './plugins/vnc/vnc-launcher.js';
import { expandMacro } from './lib/macros.js';
import { loadConfig } from './lib/config.js';
import { normalizePlaywrightProxy, createProxyPool, buildProxyUrl } from './lib/proxy.js';
import { createFlyHelpers } from './lib/fly.js';
import { createPluginEvents, loadPlugins, readPluginConfig } from './lib/plugins.js';
import { requireAuth, timingSafeCompare as _timingSafeCompare, isLoopbackAddress as _isLoopbackAddress } from './lib/auth.js';
import { windowSnapshot, compactSnapshot, buildDomMetadata } from './lib/snapshot.js';
import {
  MAX_DOWNLOAD_INLINE_BYTES,
  clearTabDownloads,
  clearSessionDownloads,
  attachDownloadListener,
  getDownloadsList,
} from './lib/downloads.js';
import { extractPageImages } from './lib/images.js';
import { buildTargetContext } from './lib/action-context.js';
import { validateOutcome } from './lib/outcome-validation.js';
import { adaptivePacingForInterrupt, detectInterrupt, chooseCookieConsentCandidate } from './lib/interrupt-handlers.js';
import { candidatesFromRefs } from './lib/target-repair.js';
import { replayStepsSelfHealing } from './lib/self-healing-replay.js';
import { createMemoryReplayHandlers } from './lib/memory-replay-handlers.js';
import { createManagedPlannerFallback, explicitAllowLlmRepair } from './lib/managed-llm-repair.js';
import {
  createManagedRecoveryRegistry,
  getRecoveryState,
  getRecoveryTargetUrl,
  markRecoveryClosed,
  recordRecoveryAction,
} from './lib/managed-recovery-registry.js';
import {
  applyLearnedDomRepair,
  deleteFlow as deleteAgentHistoryFlow,
  loadAgentHistory,
  recordFlow as recordAgentHistoryFlow,
  recordSuccessfulBrowserAction,
  searchFlows,
} from './lib/agent-history-memory.js';
import {
  seedSharedManagedFlows,
  sharedManagedFlowAvailability,
} from './lib/shared-managed-flows.js';

import {
  initMetrics, getRegister, isMetricsEnabled, createMetric,
  startMemoryReporter, stopMemoryReporter,
} from './lib/metrics.js';
import { actionFromReq, classifyError } from './lib/request-utils.js';
import { cleanupOrphanedTempFiles } from './lib/tmp-cleanup.js';
import { coalesceInflight } from './lib/inflight.js';
import {
  loadPersistedBrowserProfile,
  loadPersistedFingerprint,
  loadPersistedProfilePolicy,
  persistBrowserProfile,
  persistFingerprint,
  persistProfilePolicy,
} from './lib/persistence.js';
import {
  buildCamoufoxLaunchOptionsInput,
  expectedFingerprintFromLaunchProfile,
  generateCanonicalFingerprint,
} from './lib/camoufox-launch-profile.js';
import {
  detectSensitivePolicyChange,
  profilePolicyFromLaunchProfile,
} from './lib/managed-profile-policy.js';
import { collectBrowserFingerprintSnapshot, validateFingerprintCoherence } from './lib/fingerprint-coherence.js';
import { validateVncGeometry } from './lib/vnc-geometry-doctor.js';
import {
  listManagedBrowserProfileIdentities,
  managedBrowserProfileStatus,
  requireManagedBrowserProfileIdentity,
} from './lib/managed-browser-policy.js';
import {
  ProfileLeaseManager,
  enforceManagedLease,
  ensureManagedLease,
  managedReadAllowed,
  serializeProfileLeaseError,
} from './lib/profile-lease-manager.js';
import { managedCliErrorFields, normalizeManagedCliResult, normalizeManagedNotificationResponse } from './lib/managed-cli-schema.js';
import { ensureNotificationCaptureOnPage, installNotificationCapture } from './lib/notification-capture.js';
import { listNotifications, markNotificationsRead, recordNotification } from './lib/managed-notifications.js';
import { buildBrowserPersona } from './lib/browser-persona.js';
import { buildHumanBehaviorPersona } from './lib/human-behavior-persona.js';
import { resolveBrowserDisplayMode } from './lib/browser-display-mode.js';
import { recordVncDisplay, removeVncDisplay, readDisplayRegistry, readSelectedVncUserId } from './lib/vnc-display-registry.js';
import { shouldStartKeepalive } from './lib/keepalive-policy.js';
import { humanClick, humanType, humanPress, humanScroll, humanPrepareTarget, humanMove } from './lib/human-actions.js';
import { createHumanSessionState, getHumanCursor, updateHumanCursor } from './lib/human-session-state.js';
import { managedAuthEnsure, managedAuthStatus } from './lib/managed-auth.js';
import { credentialPath } from './lib/credentials-vault.js';
import { getLifecycleDefault, normalizeLifecycleClosePolicy, setLifecycleDefault } from './lib/managed-lifecycle-policy-store.js';
import { enforceProfileWindowBounds, managedProfileDisplayResolution, withManagedProfileLaunchArgs } from './lib/managed-browser-display-size.js';

const CONFIG = loadConfig();
const PLUGIN_CONFIGS = readPluginConfig().configs;
const VNC_HEALTH_INFO = resolveVncConfig(PLUGIN_CONFIGS.get('vnc') || {});
const MANAGED_BROWSER_PROFILES = listManagedBrowserProfileIdentities();
const MANAGED_BROWSER_PROFILES_BY_USER_ID = new Map(MANAGED_BROWSER_PROFILES.map((policy) => [policy.userId, policy]));
const managedProfileLeases = new ProfileLeaseManager({ ttlMs: CONFIG.managedProfileLeaseTtlMs });
const execFileAsync = promisify(execFile);

function getVncHealthFields(req) {
  if (!VNC_HEALTH_INFO.enabled) return {};
  const host = req.hostname || '127.0.0.1';
  const protocol = req.protocol || 'http';
  const novncPort = Number.parseInt(String(VNC_HEALTH_INFO.novncPort), 10);
  const vncPort = Number.parseInt(String(VNC_HEALTH_INFO.vncPort), 10);
  const fields = {
    vncEnabled: true,
    vncPort: Number.isFinite(vncPort) ? vncPort : null,
    novncPort: Number.isFinite(novncPort) ? novncPort : null,
    vncViewOnly: Boolean(VNC_HEALTH_INFO.viewOnly),
    vncHumanOnly: Boolean(VNC_HEALTH_INFO.humanOnly),
    vncManagedRegistryOnly: Boolean(VNC_HEALTH_INFO.managedRegistryOnly),
    vncBind: VNC_HEALTH_INFO.bind || '127.0.0.1',
  };
  if (Number.isFinite(novncPort)) {
    fields.novncUrl = `${protocol}://${host}:${novncPort}/vnc.html`;
    fields.manualResolutionUrl = fields.novncUrl;
  }
  if (Number.isFinite(vncPort)) {
    fields.vncUrl = `${protocol}://${host}:${vncPort}`;
  }
  return fields;
}

// --- Plugin event bus ---
const pluginEvents = createPluginEvents();

// --- Shared auth middleware ---
const authMiddleware = () => requireAuth(CONFIG);

const {
  requestsTotal, requestDuration, pageLoadDuration, snapshotBytes,
  activeTabsGauge, tabLockQueueDepth,
  tabLockTimeoutsTotal,
  failuresTotal, browserRestartsTotal, tabsDestroyedTotal,
  sessionsExpiredTotal, tabsReapedTotal, tabsRecycledTotal,
} = await initMetrics({ enabled: CONFIG.prometheusEnabled });

// --- Structured logging ---
function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

const app = express();
app.use(express.json({ limit: '100kb' }));

// Request logging + metrics middleware
app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  req.reqId = reqId;
  req.startTime = Date.now();

  const userId = req.body?.userId || req.query?.userId || '-';
  if (req.path !== '/health') {
    log('info', 'req', { reqId, method: req.method, path: req.path, userId });
  }

  const action = actionFromReq(req);
  const done = requestDuration.startTimer({ action });

  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const ms = Date.now() - req.startTime;
    const isErrorStatus = res.statusCode >= 400;
    requestsTotal.labels(action, isErrorStatus ? 'error' : 'success').inc();
    done();

    if (req.path !== '/health') {
      log('info', 'res', { reqId, status: res.statusCode, ms });
    }

    return origEnd(...args);
  };

  next();
});

// --- Horizontal scaling (Fly.io multi-machine) ---
const fly = createFlyHelpers(CONFIG);
const FLY_MACHINE_ID = fly.machineId;

// Route tab requests to the owning machine via fly-replay header.
app.use('/tabs/:tabId', fly.replayMiddleware(log));

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

// Interactive roles to include - exclude combobox to avoid opening complex widgets
// (date pickers, dropdowns) that can interfere with navigation
const INTERACTIVE_ROLES = [
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'menuitem', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch'
  // 'combobox' excluded - can trigger date pickers and complex dropdowns
];

// Patterns to skip (date pickers, calendar widgets)
const SKIP_PATTERNS = [
  /date/i, /calendar/i, /picker/i, /datepicker/i
];

// timingSafeCompare and isLoopbackAddress imported from lib/auth.js
const timingSafeCompare = _timingSafeCompare;
const isLoopbackAddress = _isLoopbackAddress;

// Custom error for stale/unknown element refs — returned as 422 instead of 500
class StaleRefsError extends Error {
  constructor(ref, maxRef, totalRefs) {
    super(`Unknown ref: ${ref} (valid refs: e1-${maxRef}, ${totalRefs} total). Refs reset after navigation - call snapshot first.`);
    this.name = 'StaleRefsError';
    this.code = 'stale_refs';
    this.ref = ref;
  }
}

function safeError(err) {
  if (CONFIG.nodeEnv === 'production') {
    log('error', 'internal error', { error: err.message, stack: err.stack });
    return 'Internal server error';
  }
  return err.message;
}

// Send error response with appropriate status code (422 for stale refs, 500 otherwise)
function sendError(res, err, extraFields = {}) {
  const status = err instanceof StaleRefsError ? 422 : (err.statusCode || 500);
  if (err?.code === 'profile_locked') {
    res.status(status).json({ ...serializeProfileLeaseError(err), ...extraFields });
    return;
  }
  const body = { error: safeError(err), ...extraFields };
  if (err?.code) body.code = err.code;
  if (err?.issues) body.issues = err.issues;
  if (err instanceof StaleRefsError) {
    body.code = 'stale_refs';
    body.ref = err.ref;
  }
  res.status(status).json(body);
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
      return `Blocked URL scheme: ${parsed.protocol} (only http/https allowed)`;
    }
    return null;
  } catch {
    return `Invalid URL: ${url}`;
  }
}

// isLoopbackAddress — now imported from lib/auth.js (see top of file)

// Import cookies into a user's browser context (Playwright cookies format)
// POST /sessions/:userId/cookies { cookies: Cookie[] }
//
// SECURITY:
// Cookie injection moves this from "anonymous browsing" to "authenticated browsing".
// By default, this endpoint is protected by CAMOFOX_API_KEY.
// For local development convenience, when CAMOFOX_API_KEY is NOT set, we allow
// unauthenticated cookie import ONLY from loopback (127.0.0.1 / ::1) and ONLY
// when NODE_ENV != production.
app.post('/sessions/:userId/cookies', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    if (CONFIG.apiKey) {
      const apiKey = CONFIG.apiKey;
      const auth = String(req.headers['authorization'] || '');
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match || !timingSafeCompare(match[1], apiKey)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else {
      const remoteAddress = req.socket?.remoteAddress || '';
      const allowUnauthedLocal = CONFIG.nodeEnv !== 'production' && isLoopbackAddress(remoteAddress);
      if (!allowUnauthedLocal) {
        return res.status(403).json({
          error:
            'Cookie import is disabled without CAMOFOX_API_KEY except for loopback requests in non-production environments.',
        });
      }
    }

    const userId = req.params.userId;
    if (!req.body || !('cookies' in req.body)) {
      return res.status(400).json({ error: 'Missing "cookies" field in request body' });
    }
    const cookies = req.body.cookies;
    if (!Array.isArray(cookies)) {
      return res.status(400).json({ error: 'cookies must be an array' });
    }

    if (cookies.length > 500) {
      return res.status(400).json({ error: 'Too many cookies. Maximum 500 per request.' });
    }

    const invalid = [];
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i];
      const missing = [];
      if (!c || typeof c !== 'object') {
        invalid.push({ index: i, error: 'cookie must be an object' });
        continue;
      }
      if (typeof c.name !== 'string' || !c.name) missing.push('name');
      if (typeof c.value !== 'string') missing.push('value');
      if (typeof c.domain !== 'string' || !c.domain) missing.push('domain');
      if (missing.length) invalid.push({ index: i, missing });
    }
    if (invalid.length) {
      return res.status(400).json({
        error: 'Invalid cookie objects: each cookie must include name, value, and domain',
        invalid,
      });
    }

    const allowedFields = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
    const sanitized = cookies.map(c => {
      const clean = {};
      for (const k of allowedFields) {
        if (c[k] !== undefined) clean[k] = c[k];
      }
      return clean;
    });

    const session = await getSession(userId);
    await session.context.addCookies(sanitized);
    const result = { ok: true, userId: String(userId), count: sanitized.length };
    log('info', 'cookies imported', { reqId: req.reqId, userId: String(userId), count: sanitized.length });
    pluginEvents.emit('session:cookies:import', { userId: String(userId), count: sanitized.length });
    res.json(result);
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'set_cookies').inc();
    log('error', 'cookie import failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

const browsers = new Map();
// userId -> { context, tabGroups: Map<sessionKey, Map<tabId, TabState>>, lastAccess }
// TabState = { page, refs: Map<refId, {role, name, nth}>, visitedUrls: Set, downloads: Array, toolCalls: number }
// Note: sessionKey was previously called listItemId - both are accepted for backward compatibility
const sessions = new Map();
const managedRecoveryRegistry = createManagedRecoveryRegistry();
const disabledNotificationCaptureOrigins = new Set();
const BROWSER_PROFILE_DIR = process.env.CAMOFOX_PROFILE_DIR || path.join(os.homedir(), '.camofox', 'profiles');
const KEEPALIVE_USER_ID = process.env.CAMOFOX_KEEPALIVE_USER_ID || '';
const KEEPALIVE_SESSION_KEY = process.env.CAMOFOX_KEEPALIVE_SESSION_KEY || 'manual-login';
const KEEPALIVE_URL = process.env.CAMOFOX_KEEPALIVE_URL || 'about:blank';

const SESSION_TIMEOUT_MS = CONFIG.sessionTimeoutMs;
const MAX_SNAPSHOT_NODES = 500;
const TAB_INACTIVITY_MS = CONFIG.tabInactivityMs;
const MAX_SESSIONS = CONFIG.maxSessions;
const MAX_TABS_PER_SESSION = CONFIG.maxTabsPerSession;
const MAX_TABS_GLOBAL = CONFIG.maxTabsGlobal;
const HANDLER_TIMEOUT_MS = CONFIG.handlerTimeoutMs;
const MAX_CONCURRENT_PER_USER = CONFIG.maxConcurrentPerUser;
const PAGE_CLOSE_TIMEOUT_MS = 5000;
const NAVIGATE_TIMEOUT_MS = CONFIG.navigateTimeoutMs;
const BUILDREFS_TIMEOUT_MS = CONFIG.buildrefsTimeoutMs;
const FAILURE_THRESHOLD = 3;
const MAX_CONSECUTIVE_TIMEOUTS = 3;
const TAB_LOCK_TIMEOUT_MS = 35000; // Must be > HANDLER_TIMEOUT_MS so active op times out first
const MAX_DIAGNOSTICS_BUFFER = 200;



// Proper mutex for tab serialization. The old Promise-chain lock on timeout proceeded
// WITHOUT the lock, allowing concurrent Playwright operations that corrupt CDP state.
class TabLock {
  constructor() {
    this.queue = [];
    this.active = false;
  }

  acquire(timeoutMs) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        tabLockTimeoutsTotal.inc();
        refreshTabLockQueueDepth();
        reject(new Error('Tab lock queue timeout'));
      }, timeoutMs);
      this.queue.push(entry);
      refreshTabLockQueueDepth();
      this._tryNext();
    });
  }

  release() {
    this.active = false;
    this._tryNext();
    refreshTabLockQueueDepth();
  }

  _tryNext() {
    if (this.active || this.queue.length === 0) return;
    this.active = true;
    const entry = this.queue.shift();
    clearTimeout(entry.timer);
    refreshTabLockQueueDepth();
    entry.resolve();
  }

  drain() {
    this.active = true;
    for (const entry of this.queue) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Tab destroyed'));
    }
    this.queue = [];
    refreshTabLockQueueDepth();
  }
}

// Per-tab locks to serialize operations on the same tab
const tabLocks = new Map(); // tabId -> TabLock

function getTabLock(tabId) {
  if (!tabLocks.has(tabId)) tabLocks.set(tabId, new TabLock());
  return tabLocks.get(tabId);
}

// Timeout is INSIDE the lock so each operation gets its full budget
// regardless of how long it waited in the queue.
async function withTabLock(tabId, operation, timeoutMs = HANDLER_TIMEOUT_MS) {
  const lock = getTabLock(tabId);
  await lock.acquire(TAB_LOCK_TIMEOUT_MS);
  try {
    return await withTimeout(operation(), timeoutMs, 'action');
  } finally {
    lock.release();
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

function withActionTimeout(promise, ms, label) {
  return withTimeout(promise, Math.max(1, Number(ms) || 1), label);
}

function pushDiagnostics(buffer, item) {
  buffer.push(item);
  if (buffer.length > MAX_DIAGNOSTICS_BUFFER) buffer.splice(0, buffer.length - MAX_DIAGNOSTICS_BUFFER);
}

function attachPageDiagnostics(tabState, page) {
  if (!tabState || !page || page.isClosed?.() || tabState._diagnosticsPage === page) return;
  if (!Array.isArray(tabState.consoleMessages)) tabState.consoleMessages = [];
  if (!Array.isArray(tabState.jsErrors)) tabState.jsErrors = [];
  if (!tabState.diagnosticsTotals) tabState.diagnosticsTotals = { console_messages: 0, js_errors: 0 };
  tabState._diagnosticsPage = page;
  page.on('console', (message) => {
    tabState.diagnosticsTotals.console_messages++;
    pushDiagnostics(tabState.consoleMessages, {
      ts: new Date().toISOString(),
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });
  page.on('pageerror', (error) => {
    tabState.diagnosticsTotals.js_errors++;
    pushDiagnostics(tabState.jsErrors, {
      ts: new Date().toISOString(),
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack || null,
    });
  });
}

function diagnosticsResponse(tabState, clear = false) {
  const consoleMessages = [...(tabState.consoleMessages || [])];
  const jsErrors = [...(tabState.jsErrors || [])];
  const response = {
    console_messages: consoleMessages,
    js_errors: jsErrors,
    total_messages: consoleMessages.length,
    total_errors: jsErrors.length,
    totals: {
      console_messages: tabState.diagnosticsTotals?.console_messages || 0,
      js_errors: tabState.diagnosticsTotals?.js_errors || 0,
    },
  };
  if (clear) {
    tabState.consoleMessages = [];
    tabState.jsErrors = [];
  }
  return response;
}

function requestTimeoutMs(baseMs = HANDLER_TIMEOUT_MS) {
  return proxyPool?.canRotateSessions ? Math.max(baseMs, 180000) : baseMs;
}

const userConcurrency = new Map();

async function withUserLimit(userId, operation) {
  const key = normalizeUserId(userId);
  let state = userConcurrency.get(key);
  if (!state) {
    state = { active: 0, queue: [] };
    userConcurrency.set(key, state);
  }
  if (state.active >= MAX_CONCURRENT_PER_USER) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('User concurrency limit reached, try again')), 30000);
      state.queue.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  state.active++;
  healthState.activeOps++;
  try {
    const result = await operation();
    healthState.lastSuccessfulNav = Date.now();
    return result;
  } finally {
    healthState.activeOps--;
    state.active--;
    if (state.queue.length > 0) {
      const next = state.queue.shift();
      next();
    }
    if (state.active === 0 && state.queue.length === 0) {
      userConcurrency.delete(key);
    }
  }
}

async function safePageClose(page) {
  try {
    await Promise.race([
      page.close(),
      new Promise(resolve => setTimeout(resolve, PAGE_CLOSE_TIMEOUT_MS))
    ]);
  } catch (e) {
    log('warn', 'page close failed', { error: e.message });
  }
}

// Detect host OS for fingerprint generation
function getHostOS() {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux';
}

// Proxy strategy for outbound browsing.
const proxyPool = createProxyPool(CONFIG.proxy);

if (proxyPool) {
  log('info', 'proxy pool created', {
    mode: proxyPool.mode,
    host: proxyPool.canRotateSessions ? CONFIG.proxy.backconnectHost : CONFIG.proxy.host,
    ports: proxyPool.canRotateSessions ? [CONFIG.proxy.backconnectPort] : CONFIG.proxy.ports,
    poolSize: proxyPool.size,
    country: CONFIG.proxy.country || null,
    state: CONFIG.proxy.state || null,
    city: CONFIG.proxy.city || null,
  });
} else {
  log('info', 'no proxy configured');
}

const BROWSER_IDLE_TIMEOUT_MS = CONFIG.browserIdleTimeoutMs;
function getBrowserEntry(userId) {
  const key = normalizeUserId(userId);
  let entry = browsers.get(key);
  if (!entry) {
    entry = {
      key,
      browser: null,
      idleTimer: null,
      launchPromise: null,
      warmRetryTimer: null,
      virtualDisplay: null,
      launchProxy: null,
      persona: null,
      display: null,
    };
    browsers.set(key, entry);
  }
  return entry;
}

function clearBrowserIdleTimer(userId) {
  const entry = browsers.get(normalizeUserId(userId));
  if (entry?.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function scheduleBrowserIdleShutdown(userId) {
  const key = normalizeUserId(userId);
  const entry = browsers.get(key);
  if (!entry?.browser || sessions.has(key)) return;
  clearBrowserIdleTimer(key);
  entry.idleTimer = setTimeout(async () => {
    if (sessions.has(key) || !entry.browser) return;
    log('info', 'browser idle shutdown (user browser idle)', { userId: key });
    const b = entry.browser;
    entry.browser = null;
    await b.close().catch(() => {});
    if (!entry.launchPromise && !entry.browser && !entry.idleTimer) {
      browsers.delete(key);
    }
  }, BROWSER_IDLE_TIMEOUT_MS);
}

function clearBrowserWarmRetry(userId) {
  const entry = browsers.get(normalizeUserId(userId));
  if (entry?.warmRetryTimer) {
    clearTimeout(entry.warmRetryTimer);
    entry.warmRetryTimer = null;
  }
}

function scheduleBrowserWarmRetry(userId, delayMs = 5000) {
  const entry = getBrowserEntry(userId);
  if (entry.warmRetryTimer || entry.browser || entry.launchPromise) return;
  entry.warmRetryTimer = setTimeout(async () => {
    entry.warmRetryTimer = null;
    try {
      const start = Date.now();
      await ensureBrowser(userId);
      log('info', 'background browser warm retry succeeded', { userId: entry.key, ms: Date.now() - start });
    } catch (err) {
      log('warn', 'background browser warm retry failed', { userId: entry.key, error: err.message, nextDelayMs: delayMs });
      scheduleBrowserWarmRetry(entry.key, Math.min(delayMs * 2, 30000));
    }
  }, delayMs);
}

// --- Browser health tracking ---
const healthState = {
  consecutiveNavFailures: 0,
  lastSuccessfulNav: Date.now(),
  isRecovering: false,
  activeOps: 0,
};

function recordNavSuccess() {
  healthState.consecutiveNavFailures = 0;
  healthState.lastSuccessfulNav = Date.now();
}

function recordNavFailure() {
  healthState.consecutiveNavFailures++;
  return healthState.consecutiveNavFailures >= FAILURE_THRESHOLD;
}

async function restartBrowser(reason) {
  if (healthState.isRecovering) return;
  healthState.isRecovering = true;
  browserRestartsTotal.labels(reason).inc();
  log('error', 'restarting browser', { reason, failures: healthState.consecutiveNavFailures });
  pluginEvents.emit('browser:restart', { reason });
  try {
    await closeAllSessions(`browser_restart:${reason}`, { clearDownloads: true, clearLocks: true });
    for (const entry of browsers.values()) {
      clearBrowserIdleTimer(entry.key);
      clearBrowserWarmRetry(entry.key);
      if (entry.browser) {
        await entry.browser.close().catch(() => {});
      }
      entry.browser = null;
      entry.launchPromise = null;
    }
    pluginEvents.emit('browser:closed', { reason });
    healthState.consecutiveNavFailures = 0;
    healthState.lastSuccessfulNav = Date.now();
    log('info', 'browser restarted successfully');
  } catch (err) {
    log('error', 'browser restart failed', { error: err.message });
  } finally {
    healthState.isRecovering = false;
  }
}

function getTotalTabCount() {
  let total = 0;
  for (const session of sessions.values()) {
    for (const group of session.tabGroups.values()) total += group.size;
  }
  return total;
}

function getConnectedBrowserCount() {
  let total = 0;
  for (const entry of browsers.values()) {
    if (entry.browser?.isConnected?.()) total += 1;
  }
  return total;
}



function createPersistedLaunchProfile(userId) {
  const persona = buildBrowserPersona(userId);
  return {
    version: 1,
    persona,
    launchConstraints: {
      os: persona.os,
      locale: persona.locale,
      // Keep screen/window/WebGL in the persisted persona/context layer.
      // Passing them as exact Camoufox launch constraints can make
      // fingerprint generation fail for managed Leboncoin profiles.
      screen: null,
      window: null,
      webglConfig: null,
    },
    contextDefaults: {
      locale: persona.locale,
      timezoneId: persona.timezoneId,
      geolocation: persona.geolocation,
      viewport: persona.viewport,
      deviceScaleFactor: persona.deviceScaleFactor,
    },
    firefoxUserPrefs: persona.firefoxUserPrefs,
  };
}

function resolveProfileRoot(profileDir) {
  return profileDir || BROWSER_PROFILE_DIR;
}

async function resolveLaunchProfile(userId, { profileDir } = {}) {
  const profileRoot = resolveProfileRoot(profileDir);
  const vncBounds = VNC_HEALTH_INFO.resolution || '1920x1080';
  const persisted = await loadPersistedBrowserProfile(profileRoot, userId, { warn: (msg, fields) => log('warn', msg, fields) });
  if (persisted?.launchConstraints && persisted?.contextDefaults) {
    const bounded = enforceProfileWindowBounds(persisted, { userId, vncBounds });
    const persistedSize = persisted.contextDefaults?.viewport;
    const boundedSize = bounded.contextDefaults?.viewport;
    if (bounded !== persisted && (
      persistedSize?.width !== boundedSize?.width ||
      persistedSize?.height !== boundedSize?.height ||
      persisted.contextDefaults?.deviceScaleFactor !== bounded.contextDefaults?.deviceScaleFactor ||
      persisted.managedDisplayPolicy?.invariant !== bounded.managedDisplayPolicy?.invariant
    )) {
      await persistBrowserProfile({
        profileDir: profileRoot,
        userId,
        profile: bounded,
        logger: { warn: (msg, fields) => log('warn', msg, fields) },
      });
      log('info', 'managed profile display size enforced', { userId: String(userId), viewport: boundedSize, vncBounds });
    }
    return bounded;
  }
  const profile = enforceProfileWindowBounds(createPersistedLaunchProfile(userId), { userId, vncBounds });
  await persistBrowserProfile({
    profileDir: profileRoot,
    userId,
    profile,
    logger: { warn: (msg, fields) => log('warn', msg, fields) },
  });
  return profile;
}

async function probeGoogleSearch(candidateBrowser) {
  let context = null;
  try {
    context = await candidateBrowser.newContext({
      viewport: { width: 1280, height: 720 },
      permissions: ['geolocation'],
    });
    const page = await context.newPage();
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.goto('https://www.google.com/search?q=weather%20today', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const blocked = await isGoogleSearchBlocked(page);
    return {
      ok: !blocked && isGoogleSerp(page.url()),
      url: page.url(),
      blocked,
    };
  } finally {
    await context?.close().catch(() => {});
  }
}

function requireSharedDisplayForUser(userId, expectedDisplay) {
  const normalizedUserId = String(userId);
  if (!expectedDisplay) return;
  if (CONFIG.sharedDisplay !== expectedDisplay || !CONFIG.sharedDisplayUserIds.includes(normalizedUserId)) {
    const allowed = CONFIG.sharedDisplayUserIds.join(',') || 'none';
    throw Object.assign(
      new Error(`Managed visible launch for ${normalizedUserId} requires CAMOFOX_SHARED_DISPLAY=${expectedDisplay} and CAMOFOX_SHARED_DISPLAY_USER_IDS including ${normalizedUserId}; current display=${CONFIG.sharedDisplay || 'none'}, allowed=${allowed}.`),
      { statusCode: 409 }
    );
  }
}

function assertRawTabCreateAllowed(body = {}) {
  const policy = MANAGED_BROWSER_PROFILES_BY_USER_ID.get(String(body.userId || ''));
  if (!policy || policy.siteKey !== 'leboncoin') return;
  const allowed = body.managedBrowser === true &&
    body.siteKey === policy.siteKey &&
    body.sessionKey === policy.sessionKey &&
    body.profileDir === policy.profileDir &&
    body.browserPersonaKey === policy.browserPersonaKey &&
    body.humanPersonaKey === policy.humanPersonaKey;
  if (!allowed) {
    throw Object.assign(
      new Error(`Raw tab creation is disabled for managed Leboncoin profile ${policy.profile}; use managed_browser_* tools.`),
      { statusCode: 403 }
    );
  }
}

function attachBrowserCleanup(entry, candidateBrowser, localVirtualDisplay) {
  const origClose = candidateBrowser.close.bind(candidateBrowser);
  candidateBrowser.close = async (...args) => {
    const session = sessions.get(entry.key);
    if (session) {
      for (const [sessionKey, group] of session.tabGroups || []) {
        for (const [tabId, tabState] of group) {
          updateTabRecoveryMeta(tabState, { userId: entry.key, sessionKey, tabId, profileDir: session.profileDir });
          markTabRecoveryClosed(tabState, { reason: 'browser_closed', url: tabState.page?.url?.() || undefined, title: await tabState.page?.title?.().catch(() => '') || undefined });
        }
      }
    }
    await origClose(...args);
    entry.browser = null;
    entry.launchProxy = null;
    entry.display = null;
    removeVncDisplay(entry.key);
    if (localVirtualDisplay) {
      localVirtualDisplay.kill();
      if (entry.virtualDisplay === localVirtualDisplay) entry.virtualDisplay = null;
    }
    if (!sessions.has(entry.key) && !entry.launchPromise) browsers.delete(entry.key);
  };
}

async function launchBrowserInstance(userId, { profileDir } = {}) {
  const entry = getBrowserEntry(userId);
  const profileRoot = resolveProfileRoot(profileDir);
  const launchProfile = await resolveLaunchProfile(userId, { profileDir: profileRoot });
  const profilePolicy = profilePolicyFromLaunchProfile(userId, launchProfile);
  const previousProfilePolicy = await loadPersistedProfilePolicy(profileRoot, userId, { warn: (msg, fields) => log('warn', msg, fields) });
  const policyIssues = detectSensitivePolicyChange(previousProfilePolicy, profilePolicy);
  const persistedFingerprint = await loadPersistedFingerprint(profileRoot, userId, { warn: (msg, fields) => log('warn', msg, fields) });
  if (policyIssues.length && persistedFingerprint?.fingerprint) {
    const err = new Error(`Managed profile policy changed for ${userId}; clone/reset profile before rotating fingerprint-sensitive fields: ${policyIssues.join(', ')}`);
    err.code = 'managed_profile_policy_changed';
    err.statusCode = 409;
    err.issues = policyIssues;
    throw err;
  }
  await persistProfilePolicy({ profileDir: profileRoot, userId, policy: profilePolicy, logger: { warn: (msg, fields) => log('warn', msg, fields) } });
  if (persistedFingerprint?.fingerprint) {
    // Validate persisted fingerprint screen matches persona
    // (existing profiles may have stale fingerprints from the generateCanonicalFingerprint
    //  fallback bug that dropped the screen constraint)
    const persona = launchProfile.persona || {};
    const constraints = launchProfile.launchConstraints || {};
    const rawExpected = constraints.screen !== undefined && constraints.screen !== null && constraints.screen !== ''
      ? constraints.screen
      : (persona.screen !== undefined && persona.screen !== null && persona.screen !== '' ? persona.screen : undefined);
    const fpScreen = persistedFingerprint.fingerprint?.screen;
    if (rawExpected && fpScreen && Number.isFinite(fpScreen.width) && Number.isFinite(fpScreen.height)) {
      const expW = rawExpected.minWidth ?? rawExpected.width;
      const expH = rawExpected.minHeight ?? rawExpected.height;
      // Use proportional threshold: >20% mismatch in either dimension triggers regen.
      // This catches the pre-fix bug (default BrowserForge 1280×720 vs persona 1600×900 = 20% diff)
      // without false-looping on BrowserForge's closest-match (1707×960 vs 1600×900 = 6.7%).
      const mismatch = Number.isFinite(expW) && Number.isFinite(expH) && expW > 0 && expH > 0
        && (Math.abs(fpScreen.width - expW) / expW > 0.20
         || Math.abs(fpScreen.height - expH) / expH > 0.20);
      if (mismatch) {
        log('warn', 'persisted fingerprint screen mismatch — will regenerate', {
          expected: { width: expW, height: expH },
          actual: { width: fpScreen.width, height: fpScreen.height },
          profileRoot,
        });
        // Remove stale fingerprint files so it gets regenerated
        const { fingerprintPath, fingerprintMetaPath } = persistedFingerprint;
        await fs.promises.unlink(fingerprintPath).catch(() => {});
        await fs.promises.unlink(fingerprintMetaPath).catch(() => {});
        persistedFingerprint = undefined;
      }
    }
  }
  if (persistedFingerprint?.fingerprint) {
    launchProfile.persistedFingerprint = persistedFingerprint.fingerprint;
  } else {
    const fingerprint = generateCanonicalFingerprint(launchProfile);
    await persistFingerprint({
      profileDir: profileRoot,
      userId,
      fingerprint,
      metadata: {
        source: 'camoufox-js',
        persistedFrom: 'pre-launch-generateFingerprint',
        profilePolicyVersion: launchProfile.persona?.version || null,
      },
      logger: { warn: (msg, fields) => log('warn', msg, fields) },
    });
    launchProfile.persistedFingerprint = fingerprint;
  }
  const maxAttempts = proxyPool?.launchRetries ?? 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const launchProxy = proxyPool
      ? proxyPool.getLaunchProxy(proxyPool.canRotateSessions ? `${entry.key}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : undefined)
      : null;

    let localVirtualDisplay = null;
    let vdDisplay = undefined;
    let candidateBrowser = null;

    let displayMode = null;
    try {
      displayMode = resolveBrowserDisplayMode({
        platform: os.platform(),
        userId: entry.key,
        sharedDisplay: CONFIG.sharedDisplay,
        sharedDisplayUserIds: CONFIG.sharedDisplayUserIds,
        createVirtualDisplay: () => pluginCtx.createVirtualDisplay({ resolution: managedProfileDisplayResolution(launchProfile) }),
      });
      localVirtualDisplay = displayMode.virtualDisplay;
      vdDisplay = displayMode.display;
      if (displayMode.usesSharedDisplay) {
        log('info', 'using shared browser display', { display: vdDisplay, attempt });
      } else if (localVirtualDisplay) {
        log('info', 'xvfb virtual display started', { display: vdDisplay, attempt });
      }
    } catch (err) {
      log('warn', 'xvfb not available, falling back to headless', { error: err.message, attempt });
      localVirtualDisplay = null;
      displayMode = { display: undefined, virtualDisplay: null, usesSharedDisplay: false, headless: true };
    }

    const useVirtualDisplay = !!vdDisplay;
    log('info', 'launching camoufox', {
      userId: entry.key,
      personaOs: launchProfile.launchConstraints.os,
      personaLocale: launchProfile.launchConstraints.locale,
      personaScreen: launchProfile.persona?.screen || null,
      attempt,
      maxAttempts,
      geoip: !!launchProxy,
      proxyMode: proxyPool?.mode || null,
      proxyServer: launchProxy?.server || null,
      proxySession: launchProxy?.sessionId || null,
      proxyPoolSize: proxyPool?.size || 0,
      virtualDisplay: useVirtualDisplay,
    });

    try {
      const camoufoxInput = buildCamoufoxLaunchOptionsInput(launchProfile, {
        headless: displayMode?.headless ?? (useVirtualDisplay ? false : true),
        humanize: true,
        proxy: launchProxy,
        geoip: !!launchProxy,
        virtualDisplay: vdDisplay,
      });
      let options = await launchOptions({
        ...camoufoxInput,
        enable_cache: true,
      });
      options.proxy = normalizePlaywrightProxy(options.proxy);
      options = withManagedProfileLaunchArgs(options, launchProfile);
      await pluginEvents.emitAsync('browser:launching', { options });

      if (displayMode?.usesSharedDisplay) {
        options.env = {
          ...(options.env || {}),
          DISPLAY: vdDisplay,
          MOZ_ENABLE_WAYLAND: '0',
          XDG_SESSION_TYPE: 'x11',
        };
      }

      candidateBrowser = await firefox.launch(options);

      if (proxyPool?.canRotateSessions) {
        const probe = await probeGoogleSearch(candidateBrowser);
        if (!probe.ok) {
          log('warn', 'browser launch google probe failed', {
            attempt,
            maxAttempts,
            proxySession: launchProxy?.sessionId || null,
            url: probe.url,
          });
          if (attempt < maxAttempts) {
            await candidateBrowser.close().catch(() => {});
            if (localVirtualDisplay) localVirtualDisplay.kill();
            continue;
          }
          // Last attempt: accept browser in degraded mode rather than death-spiraling.
          // Non-Google sites will still work; Google requests will get blocked responses.
          log('error', 'all proxy sessions Google-blocked, accepting browser in degraded mode', {
            maxAttempts,
            proxySession: launchProxy?.sessionId || null,
          });
        }
      }

      entry.virtualDisplay = localVirtualDisplay;
      entry.display = vdDisplay || null;
      entry.launchProxy = launchProxy;
      entry.persona = launchProfile;
      entry.profileDir = profileRoot;
      entry.browser = candidateBrowser;
      if (vdDisplay) recordVncDisplay({
        userId: entry.key,
        display: vdDisplay,
        resolution: managedProfileDisplayResolution(launchProfile),
        profileWindowSize: launchProfile?.managedDisplayPolicy?.profileWindowSize || launchProfile?.persona?.screen || null,
      });
      attachBrowserCleanup(entry, entry.browser, localVirtualDisplay);
      pluginEvents.emit('browser:launched', { browser: entry.browser, display: vdDisplay, userId: entry.key, persona: launchProfile.persona });

      log('info', 'camoufox launched', {
        userId: entry.key,
        attempt,
        maxAttempts,
        virtualDisplay: useVirtualDisplay,
        proxyMode: proxyPool?.mode || null,
        proxyServer: launchProxy?.server || null,
        proxySession: launchProxy?.sessionId || null,
      });
      return { browser: entry.browser, launchProxy, persona: launchProfile, display: vdDisplay || null };
    } catch (err) {
      lastError = err;
      log('warn', 'camoufox launch attempt failed', {
        userId: entry.key,
        attempt,
        maxAttempts,
        error: err.message,
        proxySession: launchProxy?.sessionId || null,
      });
      await candidateBrowser?.close().catch(() => {});
      if (localVirtualDisplay) localVirtualDisplay.kill();
    }
  }

  throw lastError || new Error('Failed to launch a usable browser');
}

async function ensureBrowser(userId = 'default', { profileDir } = {}) {
  const entry = getBrowserEntry(userId);
  const profileRoot = resolveProfileRoot(profileDir);
  clearBrowserIdleTimer(entry.key);
  if (entry.browser && entry.profileDir && entry.profileDir !== profileRoot) {
    log('warn', 'browser profile root changed, relaunching browser', { userId: entry.key, previousProfileDir: entry.profileDir, profileDir: profileRoot });
    const existingSession = sessions.get(entry.key);
    if (existingSession) {
      await closeSession(entry.key, existingSession, { reason: 'profile_root_changed', clearDownloads: true, clearLocks: true });
    }
    await entry.browser.close().catch(() => {});
    entry.browser = null;
    entry.launchProxy = null;
    entry.display = null;
  }
  if (entry.browser && !entry.browser.isConnected()) {
    failuresTotal.labels('browser_disconnected', 'internal').inc();
    log('warn', 'browser disconnected, clearing dead sessions and relaunching', {
      userId: entry.key,
      deadSessions: sessions.has(entry.key) ? 1 : 0,
    });
    const deadSession = sessions.get(entry.key);
    if (deadSession) {
      await closeSession(entry.key, deadSession, { reason: 'browser_disconnected', clearDownloads: true, clearLocks: true });
    }
    if (entry.virtualDisplay) {
      entry.virtualDisplay.kill();
      entry.virtualDisplay = null;
    }
    entry.launchProxy = null;
    entry.browser = null;
  }
  if (entry.browser) return { browser: entry.browser, launchProxy: entry.launchProxy, persona: entry.persona, display: entry.display };
  if (entry.launchPromise) return entry.launchPromise;
  const launchTimeoutMs = proxyPool?.launchTimeoutMs ?? 60000;
  entry.launchPromise = Promise.race([
    launchBrowserInstance(entry.key, { profileDir: profileRoot }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Browser launch timeout (${Math.round(launchTimeoutMs / 1000)}s)`)), launchTimeoutMs)),
  ]).finally(() => { entry.launchPromise = null; });
  return entry.launchPromise;
}

// Helper to normalize userId to string (JSON body may parse as number)
function normalizeUserId(userId) {
  return String(userId);
}

const sessionCreations = new Map();

function clearSessionLocks(session) {
  if (!session?.tabGroups) return;
  for (const [, group] of session.tabGroups) {
    for (const tabId of group.keys()) {
      const lock = tabLocks.get(tabId);
      if (lock) {
        lock.drain();
        tabLocks.delete(tabId);
      }
    }
  }
  refreshTabLockQueueDepth();
}

async function closeSession(userId, session, {
  reason = 'session_closed',
  clearDownloads = true,
  clearLocks = true,
} = {}) {
  if (!session) return;

  const key = normalizeUserId(userId);

  if (clearDownloads) {
    await clearSessionDownloads(session).catch(() => {});
  }

  for (const [sessionKey, group] of session.tabGroups || []) {
    for (const [tabId, tabState] of group) {
      const url = tabState?.page?.url?.() || undefined;
      const title = await tabState?.page?.title?.().catch(() => '') || undefined;
      updateTabRecoveryMeta(tabState, { userId: key, sessionKey, tabId, profileDir: session.profileDir, persona: session.launchPersona?.persona, profile: session.launchPersona });
      markTabRecoveryClosed(tabState, { reason, url, title });
    }
  }

  await pluginEvents.emitAsync('session:destroying', {
    userId: key,
    reason,
    context: session.context,
    profileDir: session.profileDir,
  });
  await session.context.close().catch(() => {});
  sessions.delete(key);
  await pluginEvents.emitAsync('session:destroyed', { userId: key, reason });

  if (clearLocks) {
    clearSessionLocks(session);
  }

  refreshActiveTabsGauge();
}

async function closeAllSessions(reason, { clearDownloads = true, clearLocks = true } = {}) {
  const openSessions = Array.from(sessions.entries());
  for (const [userId, session] of openSessions) {
    await closeSession(userId, session, { reason, clearDownloads, clearLocks });
  }
}

async function getSession(userId, { profileDir } = {}) {
  const key = normalizeUserId(userId);
  const profileRoot = resolveProfileRoot(profileDir);
  let session = sessions.get(key);
  
  // Check if existing session's context is still alive
  if (session) {
    if (session._closing) {
      // Session is being torn down by reaper/expiry — treat as dead
      session = null;
    } else {
      try {
        // Lightweight probe: pages() is synchronous-ish and throws if context is dead
        session.context.pages();
      } catch (err) {
        log('warn', 'session context dead, recreating', { userId: key, error: err.message });
        await closeSession(key, session, { reason: 'dead_context', clearDownloads: true, clearLocks: true });
        session = null;
      }
    }
  }
  
  if (session && session.profileDir && session.profileDir !== profileRoot) {
    log('warn', 'session profile root changed, recreating context', { userId: key, previousProfileDir: session.profileDir, profileDir: profileRoot });
    await closeSession(key, session, { reason: 'profile_root_changed', clearDownloads: true, clearLocks: true });
    session = null;
  }

  if (!session) {
    session = await coalesceInflight(sessionCreations, `${key}:${profileRoot}`, async () => {
      if (sessions.size >= MAX_SESSIONS) {
        throw new Error('Maximum concurrent sessions reached');
      }
      const { browser: b, launchProxy: launchBrowserProxy, persona: launchPersona, display: browserDisplay } = await ensureBrowser(key, { profileDir: profileRoot });
      const contextOptions = {
        viewport: launchPersona?.contextDefaults?.viewport || { width: 1280, height: 720 },
        permissions: ['geolocation'],
      };
      if (launchPersona?.contextDefaults?.locale) {
        contextOptions.locale = launchPersona.contextDefaults.locale;
      }
      if (launchPersona?.contextDefaults?.timezoneId) {
        contextOptions.timezoneId = launchPersona.contextDefaults.timezoneId;
      }
      if (launchPersona?.contextDefaults?.geolocation) {
        contextOptions.geolocation = launchPersona.contextDefaults.geolocation;
      }
      if (launchPersona?.contextDefaults?.deviceScaleFactor) {
        contextOptions.deviceScaleFactor = launchPersona.contextDefaults.deviceScaleFactor;
      }
      let sessionProxy = null;
      if (proxyPool?.canRotateSessions) {
        sessionProxy = proxyPool.getNext(`ctx-${key}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
        contextOptions.proxy = normalizePlaywrightProxy(sessionProxy);
        log('info', 'session proxy assigned', { userId: key, sessionId: sessionProxy.sessionId });
      } else if (proxyPool) {
        sessionProxy = proxyPool.getNext();
        contextOptions.proxy = normalizePlaywrightProxy(sessionProxy);
        log('info', 'session proxy assigned', { userId: key, proxy: sessionProxy.server });
      }
      await pluginEvents.emitAsync('session:creating', { userId: key, contextOptions, profileDir: profileRoot });
      const context = await b.newContext(contextOptions);
      if (!disabledNotificationCaptureOrigins.has(`${key}:*`)) {
        await installNotificationCapture(context, {
          profile: key,
          site: 'managed',
          origin: '',
          onNotification: (notification) => {
            try {
              recordNotification({
                storagePath: path.join(profileRoot, key, 'notifications.jsonl'),
                recorded_at: new Date().toISOString(),
                ...notification,
              });
            } catch (err) {
              log('warn', 'notification capture record failed', { userId: key, error: err.message });
            }
          },
        }).catch((err) => log('warn', 'notification capture install failed', { userId: key, error: err.message }));
      }
      
      const created = {
        context,
        tabGroups: new Map(),
        profileDir: profileRoot,
        launchPersona,
        display: browserDisplay || null,
        lastAccess: Date.now(),
        proxySessionId: sessionProxy?.sessionId || null,
        browserProxySessionId: launchBrowserProxy?.sessionId || null,
      };
      sessions.set(key, created);
      await pluginEvents.emitAsync('session:created', { userId: key, context, profileDir: profileRoot });
      log('info', 'session created', {
        userId: key,
        proxyMode: proxyPool?.mode || null,
        proxyServer: sessionProxy?.server || launchBrowserProxy?.server || null,
        proxySession: sessionProxy?.sessionId || launchBrowserProxy?.sessionId || null,
      });
      return created;
    });
  }
  session.lastAccess = Date.now();
  return session;
}

async function ensureKeepaliveTab() {
  const selectedUserId = readSelectedVncUserId(VNC_HEALTH_INFO.displaySelection);
  if (!shouldStartKeepalive({ keepaliveUserId: KEEPALIVE_USER_ID, selectedUserId })) {
    log('info', 'keepalive skipped for selected managed VNC profile', { userId: KEEPALIVE_USER_ID, selectedUserId });
    return null;
  }
  const userId = normalizeUserId(KEEPALIVE_USER_ID);
  const session = await getSession(userId);
  const group = getTabGroup(session, KEEPALIVE_SESSION_KEY);
  for (const [tabId, tabState] of group) {
    if (tabState?.page && !tabState.page.isClosed()) {
      tabState.keepAlive = true;
      tabState._lastReaperCheck = Date.now();
      tabState._lastReaperToolCalls = tabState.toolCalls;
      return { tabId, url: tabState.page.url() };
    }
    group.delete(tabId);
    const lock = tabLocks.get(tabId);
    if (lock) lock.drain();
    tabLocks.delete(tabId);
  }

  const page = await session.context.newPage();
  const tabId = fly.makeTabId();
  const tabState = createTabState(page, { keepAlive: true, userId, sessionKey: KEEPALIVE_SESSION_KEY, tabId });
  attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
  group.set(tabId, tabState);
  refreshActiveTabsGauge();

  if (KEEPALIVE_URL) {
    const urlErr = validateUrl(KEEPALIVE_URL);
    if (urlErr) throw new Error(urlErr);
    tabState.lastRequestedUrl = KEEPALIVE_URL;
    await withPageLoadDuration('keepalive_open_url', () => page.goto(KEEPALIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })).catch((err) => {
      log('warn', 'keepalive tab initial navigation failed', { userId, tabId, url: KEEPALIVE_URL, error: err.message });
    });
    tabState.visitedUrls.add(KEEPALIVE_URL);
  }

  pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url(), keepAlive: true });
  log('info', 'keepalive tab ready', { userId, sessionKey: KEEPALIVE_SESSION_KEY, tabId, url: page.url() });
  return { tabId, url: page.url() };
}

function getTabGroup(session, listItemId) {
  let group = session.tabGroups.get(listItemId);
  if (!group) {
    group = new Map();
    session.tabGroups.set(listItemId, group);
  }
  return group;
}

function isDeadContextError(err) {
  const msg = err && err.message || '';
  return msg.includes('Target page, context or browser has been closed') ||
         msg.includes('browser has been closed') ||
         msg.includes('Context closed') ||
         msg.includes('Browser closed');
}

function isTimeoutError(err) {
  const msg = err && err.message || '';
  return msg.includes('timed out after') ||
         (msg.includes('Timeout') && msg.includes('exceeded'));
}

function isTabLockQueueTimeout(err) {
  return err && err.message === 'Tab lock queue timeout';
}

function isTabDestroyedError(err) {
  return err && err.message === 'Tab destroyed';
}

// Centralized error handler for route catch blocks.
// Auto-destroys dead browser sessions and returns appropriate status codes.
function isProxyError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('NS_ERROR_PROXY') || msg.includes('proxy connection') || msg.includes('Proxy connection');
}

function handleRouteError(err, req, res, extraFields = {}) {
  const failureType = classifyError(err);
  const action = actionFromReq(req);
  failuresTotal.labels(failureType, action).inc();

  const userId = req.body?.userId || req.query?.userId;
  const tabId = req.body?.tabId || req.query?.tabId || req.params?.tabId;
  if (tabId) {
    pluginEvents.emit('tab:error', { userId, tabId, error: err });
  }
  if (userId && isDeadContextError(err)) {
    destroySession(userId);
  }
  // Proxy errors mean the session is dead — rotate at context level.
  // Destroy the user's session so the next request gets a fresh context with a new proxy.
  if (isProxyError(err) && proxyPool?.canRotateSessions && userId) {
    log('warn', 'proxy error detected, destroying user session for fresh proxy on next request', {
      action, userId, error: err.message,
    });
    browserRestartsTotal.labels('proxy_error').inc();
    destroySession(userId);
  }
  // Track consecutive timeouts per tab and auto-destroy stuck tabs
  if (userId && isTimeoutError(err)) {
    const tabId = req.body?.tabId || req.query?.tabId || req.params?.tabId;
    const session = sessions.get(normalizeUserId(userId));
    if (session && tabId) {
      const found = findTab(session, tabId);
      if (found) {
        found.tabState.consecutiveTimeouts++;
        if (found.tabState.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
          log('warn', 'auto-destroying tab after consecutive timeouts', { tabId, count: found.tabState.consecutiveTimeouts });
          destroyTab(session, tabId, 'consecutive_timeouts', userId);
        }
      }
    }
  }
  // Lock queue timeout = tab is stuck. Destroy immediately.
  if (userId && isTabLockQueueTimeout(err)) {
    const tabId = req.body?.tabId || req.query?.tabId || req.params?.tabId;
    const session = sessions.get(normalizeUserId(userId));
    if (session && tabId) {
      destroyTab(session, tabId, 'lock_queue', userId);
    }
    return res.status(503).json({ error: 'Tab unresponsive and has been destroyed. Open a new tab.', ...extraFields });
  }
  // Tab was destroyed while this request was queued in the lock
  if (isTabDestroyedError(err)) {
    return res.status(410).json({ error: 'Tab was destroyed. Open a new tab.', ...extraFields });
  }
  sendError(res, err, extraFields);
}

function destroyTab(session, tabId, reason, userId) {
  const lock = tabLocks.get(tabId);
  if (lock) {
    lock.drain();
    tabLocks.delete(tabId);
    refreshTabLockQueueDepth();
  }
  for (const [listItemId, group] of session.tabGroups) {
    if (group.has(tabId)) {
      const tabState = group.get(tabId);
      log('warn', 'destroying stuck tab', { tabId, listItemId, toolCalls: tabState.toolCalls, reason: reason || 'unknown' });
      markTabRecoveryClosed(tabState, { reason, url: tabState.page?.url?.() || undefined });
      safePageClose(tabState.page);
      group.delete(tabId);
      if (group.size === 0) session.tabGroups.delete(listItemId);
      refreshActiveTabsGauge();
      if (reason) tabsDestroyedTotal.labels(reason).inc();
      pluginEvents.emit('tab:destroyed', { userId: userId || null, tabId, reason: reason || 'unknown' });
      return true;
    }
  }
  return false;
}

/**
 * Recycle the oldest (least-used) tab in a session to free a slot.
 * Closes the old tab's page and removes it from its group.
 * Returns { recycledTabId, recycledFromGroup } or null if no tab to recycle.
 */
async function recycleOldestTab(session, reqId, userId) {
  let oldestTab = null;
  let oldestGroup = null;
  let oldestGroupKey = null;
  let oldestTabId = null;
  for (const [gKey, group] of session.tabGroups) {
    for (const [tid, ts] of group) {
      if (!oldestTab || ts.toolCalls < oldestTab.toolCalls) {
        oldestTab = ts;
        oldestGroup = group;
        oldestGroupKey = gKey;
        oldestTabId = tid;
      }
    }
  }
  if (!oldestTab) return null;

  markTabRecoveryClosed(oldestTab, { reason: 'recycled', url: oldestTab.page?.url?.() || undefined, title: await oldestTab.page?.title?.().catch(() => '') || undefined });
  await safePageClose(oldestTab.page);
  oldestGroup.delete(oldestTabId);
  if (oldestGroup.size === 0) session.tabGroups.delete(oldestGroupKey);
  const lock = tabLocks.get(oldestTabId);
  if (lock) { lock.drain(); tabLocks.delete(oldestTabId); }
  refreshTabLockQueueDepth();
  tabsRecycledTotal.inc();
  pluginEvents.emit('tab:recycled', { userId: userId || null, tabId: oldestTabId });
  log('info', 'tab recycled (limit reached)', { reqId, recycledTabId: oldestTabId, recycledFromGroup: oldestGroupKey });
  return { recycledTabId: oldestTabId, recycledFromGroup: oldestGroupKey };
}

function destroySession(userId) {
  const key = normalizeUserId(userId);
  const session = sessions.get(key);
  if (!session) return;
  log('warn', 'destroying dead session', { userId: key });
  sessions.delete(key);
  closeSession(key, session, { reason: 'destroy_session', clearDownloads: true, clearLocks: true }).catch(() => {});
}

function findTab(session, tabId) {
  for (const [listItemId, group] of session.tabGroups) {
    if (group.has(tabId)) {
      const tabState = group.get(tabId);
      return { tabState, listItemId, group };
    }
  }
  return null;
}

function createTabState(page, options = {}) {
  const behaviorPersona = options.behaviorPersona || buildHumanBehaviorPersona(
    options.humanProfileKey || [options.userId, options.sessionKey, options.tabId].filter(Boolean).join(':') || 'default',
    { profile: options.humanProfile || 'fast' },
  );

  const tabState = {
    page,
    refs: new Map(),
    visitedUrls: new Set(),
    downloads: [],
    toolCalls: 0,
    consecutiveTimeouts: 0,
    lastSnapshot: null,
    lastSnapshotUrl: null,
    lastSnapshotFull: null,
    lastRequestedUrl: null,
    googleRetryCount: 0,
    navigateAbort: null,
    keepAlive: Boolean(options.keepAlive),
    humanSession: createHumanSessionState({
      viewport: options.viewport || options.persona?.viewport || { width: 1280, height: 720 },
      seed: options.humanSeed || Date.now(),
      behaviorPersona,
    }),
    agentHistorySteps: [],
    recoveryMeta: {
      userId: options.userId,
      sessionKey: options.sessionKey,
      tabId: options.tabId,
      profileDir: options.profileDir,
      siteKey: options.siteKey,
      task_id: options.task_id || options.taskId,
      browserPersonaKey: options.browserPersonaKey,
      humanPersonaKey: options.humanPersonaKey,
      humanProfile: options.humanProfile,
      persona: options.persona,
      profile: options.profile,
    },
    consoleMessages: [],
    jsErrors: [],
    diagnosticsTotals: { console_messages: 0, js_errors: 0 },
    _diagnosticsPage: null,
  };
  attachPageDiagnostics(tabState, page);
  return tabState;
}

async function fitVisibleWindowToVncDisplay(page, session, reqId) {
  const viewport = session.launchPersona?.contextDefaults?.viewport || session.launchPersona?.persona?.viewport;
  if (!viewport?.width || !viewport?.height) return null;
  const width = Number.parseInt(String(viewport.width), 10);
  const height = Number.parseInt(String(viewport.height), 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  try {
    const measuredBefore = await page.evaluate(() => {
      try {
        return { innerWidth, innerHeight, outerWidth, outerHeight, screenW: screen.width, screenH: screen.height };
      } catch {
        return null;
      }
    });

    let x11WindowId = null;
    if (session.display && process.platform === 'linux') {
      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const { stdout } = await execFileAsync('xdotool', ['search', '--name', 'Camoufox'], {
            env: { ...process.env, DISPLAY: session.display },
            timeout: 3000,
            maxBuffer: 4096,
          });
          x11WindowId = stdout.trim().split(/\s+/).filter(Boolean).pop() || null;
          if (x11WindowId) {
            const before = await execFileAsync('xdotool', ['getwindowgeometry', x11WindowId], {
              env: { ...process.env, DISPLAY: session.display },
              timeout: 3000,
              maxBuffer: 4096,
            }).catch((err) => ({ stdout: `geometry-error:${err.message}` }));
            log('info', 'managed visible x11 window found', { reqId, display: session.display, x11WindowId, geometry: before.stdout.trim() });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (x11WindowId) {
          await execFileAsync('xdotool', ['windowmove', x11WindowId, '0', '0'], {
            env: { ...process.env, DISPLAY: session.display },
            timeout: 3000,
          });
          await execFileAsync('xdotool', ['windowsize', x11WindowId, String(width), String(height)], {
            env: { ...process.env, DISPLAY: session.display },
            timeout: 3000,
          });
        }
      } catch (err) {
        log('warn', 'managed visible x11 resize failed', { reqId, display: session.display, error: err.message });
      }
    }

    if (!x11WindowId) {
      await page.setViewportSize({ width, height });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const measured = await page.evaluate(() => {
      try {
        return { innerWidth, innerHeight, outerWidth, outerHeight, screenW: screen.width, screenH: screen.height };
      } catch {
        return null;
      }
    });
    return { width, height, measured, measuredBefore, x11WindowId, display: session.display || null };
  } catch (err) {
    log('warn', 'managed visible page resize failed', { reqId, error: err.message, viewport: { width, height } });
    return null;
  }
}

async function createServerOwnedTab(session, {
  userId,
  sessionKey,
  url,
  browserPersonaKey,
  humanPersonaKey,
  humanProfile,
  profileDir,
  siteKey,
  task_id,
  taskId,
  reqId,
  eventMetadata = {},
}) {
  const group = getTabGroup(session, sessionKey);
  const page = await session.context.newPage();
  const visibleViewport = eventMetadata.visible ? await fitVisibleWindowToVncDisplay(page, session, reqId) : null;
  const tabId = fly.makeTabId();
  const tabState = createTabState(page, {
    userId,
    sessionKey,
    tabId,
    profileDir: profileDir || session.profileDir,
    siteKey,
    task_id,
    taskId,
    browserPersonaKey,
    humanPersonaKey,
    humanProfileKey: humanPersonaKey,
    humanProfile,
    persona: session.launchPersona?.persona,
    profile: session.launchPersona,
    viewport: visibleViewport || session.launchPersona?.contextDefaults?.viewport,
  });
  attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
  group.set(tabId, tabState);
  refreshActiveTabsGauge();

  if (url) {
    const urlErr = validateUrl(url);
    if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
    tabState.lastRequestedUrl = url;
    await withPageLoadDuration('open_url', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    tabState.visitedUrls.add(url);
  }

  const result = {
    tabId,
    targetId: tabId,
    url: page.url(),
    title: await page.title().catch(() => ''),
    visibleViewport,
  };
  if (url) {
    recordTabAction(tabState, { kind: 'navigate', url: result.url || url, result: { ok: true, ...result } });
  }
  pluginEvents.emit('tab:created', { userId, tabId, page, url: page.url(), ...eventMetadata });
  log('info', 'tab created', { reqId, tabId, userId, sessionKey, url: page.url(), ...eventMetadata });
  return { result, tabState };
}

function invalidateTabSnapshot(tabState) {
  if (!tabState) return;
  tabState.lastSnapshot = null;
  tabState.lastSnapshotUrl = null;
  tabState.lastSnapshotFull = null;
}

function targetContextFromRef(tabState, ref) {
  if (!ref || !(tabState?.refs instanceof Map)) return undefined;
  const node = tabState.refs.get(ref);
  if (!node) return undefined;
  return buildTargetContext({ ref, ...node });
}

function recoverySiteKeyFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function updateTabRecoveryMeta(tabState, meta = {}) {
  if (!tabState) return;
  tabState.recoveryMeta = {
    ...(tabState.recoveryMeta || {}),
    ...Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && value !== null && value !== '')),
  };
}

function buildTabRecoveryMeta(tabState, action = {}) {
  const base = { ...(tabState?.recoveryMeta || {}) };
  const resultUrl = action?.result?.url || action?.url || tabState?.page?.url?.();
  if (!base.siteKey) base.siteKey = recoverySiteKeyFromUrl(resultUrl);
  if (!base.profileDir) base.profileDir = BROWSER_PROFILE_DIR;
  return base;
}

function recordTabAction(tabState, action) {
  const enrichedAction = { ...action };
  if (!enrichedAction.target_summary && enrichedAction.ref) {
    enrichedAction.target_summary = targetContextFromRef(tabState, enrichedAction.ref);
  }
  const recoveryMeta = buildTabRecoveryMeta(tabState, enrichedAction);
  recordRecoveryAction(managedRecoveryRegistry, recoveryMeta, enrichedAction);
  updateTabRecoveryMeta(tabState, recoveryMeta);
  recordSuccessfulBrowserAction(tabState, enrichedAction).catch((err) => {
    log('warn', 'agent history record failed', { error: err.message, kind: enrichedAction?.kind });
  });
}

function markTabRecoveryClosed(tabState, { reason = 'closed', url, title } = {}) {
  if (!tabState) return null;
  const recoveryMeta = buildTabRecoveryMeta(tabState, { result: { url, title } });
  return markRecoveryClosed(managedRecoveryRegistry, recoveryMeta, { reason, url, title });
}

async function adoptPopupIntoTab(tabState, popupPage, {
  previousPage = null,
  waitForLoadStateTimeoutMs = 3000,
} = {}) {
  if (!tabState || !popupPage || popupPage.isClosed()) return null;
  try {
    await popupPage.waitForLoadState('domcontentloaded', { timeout: waitForLoadStateTimeoutMs }).catch(() => {});
  } catch {}
  await popupPage.waitForTimeout(200).catch(() => {});

  tabState.page = popupPage;
  attachPageDiagnostics(tabState, popupPage);
  invalidateTabSnapshot(tabState);
  tabState.refs = new Map();
  const popupUrl = popupPage.url();
  if (popupUrl) tabState.visitedUrls.add(popupUrl);

  if (previousPage && previousPage !== popupPage && !previousPage.isClosed()) {
    await safePageClose(previousPage);
  }

  return {
    adopted: true,
    url: popupUrl,
    title: await popupPage.title().catch(() => ''),
  };
}

async function isGoogleUnavailable(page) {
  if (!page || page.isClosed()) return false;
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '').catch(() => '');
  return /Unable to connect|502 Bad Gateway or Proxy Error|Camoufox can’t establish a connection/.test(bodyText);
}

async function rotateGoogleTab(userId, sessionKey, tabId, previousTabState, reason, reqId) {
  if (!previousTabState?.lastRequestedUrl || !isGoogleSearchUrl(previousTabState.lastRequestedUrl)) return null;
  if ((previousTabState.googleRetryCount || 0) >= 3) return null;

  browserRestartsTotal.labels(reason).inc(); // track rotation events (not a full restart)

  // Rotate at context level — create a fresh context with a new proxy session
  // instead of restarting the entire browser (which kills ALL sessions/tabs).
  const key = normalizeUserId(userId);
  const oldSession = sessions.get(key);
  if (oldSession) {
    await closeSession(key, oldSession, { reason: 'google_rotate_context', clearDownloads: true, clearLocks: true });
  }
  const session = await getSession(userId);
  const group = getTabGroup(session, sessionKey);
  const page = await session.context.newPage();
  const tabState = createTabState(page, { userId, sessionKey, tabId });
  tabState.googleRetryCount = (previousTabState.googleRetryCount || 0) + 1;
  tabState.lastRequestedUrl = previousTabState.lastRequestedUrl;
  attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
  group.set(tabId, tabState);
  refreshActiveTabsGauge();

  log('warn', 'replaying google search on fresh context (per-context proxy rotation)', {
    reqId,
    tabId,
    retryCount: tabState.googleRetryCount,
    url: tabState.lastRequestedUrl,
    proxySession: session.proxySessionId || null,
  });

  await withPageLoadDuration('navigate', () => page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }));
  tabState.visitedUrls.add('https://www.google.com/');
  await page.waitForTimeout(1200);
  await withPageLoadDuration('navigate', () => page.goto(tabState.lastRequestedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
  tabState.visitedUrls.add(tabState.lastRequestedUrl);
  return { session, tabState };
}

function refreshActiveTabsGauge() {
  activeTabsGauge.set(getTotalTabCount());
}

function refreshTabLockQueueDepth() {
  let queued = 0;
  for (const lock of tabLocks.values()) {
    if (lock?.queue) queued += lock.queue.length;
  }
  tabLockQueueDepth.set(queued);
}

async function withPageLoadDuration(action, fn) {
  const end = pageLoadDuration.startTimer();
  try {
    return await fn();
  } finally {
    end();
  }
}



async function waitForPageReady(page, options = {}) {
  const {
    timeout = 10000,
    waitForNetwork = true,
    waitForHydration = true,
    settleMs = 200,
    hydrationPollMs = 250,
    hydrationTimeoutMs = Math.min(timeout, 10000),
  } = options;
  
  try {
    await page.waitForLoadState('domcontentloaded', { timeout });
    
    if (waitForNetwork) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        log('warn', 'networkidle timeout, continuing');
      });
    }
    
    if (waitForHydration) {
      const maxIterations = Math.max(1, Math.floor(hydrationTimeoutMs / hydrationPollMs));
      await page.evaluate(async ({ maxIterations, hydrationPollMs }) => {
        for (let i = 0; i < maxIterations; i++) {
          const entries = performance.getEntriesByType('resource');
          const recentEntries = entries.slice(-5);
          const netQuiet = recentEntries.every(e => (performance.now() - e.responseEnd) > 400);
          
          if (document.readyState === 'complete' && netQuiet) {
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            break;
          }
          await new Promise(r => setTimeout(r, hydrationPollMs));
        }
      }, { maxIterations, hydrationPollMs }).catch(() => {
        log('warn', 'hydration wait failed, continuing');
      });
    }
    
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }
    
    // Auto-dismiss common consent/privacy dialogs
    await dismissConsentDialogs(page);
    
    return true;
  } catch (err) {
    log('warn', 'page ready failed', { error: err.message });
    return false;
  }
}

async function dismissConsentDialogs(page) {
  // Common consent/privacy dialog selectors (matches Swift WebView.swift patterns)
  const dismissSelectors = [
    // OneTrust (very common)
    '#onetrust-banner-sdk button#onetrust-accept-btn-handler',
    '#onetrust-banner-sdk button#onetrust-reject-all-handler',
    '#onetrust-close-btn-container button',
    // Leboncoin / French GDPR dialogs: prefer the non-accepting choice when available.
    'dialog button:has-text("Continuer sans accepter")',
    'dialog button:has-text("Refuser")',
    'dialog button:has-text("Tout refuser")',
    'button:has-text("Continuer sans accepter")',
    'button:has-text("Refuser")',
    'button:has-text("Tout refuser")',
    // Generic patterns
    'button[data-test="cookie-accept-all"]',
    'button[aria-label="Accept all"]',
    'button[aria-label="Accept All"]',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    // Dialog close buttons
    'dialog button:has-text("Close")',
    'dialog button:has-text("Accept")',
    'dialog button:has-text("I Accept")',
    'dialog button:has-text("Got it")',
    'dialog button:has-text("OK")',
    // GDPR/CCPA specific
    '[class*="consent"] button[class*="accept"]',
    '[class*="consent"] button[class*="close"]',
    '[class*="privacy"] button[class*="close"]',
    '[class*="cookie"] button[class*="accept"]',
    '[class*="cookie"] button[class*="close"]',
    // Overlay close buttons
    '[class*="modal"] button[class*="close"]',
    '[class*="overlay"] button[class*="close"]',
  ];
  
  for (const selector of dismissSelectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 100 })) {
        await button.click({ timeout: 1000 }).catch(() => {});
        log('info', 'dismissed consent dialog', { selector });
        await page.waitForTimeout(300); // Brief pause after dismiss
        break; // Only dismiss one dialog per page load
      }
    } catch (e) {
      // Selector not found or not clickable, continue
    }
  }
}

// --- Google SERP detection ---
function isGoogleSerp(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('google.') && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

function isGoogleSearchUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('google.') && parsed.pathname === '/search';
  } catch {
    return false;
  }
}

async function isGoogleSearchBlocked(page) {
  if (!page || page.isClosed()) return false;

  const url = page.url();
  if (url.includes('google.com/sorry/')) return true;

  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) || '').catch(() => '');
  return /Our systems have detected unusual traffic|About this page|If you're having trouble accessing Google Search|SG_REL/.test(bodyText);
}

// --- Google SERP: combined extraction (refs + snapshot in one DOM pass) ---
// Returns { refs: Map, snapshot: string }
async function extractGoogleSerp(page) {
  const refs = new Map();
  if (!page || page.isClosed()) return { refs, snapshot: '' };
  
  const start = Date.now();
  
  const alreadyRendered = await page.evaluate(() => !!document.querySelector('#rso h3, #search h3, #rso [data-snhf]')).catch(() => false);
  if (!alreadyRendered) {
    try {
      await page.waitForSelector('#rso h3, #search h3, #rso [data-snhf]', { timeout: 5000 });
    } catch {
      try {
        await page.waitForSelector('#rso a[href]:not([href^="/search"]), #search a[href]:not([href^="/search"])', { timeout: 2000 });
      } catch {}
    }
  }
  
  const extracted = await page.evaluate(() => {
    const snapshot = [];
    const elements = [];
    let refCounter = 1;
    
    function addRef(role, name, extra = {}) {
      const id = 'e' + refCounter++;
      elements.push({ id, role, name, ...extra });
      return id;
    }
    
    snapshot.push('- heading "' + document.title.replace(/\"/g, '\\\"') + '"');
    
    const searchInput = document.querySelector('textarea[name="q"], input[name="q"]:not([type="hidden"])');
    if (searchInput) {
      const name = 'Search';
      const selector = searchInput.tagName === 'TEXTAREA' ? 'textarea[name="q"]' : 'input[name="q"]:not([type="hidden"])';
      const refId = addRef('searchbox', name, { selector });
      snapshot.push('- searchbox "' + name + '" [' + refId + ']: ' + (searchInput.value || ''));
    }

    const navContainer = document.querySelector('div[role="navigation"], div[role="list"]');
    if (navContainer) {
      const navLinks = navContainer.querySelectorAll('a');
      if (navLinks.length > 0) {
        snapshot.push('- navigation:');
        navLinks.forEach(a => {
          const text = (a.textContent || '').trim();
          if (!text || text.length < 1) return;
          if (/^\d+$/.test(text) && parseInt(text) < 50) return;
          const refId = addRef('link', text);
          snapshot.push('  - link "' + text + '" [' + refId + ']');
        });
      }
    }
    
    const resultContainer = document.querySelector('#rso') || document.querySelector('#search');
    if (resultContainer) {
      const resultBlocks = resultContainer.querySelectorAll(':scope > div');
      for (const block of resultBlocks) {
        const h3 = block.querySelector('h3');
        const mainLink = h3 ? h3.closest('a') : null;
        
        if (h3 && mainLink) {
          const title = h3.textContent.trim().replace(/"/g, '\\"');
          const href = mainLink.href;
          const cite = block.querySelector('cite');
          const displayUrl = cite ? cite.textContent.trim() : '';
          
          let snippet = '';
          for (const sel of ['[data-sncf]', '[data-content-feature="1"]', '.VwiC3b', 'div[style*="-webkit-line-clamp"]', 'span.aCOpRe']) {
            const el = block.querySelector(sel);
            if (el) { snippet = el.textContent.trim().slice(0, 300); break; }
          }
          if (!snippet) {
            const allText = block.textContent.trim().replace(/\s+/g, ' ');
            const titleLen = title.length + (displayUrl ? displayUrl.length : 0);
            if (allText.length > titleLen + 20) {
              snippet = allText.slice(titleLen).trim().slice(0, 300);
            }
          }
          
          const refId = addRef('link', title);
          snapshot.push('- link "' + title + '" [' + refId + ']:');
          snapshot.push('  - /url: ' + href);
          if (displayUrl) snapshot.push('  - cite: ' + displayUrl);
          if (snippet) snapshot.push('  - text: ' + snippet);
        } else {
          const blockLinks = block.querySelectorAll('a[href^="http"]:not([href*="google.com/search"])');
          if (blockLinks.length > 0) {
            const blockText = block.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
            if (blockText.length > 10) {
              snapshot.push('- group:');
              snapshot.push('  - text: ' + blockText);
              blockLinks.forEach(a => {
                const linkText = (a.textContent || '').trim().replace(/"/g, '\\"').slice(0, 100);
                if (linkText.length > 2) {
                  const refId = addRef('link', linkText);
                  snapshot.push('  - link "' + linkText + '" [' + refId + ']:');
                  snapshot.push('    - /url: ' + a.href);
                }
              });
            }
          }
        }
      }
    }
    
    const paaItems = document.querySelectorAll('[jsname="Cpkphb"], div.related-question-pair');
    if (paaItems.length > 0) {
      snapshot.push('- heading "People also ask"');
      paaItems.forEach(q => {
        const text = (q.textContent || '').trim().replace(/"/g, '\\"').slice(0, 150);
        if (text) {
          const refId = addRef('button', text);
          snapshot.push('  - button "' + text + '" [' + refId + ']');
        }
      });
    }
    
    const nextLink = document.querySelector('#botstuff a[aria-label="Next page"], td.d6cvqb a, a#pnnext');
    if (nextLink) {
      const refId = addRef('link', 'Next');
      snapshot.push('- navigation "pagination":');
      snapshot.push('  - link "Next" [' + refId + ']');
    }
    
    return { snapshot: snapshot.join('\n'), elements };
  });
  
  const seenCounts = new Map();
  for (const el of extracted.elements) {
    const key = `${el.role}:${el.name}`;
    const nth = seenCounts.get(key) || 0;
    seenCounts.set(key, nth + 1);
    refs.set(el.id, { role: el.role, name: el.name, nth, selector: el.selector || null });
  }
  
  log('info', 'extractGoogleSerp', { elapsed: Date.now() - start, refs: refs.size });
  return { refs, snapshot: extracted.snapshot };
}

const REFRESH_READY_TIMEOUT_MS = 2500;

async function extractLiveDomMetadata(page) {
  if (!page || page.isClosed()) return new Map();
  const entries = await page.evaluate(({ interactiveRoles, skipPatterns }) => {
    const safeAttributeNames = new Set([
      'id',
      'class',
      'name',
      'type',
      'placeholder',
      'aria-label',
      'title',
      'href',
      'data-testid',
      'data-test',
      'data-cy',
    ]);
    const sensitivePattern = /\b(password|passcode|secret|token|api[-_ ]?key|authorization|auth|credential|credit card|card number|cvv|ssn)\b/i;
    const skipRegexes = skipPatterns.map((source) => new RegExp(source, 'i'));
    const normalizeTextForKey = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalizeTag = (value) => String(value || '').trim().toLowerCase().match(/[a-z][a-z0-9-]*/)?.[0] || '';
    const safeText = (value) => {
      const text = normalizeTextForKey(value);
      if (!text || sensitivePattern.test(text)) return '';
      return text.slice(0, 160);
    };
    const attrsFor = (element) => {
      const attrs = {};
      for (const attr of Array.from(element?.attributes || [])) {
        const name = String(attr.name || '').toLowerCase();
        if (!safeAttributeNames.has(name)) continue;
        const value = String(attr.value || '');
        if (sensitivePattern.test(value)) continue;
        attrs[name] = value.slice(0, 160);
      }
      return attrs;
    };
    const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === 'object') return Object.keys(value).length > 0;
      return value !== undefined && value !== null && value !== '';
    }));
    const roleFor = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit.toLowerCase();
      const tag = normalizeTag(element.tagName);
      const type = String(element.getAttribute('type') || '').toLowerCase();
      if (tag === 'button' || (tag === 'input' && ['button', 'submit', 'reset'].includes(type))) return 'button';
      if (tag === 'a' && element.getAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        if (['checkbox', 'radio'].includes(type)) return type;
        if (type === 'search') return 'searchbox';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type !== 'hidden') return 'textbox';
      }
      return '';
    };
    const nameFor = (element) => normalizeTextForKey(
      element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || element.innerText
      || element.textContent
      || element.getAttribute('name')
      || ''
    );
    const related = (element, includeText = true) => element ? compact({
      tag: normalizeTag(element.tagName),
      text: includeText ? safeText(element.innerText || element.textContent) : undefined,
      attributes: attrsFor(element),
    }) : {};
    const pathFor = (element) => {
      const path = [];
      let cursor = element;
      let guard = 0;
      while (cursor && guard < 32) {
        const tag = normalizeTag(cursor.tagName);
        if (tag) path.unshift(tag);
        cursor = cursor.parentElement;
        guard += 1;
      }
      return path;
    };
    const results = [];
    const counts = new Map();
    const selector = 'a[href],button,input:not([type="hidden"]),textarea,[role]';
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 1000)) {
      if (element.closest('[hidden], [aria-hidden="true"]')) continue;
      const role = roleFor(element);
      if (!interactiveRoles.includes(role)) continue;
      const name = nameFor(element);
      if (name && skipRegexes.some((regex) => regex.test(name))) continue;
      const countKey = `${role}:${name}`;
      const nth = counts.get(countKey) || 0;
      counts.set(countKey, nth + 1);
      const path = pathFor(element);
      const parent = element.parentElement;
      const siblings = parent ? Array.from(parent.children)
        .filter((child) => child !== element)
        .slice(0, 8)
        .map((child) => related(child, false))
        .filter((entry) => Object.keys(entry).length > 0) : [];
      const nearbyText = [
        element.previousElementSibling?.innerText || element.previousElementSibling?.textContent,
        element.nextElementSibling?.innerText || element.nextElementSibling?.textContent,
        parent?.innerText || parent?.textContent,
      ].map(safeText).filter(Boolean).slice(0, 6);
      results.push({
        key: `${role}:${name}:${nth}`,
        metadata: compact({
          tag: normalizeTag(element.tagName),
          text: safeText(element.innerText || element.textContent || name),
          attributes: attrsFor(element),
          parent: related(parent),
          siblings,
          path,
          depth: path.length > 0 ? path.length - 1 : undefined,
          index: parent ? Array.from(parent.children).indexOf(element) : undefined,
          nearbyText,
        }),
      });
    }
    return results;
  }, {
    interactiveRoles: INTERACTIVE_ROLES,
    skipPatterns: SKIP_PATTERNS.map((pattern) => pattern.source),
  }).catch(() => []);

  return new Map((entries || []).map((entry) => [entry.key, entry.metadata || {}]));
}

async function buildRefs(page) {
  const refs = new Map();
  
  if (!page || page.isClosed()) {
    log('warn', 'buildRefs: page closed or invalid');
    return refs;
  }
  
  // Google SERP fast path — skip ariaSnapshot entirely
  const url = page.url();
  if (isGoogleSerp(url)) {
    const { refs: googleRefs } = await extractGoogleSerp(page);
    return googleRefs;
  }
  
  const start = Date.now();
  
  // Hard total timeout on the entire buildRefs operation
  let timerId;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => reject(new Error('buildRefs_timeout')), BUILDREFS_TIMEOUT_MS);
  });
  
  try {
    const result = await Promise.race([
      _buildRefsInner(page, refs, start),
      timeoutPromise
    ]);
    clearTimeout(timerId);
    return result;
  } catch (err) {
    clearTimeout(timerId);
    if (err.message === 'buildRefs_timeout') {
      log('warn', 'buildRefs: total timeout exceeded', { elapsed: Date.now() - start });
      return refs;
    }
    throw err;
  }
}

async function _buildRefsInner(page, refs, start) {
  if (page?.waitForLoadState) {
    await page.waitForLoadState('domcontentloaded', { timeout: REFRESH_READY_TIMEOUT_MS }).catch((err) => {
      log('warn', 'buildRefs domcontentloaded wait failed, continuing', { error: err.message });
    });
  }
  
  // Budget remaining time for ariaSnapshot
  const elapsed = Date.now() - start;
  const remaining = BUILDREFS_TIMEOUT_MS - elapsed;
  if (remaining < 2000) {
    log('warn', 'buildRefs: insufficient time for ariaSnapshot', { elapsed });
    return refs;
  }
  
  let ariaYaml;
  try {
    ariaYaml = await page.locator('body').ariaSnapshot({ timeout: Math.min(remaining - 1000, 5000) });
  } catch (err) {
    log('warn', 'ariaSnapshot failed, retrying');
    const retryBudget = BUILDREFS_TIMEOUT_MS - (Date.now() - start);
    if (retryBudget < 2000) return refs;
    try {
      ariaYaml = await page.locator('body').ariaSnapshot({ timeout: Math.min(retryBudget - 500, 5000) });
    } catch (retryErr) {
      log('warn', 'ariaSnapshot retry failed, returning empty refs', { error: retryErr.message });
      return refs;
    }
  }
  
  if (!ariaYaml) {
    log('warn', 'buildRefs: no aria snapshot');
    return refs;
  }
  
  const lines = ariaYaml.split('\n');
  let refCounter = 1;
  const liveDomMetadata = await extractLiveDomMetadata(page);
  
  // Track occurrences of each role+name combo for nth disambiguation
  const seenCounts = new Map(); // "role:name" -> count
  
  for (const line of lines) {
    if (refCounter > MAX_SNAPSHOT_NODES) break;
    
    const match = line.match(/^\s*-\s+(\w+)(?:\s+"([^"]*)")?/);
    if (match) {
      const [, role, name] = match;
      const normalizedRole = role.toLowerCase();
      
      if (normalizedRole === 'combobox') continue;
      
      if (name && SKIP_PATTERNS.some(p => p.test(name))) continue;
      
      if (INTERACTIVE_ROLES.includes(normalizedRole)) {
        const normalizedName = name || '';
        const key = `${normalizedRole}:${normalizedName}`;
        
        // Get current count and increment
        const nth = seenCounts.get(key) || 0;
        seenCounts.set(key, nth + 1);
        
        const refId = `e${refCounter++}`;
        refs.set(refId, {
          role: normalizedRole,
          name: normalizedName,
          nth,
          ...buildDomMetadata({
            ...(liveDomMetadata.get(key) || {}),
            index: liveDomMetadata.get(key)?.index ?? nth,
          }),
        });
      }
    }
  }
  
  return refs;
}

async function getAriaSnapshot(page) {
  if (!page || page.isClosed()) {
    return null;
  }
  if (page?.waitForLoadState) {
    await page.waitForLoadState('domcontentloaded', { timeout: REFRESH_READY_TIMEOUT_MS }).catch((err) => {
      log('warn', 'ariaSnapshot domcontentloaded wait failed, continuing', { error: err.message });
    });
  }
  try {
    return await page.locator('body').ariaSnapshot({ timeout: 5000 });
  } catch (err) {
    log('warn', 'getAriaSnapshot failed', { error: err.message });
    return null;
  }
}

function annotateAriaSnapshot(ariaYaml, refs) {
  let annotatedYaml = ariaYaml || '';
  if (annotatedYaml && refs.size > 0) {
    const refsByKey = new Map();
    for (const [refId, info] of refs) {
      const key = `${info.role}:${info.name}:${info.nth}`;
      refsByKey.set(key, refId);
    }

    const annotationCounts = new Map();
    const lines = annotatedYaml.split('\n');

    annotatedYaml = lines.map(line => {
      const match = line.match(/^(\s*-\s+)(\w+)(\s+"([^"]*)")?(.*)$/);
      if (match) {
        const [, prefix, role, nameMatch, name, suffix] = match;
        const normalizedRole = role.toLowerCase();
        if (normalizedRole === 'combobox') return line;
        if (name && SKIP_PATTERNS.some(p => p.test(name))) return line;
        if (INTERACTIVE_ROLES.includes(normalizedRole)) {
          const normalizedName = name || '';
          const countKey = `${normalizedRole}:${normalizedName}`;
          const nth = annotationCounts.get(countKey) || 0;
          annotationCounts.set(countKey, nth + 1);
          const key = `${normalizedRole}:${normalizedName}:${nth}`;
          const refId = refsByKey.get(key);
          if (refId) {
            return `${prefix}${role}${nameMatch || ''} [${refId}]${suffix}`;
          }
        }
      }
      return line;
    }).join('\n');
  }
  return annotatedYaml;
}

function refToLocator(page, ref, refs) {
  const info = refs.get(ref);
  if (!info) return null;

  const { role, name, nth, selector } = info;
  if (selector) {
    return page.locator(selector).first();
  }

  let locator = page.getByRole(role, name ? { name, exact: true } : undefined);

  // Always use .nth() to disambiguate duplicate role+name combinations
  // This avoids "strict mode violation" when multiple elements match
  locator = locator.nth(nth);

  return locator;
}

async function refreshTabRefs(tabState, options = {}) {
  const {
    reason = 'refresh',
    timeoutMs = null,
    preserveExistingOnEmpty = true,
  } = options;

  const beforeUrl = tabState.page?.url?.() || '';
  const existingRefs = tabState.refs instanceof Map ? tabState.refs : new Map();
  const refreshPromise = buildRefs(tabState.page);

  let refreshedRefs;
  if (timeoutMs) {
    const timeoutLabel = `${reason}_refs_timeout`;
    refreshedRefs = await Promise.race([
      refreshPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutLabel)), timeoutMs)),
    ]);
  } else {
    refreshedRefs = await refreshPromise;
  }

  const afterUrl = tabState.page?.url?.() || beforeUrl;
  if (preserveExistingOnEmpty && refreshedRefs.size === 0 && existingRefs.size > 0 && beforeUrl === afterUrl) {
    log('warn', 'preserving previous refs after empty rebuild', {
      reason,
      url: afterUrl,
      previousRefs: existingRefs.size,
    });
    return existingRefs;
  }

  return refreshedRefs;
}


app.get('/health', (req, res) => {
  if (healthState.isRecovering) {
    return res.status(503).json({ ok: false, engine: 'camoufox', recovering: true });
  }
  const running = getConnectedBrowserCount() > 0;
  if (proxyPool?.canRotateSessions && !running) {
    scheduleBrowserWarmRetry('health-check');
    return res.status(503).json({
      ok: false,
      engine: 'camoufox',
      browserConnected: false,
      browserRunning: false,
      warming: true,
      ...(FLY_MACHINE_ID ? { machineId: FLY_MACHINE_ID } : {}),
    });
  }
  res.json({ 
    ok: true, 
    engine: 'camoufox',
    browserConnected: running,
    browserRunning: running,
    activeTabs: getTotalTabCount(),
    activeSessions: sessions.size,
    consecutiveFailures: healthState.consecutiveNavFailures,
    ...getVncHealthFields(req),
    ...(FLY_MACHINE_ID ? { machineId: FLY_MACHINE_ID } : {}),
  });
});

app.get('/metrics', async (_req, res) => {
  const reg = getRegister();
  if (!reg) {
    res.status(404).json({ error: 'Prometheus metrics disabled. Set PROMETHEUS_ENABLED=1 to enable.' });
    return;
  }
  res.set('Content-Type', reg.contentType);
  res.send(await reg.metrics());
});

app.get('/managed/profiles', (_req, res) => {
  res.json({ ok: true, profiles: listManagedBrowserProfileIdentities() });
});

app.get('/managed/profiles/:profile/status', (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity({ ...req.query, profile: req.params.profile }, { operation: 'profiles.status' });
    managedReadAllowed({ ...req.query, profile: identity.profile }, managedProfileLeases, {
      allowLockedRead: CONFIG.managedProfileAllowLockedReads,
    });
    const status = managedBrowserProfileStatus({ ...req.query, profile: identity.profile }, {
      observed: managedObservedState(identity.profile),
    });
    const lease = managedProfileLeases.status(status.profile);
    res.json({ ...status, lease });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});

app.post('/managed/profiles/ensure', (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: 'profiles.ensure' });
    managedReadAllowed({ ...req.body, profile: identity.profile }, managedProfileLeases, {
      allowLockedRead: CONFIG.managedProfileAllowLockedReads,
    });
    const status = managedBrowserProfileStatus({ ...req.body, profile: identity.profile }, {
      ensure: true,
      observed: managedObservedState(identity.profile),
    });
    const lease = managedProfileLeases.status(status.profile);
    res.json({ ...status, lease });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});

app.post('/managed/profiles/lease/acquire', (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: 'profiles.lease.acquire' });
    const lease = managedProfileLeases.acquire({
      profile: identity.profile,
      owner: req.body?.owner || req.body?.owner_cli || req.body?.ownerCli,
      ttlMs: req.body?.ttl_ms || req.body?.ttlMs,
    });
    res.json({ ok: true, profile: identity.profile, ...lease });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});

app.post('/managed/profiles/lease/renew', (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: 'profiles.lease.renew' });
    const lease = managedProfileLeases.renew({
      profile: identity.profile,
      lease_id: req.body?.lease_id || req.body?.leaseId,
      ttlMs: req.body?.ttl_ms || req.body?.ttlMs,
    });
    res.json({ ok: true, profile: identity.profile, ...lease });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});

app.post('/managed/profiles/lease/release', (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: 'profiles.lease.release' });
    const result = managedProfileLeases.release({
      profile: identity.profile,
      lease_id: req.body?.lease_id || req.body?.leaseId,
    });
    res.json({ ok: true, profile: identity.profile, ...result });
  } catch (err) {
    handleRouteError(err, req, res);
  }
});

function managedObservedState(profile) {
  const policy = MANAGED_BROWSER_PROFILES.find((entry) => entry.profile === profile);
  if (!policy) return {};
  const session = sessions.get(policy.userId);
  const group = session?.tabGroups?.get(policy.sessionKey);
  const currentTabId = group ? Array.from(group.entries()).find(([, tabState]) => tabState?.page && !tabState.page.isClosed())?.[0] : null;
  return { currentTabId: currentTabId || null, updatedAt: session?.lastAccess ? new Date(session.lastAccess).toISOString() : null };
}

function managedCliPayload(identity, body = {}, extra = {}) {
  return {
    ...body,
    profile: identity.profile,
    userId: identity.userId,
    sessionKey: identity.sessionKey,
    profileDir: identity.profileDir,
    browserPersonaKey: identity.browserPersonaKey,
    humanPersonaKey: identity.humanPersonaKey,
    humanProfile: body.humanProfile || identity.defaultHumanProfile,
    siteKey: body.siteKey || identity.siteKey,
    ...extra,
  };
}

function managedCliLease(input = {}, identity, operation) {
  return ensureManagedLease({
    ...input,
    profile: identity.profile,
    owner: input.owner || input.owner_cli || input.ownerCli || `managed.cli.${operation}`,
  }, managedProfileLeases);
}

async function managedCliHandle(req, res, operation, work, options = {}) {
  let context = { mode: options.mode || 'browser', llm_used: false };
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: `managed.cli.${operation}` });
    context = { ...context, profile: identity.profile, lease_id: req.body?.lease_id || req.body?.leaseId };
    if (options.write !== false) {
      const lease = managedCliLease(req.body, identity, operation);
      context.lease_id = lease.lease_id;
    } else {
      managedReadAllowed({ ...req.body, profile: identity.profile }, managedProfileLeases, {
        allowLockedRead: CONFIG.managedProfileAllowLockedReads,
      });
    }
    const result = await work(identity, context);
    res.json(normalizeManagedCliResult(operation, result, context));
  } catch (err) {
    handleRouteError(err, req, res, managedCliErrorFields(operation, context));
  }
}

async function managedCliFindTab(identity, tabId) {
  const session = sessions.get(normalizeUserId(identity.userId));
  const found = session && findTab(session, tabId);
  return { session, found };
}

async function managedCliSnapshot(identity, body = {}) {
  const tabId = body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId;
  if (!tabId) throw Object.assign(new Error('tabId is required for managed CLI snapshot'), { statusCode: 400 });
  const { session, found } = await managedCliFindTab(identity, tabId);
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const { tabState } = found;
  updateTabRecoveryMeta(tabState, { userId: identity.userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, siteKey: identity.siteKey, task_id: body.task_id || body.taskId });
  const offset = Number.parseInt(String(body.offset || 0), 10) || 0;
  const currentUrl = tabState.page.url();
  if (!tabState.lastSnapshot || tabState.lastSnapshotUrl !== currentUrl) {
    tabState.refs = await refreshTabRefs(tabState, { reason: 'managed_cli_snapshot' });
    tabState.lastSnapshot = `url: ${currentUrl}\ntitle: ${await tabState.page.title().catch(() => '')}`;
    tabState.lastSnapshotUrl = currentUrl;
  }
  const win = windowSnapshot(tabState.lastSnapshot, offset);
  return {
    ok: true,
    tabId,
    url: currentUrl,
    title: await tabState.page.title().catch(() => ''),
    snapshot: win.text,
    refsCount: tabState.refs.size,
    truncated: win.truncated,
    totalChars: win.totalChars,
    hasMore: win.hasMore,
    nextOffset: win.nextOffset,
  };
}

async function managedCliAct(identity, body = {}) {
  const action = body.action || body.kind || body.type;
  const tabId = body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId;
  if (!tabId) throw Object.assign(new Error('tabId is required for managed CLI act'), { statusCode: 400 });
  const payload = managedCliPayload(identity, body);
  if (action === 'scroll') {
    const { session, found } = await managedCliFindTab(identity, tabId);
    if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
    const amount = body.amount || 500;
    const direction = body.direction || 'down';
    await humanScroll(found.tabState.page, { direction, amount, profile: payload.humanProfile });
    return { ok: true, tabId, url: found.tabState.page.url(), title: await found.tabState.page.title().catch(() => ''), action, sessionKey: found.listItemId, userId: session ? identity.userId : identity.userId };
  }
  throw Object.assign(new Error('Unsupported managed CLI action'), { statusCode: 400 });
}

app.post('/managed/cli/open', async (req, res) => managedCliHandle(req, res, 'open', async (identity) => {
  const payload = managedCliPayload(identity, req.body, { url: req.body?.url || identity.defaultStartUrl });
  const session = await getSession(identity.userId, { profileDir: identity.profileDir });
  const { result } = await createServerOwnedTab(session, {
    ...payload,
    reqId: req.reqId,
    eventMetadata: { managedCli: true },
  });
  return { ok: true, ...result, userId: identity.userId, sessionKey: identity.sessionKey };
}));

app.post('/managed/cli/snapshot', async (req, res) => managedCliHandle(req, res, 'snapshot', async (identity) => {
  return managedCliSnapshot(identity, req.body || {});
}, { write: false }));

app.post('/managed/cli/act', async (req, res) => managedCliHandle(req, res, 'act', async (identity) => {
  return managedCliAct(identity, req.body || {});
}));

app.post('/managed/cli/memory/record', async (req, res) => managedCliHandle(req, res, 'memory.record', async (identity) => {
  const tabId = req.body?.tabId || req.body?.targetId || managedObservedState(identity.profile).currentTabId;
  if (!tabId) throw Object.assign(new Error('tabId is required for managed CLI memory.record'), { statusCode: 400 });
  const { found } = await managedCliFindTab(identity, tabId);
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const actionKey = req.body?.actionKey || 'default';
  const saved = await recordAgentHistoryFlow(found.tabState, req.body?.siteKey || identity.siteKey, actionKey, {
    aliases: req.body?.aliases || [],
    labels: req.body?.labels || [],
  });
  return { ok: true, tabId, path: saved.path, siteKey: req.body?.siteKey || identity.siteKey, actionKey };
}));

app.post('/managed/cli/memory/replay', async (req, res) => managedCliHandle(req, res, 'memory.replay', async (identity, context) => {
  const allowLlmFallback = explicitAllowLlmRepair(req.body || {});
  const allow_llm_fallback = allowLlmFallback;
  context.llm_used = false;
  const siteKey = req.body?.siteKey || identity.siteKey;
  const actionKey = req.body?.actionKey || 'default';
  const loaded = await loadAgentHistory(siteKey, actionKey);
  const steps = loaded.payload?.hermes_meta?.derived_flow?.steps || [];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Object.assign(new Error(`AgentHistory flow has no replayable steps for ${siteKey}/${actionKey}`), { statusCode: 404 });
  }
  return { ok: true, mode: 'memory.replay', llm_used: Boolean(allow_llm_fallback && context.llm_used), allow_llm_fallback, siteKey, actionKey, steps: steps.length };
}));

app.post('/managed/cli/checkpoint', async (req, res) => managedCliHandle(req, res, 'checkpoint', async (identity) => {
  const key = normalizeUserId(identity.userId);
  const session = sessions.get(key);
  if (!session) throw Object.assign(new Error(`No active managed browser session for ${key}`), { statusCode: 404 });
  const reason = req.body?.reason || 'manual_checkpoint';
  await pluginEvents.emitAsync('session:storage:checkpoint', { userId: key, profileDir: identity.profileDir, reason });
  return { ok: true, userId: key, profileDir: identity.profileDir, reason, persisted: true };
}));

app.post('/managed/cli/release', async (req, res) => managedCliHandle(req, res, 'release', async (identity) => {
  return managedProfileLeases.release({ profile: identity.profile, lease_id: req.body?.lease_id || req.body?.leaseId });
}));

function managedApiSuccess(operation, result, extra = {}) {
  return {
    success: Boolean(result.ok),
    status: Boolean(result.ok) ? 'ok' : 'error',
    operation,
    result,
    ...extra,
  };
}

async function managedApiHandle(req, res, operation, work, options = {}) {
  let context = { mode: options.mode || 'local_api', llm_used: false };
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body || {}, { operation: `managed.api.${operation}` });
    context = { ...context, profile: identity.profile };
    if (options.write === false) {
      managedReadAllowed({ ...(req.body || {}), profile: identity.profile }, managedProfileLeases, {
        allowLockedRead: CONFIG.managedProfileAllowLockedReads,
      });
    }
    const result = await work(identity, context);
    res.json(managedApiSuccess(operation, result, {
      profile: identity.profile,
      site: identity.siteKey,
      llm_used: Boolean(context.llm_used),
    }));
  } catch (err) {
    handleRouteError(err, req, res, { operation, profile: context.profile, llm_used: Boolean(context.llm_used) });
  }
}

function explicitManagedNavigateRestore(body = {}) {
  return body.restoreCurrentTab === true || body.restore_current_tab === true || body.allowCurrentTabNavigate === true || body.allow_current_tab_navigate === true;
}

function assertManagedNavigateAllowed(identity, body = {}, tabId) {
  if (!tabId || explicitManagedNavigateRestore(body)) return;
  if (!identity?.securityPolicy?.requireConfirmationForBindingActions) return;
  throw Object.assign(new Error('refusing to navigate existing managed tab without explicit restoreCurrentTab'), {
    statusCode: 409,
    code: 'current_tab_navigation_blocked',
    currentTabId: tabId,
    requires: ['restoreCurrentTab'],
  });
}

async function managedApiOpenOrNavigate(identity, body = {}) {
  const targetUrl = body.url || identity.defaultStartUrl;
  const urlErr = validateUrl(targetUrl);
  if (urlErr) throw Object.assign(new Error(urlErr), { statusCode: 400 });
  const explicitTabId = body.tab_id || body.tabId || body.targetId;
  const observedTabId = managedObservedState(identity.profile).currentTabId;
  const tabId = explicitTabId || observedTabId;
  assertManagedNavigateAllowed(identity, body, explicitTabId ? null : observedTabId);
  await assertManagedFingerprintCoherent(identity, body);
  const payload = managedCliPayload(identity, body, { url: targetUrl });
  if (!tabId) {
    const session = await getSession(identity.userId, { profileDir: identity.profileDir });
    const { result } = await createServerOwnedTab(session, {
      ...payload,
      reqId: body.reqId,
      eventMetadata: { managedApi: true },
    });
    return { ok: true, ...result, tab_id: result.tabId, userId: identity.userId, sessionKey: identity.sessionKey };
  }
  const reqBody = { ...payload, userId: identity.userId };
  const { session, found } = await managedCliFindTab(identity, tabId);
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const { tabState } = found;
  const result = await withTabLock(tabId, async () => {
    await withPageLoadDuration('managed_api_navigate', () => tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    tabState.visitedUrls.add(targetUrl);
    invalidateTabSnapshot(tabState);
    tabState.refs = isGoogleSerp(tabState.page.url()) ? new Map() : await buildRefs(tabState.page);
    return { ok: true, tabId, tab_id: tabId, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
  });
  updateTabRecoveryMeta(tabState, { userId: identity.userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, siteKey: identity.siteKey, task_id: body.task_id || body.taskId });
  recordTabAction(tabState, { kind: 'navigate', url: result.url || reqBody.url, result });
  return { ...result, userId: identity.userId, sessionKey: found.listItemId };
}

async function managedApiFingerprintDoctor(identity, body = {}) {
  const tabId = body.tab_id || body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId;
  const profileRoot = resolveProfileRoot(identity.profileDir);
  const launchProfile = await resolveLaunchProfile(identity.userId, { profileDir: profileRoot });
  const persistedFingerprint = await loadPersistedFingerprint(profileRoot, identity.userId, { warn: (msg, fields) => log('warn', msg, fields) });
  if (persistedFingerprint?.fingerprint) launchProfile.persistedFingerprint = persistedFingerprint.fingerprint;
  const expected = expectedFingerprintFromLaunchProfile(launchProfile);
  if (!tabId) {
    return { ok: true, status: 'not_running', expected, persistedFingerprint: Boolean(persistedFingerprint?.fingerprint), issues: [] };
  }
  const { found } = await managedCliFindTab(identity, tabId);
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const observed = await withTabLock(tabId, async () => collectBrowserFingerprintSnapshot(found.tabState.page));
  const coherence = validateFingerprintCoherence({ expected, observed });
  const registry = readDisplayRegistry();
  const registryEntry = registry[identity.userId] || registry[identity.profile] || null;
  const vnc = validateVncGeometry({
    expected: {
      profileWindowSize: launchProfile?.managedDisplayPolicy?.profileWindowSize || expected.screen || expected.viewport,
      screen: expected.screen,
      viewport: expected.viewport,
    },
    observed: { browser: observed, registry: registryEntry },
  });
  const issues = [...coherence.issues, ...vnc.issues];
  const ok = coherence.ok && vnc.ok;
  return {
    ok,
    status: ok ? 'coherent' : 'incoherent',
    tabId,
    tab_id: tabId,
    expected,
    observed,
    vnc: { ok: vnc.ok, registry: registryEntry, issues: vnc.issues },
    issues,
    persistedFingerprint: Boolean(persistedFingerprint?.fingerprint),
  };
}

async function assertManagedFingerprintCoherent(identity, body = {}) {
  const tabId = body.tab_id || body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId;
  if (!tabId) return { checked: false, reason: 'no_tab' };
  const { found } = await managedCliFindTab(identity, tabId);
  if (!found) return { checked: false, reason: 'tab_not_found' };
  const profileRoot = resolveProfileRoot(identity.profileDir);
  const launchProfile = await resolveLaunchProfile(identity.userId, { profileDir: profileRoot });
  const persistedFingerprint = await loadPersistedFingerprint(profileRoot, identity.userId, { warn: (msg, fields) => log('warn', msg, fields) });
  if (persistedFingerprint?.fingerprint) launchProfile.persistedFingerprint = persistedFingerprint.fingerprint;
  const expected = expectedFingerprintFromLaunchProfile(launchProfile);
  const observed = await withTabLock(tabId, async () => collectBrowserFingerprintSnapshot(found.tabState.page));
  const coherence = validateFingerprintCoherence({ expected, observed });
  const registry = readDisplayRegistry();
  const registryEntry = registry[identity.userId] || registry[identity.profile] || null;
  const vnc = validateVncGeometry({
    expected: { profileWindowSize: launchProfile.persona?.window || launchProfile.persona?.viewport || launchProfile.persona?.screen },
    observed: { registry: registryEntry, browser: observed },
  });
  const combinedIssues = [...coherence.issues, ...vnc.issues];
  if (combinedIssues.length > 0) {
    throw Object.assign(new Error(`managed browser fingerprint is incoherent; run fingerprint doctor before write actions: ${combinedIssues.map((item) => item.kind || item.key || item.code || item.type || 'issue').join(', ')}`), {
      statusCode: 409,
      code: 'managed_fingerprint_incoherent',
      issues: combinedIssues,
    });
  }
  return { checked: true };
}

async function managedApiConsoleEval(identity, body = {}) {
  const tabId = body.tab_id || body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId;
  if (!tabId) throw Object.assign(new Error('tab_id is required for console eval'), { statusCode: 400 });
  const { session, found } = await managedCliFindTab(identity, tabId);
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const expression = typeof body.expression === 'string' && body.expression.trim() ? body.expression : 'document.title';
  const value = await withTabLock(tabId, async () => found.tabState.page.evaluate((source) => {
    // eslint-disable-next-line no-eval
    return eval(source);
  }, expression));
  return { ok: true, tabId, tab_id: tabId, value, url: found.tabState.page.url(), title: await found.tabState.page.title().catch(() => ''), userId: identity.userId, sessionKey: found.listItemId };
}

async function readManagedCredential({ profile, site, kind }) {
  const storePath = credentialPath({ profile, site, kind });
  const { stdout } = await execFileAsync('pass', ['show', storePath], { maxBuffer: 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

async function waitForPageSettled(page, { timeoutMs = 15000, settleMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = page.url();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const currentUrl = page.url();
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      stableSince = Date.now();
    }
    const readyState = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (readyState !== 'loading' && Date.now() - stableSince >= settleMs) return;
  }
}

async function evaluateAuchanSession(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || '';
    const url = window.location.href;
    const authenticated = /Bonjour,\s+[^\n]+\s*:\)|Cagnotte\s*:/i.test(body)
      && !/^https:\/\/compte\.auchan\.fr\/auth\//i.test(url);
    const loginPage = /^https:\/\/compte\.auchan\.fr\/auth\//i.test(url) || /E-mail\s+Mot de passe\s+Se souvenir de moi/i.test(body);
    const challenge = /captcha|recaptcha|code\s+(sms|email|e-mail)|vérification|verification|confirmez|confirmer/i.test(body);
    return {
      authenticated,
      loginPage,
      challenge,
      url,
      title: document.title,
      bodySample: body.slice(0, 500),
    };
  });
}

async function clickAuchanLoginIfNeeded(page) {
  const state = await evaluateAuchanSession(page);
  if (state.authenticated || state.loginPage) return state;
  await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const candidate = Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"]'))
      .find((el) => /me connecter|se connecter|connexion/i.test(textOf(el)));
    candidate?.click();
  });
  await waitForPageSettled(page, { timeoutMs: 10000 });
  return evaluateAuchanSession(page);
}

async function submitAuchanLoginForm(page, { username, password }) {
  await page.waitForSelector('#username, input[name="username"]', { timeout: 10000 });
  await page.waitForSelector('#password, input[name="password"]', { timeout: 10000 });
  await page.evaluate(({ username: userValue, password: passwordValue }) => {
    const setNativeValue = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      descriptor.set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const usernameInput = document.querySelector('#username, input[name="username"]');
    const passwordInput = document.querySelector('#password, input[name="password"]');
    setNativeValue(usernameInput, userValue);
    setNativeValue(passwordInput, passwordValue);
    const form = passwordInput.form || document.querySelector('form');
    const submit = document.querySelector('#kc-login, button[name="login"], button[type="submit"], input[type="submit"]');
    if (form?.requestSubmit) form.requestSubmit(submit || undefined);
    else if (submit?.click) submit.click();
    else form?.submit?.();
  }, { username, password });
  await waitForPageSettled(page, { timeoutMs: 20000 });
}

async function ensureAuchanAuthStrategy({ profile, site, identity }) {
  const session = await getSession(identity.userId, { profileDir: identity.profileDir });
  let tabId = managedObservedState(identity.profile).currentTabId;
  let found = tabId ? findTab(session, tabId) : null;
  if (!found) {
    const opened = await createServerOwnedTab(session, {
      ...managedCliPayload(identity, {}, { url: identity.defaultStartUrl || 'https://www.auchan.fr/' }),
      eventMetadata: { managedAuth: true },
    });
    tabId = opened.result.tabId;
    found = findTab(session, tabId);
  }
  if (!found) throw new Error('Auchan auth tab not found after open');

  const { tabState } = found;
  const result = await withTabLock(tabId, async () => {
    const page = tabState.page;
    if (!/^https:\/\/(www\.)?auchan\.fr\//i.test(page.url()) && !/^https:\/\/compte\.auchan\.fr\//i.test(page.url())) {
      await page.goto(identity.defaultStartUrl || 'https://www.auchan.fr/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await waitForPageSettled(page, { timeoutMs: 10000 });

    let state = await clickAuchanLoginIfNeeded(page);
    if (state.authenticated) return { ok: true, status: 'authenticated', login_required: false, human_required: false, tabId, checkpoint_saved: false };
    if (!state.loginPage) {
      return { ok: false, status: 'login_required', login_required: true, human_required: true, next_action: 'inspect_auchan_login_entrypoint', reason: 'login_entrypoint_not_found', tabId };
    }

    const username = await readManagedCredential({ profile, site, kind: 'username' });
    const password = await readManagedCredential({ profile, site, kind: 'password' });
    await submitAuchanLoginForm(page, { username, password });
    state = await evaluateAuchanSession(page);
    if (state.authenticated) {
      invalidateTabSnapshot(tabState);
      await pluginEvents.emitAsync('session:storage:checkpoint', { userId: normalizeUserId(identity.userId), profileDir: identity.profileDir, reason: 'auth_ensure_auchan' });
      return { ok: true, status: 'authenticated', login_required: false, human_required: false, checkpoint_saved: true, tabId, url: state.url, title: state.title };
    }
    if (state.challenge) {
      return { ok: true, status: 'checkpoint_required', login_required: true, human_required: true, next_action: 'resolve_auchan_human_challenge', tabId, url: state.url, title: state.title };
    }
    return { ok: false, status: 'login_failed', login_required: true, human_required: false, next_action: 'check_auchan_credentials_or_selectors', tabId, url: state.url, title: state.title, reason: state.loginPage ? 'still_on_login_page' : 'not_authenticated_after_submit' };
  });

  return { ...result, tab_id: tabId };
}


async function managedApiFileUpload(identity, body = {}) {
  const tabId = body.tab_id || body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId;
  if (!tabId) throw Object.assign(new Error('tab_id is required for file upload'), { statusCode: 400 });
  const selector = typeof body.selector === 'string' && body.selector.trim() ? body.selector : 'input[type="file"]';
  const paths = Array.isArray(body.paths) ? body.paths : [];
  if (!paths.length) throw Object.assign(new Error('paths is required for file upload'), { statusCode: 400 });
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw Object.assign(new Error('invalid file path for upload'), { statusCode: 400 });
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) throw Object.assign(new Error(`upload file not found: ${filePath}`), { statusCode: 400 });
  }
  const { session, found } = await managedCliFindTab(identity, tabId);
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const result = await withTabLock(tabId, async () => {
    const locator = found.tabState.page.locator(selector).first();
    await locator.setInputFiles(paths, { timeout: 30000 });
    return found.tabState.page.evaluate((sel) => {
      const input = document.querySelector(sel);
      const files = Array.from(input?.files || []).map((file) => ({ name: file.name, size: file.size, type: file.type }));
      return { files, count: files.length };
    }, selector);
  });
  invalidateTabSnapshot(found.tabState);
  updateTabRecoveryMeta(found.tabState, { userId: identity.userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, siteKey: identity.siteKey, task_id: body.task_id || body.taskId });
  return { ok: true, tabId, tab_id: tabId, uploaded: paths.length, selector, files: result.files || [], file_count: result.count || 0, url: found.tabState.page.url(), title: await found.tabState.page.title().catch(() => '') };
}

async function managedApiCheckpointStorage(identity, body = {}) {
  const key = normalizeUserId(identity.userId);
  const session = sessions.get(key);
  if (!session) throw Object.assign(new Error(`No active managed browser session for ${key}`), { statusCode: 404 });
  const reason = body.reason || 'managed_api_checkpoint';
  await pluginEvents.emitAsync('session:storage:checkpoint', { userId: key, profileDir: identity.profileDir, reason });
  return { ok: true, userId: key, profileDir: identity.profileDir, reason, persisted: true };
}

function clearManagedLifecycleTimer(session) {
  if (session?._managedLifecycleCloseTimer) {
    clearTimeout(session._managedLifecycleCloseTimer);
    session._managedLifecycleCloseTimer = null;
  }
}

function applyManagedLifecyclePolicyToSession(session, policy) {
  if (!session || !policy) return;
  clearManagedLifecycleTimer(session);
  session._managedLifecycleClosePolicy = policy;
  session.keepAlive = policy.mode === 'never';
  for (const group of session.tabGroups.values()) {
    for (const tabState of group.values()) tabState.keepAlive = policy.mode === 'never';
  }
}

async function closeManagedProfileSession(identity, reason = 'managed_lifecycle_close') {
  const key = normalizeUserId(identity.userId);
  const session = sessions.get(key);
  if (!session) return { ok: true, closed: false, userId: key, reason: 'no_active_session' };
  clearManagedLifecycleTimer(session);
  await closeSession(key, session, { reason, clearDownloads: true, clearLocks: true });
  scheduleBrowserIdleShutdown(key);
  return { ok: true, closed: true, userId: key, reason };
}

function scheduleManagedLifecycleClose(identity, policy) {
  const key = normalizeUserId(identity.userId);
  const session = sessions.get(key);
  if (!session) return { ok: true, scheduled: false, reason: 'no_active_session' };
  applyManagedLifecyclePolicyToSession(session, policy);
  if (policy.mode === 'now' || policy.mode === 'after_task') {
    setImmediate(() => closeManagedProfileSession(identity, `managed_lifecycle_${policy.mode}`).catch((err) => log('error', 'managed lifecycle close failed', { profile: identity.profile, error: err.message })));
    return { ok: true, scheduled: true, mode: policy.mode };
  }
  if (policy.mode === 'delay') {
    session._managedLifecycleCloseTimer = setTimeout(() => {
      closeManagedProfileSession(identity, 'managed_lifecycle_delay').catch((err) => log('error', 'managed lifecycle delayed close failed', { profile: identity.profile, error: err.message }));
    }, policy.delaySeconds * 1000);
    session._managedLifecycleCloseTimer.unref?.();
    return { ok: true, scheduled: true, mode: policy.mode, delaySeconds: policy.delaySeconds };
  }
  return { ok: true, scheduled: false, mode: policy.mode };
}

async function managedApiLifecycleOpen(identity, body = {}) {
  const result = await managedApiOpenOrNavigate(identity, { ...body, restoreCurrentTab: true });
  const close = body.close ? normalizeLifecycleClosePolicy(body.close) : getLifecycleDefault({ profile: identity.profile, site: identity.siteKey });
  const session = sessions.get(normalizeUserId(identity.userId));
  if (close && session) applyManagedLifecyclePolicyToSession(session, close);
  return { ok: true, ...result, lifecycle: { close: close || null } };
}

async function managedApiLifecycleClose(identity, body = {}) {
  const close = normalizeLifecycleClosePolicy(body.close || { mode: 'after_task' });
  const scheduled = scheduleManagedLifecycleClose(identity, close);
  return { ok: true, close, ...scheduled, external_actions: close.mode === 'never' ? 0 : 1 };
}

async function managedApiLifecycleDefault(identity, body = {}) {
  return setLifecycleDefault({ profile: identity.profile, site: identity.siteKey, close: body.close });
}

async function managedApiRunFlow(identity, body = {}, context = {}) {
  const allow_llm_repair = body.allow_llm_repair === undefined && body.allowLlmRepair === undefined
    ? false
    : Boolean(body.allow_llm_repair || body.allowLlmRepair);
  await assertManagedFingerprintCoherent(identity, body);
  const flow = body.flow || body.actionKey || body.action_key || 'default';
  const siteKey = body.siteKey || body.site || identity.siteKey;
  await seedSharedManagedFlows({ siteKey });
  const flow_availability = await sharedManagedFlowAvailability({ siteKey, profile: identity.profile });
  const loaded = await loadAgentHistory(siteKey, flow, { profile: identity.profile });
  const steps = loaded.payload?.hermes_meta?.derived_flow?.steps || [];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw Object.assign(new Error(`AgentHistory flow has no replayable steps for ${siteKey}/${flow}`), { statusCode: 404 });
  }
  const tabId = body.tab_id || body.tabId || body.targetId || managedObservedState(identity.profile).currentTabId || fly.makeTabId();
  const session = await getSession(identity.userId, { profileDir: identity.profileDir });
  let found = findTab(session, tabId);
  if (!found) {
    const page = await session.context.newPage();
    const tabState = createTabState(page, { userId: identity.userId, sessionKey: identity.sessionKey || 'default', tabId });
    attachDownloadListener(tabState, tabId, log, pluginEvents, identity.userId);
    getTabGroup(session, identity.sessionKey || 'default').set(tabId, tabState);
    refreshActiveTabsGauge();
    found = findTab(session, tabId);
  }
  if (!found) throw Object.assign(new Error('Tab not found'), { statusCode: 404 });
  const { tabState } = found;
  const replayRefreshRefs = async (reason = 'managed_api_flow_replay') => {
    invalidateTabSnapshot(tabState);
    tabState.refs = await refreshTabRefs(tabState, { reason });
    return tabState.refs;
  };
  const replayHandlers = createMemoryReplayHandlers({
    tabState,
    refreshRefs: replayRefreshRefs,
    waitForPageReady,
  });
  let learned = false;
  let learnedPath;
  const learnedPayloads = [];
  const replay = await replayStepsSelfHealing(steps, {
    handlers: {
      ...replayHandlers,
      navigate: async (step) => {
        await tabState.page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        invalidateTabSnapshot(tabState);
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
      },
      file_upload: async (step) => {
        const selector = typeof step.selector === 'string' && step.selector.trim() ? step.selector : 'input[type="file"]';
        const paths = Array.isArray(step.paths) ? step.paths : [];
        if (!paths.length) return { ok: false, error: 'paths is required for file_upload step' };
        for (const filePath of paths) {
          if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, error: 'invalid file path for upload' };
          const stat = await fs.promises.stat(filePath).catch(() => null);
          if (!stat || !stat.isFile()) return { ok: false, error: `upload file not found: ${filePath}` };
        }
        const locator = tabState.page.locator(selector).first();
        await locator.setInputFiles(paths, { timeout: 30000 });
        const uploadState = await tabState.page.evaluate((sel) => {
          const input = document.querySelector(sel);
          const files = Array.from(input?.files || []).map((file) => ({ name: file.name, size: file.size, type: file.type }));
          return { files, count: files.length };
        }, selector);
        await tabState.page.waitForTimeout(500).catch(() => {});
        invalidateTabSnapshot(tabState);
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, uploaded: paths.length, file_count: uploadState.count || 0, files: uploadState.files || [], url: tabState.page.url() };
      },
      click: async (step) => {
        const locator = step.ref ? refToLocator(tabState.page, step.ref, tabState.refs) : tabState.page.locator(step.selector);
        if (!locator) return { ok: false, error: `Ref not found: ${step.ref}` };
        await humanPrepareTarget(tabState.page, locator, {
          behaviorPersona: tabState.humanSession?.behaviorPersona,
          viewport: tabState.humanSession?.viewport,
        });
        const clickResult = await humanClick(tabState.page, locator, {
          profile: body.humanProfile || 'fast',
          from: getHumanCursor(tabState.humanSession),
          viewport: tabState.humanSession?.viewport,
        });
        updateHumanCursor(tabState.humanSession, clickResult.position);
        await tabState.page.waitForTimeout(500);
        invalidateTabSnapshot(tabState);
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, url: tabState.page.url() };
      },
      type: async (step) => {
        const locator = step.ref ? refToLocator(tabState.page, step.ref, tabState.refs) : tabState.page.locator(step.selector).first();
        if (!locator) return { ok: false, error: `Ref not found: ${step.ref}` };
        await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
        await humanType(tabState.page, locator, step.text, {
          profile: body.humanProfile || 'fast',
          clearFirst: true,
          mistakesRate: 0,
        });
        invalidateTabSnapshot(tabState);
        return { ok: true, url: tabState.page.url() };
      },
      press: async (step) => {
        await humanPress(tabState.page, step.key, { profile: body.humanProfile || 'fast' });
        invalidateTabSnapshot(tabState);
        return { ok: true, url: tabState.page.url() };
      },
      scroll: async (step) => {
        await humanScroll(tabState.page, {
          direction: step.direction || 'down',
          amount: step.amount || 500,
          profile: body.humanProfile || 'fast',
        });
        invalidateTabSnapshot(tabState);
        return { ok: true, url: tabState.page.url() };
      },
      back: async () => {
        await tabState.page.goBack({ timeout: 10000 }).catch(() => {});
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, url: tabState.page.url() };
      },
    },
    refreshRefs: async () => {
      await replayRefreshRefs('managed_api_flow_repair');
    },
    getCandidates: async () => candidatesFromRefs(tabState.refs),
    detectInterrupt: async () => detectInterrupt({
      url: tabState.page.url(),
      title: await tabState.page.title().catch(() => ''),
      text: await tabState.page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '').catch(() => ''),
    }),
    adaptivePacing: (interrupt) => adaptivePacingForInterrupt(interrupt, {
      profile: body.humanProfile || 'medium',
      consecutiveInterrupts: tabState.consecutiveTimeouts,
    }),
    waitForPacing: async (delayMs) => {
      await tabState.page.waitForTimeout(Math.min(delayMs, 3000));
    },
    resolveInterrupt: async (interrupt) => {
      if (interrupt?.type !== 'cookie_banner') return { ok: true, skipped: true };
      tabState.refs = await refreshTabRefs(tabState, { reason: 'managed_api_flow_interrupt' });
      const candidate = chooseCookieConsentCandidate(candidatesFromRefs(tabState.refs));
      if (!candidate?.ref) return { ok: false, error: 'No cookie consent candidate found' };
      const locator = refToLocator(tabState.page, candidate.ref, tabState.refs);
      if (!locator) return { ok: false, error: `Ref not found: ${candidate.ref}` };
      await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
      const clickResult = await humanClick(tabState.page, locator, {
        profile: body.humanProfile || 'fast',
        from: getHumanCursor(tabState.humanSession),
      });
      updateHumanCursor(tabState.humanSession, clickResult.position);
      await tabState.page.waitForTimeout(500);
      tabState.refs = await refreshTabRefs(tabState, { reason: 'managed_api_flow_interrupt_resolved' });
      return { ok: true, ref: candidate.ref, type: interrupt.type };
    },
    validate: async (expected) => validateOutcome(expected, {
      getUrl: async () => tabState.page.url(),
      getTitle: async () => tabState.page.title(),
      hasText: async (text) => tabState.page.getByText(text).first().isVisible({ timeout: 1000 }).catch(() => false),
      hasSelector: async (selector) => tabState.page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false),
    }),
    parameters: body.params || body.parameters || {},
    max_side_effect_level: body.max_side_effect_level || body.maxSideEffectLevel || 'publish',
    learnRepairs: body.learnRepairs === true || body.learn_repairs === true,
    learnRepair: async (payload) => {
      const saved = await applyLearnedDomRepair({
        siteKey,
        actionKey: flow,
        sourcePath: loaded.path,
        payload,
      });
      learned = true;
      learnedPath = saved.path;
      learnedPayloads.push(payload);
    },
    ...(allow_llm_repair ? {
      allowLlmFallback: true,
      plannerFallback: createManagedPlannerFallback({ tabState, candidatesFromRefs }),
    } : {}),
  });
  context.llm_used = Boolean(replay.llm_used);
  return {
    ok: replay.ok !== false,
    ...replay,
    mode: replay.mode || 'memory.replay',
    allow_llm_repair,
    siteKey,
    actionKey: flow,
    flow,
    params: body.params || {},
    steps: steps.length,
    flow_availability,
    tabId,
    tab_id: tabId,
    url: tabState.page.url(),
    title: await tabState.page.title().catch(() => ''),
    ...(learned ? { learned, learnedPath, learnedRepairs: learnedPayloads.length } : {}),
  };
}

async function managedApiListFlows(identity, body = {}) {
  const siteKey = body.siteKey || body.site || identity.siteKey;
  await seedSharedManagedFlows({ siteKey });
  const flows = await searchFlows({ siteKey, profile: identity.profile, query: body.query || '' });
  return { ok: true, mode: 'memory.catalog', llm_used: false, siteKey, profile: identity.profile, flows, count: flows.length };
}

async function managedApiInspectFlow(identity, body = {}) {
  const flow = body.flow || body.actionKey || body.action_key || 'default';
  const siteKey = body.siteKey || body.site || identity.siteKey;
  await seedSharedManagedFlows({ siteKey });
  const loaded = await loadAgentHistory(siteKey, flow, { profile: identity.profile });
  const meta = loaded.payload?.hermes_meta || {};
  const steps = Array.isArray(meta.derived_flow?.steps) ? meta.derived_flow.steps : [];
  return {
    ok: true,
    mode: 'memory.inspect',
    llm_used: false,
    siteKey: meta.site_key || siteKey,
    actionKey: meta.action_key || flow,
    flow,
    profile: identity.profile,
    aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
    labels: Array.isArray(meta.labels) ? meta.labels : [],
    parameters: Array.isArray(meta.parameters) ? meta.parameters : [],
    side_effect_level: meta.side_effect_level,
    safe_to_share: meta.safe_to_share,
    steps,
    steps_count: steps.length,
    path: loaded.path,
  };
}

function notificationCaptureKey(identity, origin) {
  return `${identity.profile}:${origin}`;
}

function validateNotificationOrigin(identity, body = {}) {
  const origin = body.origin || identity.defaultStartUrl;
  if (!origin) throw Object.assign(new Error('origin is required'), { statusCode: 400 });
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error(`Blocked notification origin scheme: ${parsed.protocol}`), { statusCode: 400 });
  }
  const site = body.site || body.siteKey || identity.siteKey;
  if (site !== identity.siteKey) {
    throw Object.assign(new Error(`site must match managed profile site ${identity.siteKey}`), { statusCode: 400 });
  }
  return parsed.origin;
}

async function managedNotificationsHandle(req, res, operation, work, options = {}) {
  let context = { llm_used: false };
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body || {}, { operation: `notifications.${operation}` });
    const origin = validateNotificationOrigin(identity, req.body || {});
    context = { profile: identity.profile, site: identity.siteKey, origin, llm_used: false };
    if (options.write === false) {
      managedReadAllowed({ ...(req.body || {}), profile: identity.profile }, managedProfileLeases, {
        allowLockedRead: CONFIG.managedProfileAllowLockedReads,
      });
    }
    const result = await work(identity, origin, context);
    res.json(normalizeManagedNotificationResponse(result, context));
  } catch (err) {
    handleRouteError(err, req, res, normalizeManagedNotificationResponse({ success: false, error: err.code || 'failed' }, context));
  }
}

function recordManagedNotificationForIdentity(identity, origin) {
  return (notification) => {
    try {
      recordNotification({
        storagePath: notificationStorePath(identity),
        recorded_at: new Date().toISOString(),
        site: identity.siteKey,
        origin,
        ...notification,
      });
    } catch (err) {
      log('warn', 'notification capture record failed', { profile: identity.profile, error: err.message });
    }
  };
}

async function ensureManagedNotificationPageCapture(identity, origin, page) {
  return ensureNotificationCaptureOnPage(page, {
    profile: identity.profile,
    site: identity.siteKey,
    origin,
    onNotification: recordManagedNotificationForIdentity(identity, origin),
  });
}

async function readNotificationPermission(identity, origin) {
  const session = await getSession(identity.userId, { profileDir: identity.profileDir });
  const page = session.context.pages().find((candidate) => !candidate.isClosed?.()) || await session.context.newPage();
  if (page.url() === 'about:blank') await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const capture = await ensureManagedNotificationPageCapture(identity, origin, page);
  const permission = await page.evaluate(() => (typeof Notification === 'function' ? Notification.permission : 'unsupported')).catch(() => 'unsupported');
  return { session, page, permission, capture };
}

async function emitManagedNotificationSelfTest(identity, origin) {
  const { page, permission, capture } = await readNotificationPermission(identity, origin);
  const diagnostics = await page.evaluate(() => {
    const title = `ManagedBrowser notification self-test ${Date.now()}`;
    const captureBindingAvailable = Boolean(window.__managedBrowserNotificationCaptureBindingAvailable?.());
    let notification_created = false;
    let notification_error = null;
    try {
      if (typeof Notification !== 'function') throw new Error('Notification unsupported');
      new Notification(title, {
        body: 'Managed Browser capture self-test',
        tag: 'managed-browser-self-test',
        data: { url: window.location.href },
      });
      notification_created = true;
    } catch (err) {
      notification_error = String(err && err.message ? err.message : err);
    }
    return {
      title,
      notification_created,
      notification_error,
      capture_binding_available: captureBindingAvailable,
      capture_last_attempt: window.__managedBrowserNotificationCaptureLastAttempt || null,
      capture_last_error: window.__managedBrowserNotificationCaptureLastError || null,
    };
  });
  return { success: diagnostics.notification_created, permission, capture, ...diagnostics, external_actions: 0 };
}

async function checkpointManagedNotificationStorage(identity, reason = 'notifications_permission_change') {
  await pluginEvents.emitAsync('session:storage:checkpoint', { userId: identity.userId, profileDir: identity.profileDir, reason });
  return { persisted: true, reason };
}

function disableNotificationCaptureForOrigin(identity, origin) {
  disabledNotificationCaptureOrigins.add(notificationCaptureKey(identity, origin));
  return { disabled: true };
}

function notificationStorePath(identity) {
  return path.join(identity.profileDir, 'notifications.jsonl');
}

function parseNotificationLimit(value, fallback = 50) {
  const limit = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, 500);
}

async function readNotificationCursorState(statePath) {
  if (!statePath) return {};
  try {
    const text = await fs.promises.readFile(statePath, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeNotificationCursorState(statePath, state) {
  if (!statePath) return { persisted: false };
  await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
  await fs.promises.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return { persisted: true, state };
}

app.post('/notifications/status', async (req, res) => managedNotificationsHandle(req, res, 'status', async (identity, origin) => {
  const { permission } = await readNotificationPermission(identity, origin);
  return { success: true, permission, capture_disabled: disabledNotificationCaptureOrigins.has(notificationCaptureKey(identity, origin)), external_actions: 0 };
}, { write: false }));

app.post('/notifications/enable', async (req, res) => managedNotificationsHandle(req, res, 'enable', async (identity, origin) => {
  const confirm = req.body?.confirm;
  if (confirm === true) {
    const session = await getSession(identity.userId, { profileDir: identity.profileDir });
    await session.context.grantPermissions(['notifications'], { origin });
    disabledNotificationCaptureOrigins.delete(notificationCaptureKey(identity, origin));
    const { permission } = await readNotificationPermission(identity, origin);
    const checkpoint = await checkpointManagedNotificationStorage(identity, 'notifications_enable');
    return { success: true, permission, ...checkpoint, external_actions: 1 };
  }
  const { permission } = await readNotificationPermission(identity, origin);
  return { success: false, status: 'requires_confirm', error: 'requires_confirm', requires_confirm: true, permission, external_actions: 0 };
}));

app.post('/notifications/disable', async (req, res) => managedNotificationsHandle(req, res, 'disable', async (identity, origin) => {
  const disabled = disableNotificationCaptureForOrigin(identity, origin);
  const { permission } = await readNotificationPermission(identity, origin);
  return { success: true, permission, ...disabled, external_actions: 0 };
}));

app.post('/notifications/list', async (req, res) => managedNotificationsHandle(req, res, 'list', async (identity, origin) => {
  const limit = parseNotificationLimit(req.body?.limit, 50);
  const notifications = listNotifications({ storagePath: notificationStorePath(identity), profile: identity.profile, site: identity.siteKey, origin, limit });
  return { success: true, notifications, count: notifications.length, limit, external_actions: 0 };
}, { write: false }));

app.post('/notifications/poll', async (req, res) => managedNotificationsHandle(req, res, 'poll', async (identity, origin) => {
  const { permission } = await readNotificationPermission(identity, origin);
  if (permission === 'default' || permission === 'denied') {
    return { success: false, status: 'requires_enable', permission, notifications: [], count: 0, external_actions: 0 };
  }
  const limit = parseNotificationLimit(req.body?.limit, 50);
  const cursorState = await readNotificationCursorState(req.body?.state);
  const cursor = req.body?.cursor || cursorState.cursor || null;
  const all = listNotifications({ storagePath: notificationStorePath(identity), profile: identity.profile, site: identity.siteKey, origin });
  const startIndex = cursor ? all.findIndex((notification) => notification.id === cursor) + 1 : 0;
  const notifications = all.slice(Math.max(0, startIndex)).slice(0, limit);
  const nextCursor = notifications.length ? notifications[notifications.length - 1].id : cursor;
  const persisted = await writeNotificationCursorState(req.body?.state, { cursor: nextCursor, updated_at: new Date().toISOString() });
  return { success: true, permission, notifications, count: notifications.length, cursor: nextCursor, state_persisted: persisted.persisted, external_actions: 0 };
}, { write: false }));

app.post('/notifications/self-test', async (req, res) => managedNotificationsHandle(req, res, 'self-test', async (identity, origin) => {
  return emitManagedNotificationSelfTest(identity, origin);
}, { write: false }));

app.post('/notifications/mark-read', async (req, res) => managedNotificationsHandle(req, res, 'mark-read', async (identity) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : (req.body?.id ? [req.body.id] : []);
  const result = markNotificationsRead({ storagePath: notificationStorePath(identity), ids });
  return { success: true, ...result, external_actions: 0 };
}));

app.post('/profile/status', async (req, res) => managedApiHandle(req, res, 'profile.status', async (identity) => {
  return managedBrowserProfileStatus({ profile: identity.profile, site: identity.siteKey }, { observed: managedObservedState(identity.profile) });
}, { write: false }));

app.post('/fingerprint/doctor', async (req, res) => managedApiHandle(req, res, 'fingerprint.doctor', async (identity) => {
  return managedApiFingerprintDoctor(identity, req.body || {});
}, { write: false }));

app.post('/auth/status', async (req, res) => managedApiHandle(req, res, 'auth.status', async (identity) => {
  return managedAuthStatus({ profile: identity.profile, site: identity.siteKey });
}, { write: false }));

app.post('/auth/ensure', async (req, res) => managedApiHandle(req, res, 'auth.ensure', async (identity) => {
  const strategy = identity.siteKey === 'auchan'
    ? ({ profile, site }) => ensureAuchanAuthStrategy({ profile, site, identity })
    : undefined;
  return managedAuthEnsure({ profile: identity.profile, site: identity.siteKey }, { strategy });
}));

app.post('/navigate', async (req, res, next) => {
  if (!req.body?.profile) return next();
  return managedApiHandle(req, res, 'navigate', async (identity) => managedApiOpenOrNavigate(identity, req.body || {}));
});

app.post('/console/eval', async (req, res) => managedApiHandle(req, res, 'console.eval', async (identity) => managedApiConsoleEval(identity, req.body || {}), { write: false }));

app.post('/file-upload', async (req, res) => managedApiHandle(req, res, 'file-upload', async (identity) => managedApiFileUpload(identity, req.body || {})));

app.post('/storage/checkpoint', async (req, res) => managedApiHandle(req, res, 'storage.checkpoint', async (identity) => managedApiCheckpointStorage(identity, req.body || {})));

app.post('/flow/run', async (req, res) => managedApiHandle(req, res, 'flow.run', async (identity, context) => managedApiRunFlow(identity, req.body || {}, context)));

app.post('/flow/list', async (req, res) => managedApiHandle(req, res, 'flow.list', async (identity) => managedApiListFlows(identity, req.body || {}), { write: false }));

app.post('/flow/inspect', async (req, res) => managedApiHandle(req, res, 'flow.inspect', async (identity) => managedApiInspectFlow(identity, req.body || {}), { write: false }));

app.post('/lifecycle/open', async (req, res) => managedApiHandle(req, res, 'lifecycle.open', async (identity) => managedApiLifecycleOpen(identity, req.body || {})));

app.post('/lifecycle/close', async (req, res) => managedApiHandle(req, res, 'lifecycle.close', async (identity) => managedApiLifecycleClose(identity, req.body || {})));

app.post('/lifecycle/default', async (req, res) => managedApiHandle(req, res, 'lifecycle.default', async (identity) => managedApiLifecycleDefault(identity, req.body || {})));

const LEGACY_VISIBLE_TAB_USER_ID_PROFILES = new Set(['leboncoin-cim', 'leboncoin-ge', 'emploi', 'example-demo']);

function visibleTabIdentityInput(body = {}) {
  if ((!body.profile || !String(body.profile).trim()) && LEGACY_VISIBLE_TAB_USER_ID_PROFILES.has(String(body.userId || ''))) {
    return { ...body, profile: String(body.userId) };
  }
  return body;
}

// Create new tab
app.post('/managed/visible-tab', async (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(visibleTabIdentityInput(req.body || {}), { operation: 'managed.visible-tab' });
    const payload = managedCliPayload(identity, req.body, { url: req.body?.url || identity.defaultStartUrl });
    const lease = ensureManagedLease({ ...payload, owner: payload.owner || payload.owner_cli || payload.ownerCli || 'managed.visible-tab' }, managedProfileLeases);
    const { userId, sessionKey, url, profileDir, display } = payload;
    if (!url) {
      return res.status(400).json({ error: 'url required' });
    }
    const urlErr = validateUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });
    if (display) requireSharedDisplayForUser(userId, display);

    const result = await withTimeout((async () => {
      const session = await getSession(userId, { profileDir });
      let totalTabs = 0;
      for (const group of session.tabGroups.values()) totalTabs += group.size;
      if (totalTabs >= MAX_TABS_PER_SESSION || getTotalTabCount() >= MAX_TABS_GLOBAL) {
        const recycled = await recycleOldestTab(session, req.reqId, userId);
        if (!recycled) {
          throw Object.assign(new Error('Maximum tabs per session reached'), { statusCode: 429 });
        }
      }

      const { result: tabResult } = await createServerOwnedTab(session, {
        ...payload,
        reqId: req.reqId,
        eventMetadata: { visible: true, display: display || null },
      });
      return { ok: true, ...tabResult, userId, sessionKey, visible: true, display: display || null, lease_id: lease.lease_id };
    })(), requestTimeoutMs(), 'managed visible tab create');

    res.json(result);
  } catch (err) {
    log('error', 'managed visible tab create failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

app.post('/managed/recover-tab', async (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: 'managed.recover-tab' });
    enforceManagedLease({ ...req.body, profile: identity.profile }, managedProfileLeases);
    const { userId, sessionKey, profileDir, siteKey, tabId, fallbackUrl, browserPersonaKey, humanPersonaKey, humanProfile, task_id, taskId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const resolvedSessionKey = sessionKey || 'default';
    const key = normalizeUserId(userId);
    const meta = { userId, sessionKey: resolvedSessionKey, profileDir, siteKey, tabId, task_id: task_id || taskId };
    const session = sessions.get(key);
    const found = session && tabId ? findTab(session, tabId) : null;
    if (found?.tabState?.page && !found.tabState.page.isClosed()) {
      updateTabRecoveryMeta(found.tabState, { ...meta, sessionKey: found.listItemId, profileDir: profileDir || session.profileDir });
      const url = found.tabState.page.url();
      const title = await found.tabState.page.title().catch(() => '');
      recordRecoveryAction(managedRecoveryRegistry, buildTabRecoveryMeta(found.tabState, { result: { url, title } }), { kind: 'recover', result: { ok: true, url, title, recovered: false } });
      return res.json({ ok: true, recovered: false, previousTabId: tabId || null, tabId, url, title });
    }

    const state = getRecoveryState(managedRecoveryRegistry, meta);
    const previousTabId = tabId || state?.lastTabId || null;
    const targetUrl = getRecoveryTargetUrl(state, fallbackUrl);
    if (!targetUrl) {
      return res.status(404).json({
        error: 'No recovery target URL available',
        recovered: false,
        previousTabId,
      });
    }
    const activeSession = await getSession(userId, { profileDir });
    const { result, tabState } = await createServerOwnedTab(activeSession, {
      userId,
      sessionKey: resolvedSessionKey,
      url: targetUrl,
      browserPersonaKey,
      humanPersonaKey,
      humanProfile,
      profileDir,
      siteKey,
      task_id,
      taskId,
      reqId: req.reqId,
      eventMetadata: { recovered: true, previousTabId },
    });
    updateTabRecoveryMeta(tabState, { ...meta, tabId: result.tabId, profileDir: profileDir || activeSession.profileDir });
    tabState.refs = await buildRefs(tabState.page);
    const ariaYaml = await getAriaSnapshot(tabState.page);
    const annotatedYaml = compactSnapshot(annotateAriaSnapshot(ariaYaml, tabState.refs));
    tabState.lastSnapshot = annotatedYaml;
    tabState.lastSnapshotFull = false;
    tabState.lastSnapshotUrl = tabState.page.url();
    recordTabAction(tabState, { kind: 'recover', url: result.url || targetUrl, result: { ok: true, ...result, recovered: true, previousTabId } });
    res.json({ ok: true, recovered: true, previousTabId, tabId: result.tabId, url: result.url, title: result.title, snapshot: annotatedYaml, refsCount: tabState.refs.size });
  } catch (err) {
    log('error', 'managed tab recovery failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

app.post('/managed/storage-checkpoint', async (req, res) => {
  try {
    const identity = requireManagedBrowserProfileIdentity(req.body, { operation: 'managed.storage-checkpoint' });
    enforceManagedLease({ ...req.body, profile: identity.profile }, managedProfileLeases);
    const { userId, profileDir, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const key = normalizeUserId(userId);
    const session = sessions.get(key);
    if (!session) {
      return res.status(404).json({ error: `No active managed browser session for ${key}` });
    }
    const effectiveProfileDir = profileDir || session.profileDir;
    await pluginEvents.emitAsync('session:storage:checkpoint', {
      userId: key,
      profileDir: effectiveProfileDir,
      reason: reason || 'manual_checkpoint',
    });
    res.json({ ok: true, userId: key, profileDir: effectiveProfileDir, reason: reason || 'manual_checkpoint', persisted: true });
  } catch (err) {
    log('error', 'managed storage checkpoint failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

app.post('/tabs', async (req, res) => {
  try {
    const { userId, sessionKey, listItemId, url, profileDir, browserPersonaKey, humanPersonaKey, humanProfile, siteKey, task_id, taskId } = req.body;
    assertRawTabCreateAllowed(req.body);
    // Accept both sessionKey (preferred) and listItemId (legacy) for backward compatibility
    const resolvedSessionKey = sessionKey || listItemId;
    if (!userId || !resolvedSessionKey) {
      return res.status(400).json({ error: 'userId and sessionKey required' });
    }
    
    const result = await withTimeout((async () => {
      const session = await getSession(userId, { profileDir });
      
      let totalTabs = 0;
      for (const group of session.tabGroups.values()) totalTabs += group.size;
      
      // Recycle oldest tab when limits are reached instead of rejecting
      if (totalTabs >= MAX_TABS_PER_SESSION || getTotalTabCount() >= MAX_TABS_GLOBAL) {
        const recycled = await recycleOldestTab(session, req.reqId, userId);
        if (!recycled) {
          throw Object.assign(new Error('Maximum tabs per session reached'), { statusCode: 429 });
        }
      }
      
      const { result } = await createServerOwnedTab(session, {
        userId,
        sessionKey: resolvedSessionKey,
        url,
        browserPersonaKey,
        humanPersonaKey,
        humanProfile,
        profileDir,
        siteKey,
        task_id,
        taskId,
        reqId: req.reqId,
      });
      return { tabId: result.tabId, url: result.url };
    })(), requestTimeoutMs(), 'tab create');

    res.json(result);
  } catch (err) {
    log('error', 'tab create failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Navigate
app.post('/tabs/:tabId/navigate', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, url, macro, query, sessionKey, listItemId, profileDir, browserPersonaKey, humanPersonaKey, humanProfile, siteKey, task_id, taskId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const result = await withUserLimit(userId, () => withTimeout((async () => {
      await ensureBrowser(userId, { profileDir });
      const resolvedSessionKey = sessionKey || listItemId || 'default';
      let session = sessions.get(normalizeUserId(userId));
      let found = session && findTab(session, tabId);
      
      let tabState;
      if (!found) {
        session = await getSession(userId, { profileDir });
        let sessionTabs = 0;
        for (const g of session.tabGroups.values()) sessionTabs += g.size;
        if (getTotalTabCount() >= MAX_TABS_GLOBAL || sessionTabs >= MAX_TABS_PER_SESSION) {
          // Recycle oldest tab to free a slot, then create new page
          const recycled = await recycleOldestTab(session, req.reqId, userId);
          if (!recycled) {
            throw new Error('Maximum tabs per session reached');
          }
        }
        {
          const page = await session.context.newPage();
          tabState = createTabState(page, {
            userId: browserPersonaKey || userId,
            sessionKey: resolvedSessionKey,
            tabId,
            profileDir: profileDir || session.profileDir,
            siteKey,
            task_id,
            taskId,
            browserPersonaKey,
            humanPersonaKey,
            humanProfileKey: humanPersonaKey,
            humanProfile,
            persona: session.launchPersona?.persona,
            profile: session.launchPersona,
          });
          attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
          const group = getTabGroup(session, resolvedSessionKey);
          group.set(tabId, tabState);
          refreshActiveTabsGauge();
          log('info', 'tab auto-created on navigate', { reqId: req.reqId, tabId, userId });
        }
      } else {
        tabState = found.tabState;
      }
      tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
      
      let targetUrl = url;
      if (macro && macro !== '__NO__' && macro !== 'none' && macro !== 'null') {
        targetUrl = expandMacro(macro, query) || url;
      }
      
      if (!targetUrl) throw new Error('url or macro required');
      
      const urlErr = validateUrl(targetUrl);
      if (urlErr) throw new Error(urlErr);
      
      return await withTabLock(tabId, async () => {
        const currentSessionKey = found?.listItemId || resolvedSessionKey;
        const isGoogleSearch = isGoogleSearchUrl(targetUrl);

        const navigateCurrentPage = async () => {
          tabState.lastRequestedUrl = targetUrl;
          const ac = tabState.navigateAbort = new AbortController();
          const gotoP = withPageLoadDuration('navigate', () => tabState.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }));
          try {
            await Promise.race([
              gotoP,
              new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('Navigation aborted: tab deleted')), { once: true })),
            ]);
            tabState.visitedUrls.add(targetUrl);
            invalidateTabSnapshot(tabState);
          } catch (err) {
            gotoP.catch(() => {}); // suppress unhandled rejection from still-pending goto
            throw err;
          } finally {
            tabState.navigateAbort = null;
          }
        };

        const prewarmGoogleHome = async () => {
          if (!isGoogleSearch || tabState.visitedUrls.has('https://www.google.com/')) return;
          await withPageLoadDuration('navigate', () => tabState.page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }));
          tabState.visitedUrls.add('https://www.google.com/');
          await tabState.page.waitForTimeout(1200);
        };

        const recreateTabOnFreshContext = async () => {
          const previousRetryCount = tabState.googleRetryCount || 0;
          browserRestartsTotal.labels('google_search_block').inc();
          // Rotate at context level — destroy this user's session and create
          // a fresh one with a new proxy session. Does NOT restart the browser.
          const key = normalizeUserId(userId);
          const oldSession = sessions.get(key);
          if (oldSession) {
            await closeSession(key, oldSession, { reason: 'google_blocked_context_rotate', clearDownloads: true, clearLocks: true });
          }
          session = await getSession(userId, { profileDir });
          const group = getTabGroup(session, currentSessionKey);
          const page = await session.context.newPage();
          tabState = createTabState(page, {
            userId,
            sessionKey: currentSessionKey,
            tabId,
            profileDir: profileDir || session.profileDir,
            siteKey,
            task_id,
            taskId,
            browserPersonaKey,
            humanPersonaKey,
            humanProfileKey: humanPersonaKey,
            humanProfile,
            persona: session.launchPersona?.persona,
            profile: session.launchPersona,
          });
          tabState.googleRetryCount = previousRetryCount + 1;
          attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
          group.set(tabId, tabState);
          refreshActiveTabsGauge();
        };

        if (isGoogleSearch && proxyPool?.canRotateSessions) {
          await prewarmGoogleHome();
        }

        await navigateCurrentPage();

        if (isGoogleSearch && proxyPool?.canRotateSessions && await isGoogleSearchBlocked(tabState.page)) {
          log('warn', 'google search blocked, rotating browser proxy session', {
            reqId: req.reqId,
            tabId,
            url: tabState.page.url(),
            proxySession: session.browserProxySessionId || null,
          });
          await recreateTabOnFreshContext();
          await prewarmGoogleHome();
          await navigateCurrentPage();
        }
        
        // For Google SERP: skip eager ref building during navigate.
        // Results render asynchronously after DOMContentLoaded — the snapshot
        // call will wait for and extract them.
        if (isGoogleSerp(tabState.page.url())) {
          tabState.refs = new Map();
          return { ok: true, tabId, url: tabState.page.url(), refsAvailable: false, googleSerp: true };
        }

        if (isGoogleSearch && await isGoogleSearchBlocked(tabState.page)) {
          return { ok: false, tabId, url: tabState.page.url(), refsAvailable: false, googleBlocked: true };
        }
        
        tabState.refs = await buildRefs(tabState.page);
        return { ok: true, tabId, url: tabState.page.url(), refsAvailable: tabState.refs.size > 0 };
      }, requestTimeoutMs());
    })(), requestTimeoutMs(), 'navigate'));
    
    {
      const session = sessions.get(normalizeUserId(req.body.userId));
      const found = session && findTab(session, tabId);
      if (found?.tabState) {
        updateTabRecoveryMeta(found.tabState, { userId: req.body.userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, siteKey: req.body.siteKey, task_id: req.body.task_id || req.body.taskId });
        recordTabAction(found.tabState, { kind: 'navigate', url: result.url || req.body.url, result });
      }
    }
    log('info', 'navigated', { reqId: req.reqId, tabId, url: result.url });
    pluginEvents.emit('tab:navigated', { userId: req.body.userId, tabId, url: result.url, prevUrl: null });
    res.json(result);
  } catch (err) {
    log('error', 'navigate failed', { reqId: req.reqId, tabId, error: err.message });
    const is400 = err.message && (err.message.startsWith('Blocked URL scheme') || err.message === 'url or macro required');
    if (is400) {
      return res.status(400).json({ error: safeError(err) });
    }
    handleRouteError(err, req, res);
  }
});

// Snapshot
app.get('/tabs/:tabId/snapshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const recoveryHints = {
      userId,
      sessionKey: req.query.sessionKey || req.query.listItemId,
      profileDir: req.query.profileDir,
      siteKey: req.query.siteKey,
      task_id: req.query.task_id || req.query.taskId,
    };
    const format = req.query.format || 'text';
    const offset = parseInt(req.query.offset) || 0;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { ...recoveryHints, sessionKey: recoveryHints.sessionKey || found.listItemId, tabId: req.params.tabId, profileDir: recoveryHints.profileDir || session.profileDir });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;

    const includeScreenshot = req.query.includeScreenshot === 'true';
    const full = req.query.full === 'true';
    const currentUrl = tabState.page.url();

    if (!includeScreenshot && offset === 0 && tabState.lastSnapshot && tabState.lastSnapshotUrl === currentUrl && tabState.lastSnapshotFull === full) {
      const win = windowSnapshot(tabState.lastSnapshot, 0);
      const response = { url: currentUrl, snapshot: win.text, refsCount: tabState.refs.size, truncated: win.truncated, totalChars: win.totalChars, hasMore: win.hasMore, nextOffset: win.nextOffset };
      recordTabAction(tabState, { kind: 'snapshot', full, includeScreenshot, offset, result: { ok: true, ...response, title: await tabState.page.title().catch(() => '') } });
      log('info', 'snapshot (cached)', { reqId: req.reqId, tabId: req.params.tabId, totalChars: win.totalChars });
      return res.json(response);
    }

    // Cached chunk retrieval for offset>0 requests
    if (offset > 0 && tabState.lastSnapshot && tabState.lastSnapshotFull === full) {
      const win = windowSnapshot(tabState.lastSnapshot, offset);
      const response = { url: currentUrl, snapshot: win.text, refsCount: tabState.refs.size, truncated: win.truncated, totalChars: win.totalChars, hasMore: win.hasMore, nextOffset: win.nextOffset };
      if (includeScreenshot) {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }
      recordTabAction(tabState, { kind: 'snapshot', full, includeScreenshot, offset, result: { ok: true, ...response, title: await tabState.page.title().catch(() => '') } });
      log('info', 'snapshot (cached offset)', { reqId: req.reqId, tabId: req.params.tabId, offset, totalChars: win.totalChars });
      return res.json(response);
    }

    const result = await withUserLimit(userId, () => withTimeout((async () => {
      if (proxyPool?.canRotateSessions && isGoogleSearchUrl(tabState.lastRequestedUrl || '')) {
        const blocked = await isGoogleSearchBlocked(tabState.page);
        const unavailable = !blocked && await isGoogleUnavailable(tabState.page);
        if (blocked || unavailable) {
          const rotated = await rotateGoogleTab(userId, found.listItemId, req.params.tabId, tabState, blocked ? 'google_search_block_snapshot' : 'google_search_unavailable_snapshot', req.reqId);
          if (rotated) {
            tabState.page = rotated.tabState.page;
            tabState.refs = rotated.tabState.refs;
            tabState.visitedUrls = rotated.tabState.visitedUrls;
            tabState.downloads = rotated.tabState.downloads;
            tabState.toolCalls = rotated.tabState.toolCalls;
            tabState.consecutiveTimeouts = rotated.tabState.consecutiveTimeouts;
            tabState.lastSnapshot = rotated.tabState.lastSnapshot;
            tabState.lastSnapshotFull = rotated.tabState.lastSnapshotFull;
            tabState.lastRequestedUrl = rotated.tabState.lastRequestedUrl;
            attachPageDiagnostics(tabState, tabState.page);
            tabState.googleRetryCount = rotated.tabState.googleRetryCount;
          }
        }
      }

      const pageUrl = tabState.page.url();
      
      // Google SERP fast path — DOM extraction instead of ariaSnapshot
      if (isGoogleSerp(pageUrl)) {
        const { refs: googleRefs, snapshot: googleSnapshot } = await extractGoogleSerp(tabState.page);
        tabState.refs = googleRefs;
        tabState.lastSnapshotUrl = pageUrl;
        const annotatedYaml = full ? googleSnapshot : compactSnapshot(googleSnapshot);
        tabState.lastSnapshot = annotatedYaml;
        tabState.lastSnapshotFull = full;
        snapshotBytes.labels('google_serp').observe(Buffer.byteLength(annotatedYaml, 'utf8'));
        const win = windowSnapshot(annotatedYaml, offset);
        const response = {
          url: pageUrl,
          snapshot: win.text,
          refsCount: tabState.refs.size,
          truncated: win.truncated,
          totalChars: win.totalChars,
          hasMore: win.hasMore,
          nextOffset: win.nextOffset,
        };
        if (includeScreenshot) {
          const pngBuffer = await tabState.page.screenshot({ type: 'png' });
          response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
        }
        return response;
      }
      
      tabState.refs = await refreshTabRefs(tabState, { reason: 'snapshot' });
      const ariaYaml = await getAriaSnapshot(tabState.page);
      
      let annotatedYaml = annotateAriaSnapshot(ariaYaml, tabState.refs);
      if (!full) annotatedYaml = compactSnapshot(annotatedYaml);

      tabState.lastSnapshot = annotatedYaml;
      tabState.lastSnapshotFull = full;
      tabState.lastSnapshotUrl = tabState.page.url();
      if (annotatedYaml) snapshotBytes.labels(full ? 'full' : 'compact').observe(Buffer.byteLength(annotatedYaml, 'utf8'));
      const win = windowSnapshot(annotatedYaml, offset);

      const response = {
        url: tabState.page.url(),
        snapshot: win.text,
        refsCount: tabState.refs.size,
        truncated: win.truncated,
        totalChars: win.totalChars,
        hasMore: win.hasMore,
        nextOffset: win.nextOffset,
      };

      if (includeScreenshot) {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }

      return response;
    })(), requestTimeoutMs(), 'snapshot'));

    recordTabAction(tabState, { kind: 'snapshot', full, includeScreenshot, offset, result: { ok: true, ...result, title: await tabState.page.title().catch(() => '') } });
    pluginEvents.emit('tab:snapshot', { userId: req.query.userId, tabId: req.params.tabId, snapshot: result.snapshot });
    log('info', 'snapshot', { reqId: req.reqId, tabId: req.params.tabId, url: result.url, snapshotLen: result.snapshot?.length, refsCount: result.refsCount, hasScreenshot: !!result.screenshot, truncated: result.truncated });
    res.json(result);
  } catch (err) {
    log('error', 'snapshot failed', { reqId: req.reqId, tabId: req.params.tabId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Wait for page ready
app.post('/tabs/:tabId/wait', async (req, res) => {
  try {
    const { userId, timeout = 10000, waitForNetwork = true } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId: req.params.tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    const ready = await waitForPageReady(tabState.page, { timeout, waitForNetwork });
    const result = { ok: true, ready, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
    recordTabAction(tabState, { kind: 'wait', timeout, waitForNetwork, result });
    
    res.json(result);
  } catch (err) {
    log('error', 'wait failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Click
app.post('/tabs/:tabId/click', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector, humanProfile = 'fast' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    if (!ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required' });
    }
    
    let targetSummary = targetContextFromRef(tabState, ref);
    const result = await withUserLimit(userId, () => withTabLock(tabId, async () => {
      const clickStart = Date.now();
      const clickDeadlineAt = clickStart + HANDLER_TIMEOUT_MS - 2500;
      const remainingBudget = () => Math.max(0, clickDeadlineAt - Date.now());
      const clickPhaseLog = (phase, extra = {}) => log('info', `click phase ${phase}`, { reqId: req.reqId, tabId, elapsed: Date.now() - clickStart, budget: remainingBudget(), ...extra });
      const onGoogleSerp = isGoogleSerp(tabState.page.url());
      const sourcePage = tabState.page;
      const popupPromise = sourcePage.waitForEvent('popup', { timeout: 1500 }).catch(() => null);

      const resolveLocator = async () => {
        if (ref) {
          let locator = refToLocator(tabState.page, ref, tabState.refs);
          if (!locator) {
            log('info', 'auto-refreshing refs before click', { ref, hadRefs: tabState.refs.size });
            try {
              const preClickBudget = Math.min(4000, remainingBudget());
              tabState.refs = await refreshTabRefs(tabState, { reason: 'pre_click', timeoutMs: preClickBudget });
            } catch (e) {
              if (e.message === 'pre_click_refs_timeout' || e.message === 'buildRefs_timeout') {
                log('warn', 'pre-click buildRefs timed out, proceeding without refresh');
              } else {
                throw e;
              }
            }
            locator = refToLocator(tabState.page, ref, tabState.refs);
          }
          if (!locator) {
            const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none';
            throw new StaleRefsError(ref, maxRef, tabState.refs.size);
          }
          targetSummary = targetSummary || targetContextFromRef(tabState, ref);
          return locator;
        }
        return tabState.page.locator(selector);
      };

      const locator = await resolveLocator();
      clickPhaseLog('locator_resolved', { onGoogleSerp });
      if (onGoogleSerp) {
        await locator.click({ timeout: 3000, force: true });
      } else {
        clickPhaseLog('prepare_start');
        try {
          await withActionTimeout(
            humanPrepareTarget(tabState.page, locator, {
              profile: humanProfile,
              viewport: tabState.humanSession?.viewport,
              behaviorPersona: tabState.humanSession?.behaviorPersona,
              timeout: Math.min(1000, remainingBudget()),
              boxTimeout: 500,
              scrollTimeout: 1000,
              allowBoundingBoxFallback: true,
              preferBoundingBox: true,
              skipReadingPause: true,
            }),
            Math.min(1500, remainingBudget()),
            'click prepare timed out'
          );
          clickPhaseLog('prepare_done');
        } catch (err) {
          clickPhaseLog('prepare_skipped', { error: err.message });
        }
        clickPhaseLog('human_click_start', { cursor: getHumanCursor(tabState.humanSession) });
        const clickResult = await withActionTimeout(
          humanClick(tabState.page, locator, {
            profile: humanProfile,
            from: getHumanCursor(tabState.humanSession),
            viewport: tabState.humanSession?.viewport,
            timeout: Math.min(5000, remainingBudget()),
            moveTimeout: 150,
            mouseTimeout: 700,
            allowBoundingBoxFallback: true,
            preferBoundingBox: true,
            allowLocatorClickFallback: true,
            allowKeyboardActivateFallback: true,
            deadlineAt: clickDeadlineAt,
          }),
          Math.min(8000, remainingBudget()),
          'human click timed out'
        );
        clickPhaseLog('human_click_done', { position: clickResult.position });
        updateHumanCursor(tabState.humanSession, clickResult.cursor || clickResult.position);
      }

      const popupPage = await Promise.race([
        popupPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 1600)),
      ]);
      if (popupPage && !popupPage.isClosed()) {
        const adoptedPopup = await adoptPopupIntoTab(tabState, popupPage, { previousPage: sourcePage });
        return {
          ok: true,
          url: adoptedPopup?.url || tabState.page.url(),
          title: adoptedPopup?.title || '',
          refsAvailable: false,
          popupAdopted: true,
        };
      }
      
      if (onGoogleSerp) {
        try {
          await tabState.page.waitForLoadState('domcontentloaded', { timeout: 3000 });
        } catch {}
        await tabState.page.waitForTimeout(200);
        invalidateTabSnapshot(tabState);
        tabState.refs = new Map();
        const newUrl = tabState.page.url();
        tabState.visitedUrls.add(newUrl);
        return { ok: true, url: newUrl, refsAvailable: false };
      }
      invalidateTabSnapshot(tabState);
      const postClickBudget = Math.max(2000, remainingBudget());
      try {
        tabState.refs = await refreshTabRefs(tabState, { reason: 'post_click', timeoutMs: postClickBudget });
      } catch (e) {
        if (e.message === 'post_click_refs_timeout' || e.message === 'buildRefs_timeout') {
          log('warn', 'post-click buildRefs timed out, returning without refs', { budget: postClickBudget, elapsed: Date.now() - clickStart });
          tabState.refs = new Map();
        } else {
          throw e;
        }
      }
      
      const newUrl = tabState.page.url();
      tabState.visitedUrls.add(newUrl);
      return { ok: true, url: newUrl, refsAvailable: tabState.refs.size > 0 };
    }));
    
    recordTabAction(tabState, { kind: 'click', ref: req.body.ref, selector: req.body.selector, target_summary: targetSummary, result });
    log('info', 'clicked', { reqId: req.reqId, tabId, url: result.url });
    pluginEvents.emit('tab:click', { userId: req.body.userId, tabId, ref: req.body.ref, selector: req.body.selector });
    res.json(result);
  } catch (err) {
    log('error', 'click failed', { reqId: req.reqId, tabId, error: err.message });
    if (err.message?.includes('timed out')) {
      try {
        const session = sessions.get(normalizeUserId(req.body.userId));
        const found = session && findTab(session, tabId);
        if (found?.tabState?.page && !found.tabState.page.isClosed()) {
          found.tabState.refs = await refreshTabRefs(found.tabState, { reason: 'click_timeout' });
          invalidateTabSnapshot(found.tabState);
          return res.status(500).json({
            error: safeError(err),
            hint: 'The page may have changed. Call snapshot to see the current state and retry.',
            url: found.tabState.page.url(),
            refsCount: found.tabState.refs.size,
          });
        }
      } catch (refreshErr) {
        log('warn', 'post-timeout refresh failed', { error: refreshErr.message });
      }
    }
    handleRouteError(err, req, res);
  }
});

// Type
app.post('/tabs/:tabId/type', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, ref, selector, text, mode = 'fill', delay = 30, submit = false, pressEnter = false, humanProfile = 'fast', clearFirst = true } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    if (mode !== 'fill' && mode !== 'keyboard') {
      return res.status(400).json({ error: "mode must be 'fill' or 'keyboard'" });
    }
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' });
    }
    // keyboard mode: ref/selector are optional (types into current focus)
    if (mode === 'fill' && !ref && !selector) {
      return res.status(400).json({ error: 'ref or selector required for mode=fill' });
    }
    const shouldSubmit = submit || pressEnter;
    let targetSummary = targetContextFromRef(tabState, ref);
    
    await withTabLock(tabId, async () => {
      // Resolve and focus the target if ref/selector provided
      let locator = null;
      if (ref) {
        locator = refToLocator(tabState.page, ref, tabState.refs);
        if (!locator) {
          log('info', 'auto-refreshing refs before type', { ref, hadRefs: tabState.refs.size, mode });
          tabState.refs = await refreshTabRefs(tabState, { reason: 'type' });
          locator = refToLocator(tabState.page, ref, tabState.refs);
        }
        if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
        targetSummary = targetSummary || targetContextFromRef(tabState, ref);
      }
      
      if (!locator && selector) {
        locator = tabState.page.locator(selector);
      }

      if (locator) {
        try {
          await withActionTimeout(
            humanPrepareTarget(tabState.page, locator, {
              profile: humanProfile,
              viewport: tabState.humanSession?.viewport,
              behaviorPersona: tabState.humanSession?.behaviorPersona,
              timeout: 1000,
              boxTimeout: 500,
              scrollTimeout: 1000,
              allowBoundingBoxFallback: true,
              preferBoundingBox: true,
              skipReadingPause: true,
            }),
            1500,
            'type prepare timed out'
          );
        } catch (err) {
          log('info', 'type prepare skipped', { reqId: req.reqId, tabId, error: err.message });
        }
      }

      if (mode === 'fill') {
        if (!locator) {
          throw new Error('ref or selector required for mode=fill');
        }
        await humanType(tabState.page, locator, text, {
          profile: humanProfile,
          clearFirst,
          mistakesRate: 0,
          timeout: 1000,
          allowDomFocusFallback: true,
        });
      } else {
        if (locator) {
          await humanType(tabState.page, locator, text, {
            profile: humanProfile,
            clearFirst: false,
            mistakesRate: 0,
            timeout: 1000,
            allowDomFocusFallback: true,
          });
        } else {
          await humanType(tabState.page, locator || null, text, { profile: humanProfile, clearFirst: false, mistakesRate: 0 });
        }
      }
      if (shouldSubmit) await humanPress(tabState.page, 'Enter', { profile: humanProfile });
      invalidateTabSnapshot(tabState);
      await tabState.page.waitForTimeout(50).catch(() => undefined);
    });
    
    const result = { ok: true, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
    recordTabAction(tabState, { kind: 'type', ref, selector, text, target_summary: targetSummary, result });
    pluginEvents.emit('tab:type', { userId: req.body.userId, tabId, text: req.body.text, ref: req.body.ref, mode: req.body.mode || 'fill' });
    res.json(result);
  } catch (err) {
    log('error', 'type failed', { reqId: req.reqId, error: err.message });
    if (err.message?.includes('timed out') || err.message?.includes('not an <input>')) {
      try {
        const session = sessions.get(normalizeUserId(req.body.userId));
        const found = session && findTab(session, tabId);
        if (found?.tabState?.page && !found.tabState.page.isClosed()) {
          found.tabState.refs = await refreshTabRefs(found.tabState, { reason: 'type_timeout' });
          invalidateTabSnapshot(found.tabState);
          return res.status(500).json({
            error: safeError(err),
            hint: 'The page may have changed. Call snapshot to see the current state and retry.',
            url: found.tabState.page.url(),
            refsCount: found.tabState.refs.size,
          });
        }
      } catch (refreshErr) {
        log('warn', 'post-timeout refresh failed', { error: refreshErr.message });
      }
    }
    handleRouteError(err, req, res);
  }
});

// Press key
app.post('/tabs/:tabId/press', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId, key, humanProfile = 'fast' } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    await withTabLock(tabId, async () => {
      await humanPress(tabState.page, key, { profile: humanProfile });
    });
    
    const result = { ok: true, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
    recordTabAction(tabState, { kind: 'press', key, result });
    pluginEvents.emit('tab:press', { userId, tabId, key });
    res.json(result);
  } catch (err) {
    log('error', 'press failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Scroll
app.post('/tabs/:tabId/scroll', async (req, res) => {
  try {
    const { userId, direction = 'down', amount = 500, humanProfile = 'fast' } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId: req.params.tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    await humanScroll(tabState.page, { direction, amount, profile: humanProfile });
    
    const result = { ok: true, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
    recordTabAction(tabState, { kind: 'scroll', direction, amount, result });
    pluginEvents.emit('tab:scroll', { userId, tabId: req.params.tabId, direction, amount });
    res.json(result);
  } catch (err) {
    log('error', 'scroll failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Back
app.post('/tabs/:tabId/back', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    const result = await withTabLock(tabId, async () => {
      try {
        await tabState.page.goBack({ timeout: 10000 });
      } catch (navErr) {
        // NS_BINDING_CANCELLED_OLD_LOAD: Firefox cancels the old load when going back.
        // The navigation itself succeeded — just the prior page's load was interrupted.
        if (navErr.message && navErr.message.includes('NS_BINDING_CANCELLED')) {
          log('info', 'goBack cancelled old load (expected)', { reqId: req.reqId, tabId });
        } else {
          throw navErr;
        }
      }
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    recordTabAction(tabState, { kind: 'back', result: { ...result, title: await tabState.page.title().catch(() => '') } });
    res.json(result);
  } catch (err) {
    log('error', 'back failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Forward
app.post('/tabs/:tabId/forward', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;

    const result = await withTabLock(tabId, async () => {
      await tabState.page.goForward({ timeout: 10000 });
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    recordTabAction(tabState, { kind: 'forward', result: { ...result, title: await tabState.page.title().catch(() => '') } });
    res.json(result);
  } catch (err) {
    log('error', 'forward failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Refresh
app.post('/tabs/:tabId/refresh', async (req, res) => {
  const tabId = req.params.tabId;
  
  try {
    const { userId } = req.body;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;

    const result = await withTabLock(tabId, async () => {
      await Promise.all([
        tabState.page.waitForLoadState('load', { timeout: 30000 }).catch(() => undefined),
        tabState.page.reload({ timeout: 30000 }),
      ]);
      invalidateTabSnapshot(tabState);
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, url: tabState.page.url() };
    });
    
    recordTabAction(tabState, { kind: 'refresh', result: { ...result, title: await tabState.page.title().catch(() => '') } });
    res.json(result);
  } catch (err) {
    log('error', 'refresh failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Get links
app.get('/tabs/:tabId/links', async (req, res) => {
  try {
    const userId = req.query.userId;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) {
      log('warn', 'links: tab not found', { reqId: req.reqId, tabId: req.params.tabId, userId, hasSession: !!session });
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    const allLinks = await tabState.page.evaluate(() => {
      const links = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        const text = a.textContent?.trim().slice(0, 100) || '';
        if (href && href.startsWith('http')) {
          links.push({ url: href, text });
        }
      });
      return links;
    });
    
    const total = allLinks.length;
    const paginated = allLinks.slice(offset, offset + limit);
    
    res.json({
      links: paginated,
      pagination: { total, offset, limit, hasMore: offset + limit < total }
    });
  } catch (err) {
    log('error', 'links failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Get captured downloads
app.get('/tabs/:tabId/downloads', async (req, res) => {
  try {
    const userId = req.query.userId;
    const includeData = req.query.includeData === 'true';
    const consume = req.query.consume === 'true';
    const maxBytesRaw = Number(req.query.maxBytes);
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : MAX_DOWNLOAD_INLINE_BYTES;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    tabState.toolCalls++;

    const downloads = await getDownloadsList(tabState, { includeData, maxBytes });

    if (consume) {
      await clearTabDownloads(tabState);
    }

    res.json({ tabId: req.params.tabId, downloads });
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'downloads').inc();
    log('error', 'downloads failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Get console/pageerror diagnostics
app.get('/tabs/:tabId/diagnostics', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const clear = req.query.clear === 'true';
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    res.json(diagnosticsResponse(found.tabState, clear));
  } catch (err) {
    log('error', 'diagnostics failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Get image elements from current page
app.get('/tabs/:tabId/images', async (req, res) => {
  try {
    const userId = req.query.userId;
    const includeData = req.query.includeData === 'true';
    const maxBytesRaw = Number(req.query.maxBytes);
    const limitRaw = Number(req.query.limit);
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : MAX_DOWNLOAD_INLINE_BYTES;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 20) : 8;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId: req.params.tabId, profileDir: session.profileDir, task_id: req.query.task_id || req.query.taskId, siteKey: req.query.siteKey });
    tabState.toolCalls++;

    const images = await extractPageImages(tabState.page, { includeData, maxBytes, limit });
    const result = { ok: true, tabId: req.params.tabId, images, url: tabState.page.url(), title: await tabState.page.title().catch(() => '') };
    recordTabAction(tabState, { kind: 'images', includeData, maxBytes, limit, result });

    res.json({ tabId: req.params.tabId, images });
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'images').inc();
    log('error', 'images failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Screenshot
app.get('/tabs/:tabId/screenshot', async (req, res) => {
  try {
    const userId = req.query.userId;
    const fullPage = req.query.fullPage === 'true';
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId: req.params.tabId, profileDir: session.profileDir, task_id: req.query.task_id || req.query.taskId, siteKey: req.query.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    const buffer = await tabState.page.screenshot({ type: 'png', fullPage });
    recordTabAction(tabState, { kind: 'screenshot', fullPage, result: { ok: true, url: tabState.page.url(), title: await tabState.page.title().catch(() => ''), mimeType: 'image/png', bytes: buffer.length } });
    pluginEvents.emit('tab:screenshot', { userId, tabId: req.params.tabId, buffer });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    log('error', 'screenshot failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Stats
app.get('/tabs/:tabId/stats', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    
    const { tabState, listItemId } = found;
    res.json({
      tabId: req.params.tabId,
      sessionKey: listItemId,
      listItemId, // Legacy compatibility
      url: tabState.page.url(),
      visitedUrls: Array.from(tabState.visitedUrls),
      downloadsCount: Array.isArray(tabState.downloads) ? tabState.downloads.length : 0,
      toolCalls: tabState.toolCalls,
      refsCount: tabState.refs.size
    });
  } catch (err) {
    log('error', 'stats failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Evaluate JavaScript in page context
app.post('/tabs/:tabId/evaluate', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { userId, expression } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!expression) return res.status(400).json({ error: 'expression is required' });

    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });

    session.lastAccess = Date.now();
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId: req.params.tabId, profileDir: session.profileDir, task_id: req.body.task_id || req.body.taskId, siteKey: req.body.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;

    pluginEvents.emit('tab:evaluate', { userId, tabId: req.params.tabId, expression });
    const result = await tabState.page.evaluate(expression);
    const response = { ok: true, result };
    recordTabAction(tabState, {
      kind: 'evaluate',
      expression,
      replaySafe: req.body.replaySafe === true || req.body.replay_safe === true,
      result: { ok: true, url: tabState.page.url(), title: await tabState.page.title().catch(() => ''), resultType: typeof result },
    });
    pluginEvents.emit('tab:evaluated', { userId, tabId: req.params.tabId, result });
    log('info', 'evaluate', { reqId: req.reqId, tabId: req.params.tabId, userId, resultType: typeof result });
    res.json(response);
  } catch (err) {
    failuresTotal.labels(classifyError(err), 'evaluate').inc();
    log('error', 'evaluate failed', { reqId: req.reqId, error: err.message });
    res.status(500).json({ error: safeError(err) });
  }
});

// Close tab
app.delete('/tabs/:tabId', async (req, res) => {
  try {
    const userId = req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required (query or body)' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, req.params.tabId);
    if (found) {
      if (found.tabState.navigateAbort) found.tabState.navigateAbort.abort();
      recordTabAction(found.tabState, { kind: 'close', reason: 'api_delete_tab', result: { ok: true, url: found.tabState.page?.url?.() || '', title: await found.tabState.page?.title?.().catch(() => '') } });
      markTabRecoveryClosed(found.tabState, { reason: 'api_delete_tab', url: found.tabState.page?.url?.() || undefined, title: await found.tabState.page?.title?.().catch(() => '') || undefined });
      await clearTabDownloads(found.tabState);
      await safePageClose(found.tabState.page);
      found.group.delete(req.params.tabId);
      { const _l = tabLocks.get(req.params.tabId); if (_l) _l.drain(); tabLocks.delete(req.params.tabId); refreshTabLockQueueDepth(); }
      if (found.group.size === 0) {
        session.tabGroups.delete(found.listItemId);
      }
      refreshActiveTabsGauge();
      log('info', 'tab closed', { reqId: req.reqId, tabId: req.params.tabId, userId });
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'tab close failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Close tab group
app.delete('/tabs/group/:listItemId', async (req, res) => {
  try {
    const userId = req.query.userId || req.body?.userId;
    if (!userId) return res.status(400).json({ error: 'userId required (query or body)' });
    const session = sessions.get(normalizeUserId(userId));
    const group = session?.tabGroups.get(req.params.listItemId);
    if (group) {
      for (const [tabId, tabState] of group) {
        markTabRecoveryClosed(tabState, { reason: 'api_delete_group', url: tabState.page?.url?.() || undefined, title: await tabState.page?.title?.().catch(() => '') || undefined });
        await clearTabDownloads(tabState);
        await safePageClose(tabState.page);
        const lock = tabLocks.get(tabId);
        if (lock) {
          lock.drain();
          tabLocks.delete(tabId);
        }
      }
      session.tabGroups.delete(req.params.listItemId);
      refreshTabLockQueueDepth();
      refreshActiveTabsGauge();
      log('info', 'tab group closed', { reqId: req.reqId, listItemId: req.params.listItemId, userId });
    }
    res.json({ ok: true });
  } catch (err) {
    log('error', 'tab group close failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Close session
app.delete('/sessions/:userId', async (req, res) => {
  try {
    const userId = normalizeUserId(req.params.userId);
    const session = sessions.get(userId);
    if (session) {
      await closeSession(userId, session, { reason: 'api_delete_session', clearDownloads: true, clearLocks: true });
      log('info', 'session closed', { userId });
    }
    scheduleBrowserIdleShutdown(userId);
    res.json({ ok: true });
  } catch (err) {
    log('error', 'session close failed', { error: err.message });
    handleRouteError(err, req, res);
  }
});

// Cleanup stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of Array.from(sessions.entries())) {
    if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
      session._closing = true;
      const idleMs = now - session.lastAccess;
      sessionsExpiredTotal.inc();
      pluginEvents.emit('session:expired', { userId, idleMs });
      closeSession(userId, session, { reason: 'session_timeout', clearDownloads: true, clearLocks: true }).catch(() => {});
      log('info', 'session expired', { userId });
    }
  }
  for (const userId of Array.from(browsers.keys())) scheduleBrowserIdleShutdown(userId);
  refreshTabLockQueueDepth();
}, 60_000);

// Per-tab inactivity reaper — close tabs idle for TAB_INACTIVITY_MS
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions) {
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        if (tabState.keepAlive) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (!tabState._lastReaperCheck) {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
          continue;
        }
        if (tabState.toolCalls === tabState._lastReaperToolCalls) {
          const idleMs = now - tabState._lastReaperCheck;
          if (idleMs >= TAB_INACTIVITY_MS) {
            tabsReapedTotal.inc();
            log('info', 'tab reaped (inactive)', { userId, tabId, listItemId, idleMs, toolCalls: tabState.toolCalls });
            markTabRecoveryClosed(tabState, { reason: 'tab_inactivity_reaper', url: tabState.page?.url?.() || undefined });
            safePageClose(tabState.page);
            group.delete(tabId);
            { const _l = tabLocks.get(tabId); if (_l) _l.drain(); tabLocks.delete(tabId); }
            refreshTabLockQueueDepth();
            refreshActiveTabsGauge();
          }
        } else {
          tabState._lastReaperCheck = now;
          tabState._lastReaperToolCalls = tabState.toolCalls;
        }
      }
      if (group.size === 0) {
        session.tabGroups.delete(listItemId);
      }
    }
    // Clean up sessions with zero tabs remaining — free browser context memory
    if (session.tabGroups.size === 0) {
      session._closing = true;
      log('info', 'session empty after tab reaper, closing', { userId });
      closeSession(userId, session, { reason: 'tab_reaper_empty_session', clearDownloads: true, clearLocks: true }).catch(() => {});
      sessionsExpiredTotal.inc();
    }
  }
  for (const userId of Array.from(browsers.keys())) scheduleBrowserIdleShutdown(userId);
}, 60_000);

// =============================================================================
// OpenClaw-compatible endpoint aliases
// These allow camoufox to be used as a profile backend for OpenClaw's browser tool
// =============================================================================

// GET / - Status (passive — does not launch browser)
app.get('/', (req, res) => {
  const running = getConnectedBrowserCount() > 0;
  res.json({ 
    ok: true,
    enabled: true,
    running,
    engine: 'camoufox',
    browserConnected: running,
    browserRunning: running,
    activeBrowsers: getConnectedBrowserCount(),
  });
});

app.post('/memory/record', async (req, res) => {
  try {
    const { userId, tabId, targetId, siteKey, actionKey = 'default', aliases = [], labels = [] } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!siteKey) return res.status(400).json({ error: 'siteKey is required' });
    const resolvedTabId = tabId || targetId;
    if (!resolvedTabId) return res.status(400).json({ error: 'tabId or targetId is required' });
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, resolvedTabId);
    if (!found) return res.status(404).json({ error: 'Tab not found' });
    const saved = await recordAgentHistoryFlow(found.tabState, siteKey, actionKey, { aliases, labels });
    res.json({ ok: true, path: saved.path, siteKey, actionKey });
  } catch (err) {
    log('error', 'agent history record endpoint failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

app.get('/memory/search', async (req, res) => {
  try {
    const siteKey = req.query?.siteKey;
    const query = req.query?.q || req.query?.query || '';
    if (!siteKey) return res.status(400).json({ error: 'siteKey is required' });
    const results = await searchFlows({ siteKey, query });
    res.json({ ok: true, results });
  } catch (err) {
    log('error', 'agent history search endpoint failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

app.delete('/memory/delete', async (req, res) => {
  try {
    const siteKey = req.query?.siteKey || req.body?.siteKey;
    const actionKey = req.query?.actionKey || req.body?.actionKey || 'default';
    if (!siteKey) return res.status(400).json({ error: 'siteKey is required' });
    const result = await deleteAgentHistoryFlow(siteKey, actionKey);
    res.json(result);
  } catch (err) {
    log('error', 'agent history delete endpoint failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

app.post('/memory/replay', async (req, res) => {
  try {
    const { userId, tabId, targetId, siteKey, actionKey = 'default', learnRepairs = false, parameters = {} } = req.body || {};
    const allowLlmFallback = explicitAllowLlmRepair(req.body || {});
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!siteKey) return res.status(400).json({ error: 'siteKey is required' });
    const resolvedTabId = tabId || targetId || fly.makeTabId();
    const session = await getSession(userId);
    let found = findTab(session, resolvedTabId);
    if (!found) {
      const page = await session.context.newPage();
      const tabState = createTabState(page, { userId, sessionKey: 'default', tabId: resolvedTabId });
      attachDownloadListener(tabState, resolvedTabId, log, pluginEvents, userId);
      getTabGroup(session, 'default').set(resolvedTabId, tabState);
      refreshActiveTabsGauge();
      found = findTab(session, resolvedTabId);
    }
    const { tabState } = found;
    const loaded = await loadAgentHistory(siteKey, actionKey);
    const steps = loaded.payload?.hermes_meta?.derived_flow?.steps || [];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`AgentHistory flow has no replayable steps for ${siteKey}/${actionKey}`);
    }
    const replayRefreshRefs = async (reason = 'memory_replay_refresh') => {
      invalidateTabSnapshot(tabState);
      tabState.refs = await refreshTabRefs(tabState, { reason });
      return tabState.refs;
    };
    const replayHandlers = createMemoryReplayHandlers({
      tabState,
      refreshRefs: replayRefreshRefs,
      waitForPageReady,
    });
    let learned = false;
    let learnedPath;
    const learnedPayloads = [];
    const replay = await replayStepsSelfHealing(steps, {
      handlers: {
        ...replayHandlers,
        navigate: async (step) => {
          await tabState.page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          invalidateTabSnapshot(tabState);
          tabState.refs = await buildRefs(tabState.page);
          return { ok: true, url: tabState.page.url() };
        },
        click: async (step) => {
          const locator = step.ref ? refToLocator(tabState.page, step.ref, tabState.refs) : tabState.page.locator(step.selector);
          if (!locator) return { ok: false, error: `Ref not found: ${step.ref}` };
          await humanPrepareTarget(tabState.page, locator, {
            behaviorPersona: tabState.humanSession?.behaviorPersona,
            viewport: tabState.humanSession?.viewport,
          });
          const clickResult = await humanClick(tabState.page, locator, {
            profile: req.body.humanProfile || 'fast',
            from: getHumanCursor(tabState.humanSession),
            viewport: tabState.humanSession?.viewport,
          });
          updateHumanCursor(tabState.humanSession, clickResult.position);
          await tabState.page.waitForTimeout(500);
          invalidateTabSnapshot(tabState);
          tabState.refs = await buildRefs(tabState.page);
          return { ok: true, url: tabState.page.url() };
        },
        type: async (step) => {
          const locator = step.ref ? refToLocator(tabState.page, step.ref, tabState.refs) : tabState.page.locator(step.selector);
          if (!locator) return { ok: false, error: `Ref not found: ${step.ref}` };
          await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
          await humanType(tabState.page, locator, step.text, {
            profile: req.body.humanProfile || 'fast',
            clearFirst: true,
            mistakesRate: 0,
          });
          invalidateTabSnapshot(tabState);
          return { ok: true, url: tabState.page.url() };
        },
        press: async (step) => {
          await humanPress(tabState.page, step.key, { profile: req.body.humanProfile || 'fast' });
          invalidateTabSnapshot(tabState);
          return { ok: true, url: tabState.page.url() };
        },
        scroll: async (step) => {
          await humanScroll(tabState.page, {
            direction: step.direction || 'down',
            amount: step.amount || 500,
            profile: req.body.humanProfile || 'fast',
          });
          invalidateTabSnapshot(tabState);
          return { ok: true, url: tabState.page.url() };
        },
        back: async () => {
          await tabState.page.goBack({ timeout: 10000 }).catch(() => {});
          tabState.refs = await buildRefs(tabState.page);
          return { ok: true, url: tabState.page.url() };
        },
      },
      refreshRefs: async () => {
        await replayRefreshRefs('memory_replay_repair');
      },
      getCandidates: async () => candidatesFromRefs(tabState.refs),
      detectInterrupt: async () => detectInterrupt({
        url: tabState.page.url(),
        title: await tabState.page.title().catch(() => ''),
        text: await tabState.page.evaluate(() => document.body?.innerText?.slice(0, 1500) || '').catch(() => ''),
      }),
      adaptivePacing: (interrupt) => adaptivePacingForInterrupt(interrupt, {
        profile: req.body.humanProfile || 'medium',
        consecutiveInterrupts: tabState.consecutiveTimeouts,
      }),
      waitForPacing: async (delayMs) => {
        await tabState.page.waitForTimeout(Math.min(delayMs, 3000));
      },
      resolveInterrupt: async (interrupt) => {
        if (interrupt?.type !== 'cookie_banner') return { ok: true, skipped: true };
        tabState.refs = await refreshTabRefs(tabState, { reason: 'memory_replay_interrupt' });
        const candidate = chooseCookieConsentCandidate(candidatesFromRefs(tabState.refs));
        if (!candidate?.ref) return { ok: false, error: 'No cookie consent candidate found' };
        const locator = refToLocator(tabState.page, candidate.ref, tabState.refs);
        if (!locator) return { ok: false, error: `Ref not found: ${candidate.ref}` };
        await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
        const clickResult = await humanClick(tabState.page, locator, {
          profile: req.body.humanProfile || 'fast',
          from: getHumanCursor(tabState.humanSession),
        });
        updateHumanCursor(tabState.humanSession, clickResult.position);
        await tabState.page.waitForTimeout(500);
        tabState.refs = await refreshTabRefs(tabState, { reason: 'memory_replay_interrupt_resolved' });
        return { ok: true, ref: candidate.ref, type: interrupt.type };
      },
      validate: async (expected) => validateOutcome(expected, {
        getUrl: async () => tabState.page.url(),
        getTitle: async () => tabState.page.title(),
        hasText: async (text) => tabState.page.getByText(text).first().isVisible({ timeout: 1000 }).catch(() => false),
        hasSelector: async (selector) => tabState.page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false),
      }),
      parameters,
      learnRepairs,
      learnRepair: async (payload) => {
        const saved = await applyLearnedDomRepair({
          siteKey,
          actionKey,
          sourcePath: loaded.path,
          payload,
        });
        learned = true;
        learnedPath = saved.path;
        learnedPayloads.push(payload);
      },
      ...(allowLlmFallback ? {
        allowLlmFallback: true,
        plannerFallback: createManagedPlannerFallback({ tabState, candidatesFromRefs }),
      } : {}),
    });
    res.json({
      ...replay,
      targetId: resolvedTabId,
      tabId: resolvedTabId,
      url: tabState.page.url(),
      ...(learned ? { learned, learnedPath, learnedRepairs: learnedPayloads.length } : {}),
    });
  } catch (err) {
    log('error', 'agent history replay endpoint failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// GET /tabs - List all tabs (OpenClaw expects this)
app.get('/tabs', async (req, res) => {
  try {
    const userId = req.query.userId;
    const session = sessions.get(normalizeUserId(userId));
    
    if (!session) {
      return res.json({ running: true, tabs: [] });
    }
    
    const tabs = [];
    for (const [listItemId, group] of session.tabGroups) {
      for (const [tabId, tabState] of group) {
        tabs.push({
          targetId: tabId,
          tabId,
          url: tabState.page.url(),
          title: await tabState.page.title().catch(() => ''),
          listItemId
        });
      }
    }
    
    res.json({ running: true, tabs });
  } catch (err) {
    log('error', 'list tabs failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// POST /tabs/open - Open tab (alias for POST /tabs, OpenClaw format)
app.post('/tabs/open', async (req, res) => {
  try {
    const { url, userId, listItemId = 'default' } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }
    
    const urlErr = validateUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });
    
    const session = await getSession(userId);
    
    // Recycle oldest tab when limits are reached instead of rejecting
    let totalTabs = 0;
    for (const g of session.tabGroups.values()) totalTabs += g.size;
    if (totalTabs >= MAX_TABS_PER_SESSION || getTotalTabCount() >= MAX_TABS_GLOBAL) {
      const recycled = await recycleOldestTab(session, req.reqId, userId);
      if (!recycled) {
        return res.status(429).json({ error: 'Maximum tabs per session reached' });
      }
    }
    
    const group = getTabGroup(session, listItemId);
    
    const page = await session.context.newPage();
    const tabId = fly.makeTabId();
    const tabState = createTabState(page, { userId, sessionKey: listItemId, tabId });
    attachDownloadListener(tabState, tabId, log, pluginEvents, userId);
    group.set(tabId, tabState);
    refreshActiveTabsGauge();
    
    await withPageLoadDuration('open_url', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
    tabState.visitedUrls.add(url);
    
    const result = { 
      ok: true,
      targetId: tabId,
      tabId,
      url: page.url(),
      title: await page.title().catch(() => '')
    };
    recordTabAction(tabState, { kind: 'navigate', url: result.url || url, result });
    log('info', 'openclaw tab opened', { reqId: req.reqId, tabId, url: page.url() });
    res.json(result);
  } catch (err) {
    log('error', 'openclaw tab open failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// POST /start - Start browser (OpenClaw expects this)
app.post('/start', async (req, res) => {
  try {
    const userId = normalizeUserId(req.body?.userId || req.query?.userId || 'default');
    await ensureBrowser(userId);
    res.json({ ok: true, profile: 'camoufox' });
  } catch (err) {
    failuresTotal.labels('browser_launch', 'start').inc();
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// POST /stop - Stop browser (OpenClaw expects this)
app.post('/stop', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || !timingSafeCompare(adminKey, CONFIG.adminKey)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const userId = req.body?.userId || req.query?.userId;
    if (userId) {
      const key = normalizeUserId(userId);
      const entry = browsers.get(key);
      if (entry?.browser) {
        await entry.browser.close().catch(() => {});
        entry.browser = null;
      }
    } else {
      for (const entry of browsers.values()) {
        if (entry.browser) {
          await entry.browser.close().catch(() => {});
          entry.browser = null;
        }
      }
    }
    await closeAllSessions('admin_stop', { clearDownloads: true, clearLocks: true });
    res.json({ ok: true, stopped: true, profile: 'camoufox' });
  } catch (err) {
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// POST /navigate - Navigate (OpenClaw format with targetId in body)
app.post('/navigate', async (req, res) => {
  try {
    const { targetId, url, userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }
    
    const urlErr = validateUrl(url);
    if (urlErr) return res.status(400).json({ error: urlErr });
    
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, targetId);
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    const result = await withTabLock(targetId, async () => {
      await withPageLoadDuration('navigate', () => tabState.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }));
      tabState.visitedUrls.add(url);
      invalidateTabSnapshot(tabState);
      
      // Google SERP: defer extraction to snapshot call
      if (isGoogleSerp(tabState.page.url())) {
        tabState.refs = new Map();
        return { ok: true, targetId, url: tabState.page.url(), googleSerp: true };
      }
      
      tabState.refs = await buildRefs(tabState.page);
      return { ok: true, targetId, url: tabState.page.url() };
    });
    
    recordTabAction(tabState, { kind: 'navigate', url: result.url || url, result });
    res.json(result);
  } catch (err) {
    log('error', 'openclaw navigate failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// GET /snapshot - Snapshot (OpenClaw format with query params)
app.get('/snapshot', async (req, res) => {
  try {
    const { targetId, userId, format = 'text' } = req.query;
    const offset = parseInt(req.query.offset) || 0;
    const includeScreenshot = req.query.includeScreenshot === 'true';
    const full = req.query.full === 'true';
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, targetId);
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    updateTabRecoveryMeta(tabState, { userId, sessionKey: found.listItemId, tabId: targetId, profileDir: session.profileDir, task_id: req.query.task_id || req.query.taskId, siteKey: req.query.siteKey });
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;

    // Cached chunk retrieval
    if (offset > 0 && tabState.lastSnapshot && tabState.lastSnapshotFull === full) {
      const win = windowSnapshot(tabState.lastSnapshot, offset);
      const response = { ok: true, format: 'aria', targetId, url: tabState.page.url(), snapshot: win.text, refsCount: tabState.refs.size, truncated: win.truncated, totalChars: win.totalChars, hasMore: win.hasMore, nextOffset: win.nextOffset };
      if (includeScreenshot) {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }
      recordTabAction(tabState, { kind: 'snapshot', full, includeScreenshot, offset, result: { ...response, title: await tabState.page.title().catch(() => '') } });
      return res.json(response);
    }

    const pageUrl = tabState.page.url();
    
    // Google SERP fast path
    if (isGoogleSerp(pageUrl)) {
      const { refs: googleRefs, snapshot: googleSnapshot } = await extractGoogleSerp(tabState.page);
      tabState.refs = googleRefs;
      const annotatedYaml = full ? googleSnapshot : compactSnapshot(googleSnapshot);
      tabState.lastSnapshot = annotatedYaml;
      tabState.lastSnapshotFull = full;
      snapshotBytes.labels('google_serp').observe(Buffer.byteLength(annotatedYaml, 'utf8'));
      tabState.lastSnapshotUrl = pageUrl;
      const win = windowSnapshot(annotatedYaml, offset);
      const response = {
        ok: true, format: 'aria', targetId, url: pageUrl,
        snapshot: win.text, refsCount: tabState.refs.size,
        truncated: win.truncated, totalChars: win.totalChars,
        hasMore: win.hasMore, nextOffset: win.nextOffset,
      };
      if (includeScreenshot) {
        const pngBuffer = await tabState.page.screenshot({ type: 'png' });
        response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
      }
      recordTabAction(tabState, { kind: 'snapshot', full, includeScreenshot, offset, result: { ...response, title: await tabState.page.title().catch(() => '') } });
      return res.json(response);
    }
    
    tabState.refs = await buildRefs(tabState.page);
    
    const ariaYaml = await getAriaSnapshot(tabState.page);
    
    let annotatedYaml = annotateAriaSnapshot(ariaYaml, tabState.refs);
    if (!full) annotatedYaml = compactSnapshot(annotatedYaml);

    tabState.lastSnapshot = annotatedYaml;
    tabState.lastSnapshotFull = full;
    tabState.lastSnapshotUrl = tabState.page.url();
    if (annotatedYaml) snapshotBytes.labels(full ? 'full' : 'compact').observe(Buffer.byteLength(annotatedYaml, 'utf8'));
    const win = windowSnapshot(annotatedYaml, offset);

    const response = {
      ok: true,
      format: 'aria',
      targetId,
      url: tabState.page.url(),
      snapshot: win.text,
      refsCount: tabState.refs.size,
      truncated: win.truncated,
      totalChars: win.totalChars,
      hasMore: win.hasMore,
      nextOffset: win.nextOffset,
    };

    if (includeScreenshot) {
      const pngBuffer = await tabState.page.screenshot({ type: 'png' });
      response.screenshot = { data: pngBuffer.toString('base64'), mimeType: 'image/png' };
    }

    recordTabAction(tabState, { kind: 'snapshot', full, includeScreenshot, offset, result: { ...response, title: await tabState.page.title().catch(() => '') } });
    res.json(response);
  } catch (err) {
    log('error', 'openclaw snapshot failed', { reqId: req.reqId, error: err.message });
    handleRouteError(err, req, res);
  }
});

// POST /act - Combined action endpoint (OpenClaw format)
// Routes to click/type/scroll/press/etc based on 'kind' parameter
app.post('/act', async (req, res) => {
  try {
    const { kind, targetId, userId, ...params } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    if (!kind) {
      return res.status(400).json({ error: 'kind is required' });
    }
    
    const session = sessions.get(normalizeUserId(userId));
    const found = session && findTab(session, targetId);
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    
    const { tabState } = found;
    tabState.toolCalls++; tabState.consecutiveTimeouts = 0;
    
    const result = await withTabLock(targetId, async () => {
      switch (kind) {
        case 'click': {
          const { ref, selector } = params;
          if (!ref && !selector) {
            throw new Error('ref or selector required');
          }
          
          const doClick = async (locatorOrSelector, isLocator) => {
            const locator = isLocator ? locatorOrSelector : tabState.page.locator(locatorOrSelector);
            await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
            const clickResult = await humanClick(tabState.page, locator, {
              profile: params.humanProfile || 'fast',
              from: getHumanCursor(tabState.humanSession),
            });
            updateHumanCursor(tabState.humanSession, clickResult.position);
          };
          
          if (ref) {
            let locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              log('info', 'auto-refreshing refs before click (openclaw)', { ref, hadRefs: tabState.refs.size });
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
            await doClick(locator, true);
          } else {
            await doClick(selector, false);
          }
          
          await tabState.page.waitForTimeout(500);
          tabState.refs = await buildRefs(tabState.page);
          return { ok: true, targetId, url: tabState.page.url() };
        }
        
        case 'type': {
          const { ref, selector, text, submit, mode = 'fill', delay = 30 } = params;
          if (mode === 'fill' && !ref && !selector) {
            throw new Error('ref or selector required for mode=fill');
          }
          if (typeof text !== 'string') {
            throw new Error('text is required');
          }
          if (mode !== 'fill' && mode !== 'keyboard') {
            throw new Error("mode must be 'fill' or 'keyboard'");
          }
          
          let locator = null;
          if (ref) {
            locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              log('info', 'auto-refreshing refs before type (openclaw)', { ref, hadRefs: tabState.refs.size, mode });
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
          }
          
          if (!locator && selector) {
            locator = tabState.page.locator(selector);
          }

          if (locator) {
            await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
          }

          if (mode === 'fill') {
            await humanType(tabState.page, locator, text, { profile: params.humanProfile || 'fast', clearFirst: true, mistakesRate: 0 });
          } else {
            if (locator) {
              await locator.focus({ timeout: 10000 });
            }
            await humanType(tabState.page, locator || null, text, { profile: params.humanProfile || 'fast', clearFirst: false, mistakesRate: 0 });
          }
          if (submit) await humanPress(tabState.page, 'Enter', { profile: params.humanProfile || 'fast' });
          return { ok: true, targetId };
        }
        
        case 'press': {
          const { key } = params;
          if (!key) throw new Error('key is required');
          await humanPress(tabState.page, key, { profile: params.humanProfile || 'fast' });
          return { ok: true, targetId };
        }
        
        case 'scroll':
        case 'scrollIntoView': {
          const { ref, direction = 'down', amount = 500 } = params;
          if (ref) {
            let locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
            await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
          }
          await humanScroll(tabState.page, { direction, amount, profile: params.humanProfile || 'fast' });
          await tabState.page.waitForTimeout(300);
          return { ok: true, targetId };
        }
        
        case 'hover': {
          const { ref, selector } = params;
          if (!ref && !selector) throw new Error('ref or selector required');
          
          let locator;
          if (ref) {
            locator = refToLocator(tabState.page, ref, tabState.refs);
            if (!locator) {
              tabState.refs = await buildRefs(tabState.page);
              locator = refToLocator(tabState.page, ref, tabState.refs);
            }
            if (!locator) { const maxRef = tabState.refs.size > 0 ? `e${tabState.refs.size}` : 'none'; throw new StaleRefsError(ref, maxRef, tabState.refs.size); }
          } else {
            locator = tabState.page.locator(selector);
          }
          await humanPrepareTarget(tabState.page, locator, { behaviorPersona: tabState.humanSession?.behaviorPersona });
          const hoverBox = await locator.boundingBox();
          if (!hoverBox) throw new Error('hover target is not visible');
          const hoverMove = await humanMove(tabState.page, {
            from: getHumanCursor(tabState.humanSession),
            to: { x: hoverBox.x + hoverBox.width / 2, y: hoverBox.y + hoverBox.height / 2 },
            profile: params.humanProfile || 'fast',
          });
          updateHumanCursor(tabState.humanSession, hoverMove.position);
          return { ok: true, targetId };
        }
        
        case 'wait': {
          const { timeMs, text, loadState } = params;
          if (timeMs) {
            await tabState.page.waitForTimeout(timeMs);
          } else if (text) {
            await tabState.page.waitForSelector(`text=${text}`, { timeout: 30000 });
          } else if (loadState) {
            await tabState.page.waitForLoadState(loadState, { timeout: 30000 });
          }
          return { ok: true, targetId, url: tabState.page.url() };
        }
        
        case 'close': {
          const url = tabState.page?.url?.() || undefined;
          const title = await tabState.page?.title?.().catch(() => '') || undefined;
          recordTabAction(tabState, { kind: 'close', reason: 'act_close', result: { ok: true, url, title } });
          markTabRecoveryClosed(tabState, { reason: 'act_close', url, title });
          await safePageClose(tabState.page);
          found.group.delete(targetId);
          { const _l = tabLocks.get(targetId); if (_l) _l.drain(); tabLocks.delete(targetId); }
          return { ok: true, targetId };
        }
        
        default:
          throw new Error(`Unsupported action kind: ${kind}`);
      }
    });
    
    const actionResult = { ...result, url: result.url || tabState.page.url(), title: await tabState.page.title().catch(() => '') };
    if (['click', 'type', 'press', 'scroll', 'scrollIntoView', 'wait', 'hover'].includes(kind)) {
      recordTabAction(tabState, {
        kind: kind === 'scrollIntoView' ? 'scroll' : kind,
        ref: params.ref,
        selector: params.selector,
        text: params.text,
        key: params.key,
        direction: params.direction,
        amount: params.amount,
        result: actionResult,
      });
    }
    res.json(result);
  } catch (err) {
    log('error', 'act failed', { reqId: req.reqId, kind: req.body?.kind, error: err.message });
    handleRouteError(err, req, res);
  }
});

// Periodic stats beacon (every 5 min)
setInterval(() => {
  const mem = process.memoryUsage();
  let totalTabs = 0;
  for (const [, session] of sessions) {
    for (const [, group] of session.tabGroups) {
      totalTabs += group.size;
    }
  }
  log('info', 'stats', {
    sessions: sessions.size,
    tabs: totalTabs,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    uptimeSeconds: Math.floor(process.uptime()),
    browserConnected: getConnectedBrowserCount() > 0,
    activeBrowsers: getConnectedBrowserCount(),
  });
}, 5 * 60_000);

// Active health probe — detect hung browser even when isConnected() lies
setInterval(async () => {
  const entry = Array.from(browsers.values()).find((candidate) => candidate.browser?.isConnected?.());
  if (!entry?.browser || healthState.isRecovering) return;
  const timeSinceSuccess = Date.now() - healthState.lastSuccessfulNav;
  // Skip probe if operations are in flight AND last success was recent.
  // If it's been >120s since any successful operation, probe anyway —
  // active ops are likely stuck on a frozen browser and will time out eventually.
  if (healthState.activeOps > 0 && timeSinceSuccess < 120000) {
    log('info', 'health probe skipped, operations active', { activeOps: healthState.activeOps });
    return;
  }
  if (timeSinceSuccess < 120000) return;
  
  if (healthState.activeOps > 0) {
    log('warn', 'health probe forced despite active ops', { activeOps: healthState.activeOps, timeSinceSuccessMs: timeSinceSuccess });
  }
  
  let testContext;
  try {
    testContext = await entry.browser.newContext();
    const page = await testContext.newPage();
    await page.goto('about:blank', { timeout: 5000 });
    await page.close();
    await testContext.close();
    healthState.lastSuccessfulNav = Date.now();
  } catch (err) {
    failuresTotal.labels('health_probe', 'internal').inc();
    log('warn', 'health probe failed', { error: err.message, timeSinceSuccessMs: timeSinceSuccess });
    if (testContext) await testContext.close().catch(() => {});
    restartBrowser('health probe failed').catch(() => {});
  }
}, 60_000);

// Crash logging
process.on('uncaughtException', (err) => {
  pluginEvents.emit('browser:error', { error: err });
  log('error', 'uncaughtException', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', { reason: String(reason) });
});

// Graceful shutdown
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  pluginEvents.emit('server:shutdown', { signal });

  const forceTimeout = setTimeout(() => {
    log('error', 'shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceTimeout.unref();

  server.close();
  stopMemoryReporter();

  await closeAllSessions(`shutdown:${signal}`, {
    clearDownloads: false,
    clearLocks: false,
  });

  for (const entry of browsers.values()) {
    if (entry.browser) await entry.browser.close().catch(() => {});
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Idle self-shutdown REMOVED — it was racing with min_machines_running=2
// and stopping machines that Fly couldn't auto-restart fast enough, leaving
// only 1 machine to handle all browser traffic (causing timeouts for users).
// Fly's auto_stop_machines=false + min_machines_running=2 handles scaling.

const PORT = CONFIG.port;
pluginEvents.emit('server:starting', { port: PORT });

// Load plugins before starting the server
const pluginCtx = {
  sessions,
  config: CONFIG,
  log,
  events: pluginEvents,
  auth: authMiddleware,
  ensureBrowser,
  getSession,
  destroySession,
  closeSession,
  withUserLimit,
  safePageClose,
  normalizeUserId,
  validateUrl,
  safeError,
  buildProxyUrl,
  proxyPool,
  failuresTotal,
  metricsRegistry: getRegister,
  createMetric,
  /** Factory for Xvfb virtual display. Plugins can replace this to customise resolution/args. */
  createVirtualDisplay: () => new VirtualDisplay(),
  /** The upstream VirtualDisplay class — plugins can subclass it. */
  VirtualDisplay,
};
const loadedPlugins = await loadPlugins(app, pluginCtx);

const server = app.listen(PORT, async () => {
  startMemoryReporter();
  refreshActiveTabsGauge();
  refreshTabLockQueueDepth();
  pluginEvents.emit('server:started', { port: PORT, pid: process.pid, plugins: loadedPlugins });
  if (FLY_MACHINE_ID) {
    log('info', 'server started (fly)', { port: PORT, pid: process.pid, machineId: FLY_MACHINE_ID, nodeVersion: process.version });
  } else {
    log('info', 'server started', { port: PORT, pid: process.pid, nodeVersion: process.version });
  }
  const tmpCleanup = cleanupOrphanedTempFiles({ tmpDir: os.tmpdir() });
  if (tmpCleanup.removed > 0) {
    log('info', 'cleaned up orphaned camoufox temp files', tmpCleanup);
  }
  // Pre-warm a default browser so first request doesn't eat a cold start.
  try {
    const start = Date.now();
    await ensureBrowser('default');
    log('info', 'browser pre-warmed', { userId: 'default', ms: Date.now() - start });
    scheduleBrowserIdleShutdown('default');
  } catch (err) {
    log('error', 'browser pre-warm failed (will retry in background)', { error: err.message });
    scheduleBrowserWarmRetry('default');
  }
  if (KEEPALIVE_USER_ID) {
    try {
      await ensureKeepaliveTab();
    } catch (err) {
      log('error', 'keepalive tab startup failed (will retry)', { userId: KEEPALIVE_USER_ID, error: err.message });
    }
    setInterval(() => {
      ensureKeepaliveTab().catch((err) => log('error', 'keepalive tab retry failed', { userId: KEEPALIVE_USER_ID, error: err.message }));
    }, 60_000);
  }
  // Idle self-shutdown removed — Fly manages machine lifecycle via fly.toml.
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('error', 'port in use', { port: PORT });
    process.exit(1);
  }
  log('error', 'server error', { error: err.message });
  process.exit(1);
});
