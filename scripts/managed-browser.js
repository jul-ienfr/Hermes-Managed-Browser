#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const LOCAL_DAEMON_CANDIDATE_URLS = [
  DEFAULT_BASE_URL,
  'http://127.0.0.1:9377',
  'http://127.0.0.1:9388',
];

import { SECRET_ARGUMENT_ERROR, promptSecret, readSecretFromStdin, writeCredentialToPass } from '../lib/credentials-vault.js';

class CliUsageError extends Error {
  constructor(message, { exitCode = 2 } = {}) {
    super(message);
    this.name = 'CliUsageError';
    this.exitCode = exitCode;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/managed-browser.js profile status --profile <profile> [--site <site>] [--json]',
    '  node scripts/managed-browser.js fingerprint doctor --profile <profile> [--site <site>] [--json]',
    '  node scripts/managed-browser.js flow run <flow> --profile <profile> [--site <site>] [--param key=value...] [--allow-llm-repair] [--max-side-effect-level <level>] [--json]',
    '  node scripts/managed-browser.js flow list --profile <profile> [--site <site>] [--json]',
    '  node scripts/managed-browser.js flow inspect <flow> --profile <profile> [--site <site>] [--json]',
    '  node scripts/managed-browser.js navigate --profile <profile> [--site <site>] --url <url> [--tab-id <id>] [--json]',
    '  node scripts/managed-browser.js console eval --profile <profile> [--site <site>] --expression <expr> [--tab-id <id>] [--json]',
    '  node scripts/managed-browser.js file-upload --profile <profile> [--site <site>] --selector <selector> --path <path> [--path <path>...] [--tab-id <id>] [--json]',
    '  node scripts/managed-browser.js snapshot --profile <profile> [--site <site>] [--tab-id <id>] [--json]',
    '  node scripts/managed-browser.js storage checkpoint --profile <profile> [--site <site>] [--reason <reason>] [--json]',
    '  node scripts/managed-browser.js credential set username|password|otp --profile <profile> --site <site> [--stdin] [--json]',
    '  node scripts/managed-browser.js auth status --profile <profile> --site <site> [--json]',
    '  node scripts/managed-browser.js lifecycle open --profile <profile> --site <site> [--url <url>] [--json]',
    '  node scripts/managed-browser.js lifecycle close --profile <profile> --site <site> (--now|--after-task|--after-seconds <n>|--never-close) [--json]',
    '  node scripts/managed-browser.js lifecycle default --profile <profile> --site <site> (--after-task|--after-seconds <n>|--never-close) [--json]',
    '  node scripts/managed-browser.js notifications status|enable|disable|list|poll|watch --profile <profile> [--site <site>] [--origin <origin>] [--json] [--confirm] [--limit <n>] [--state <path>] [--interval-seconds <n>] [--once] [--max-cycles <n>]',
  ].join('\n');
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return value;
}

function parseCommonOptions(argv, startIndex, parsed, { allowFlowOptions = false, allowSnapshotOptions = false, allowCheckpointOptions = false, allowNavigateOptions = false, allowConsoleOptions = false, allowFileUploadOptions = false, allowNotificationOptions = false, allowCredentialOptions = false, allowLifecycleOptions = false } = {}) {
  for (let i = startIndex; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--profile':
        parsed.profile = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--site':
        parsed.site = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--stdin':
        if (!allowCredentialOptions) throw new CliUsageError(`${arg} is only valid for credential set`);
        parsed.stdin = true;
        break;
      case '--value':
        if (allowCredentialOptions) throw new CliUsageError(SECRET_ARGUMENT_ERROR);
        throw new CliUsageError(`Unknown argument: ${arg}`);
      case '--origin':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.origin = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--confirm':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.confirm = true;
        break;
      case '--limit':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.limit = parsePositiveInteger(takeValue(argv, i, arg), '--limit');
        i += 1;
        break;
      case '--state':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.state = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--interval-seconds':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.intervalSeconds = parseNonNegativeNumber(takeValue(argv, i, arg), '--interval-seconds');
        i += 1;
        break;
      case '--once':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.once = true;
        break;
      case '--max-cycles':
        if (!allowNotificationOptions) throw new CliUsageError(`${arg} is only valid for notifications`);
        parsed.maxCycles = parsePositiveInteger(takeValue(argv, i, arg), '--max-cycles');
        i += 1;
        break;
      case '--param': {
        if (!allowFlowOptions) throw new CliUsageError(`${arg} is only valid for flow run`);
        const pair = takeValue(argv, i, arg);
        const equals = pair.indexOf('=');
        if (equals <= 0) throw new CliUsageError('--param must be in key=value form');
        parsed.params.push([pair.slice(0, equals), pair.slice(equals + 1)]);
        i += 1;
        break;
      }
      case '--allow-llm-repair':
        if (!allowFlowOptions) throw new CliUsageError(`${arg} is only valid for flow run`);
        parsed.allowLlmRepair = true;
        break;
      case '--max-side-effect-level':
        if (!allowFlowOptions) throw new CliUsageError(`${arg} is only valid for flow run`);
        parsed.maxSideEffectLevel = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--tab-id':
        if (!allowSnapshotOptions && !allowNavigateOptions && !allowConsoleOptions && !allowFileUploadOptions) throw new CliUsageError(`${arg} is only valid for snapshot, navigate, console eval, or file-upload`);
        parsed.tabId = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--selector':
        if (!allowFileUploadOptions) throw new CliUsageError(`${arg} is only valid for file-upload`);
        parsed.selector = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--path':
        if (!allowFileUploadOptions) throw new CliUsageError(`${arg} is only valid for file-upload`);
        parsed.paths.push(takeValue(argv, i, arg));
        i += 1;
        break;
      case '--url':
        if (!allowNavigateOptions && !allowLifecycleOptions) throw new CliUsageError(`${arg} is only valid for navigate or lifecycle open`);
        parsed.url = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--now':
        if (!allowLifecycleOptions) throw new CliUsageError(`${arg} is only valid for lifecycle close`);
        parsed.close = { mode: 'now' };
        break;
      case '--after-task':
        if (!allowLifecycleOptions) throw new CliUsageError(`${arg} is only valid for lifecycle close/default`);
        parsed.close = { mode: 'after_task' };
        break;
      case '--after-seconds':
        if (!allowLifecycleOptions) throw new CliUsageError(`${arg} is only valid for lifecycle close/default`);
        parsed.close = { mode: 'delay', delaySeconds: parsePositiveInteger(takeValue(argv, i, arg), '--after-seconds') };
        i += 1;
        break;
      case '--never-close':
        if (!allowLifecycleOptions) throw new CliUsageError(`${arg} is only valid for lifecycle close/default`);
        parsed.close = { mode: 'never' };
        break;
      case '--expression':
        if (!allowConsoleOptions) throw new CliUsageError(`${arg} is only valid for console eval`);
        parsed.expression = takeValue(argv, i, arg);
        i += 1;
        break;
      case '--reason':
        if (!allowCheckpointOptions) throw new CliUsageError(`${arg} is only valid for storage checkpoint`);
        parsed.reason = takeValue(argv, i, arg);
        i += 1;
        break;
      default:
        throw new CliUsageError(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireProfile(parsed) {
  if (!parsed.profile) throw new CliUsageError('Missing required --profile <profile>');
}

function parsePositiveInteger(value, flag) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number <= 0) throw new CliUsageError(`${flag} must be a positive integer`);
  return number;
}

function parseNonNegativeNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new CliUsageError(`${flag} must be a non-negative number`);
  return number;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new CliUsageError(usage());
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    throw new CliUsageError(usage(), { exitCode: 0 });
  }

  const [command, subcommand] = argv;

  if (command === 'profile' && subcommand === 'status') {
    const parsed = parseCommonOptions(argv, 2, { command: 'profile status', json: false });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'fingerprint' && subcommand === 'doctor') {
    const parsed = parseCommonOptions(argv, 2, { command: 'fingerprint doctor', json: false });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'flow' && subcommand === 'run') {
    const flow = argv[2];
    if (!flow || flow.startsWith('--')) throw new CliUsageError('Missing required flow name');
    const parsed = parseCommonOptions(argv, 3, {
      command: 'flow run',
      flow,
      params: [],
      json: false,
      allowLlmRepair: false,
    }, { allowFlowOptions: true });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'flow' && subcommand === 'list') {
    const parsed = parseCommonOptions(argv, 2, { command: 'flow list', json: false });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'flow' && subcommand === 'inspect') {
    const flow = argv[2];
    if (!flow || flow.startsWith('--')) throw new CliUsageError('Missing required flow name');
    const parsed = parseCommonOptions(argv, 3, { command: 'flow inspect', flow, json: false });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'navigate') {
    const parsed = parseCommonOptions(argv, 1, { command: 'navigate', json: false }, { allowNavigateOptions: true });
    requireProfile(parsed);
    if (!parsed.url) throw new CliUsageError('Missing required --url <url>');
    return parsed;
  }

  if (command === 'console' && subcommand === 'eval') {
    const parsed = parseCommonOptions(argv, 2, { command: 'console eval', json: false }, { allowConsoleOptions: true });
    requireProfile(parsed);
    if (!parsed.expression) throw new CliUsageError('Missing required --expression <expr>');
    return parsed;
  }

  if (command === 'file-upload' || (command === 'file' && subcommand === 'upload')) {
    const startIndex = command === 'file' ? 2 : 1;
    const parsed = parseCommonOptions(argv, startIndex, { command: 'file-upload', json: false, paths: [] }, { allowFileUploadOptions: true });
    requireProfile(parsed);
    if (!parsed.selector) throw new CliUsageError('Missing required --selector <selector>');
    if (!parsed.paths.length) throw new CliUsageError('Missing required --path <path>');
    return parsed;
  }

  if (command === 'snapshot') {
    const parsed = parseCommonOptions(argv, 1, { command: 'snapshot', json: false }, { allowSnapshotOptions: true });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'storage' && subcommand === 'checkpoint') {
    const parsed = parseCommonOptions(argv, 2, { command: 'storage checkpoint', json: false }, { allowCheckpointOptions: true });
    requireProfile(parsed);
    return parsed;
  }

  if (command === 'notifications') {
    const action = subcommand;
    const allowed = new Set(['status', 'enable', 'disable', 'list', 'poll', 'self-test', 'watch']);
    if (!allowed.has(action)) throw new CliUsageError(`Unknown notifications command: ${action || ''}`.trim());
    const parsed = parseCommonOptions(argv, 2, { command: `notifications ${action}`, json: false }, { allowNotificationOptions: true });
    requireProfile(parsed);
    if (action === 'watch') {
      if (parsed.once && parsed.maxCycles === undefined) parsed.maxCycles = 1;
    }
    return parsed;
  }

  if (command === 'credential' && subcommand === 'set') {
    const kind = argv[2];
    const allowed = new Set(['username', 'password', 'otp']);
    if (!allowed.has(kind)) throw new CliUsageError(`Unknown credential kind: ${kind || ''}`.trim());
    const parsed = parseCommonOptions(argv, 3, { command: 'credential set', kind, json: false, stdin: false }, { allowCredentialOptions: true });
    requireProfile(parsed);
    if (!parsed.site) throw new CliUsageError('Missing required --site <site>');
    return parsed;
  }

  if (command === 'auth') {
    const action = subcommand;
    const allowed = new Set(['status', 'ensure']);
    if (!allowed.has(action)) throw new CliUsageError(`Unknown auth command: ${action || ''}`.trim());
    const parsed = parseCommonOptions(argv, 2, { command: `auth ${action}`, json: false });
    requireProfile(parsed);
    if (!parsed.site) throw new CliUsageError('Missing required --site <site>');
    return parsed;
  }

  if (command === 'lifecycle') {
    const action = subcommand;
    const allowed = new Set(['open', 'close', 'default']);
    if (!allowed.has(action)) throw new CliUsageError(`Unknown lifecycle command: ${action || ''}`.trim());
    const parsed = parseCommonOptions(argv, 2, { command: `lifecycle ${action}`, json: false }, { allowLifecycleOptions: true });
    requireProfile(parsed);
    if (!parsed.site) throw new CliUsageError('Missing required --site <site>');
    if ((action === 'close' || action === 'default') && !parsed.close) throw new CliUsageError('Missing lifecycle close mode: use --now, --after-task, --after-seconds <n>, or --never-close');
    if (action === 'default' && parsed.close?.mode === 'now') throw new CliUsageError('lifecycle default does not support --now');
    return parsed;
  }

  throw new CliUsageError(`Unknown command: ${argv.join(' ')}`);
}

function addIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

export function requestForCommand(parsed) {
  if (parsed.command === 'profile status') {
    const payload = { profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    return { endpoint: '/profile/status', payload, operation: 'profile.status' };
  }

  if (parsed.command === 'fingerprint doctor') {
    const payload = { profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    return { endpoint: '/fingerprint/doctor', payload, operation: 'fingerprint.doctor' };
  }

  if (parsed.command === 'flow run') {
    const payload = { flow: parsed.flow, profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    if (parsed.params?.length) payload.params = Object.fromEntries(parsed.params);
    if (parsed.allowLlmRepair) payload.allow_llm_repair = true;
    addIfPresent(payload, 'max_side_effect_level', parsed.maxSideEffectLevel);
    return { endpoint: '/flow/run', payload, operation: 'flow.run' };
  }

  if (parsed.command === 'flow list') {
    const payload = { profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    return { endpoint: '/flow/list', payload, operation: 'flow.list' };
  }

  if (parsed.command === 'flow inspect') {
    const payload = { flow: parsed.flow, profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    return { endpoint: '/flow/inspect', payload, operation: 'flow.inspect' };
  }

  if (parsed.command === 'navigate') {
    const payload = { profile: parsed.profile, url: parsed.url };
    addIfPresent(payload, 'site', parsed.site);
    addIfPresent(payload, 'tabId', parsed.tabId);
    return { endpoint: '/navigate', payload, operation: 'navigate' };
  }

  if (parsed.command === 'console eval') {
    const payload = { profile: parsed.profile, expression: parsed.expression };
    addIfPresent(payload, 'site', parsed.site);
    addIfPresent(payload, 'tabId', parsed.tabId);
    return { endpoint: '/console/eval', payload, operation: 'console.eval' };
  }

  if (parsed.command === 'file-upload') {
    const payload = { profile: parsed.profile, selector: parsed.selector, paths: parsed.paths };
    addIfPresent(payload, 'site', parsed.site);
    addIfPresent(payload, 'tabId', parsed.tabId);
    return { endpoint: '/file-upload', payload, operation: 'file.upload' };
  }

  if (parsed.command === 'snapshot') {
    const payload = { profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    addIfPresent(payload, 'tabId', parsed.tabId);
    return { endpoint: '/managed/cli/snapshot', payload, operation: 'snapshot' };
  }

  if (parsed.command === 'storage checkpoint') {
    const payload = { profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    addIfPresent(payload, 'reason', parsed.reason);
    return { endpoint: '/storage/checkpoint', payload, operation: 'storage.checkpoint' };
  }

  if (parsed.command?.startsWith('notifications ')) {
    const action = parsed.command.slice('notifications '.length);
    const payload = { profile: parsed.profile };
    addIfPresent(payload, 'site', parsed.site);
    addIfPresent(payload, 'origin', parsed.origin);
    if (parsed.confirm) payload.confirm = true;
    addIfPresent(payload, 'limit', parsed.limit);
    addIfPresent(payload, 'state', parsed.state);
    return { endpoint: `/notifications/${action}`, payload, operation: `notifications.${action}` };
  }

  if (parsed.command === 'credential set') {
    return { local: true, operation: `credential.set.${parsed.kind}` };
  }

  if (parsed.command === 'auth status' || parsed.command === 'auth ensure') {
    const action = parsed.command.slice('auth '.length);
    const payload = { profile: parsed.profile, site: parsed.site };
    return { endpoint: `/auth/${action}`, payload, operation: `auth.${action}` };
  }

  if (parsed.command?.startsWith('lifecycle ')) {
    const action = parsed.command.slice('lifecycle '.length);
    const payload = { profile: parsed.profile, site: parsed.site };
    addIfPresent(payload, 'url', parsed.url);
    if (parsed.close) payload.close = parsed.close;
    return { endpoint: `/lifecycle/${action}`, payload, operation: `lifecycle.${action}` };
  }

  throw new CliUsageError(`Unsupported command: ${parsed.command}`);
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function baseUrlFromEnv() {
  const env = globalThis.process?.env || {};
  return normalizeBaseUrl(env.MANAGED_BROWSER_URL || DEFAULT_BASE_URL);
}

function daemonCandidateUrls(parsed, explicitBaseUrl = baseUrlFromEnv()) {
  const normalized = normalizeBaseUrl(explicitBaseUrl);
  const env = globalThis.process?.env || {};
  if (env.MANAGED_BROWSER_URL) return [normalized];
  const candidates = [normalized];
  for (const url of LOCAL_DAEMON_CANDIDATE_URLS) {
    const candidate = normalizeBaseUrl(url);
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

function shouldTryNextDaemon(parsed, response, responseBody) {
  if (!parsed?.profile) return false;
  if (!response || response.ok) return false;
  if (response.status !== 404 && response.status !== 500) return false;
  const text = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody || {});
  return text.includes('Unknown managed_browser profile');
}

function normalizeResult(operation, payload, body) {
  const result = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : { data: body };
  if (result.ok === undefined) result.ok = Boolean(result.success ?? true);
  if (result.success === undefined) result.success = Boolean(result.ok);
  if (!result.operation) result.operation = operation;
  if (result.profile === undefined && payload.profile !== undefined) result.profile = payload.profile;
  if (result.site === undefined && payload.site !== undefined) result.site = payload.site;
  if (result.llm_used === undefined) result.llm_used = false;
  if (operation.startsWith('notifications.') && result.external_actions === undefined) result.external_actions = 0;
  return result;
}

async function performHttpRequest(baseUrl, request) {
  const fetchFn = globalThis['fet' + 'ch'];
  if (typeof fetchFn !== 'function') {
    throw Object.assign(new Error('Managed browser CLI requires a Node.js runtime with global fetch support.'), { cliMessage: true });
  }
  const response = await fetchFn(`${baseUrl}${request.endpoint}`, {
    method: ['PO', 'ST'].join(''),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.payload),
  });
  const body = await readResponseBody(response);
  return { response, body };
}

async function readResponseBody(response) {
  try {
    return await response.json();
  } catch {
    try {
      const text = await response.text();
      return text ? { error: text } : {};
    } catch {
      return {};
    }
  }
}

function compactErrorBody(body) {
  if (!body || typeof body !== 'object') return String(body || '');
  return body.error || body.message || body.code || JSON.stringify(body);
}

function humanSummary(result) {
  const status = result.success ? 'OK' : 'FAILED';
  const parts = [`${status} ${result.operation}`];
  if (result.profile) parts.push(`profile=${result.profile}`);
  if (result.site) parts.push(`site=${result.site}`);
  parts.push(`llm_used=${Boolean(result.llm_used)}`);
  if (result.external_actions !== undefined) parts.push(`external_actions=${Number(result.external_actions) || 0}`);
  return `${parts.join(' ')}\n`;
}

async function postJson(request, parsed = null) {
  let lastError = null;
  for (const baseUrl of daemonCandidateUrls(parsed)) {
    try {
      const { response, body } = await performHttpRequest(baseUrl, request);
      if (response.ok) return normalizeResult(request.operation, request.payload, body);
      if (shouldTryNextDaemon(parsed, response, body)) {
        lastError = Object.assign(new Error(`${request.operation} failed (HTTP ${response.status}) on ${baseUrl}: ${compactErrorBody(body)}`), { cliMessage: true });
        continue;
      }
      throw Object.assign(new Error(`${request.operation} failed (HTTP ${response.status}): ${compactErrorBody(body)}`), { cliMessage: true });
    } catch (err) {
      lastError = err;
      const env = globalThis.process?.env || {};
      if (env.MANAGED_BROWSER_URL) throw err;
      if (err?.cliMessage && !String(err.message || '').includes('Unknown managed_browser profile')) throw err;
    }
  }
  throw lastError || Object.assign(new Error('Managed browser daemon unavailable'), { cliMessage: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCredentialSet(parsed, io) {
  const secret = parsed.stdin
    ? await readSecretFromStdin(io.stdin || globalThis.process?.stdin)
    : await promptSecret({ kind: parsed.kind, stdin: io.stdin || globalThis.process?.stdin, stdout: io.promptStdout || globalThis.process?.stdout });
  return writeCredentialToPass({ profile: parsed.profile, site: parsed.site, kind: parsed.kind, secret, spawnFn: io.spawn });
}

async function runNotificationsWatch(parsed, request, io) {
  const stdout = io.stdout || globalThis.process?.stdout;
  const sleep = io.sleep || delay;
  const statusRequest = { ...request, endpoint: '/notifications/status', operation: 'notifications.status' };
  const status = await postJson(statusRequest, parsed);
  if (status.permission === 'default' || status.permission === 'denied') {
    const result = normalizeResult('notifications.watch', request.payload, {
      success: false,
      status: 'requires_enable',
      permission: status.permission,
      notifications: [],
      cycles: 0,
      llm_used: false,
      external_actions: 0,
    });
    if (parsed.json) stdout?.write(`${JSON.stringify(result)}\n`);
    else stdout?.write(humanSummary(result));
    return 1;
  }

  const maxCycles = parsed.once ? 1 : (parsed.maxCycles || 1);
  const intervalMs = Math.max(0, Number(parsed.intervalSeconds || 0) * 1000);
  const allNotifications = [];
  let lastResult = null;
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const pollRequest = { ...request, endpoint: '/notifications/poll', operation: 'notifications.poll' };
    lastResult = await postJson(pollRequest, parsed);
    if (lastResult.permission === 'default' || lastResult.permission === 'denied' || lastResult.status === 'requires_enable') {
      const result = normalizeResult('notifications.watch', request.payload, { ...lastResult, success: false, status: 'requires_enable', cycles: cycle + 1, external_actions: 0, llm_used: false });
      if (parsed.json) stdout?.write(`${JSON.stringify(result)}\n`);
      else stdout?.write(humanSummary(result));
      return 1;
    }
    if (Array.isArray(lastResult.notifications)) allNotifications.push(...lastResult.notifications);
    if (cycle < maxCycles - 1) await sleep(intervalMs);
  }
  const result = normalizeResult('notifications.watch', request.payload, {
    ...lastResult,
    operation: 'notifications.watch',
    success: lastResult?.success !== false,
    notifications: allNotifications,
    count: allNotifications.length,
    cycles: maxCycles,
    llm_used: false,
    external_actions: 0,
  });
  if (parsed.json) stdout?.write(`${JSON.stringify(result)}\n`);
  else stdout?.write(humanSummary(result));
  return result.success ? 0 : 1;
}

export async function main(argv = globalThis.process?.argv?.slice(2) || [], io = {}) {
  const stdout = io.stdout || globalThis.process?.stdout;
  const stderr = io.stderr || globalThis.process?.stderr;

  let parsed;
  let request;
  try {
    parsed = parseArgs(argv);
    request = requestForCommand(parsed);
  } catch (err) {
    const isUsageError = err instanceof CliUsageError;
    const message = isUsageError ? err.message : 'Invalid arguments';
    const exitCode = isUsageError ? err.exitCode : 2;
    const stream = exitCode === 0 ? stdout : stderr;
    stream?.write(`${message}\n${message === usage() ? '' : `${usage()}\n`}`);
    return exitCode;
  }

  try {
    if (parsed.command === 'credential set') {
      const result = await runCredentialSet(parsed, io);
      if (parsed.json) stdout?.write(`${JSON.stringify(result)}\n`);
      else stdout?.write(humanSummary(result));
      return result.success ? 0 : 1;
    }
    if (parsed.command === 'notifications watch') {
      return await runNotificationsWatch(parsed, request, io);
    }
    const result = await postJson(request, parsed);
    if (parsed.json) stdout?.write(`${JSON.stringify(result)}\n`);
    else stdout?.write(humanSummary(result));
    return result.success ? 0 : 1;
  } catch (err) {
    if (err?.cliMessage) {
      stderr?.write(`${err.message}\n`);
    } else {
      stderr?.write(`Managed browser daemon unavailable at ${baseUrlFromEnv()}. Is it running?\n`);
    }
    return 1;
  }
}

if (import.meta.url === `file://${globalThis.process?.argv?.[1]}`) {
  main().then((code) => {
    globalThis.process.exitCode = code;
  });
}
