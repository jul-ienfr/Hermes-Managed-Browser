/**
 * Camoufox Browser - OpenClaw Plugin
 *
 * Provides browser automation tools using the Camoufox anti-detection browser.
 * Server auto-starts when plugin loads (configurable via autoStart: false).
 */

import type { ChildProcess } from "child_process";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { loadConfig } from "./lib/config.js";
import { launchServer } from "./lib/launcher.js";
import { readCookieFile } from "./lib/cookies.js";
import { summarizeAgentHistoryTimeline } from "./lib/human-session-recording.js";
import { lifecycleStateForPolicy, shouldRotateManagedProfile, shouldWarmupManagedProfile } from "./lib/managed-lifecycle.js";
import { managedBrowserContextKey, resolveManagedBrowserProfile } from "./lib/managed-browser-policy.js";

// Get plugin directory - works in both ESM and CJS contexts
const getPluginDir = (): string => {
  try {
    // ESM context
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS context
    return __dirname;
  }
};

interface PluginConfig {
  url?: string;
  autoStart?: boolean;
  port?: number;
  maxSessions?: number;
  maxTabsPerSession?: number;
  sessionTimeoutMs?: number;
  browserIdleTimeoutMs?: number;
  maxOldSpaceSize?: number;
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

interface HealthCheckResult {
  status: "ok" | "warn" | "error";
  message?: string;
  details?: Record<string, unknown>;
}

interface CliCommand {
  description: (desc: string) => CliCommand;
  option: (flags: string, desc: string, defaultValue?: string) => CliCommand;
  argument: (name: string, desc: string) => CliCommand;
  action: (handler: (...args: unknown[]) => void | Promise<void>) => CliCommand;
  command: (name: string) => CliCommand;
}

interface CliContext {
  program: CliCommand;
  config: PluginConfig;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

interface ToolContext {
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
}

type ToolDefinition = {
  name: string;
  description: string;
  parameters: object;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

type ToolFactory = (ctx: ToolContext) => ToolDefinition | ToolDefinition[] | null | undefined;

interface PluginApi {
  registerTool: (
    tool: ToolDefinition | ToolFactory,
    options?: { optional?: boolean }
  ) => void;
  registerCommand: (cmd: {
    name: string;
    description: string;
    handler: (args: string[]) => Promise<void>;
  }) => void;
  registerCli?: (
    registrar: (ctx: CliContext) => void | Promise<void>,
    opts?: { commands?: string[] }
  ) => void;
  registerRpc?: (
    name: string,
    handler: (params: Record<string, unknown>) => Promise<unknown>
  ) => void;
  registerHealthCheck?: (
    name: string,
    check: () => Promise<HealthCheckResult>
  ) => void;
  config: Record<string, unknown>;
  pluginConfig?: PluginConfig;
  log: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

let serverProcess: ChildProcess | null = null;

async function startServer(
  pluginDir: string,
  port: number,
  log: PluginApi["log"],
  pluginCfg?: PluginConfig
): Promise<ChildProcess> {
  const cfg = loadConfig();
  const env: Record<string, string> = { ...cfg.serverEnv };
  if (pluginCfg?.maxSessions != null) env.MAX_SESSIONS = String(pluginCfg.maxSessions);
  if (pluginCfg?.maxTabsPerSession != null) env.MAX_TABS_PER_SESSION = String(pluginCfg.maxTabsPerSession);
  if (pluginCfg?.sessionTimeoutMs != null) env.SESSION_TIMEOUT_MS = String(pluginCfg.sessionTimeoutMs);
  if (pluginCfg?.browserIdleTimeoutMs != null) env.BROWSER_IDLE_TIMEOUT_MS = String(pluginCfg.browserIdleTimeoutMs);
  const proc = launchServer({ pluginDir, port, env, log, nodeArgs: pluginCfg?.maxOldSpaceSize != null ? [`--max-old-space-size=${pluginCfg.maxOldSpaceSize}`] : undefined });

  proc.on("error", (err: Error) => {
    log?.error?.(`Server process error: ${err.message}`);
    serverProcess = null;
  });

  proc.on("exit", (code: number | null) => {
    if (code !== 0 && code !== null) {
      log?.error?.(`Server exited with code ${code}`);
    }
    serverProcess = null;
  });

  // Wait for server to be ready
  const baseUrl = `http://localhost:${port}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        log.info(`Camoufox server ready on port ${port}`);
        return proc;
      }
    } catch {
      // Server not ready yet
    }
  }
  proc.kill();
  throw new Error("Server failed to start within 15 seconds");
}

async function checkServerRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchApi(
  baseUrl: string,
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

function toToolResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export default function register(api: PluginApi) {
  const cfg = api.pluginConfig ?? (api.config as unknown as PluginConfig);
  const port = cfg.port || 9377;
  const baseUrl = cfg.url || `http://localhost:${port}`;
  const autoStart = cfg.autoStart !== false; // default true
  const pluginDir = getPluginDir();
  const fallbackUserId = `camofox-${randomUUID()}`;
  const currentHermesTabsByContext = new Map<string, string>();
  const currentManagedTabsByContext = new Map<string, string>();
  const managedLifecycleByContext = new Map<string, { state: string; updatedAt: string; readySince?: string; currentTabId?: string }>();

  const hermesContextKey = (ctx: ToolContext): string =>
    `${ctx.agentId || fallbackUserId}:${ctx.sessionKey || "default"}`;

  const extractTabId = (payload: unknown): string | undefined => {
    if (!payload || typeof payload !== "object") return undefined;
    const data = payload as Record<string, unknown>;
    const direct = data.tabId || data.targetId || data.newTabId;
    if (typeof direct === "string" && direct) return direct;
    const result = data.result;
    if (result && typeof result === "object") {
      const nested = result as Record<string, unknown>;
      const nestedId = nested.tabId || nested.targetId || nested.newTabId;
      if (typeof nestedId === "string" && nestedId) return nestedId;
    }
    return undefined;
  };

  const rememberHermesTab = (ctx: ToolContext, payload: unknown, explicitTabId?: string): void => {
    const tabId = explicitTabId || extractTabId(payload);
    if (tabId) currentHermesTabsByContext.set(hermesContextKey(ctx), tabId);
  };

  const resolveHermesTabId = (ctx: ToolContext, tabId?: unknown): string => {
    if (typeof tabId === "string" && tabId) return tabId;
    const remembered = currentHermesTabsByContext.get(hermesContextKey(ctx));
    if (!remembered) {
      throw new Error("No active Hermes browser tab. Call browser_navigate first or pass tabId explicitly.");
    }
    return remembered;
  };

  const updateManagedLifecycle = (ctx: ToolContext, policy: { profile: string; sessionKey: string }, state: string, currentTabId?: string): void => {
    const previous = managedLifecycleByContext.get(managedBrowserContextKey(ctx, policy));
    const now = new Date().toISOString();
    managedLifecycleByContext.set(managedBrowserContextKey(ctx, policy), {
      state,
      updatedAt: now,
      readySince: state === "READY" ? (previous?.readySince || now) : previous?.readySince,
      ...(currentTabId ? { currentTabId } : {}),
    });
  };

  const rememberManagedTab = (ctx: ToolContext, policy: { profile: string; sessionKey: string }, payload: unknown, explicitTabId?: string): void => {
    const tabId = explicitTabId || extractTabId(payload);
    if (tabId) {
      currentManagedTabsByContext.set(managedBrowserContextKey(ctx, policy), tabId);
      updateManagedLifecycle(ctx, policy, "READY", tabId);
    }
  };

  const resolveManagedTabId = (ctx: ToolContext, policy: { profile: string; sessionKey: string }, tabId?: unknown): string => {
    if (typeof tabId === "string" && tabId) return tabId;
    const remembered = currentManagedTabsByContext.get(managedBrowserContextKey(ctx, policy));
    if (!remembered) {
      throw new Error(`No active managed browser tab for profile ${policy.profile}. Call managed_browser_bind_existing_tab first or pass tabId explicitly.`);
    }
    return remembered;
  };

  // Auto-start server if configured (default: true)
  if (autoStart) {
    (async () => {
      const alreadyRunning = await checkServerRunning(baseUrl);
      if (alreadyRunning) {
        api.log?.info?.(`Camoufox server already running at ${baseUrl}`);
      } else {
        try {
          serverProcess = await startServer(pluginDir, port, api.log, cfg);
        } catch (err) {
          api.log?.error?.(`Failed to auto-start server: ${(err as Error).message}`);
        }
      }
    })();
  }

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_create_tab",
    description:
      "PREFERRED: Create a new browser tab using Camoufox anti-detection browser. Use camofox tools instead of Chrome/built-in browser - they bypass bot detection on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Initial URL to navigate to" },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const sessionKey = ctx.sessionKey || "default";
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, "/tabs", {
        method: "POST",
        body: JSON.stringify({ ...params, userId, sessionKey }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_snapshot",
    description:
      "Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction, plus a visual screenshot. " +
      "Large pages are truncated with pagination links preserved at the bottom. " +
      "If the response includes hasMore=true and nextOffset, call again with that offset to see more content.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        offset: { type: "number", description: "Character offset for paginated snapshots. Use nextOffset from a previous truncated response." },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId, offset } = params as { tabId: string; offset?: number };
      const userId = ctx.agentId || fallbackUserId;
      const qs = offset ? `&offset=${offset}` : '';
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/snapshot?userId=${userId}&includeScreenshot=true${qs}`) as Record<string, unknown>;
      const content: ToolResult["content"] = [
        { type: "text", text: JSON.stringify({ url: result.url, refsCount: result.refsCount, snapshot: result.snapshot, truncated: result.truncated, totalChars: result.totalChars, hasMore: result.hasMore, nextOffset: result.nextOffset }, null, 2) },
      ];
      const screenshot = result.screenshot as { data?: string; mimeType?: string } | undefined;
      if (screenshot?.data) {
        content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType || "image/png" });
      }
      return { content };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_click",
    description: "Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g., e1)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/click`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_type",
    description: "Type text into an element in a Camoufox tab.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from snapshot (e.g., e2)" },
        selector: { type: "string", description: "CSS selector (alternative to ref)" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["tabId", "text"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/type`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_navigate",
    description:
      "Navigate a Camoufox tab to a URL or use a search macro (@google_search, @youtube_search, etc.). Preferred over Chrome for sites with bot detection.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        url: { type: "string", description: "URL to navigate to" },
        macro: {
          type: "string",
          description: "Search macro (e.g., @google_search, @youtube_search)",
          enum: [
            "@google_search",
            "@youtube_search",
            "@amazon_search",
            "@reddit_search",
            "@wikipedia_search",
            "@twitter_search",
            "@yelp_search",
            "@spotify_search",
            "@netflix_search",
            "@linkedin_search",
            "@instagram_search",
            "@tiktok_search",
            "@twitch_search",
          ],
        },
        query: { type: "string", description: "Search query (when using macro)" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/navigate`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_scroll",
    description: "Scroll a Camoufox page.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll" },
      },
      required: ["tabId", "direction"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId: string } & Record<string, unknown>;
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/scroll`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_screenshot",
    description: "Take a screenshot of a Camoufox page.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId: string };
      const userId = ctx.agentId || fallbackUserId;
      const url = `${baseUrl}/tabs/${tabId}/screenshot?userId=${userId}`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
      }
      // Guard: if server returns JSON/text instead of image (e.g. error with 200),
      // return as text to avoid crashing the client with base64-encoded JSON.
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        const text = await res.text();
        return { content: [{ type: "text", text: `Screenshot failed: ${text}` }] };
      }
      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: contentType || "image/png",
          },
        ],
      };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_close_tab",
    description: "Close a Camoufox browser tab.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId: string };
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}?userId=${userId}`, {
        method: "DELETE",
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_evaluate",
    description:
      "Execute JavaScript in a Camoufox tab's page context. Returns the result of the expression. Use for injecting scripts, reading page state, or calling web app APIs.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        expression: { type: "string", description: "JavaScript expression to evaluate in the page context" },
      },
      required: ["tabId", "expression"],
    },
    async execute(_id, params) {
      const { tabId, expression } = params as { tabId: string; expression: string };
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${tabId}/evaluate`, {
        method: "POST",
        body: JSON.stringify({ userId, expression }),
      });
      return toToolResult(result);
    },
  }));

  const normalizeHermesRef = (ref: unknown): unknown =>
    typeof ref === "string" && ref.startsWith("@") ? ref.slice(1) : ref;

  const appendQuery = (path: string, query: Record<string, unknown>): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  };

  const resolveManagedHumanProfile = (value: unknown, defaultHumanProfile: string): string => {
    if (value === undefined || value === null || value === "") return defaultHumanProfile;
    if (value === "fast" || value === "medium" || value === "slow") return value;
    throw new Error('managed_browser humanProfile must be one of "fast", "medium", or "slow".');
  };

  const managedProfileProperties = {
    profile: { type: "string", description: "Managed browser profile, e.g. leboncoin-cim or leboncoin-ge" },
    site: { type: "string", description: "Optional managed site key, e.g. leboncoin" },
  };

  const managedHumanProperties = {
    humanProfile: { type: "string", enum: ["fast", "medium", "slow"], description: "Optional human behavior speed profile; defaults to the managed profile policy" },
  };

  const managedHumanPayload = (policy: { userId: string; defaultHumanProfile: string }, humanProfile: unknown, body: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...body,
    userId: policy.userId,
    humanProfile: resolveManagedHumanProfile(humanProfile, policy.defaultHumanProfile),
  });

  const managedTabCreatePayload = (policy: { userId: string; siteKey: string; sessionKey: string; profileDir: string; browserPersonaKey: string; humanPersonaKey: string; defaultHumanProfile: string }, url: string, humanProfile?: unknown): Record<string, unknown> => ({
    managedBrowser: true,
    siteKey: policy.siteKey,
    url,
    userId: policy.userId,
    sessionKey: policy.sessionKey,
    profileDir: policy.profileDir,
    browserPersonaKey: policy.browserPersonaKey,
    humanPersonaKey: policy.humanPersonaKey,
    humanProfile: resolveManagedHumanProfile(humanProfile, policy.defaultHumanProfile),
  });

  const assertManagedBrowserCanOpenTab = (policy: { profile: string; displayPolicy?: { mode?: string; requiresExistingWindow?: boolean } }, tabId?: unknown): void => {
    if (policy.displayPolicy?.requiresExistingWindow && !(typeof tabId === "string" && tabId)) {
      throw new Error(
        `Managed profile ${policy.profile} is manual VNC-only: bind an existing tab with managed_browser_bind_existing_tab or pass an existing tabId. ` +
        "Refusing to create a new raw Camoufox tab because it can trigger site restriction."
      );
    }
  };

  const firstManagedTabId = (payload: unknown, requestedTabId?: unknown): string | undefined => {
    if (typeof requestedTabId === "string" && requestedTabId) return requestedTabId;
    if (!payload || typeof payload !== "object") return undefined;
    const tabs = (payload as { tabs?: unknown }).tabs;
    if (!Array.isArray(tabs)) return undefined;
    for (const tab of tabs) {
      const tabId = extractTabId(tab);
      if (tabId) return tabId;
    }
    return undefined;
  };

  const isRecoverableManagedTabError = (err: unknown): boolean => {
    const message = (err as Error)?.message || "";
    return /Tab not found|closed context|context.*closed|browser disconnected|browser.*disconnected/i.test(message);
  };

  const recoverManagedTab = async (ctx: ToolContext, policy: ReturnType<typeof resolveManagedBrowserProfile>, tabId: string, fallbackUrl?: string): Promise<Record<string, unknown>> => {
    const recovered = await fetchApi(baseUrl, "/managed/recover-tab", {
      method: "POST",
      body: JSON.stringify({
        userId: policy.userId,
        siteKey: policy.siteKey,
        sessionKey: policy.sessionKey,
        profileDir: policy.profileDir,
        tabId,
        fallbackUrl: fallbackUrl || policy.defaultStartUrl,
      }),
    }) as Record<string, unknown>;
    rememberManagedTab(ctx, policy, recovered);
    const recoveredTabId = extractTabId(recovered);
    if (recoveredTabId) rememberManagedTab(ctx, policy, recovered, recoveredTabId);
    return recovered;
  };

  const withManagedTabRecovery = async <T>(ctx: ToolContext, policy: ReturnType<typeof resolveManagedBrowserProfile>, tabId: string, operation: (activeTabId: string) => Promise<T>, fallbackUrl?: string): Promise<{ result: T; tabId: string; recovered?: Record<string, unknown> }> => {
    try {
      return { result: await operation(tabId), tabId };
    } catch (err) {
      if (!isRecoverableManagedTabError(err)) throw err;
      const recovered = await recoverManagedTab(ctx, policy, tabId, fallbackUrl);
      const recoveredTabId = extractTabId(recovered);
      if (!recoveredTabId) throw err;
      return { result: await operation(recoveredTabId), tabId: recoveredTabId, recovered };
    }
  };

  const addRecoveredMetadata = (result: unknown, recovered?: Record<string, unknown>): unknown => {
    if (!recovered) return result;
    if (result && typeof result === "object" && !Array.isArray(result)) return { ...(result as Record<string, unknown>), recovered };
    return { result, recovered };
  };

  const registerBrowserContractTools = (registrations: Array<(ctx: ToolContext) => ToolDefinition>): void => {
    for (const registration of registrations) api.registerTool(registration);
  };

  const memoryToolProperties = {
    ...managedProfileProperties,
    tabId: { type: "string", description: "Optional tab identifier; defaults to remembered managed tab or opens a replay tab server-side" },
    actionKey: { type: "string", description: "AgentHistory action key/flow name; defaults to default" },
    action_key: { type: "string", description: "Snake_case alias for actionKey" },
    parameters: { type: "object", description: "Runtime values for parameterized replay steps" },
    url: { type: "string", description: "Optional URL context for compatibility" },
    start_url: { type: "string", description: "Alias for url/starting URL" },
    allow_llm_repair: { type: "boolean", default: false, description: "Allow server-side LLM repair only as a final fallback; default false" },
    allowLlmRepair: { type: "boolean", default: false, description: "CamelCase alias for allow_llm_repair; default false" },
    learnRepairs: { type: "boolean", default: false, description: "Persist successful deterministic repairs" },
    humanProfile: managedHumanProperties.humanProfile,
  };

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_run_memory",
    description: "Replay a managed AgentHistory memory/flow deterministically by default. LLM repair is off unless allow_llm_repair is explicitly true; any LLM fallback only proposes a repaired step for local handlers.",
    parameters: {
      type: "object",
      properties: memoryToolProperties,
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, actionKey, action_key, parameters = {}, allow_llm_repair, allowLlmRepair, learnRepairs = false, url, start_url, humanProfile } = params as {
        tabId?: string; profile?: string; site?: string; actionKey?: string; action_key?: string; parameters?: Record<string, unknown>; allow_llm_repair?: boolean; allowLlmRepair?: boolean; learnRepairs?: boolean; url?: string; start_url?: string; humanProfile?: string;
      };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const remembered = currentManagedTabsByContext.get(managedBrowserContextKey(ctx, policy));
      const payload: Record<string, unknown> = {
        userId: policy.userId,
        siteKey: policy.siteKey,
        actionKey: actionKey || action_key || "default",
        parameters,
        learnRepairs,
        url: url || start_url,
        humanProfile: resolveManagedHumanProfile(humanProfile, policy.defaultHumanProfile),
      };
      if (tabId || remembered) payload.tabId = tabId || remembered;
      if (allowLlmRepair === true || (allowLlmRepair === undefined && allow_llm_repair === true)) payload.allowLlmRepair = true;
      const replay = typeof payload.tabId === "string"
        ? await withManagedTabRecovery(ctx, policy, payload.tabId, async (activeTabId) => {
            payload.tabId = activeTabId;
            return await fetchApi(baseUrl, "/memory/replay", { method: "POST", body: JSON.stringify(payload) }) as Record<string, unknown>;
          }, url || start_url)
        : { result: await fetchApi(baseUrl, "/memory/replay", { method: "POST", body: JSON.stringify(payload) }) as Record<string, unknown>, tabId: "" };
      const result = replay.result as Record<string, unknown>;
      rememberManagedTab(ctx, policy, result, typeof result.tabId === "string" ? result.tabId : replay.tabId || undefined);
      return toToolResult({
        ...(addRecoveredMetadata(result, replay.recovered) as Record<string, unknown>),
        llm_used: result.llm_used === true,
        mode: result.mode || null,
        failure_reason: result.ok === false ? ((result.results as Array<Record<string, unknown>> | undefined)?.find((item) => item.ok === false)?.error || result.error || null) : null,
      });
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_run_flow",
    description: "Alias for managed_browser_run_memory using flow_name/actionKey.",
    parameters: {
      type: "object",
      properties: {
        ...memoryToolProperties,
        flow_name: { type: "string", description: "Flow name alias for actionKey" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const flowName = typeof params.flow_name === "string" && params.flow_name ? params.flow_name : (params.actionKey || params.action_key);
      const policy = resolveManagedBrowserProfile({ profile: params.profile as string | undefined, site: params.site as string | undefined });
      const remembered = currentManagedTabsByContext.get(managedBrowserContextKey(ctx, policy));
      const payload: Record<string, unknown> = {
        userId: policy.userId,
        siteKey: policy.siteKey,
        actionKey: flowName || "default",
        parameters: params.parameters || {},
        learnRepairs: params.learnRepairs === true,
        url: params.url || params.start_url,
        humanProfile: resolveManagedHumanProfile(params.humanProfile, policy.defaultHumanProfile),
      };
      if (typeof params.tabId === "string" && params.tabId || remembered) payload.tabId = (params.tabId as string) || remembered;
      if (params.allowLlmRepair === true || (params.allowLlmRepair === undefined && params.allow_llm_repair === true)) payload.allowLlmRepair = true;
      const replay = typeof payload.tabId === "string"
        ? await withManagedTabRecovery(ctx, policy, payload.tabId, async (activeTabId) => {
            payload.tabId = activeTabId;
            return await fetchApi(baseUrl, "/memory/replay", { method: "POST", body: JSON.stringify(payload) }) as Record<string, unknown>;
          }, typeof params.url === "string" ? params.url : (typeof params.start_url === "string" ? params.start_url : undefined))
        : { result: await fetchApi(baseUrl, "/memory/replay", { method: "POST", body: JSON.stringify(payload) }) as Record<string, unknown>, tabId: "" };
      const result = replay.result as Record<string, unknown>;
      rememberManagedTab(ctx, policy, result, typeof result.tabId === "string" ? result.tabId : replay.tabId || undefined);
      return toToolResult({
        ...(addRecoveredMetadata(result, replay.recovered) as Record<string, unknown>),
        llm_used: result.llm_used === true,
        mode: result.mode || null,
        failure_reason: result.ok === false ? ((result.results as Array<Record<string, unknown>> | undefined)?.find((item) => item.ok === false)?.error || result.error || null) : null,
      });
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_bind_existing_tab",
    description: "Bind a managed profile to an already-open server-owned managed browser tab without creating a new tab.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional existing tab identifier. If omitted, the first existing tab for the managed userId is selected." },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site } = params as { tabId?: string; profile?: string; site?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const tabsResult = await fetchApi(baseUrl, appendQuery("/tabs", { userId: policy.userId }));
      const resolvedTabId = firstManagedTabId(tabsResult, tabId);
      if (!resolvedTabId) {
        throw new Error(
          `No server-owned managed browser tab found for profile ${policy.profile}. ` +
          "Use managed_browser_launch_visible_window or managed_browser_navigate to create a server-owned managed tab, or pass an existing managed tabId."
        );
      }
      rememberManagedTab(ctx, policy, { tabId: resolvedTabId });
      const status = managedStatusSnapshot(ctx, policy);
      return toToolResult({
        profile: policy.profile,
        siteKey: policy.siteKey,
        userId: policy.userId,
        bound: true,
        tabId: resolvedTabId,
        currentTabId: status.rememberedTabId || resolvedTabId,
        tabsResult,
      });
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_launch_visible_window",
    description: "Open a server-owned managed browser tab for a managed profile and remember it as the current tab.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        url: { type: "string", description: "URL to open; defaults to the profile start URL" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { profile, site, humanProfile, url } = params as { profile?: string; site?: string; humanProfile?: string; url?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      if (!policy.displayPolicy?.allowServerOwnedVisibleLaunch) {
        throw new Error(`Managed profile ${policy.profile} does not allow server-owned launch.`);
      }
      const payload = managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile);
      if (policy.displayPolicy?.display) payload.display = policy.displayPolicy.display;
      const result = await fetchApi(baseUrl, "/managed/visible-tab", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      rememberManagedTab(ctx, policy, result);
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_checkpoint_storage",
    description: "Persist the current server-owned managed browser session storage state after login or account-state changes.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        reason: { type: "string", description: "Optional checkpoint reason, e.g. manual_login" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { profile, site, reason } = params as { profile?: string; site?: string; reason?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const result = await fetchApi(baseUrl, "/managed/storage-checkpoint", {
        method: "POST",
        body: JSON.stringify({
          userId: policy.userId,
          profileDir: policy.profileDir,
          reason: reason || "manual_checkpoint",
        }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_navigate",
    description: "Managed-profile browser navigation using the Hermes/Camoufox contract. Requires an explicit managed profile and remembers the current tab for that profile only.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        url: { type: "string", description: "URL to navigate to; defaults to the profile start URL when omitted" },
        tabId: { type: "string", description: "Optional existing tab identifier" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, url, ...rest } = params as { tabId?: string; profile?: string; site?: string; url?: string } & Record<string, unknown>;
      const policy = resolveManagedBrowserProfile({ profile, site });
      const targetUrl = url || policy.defaultStartUrl;
      assertManagedBrowserCanOpenTab(policy, tabId);
      let result;
      if (tabId) {
        result = await fetchApi(baseUrl, `/tabs/${tabId}/navigate`, {
          method: "POST",
          body: JSON.stringify({
            ...rest,
            ...managedTabCreatePayload(policy, targetUrl),
          }),
        });
      } else {
        result = await fetchApi(baseUrl, "/tabs", {
          method: "POST",
          body: JSON.stringify({
            ...rest,
            ...managedTabCreatePayload(policy, targetUrl),
          }),
        });
      }
      rememberManagedTab(ctx, policy, result);
      if (tabId) rememberManagedTab(ctx, policy, { tabId });
      const resolvedTabId = tabId || extractTabId(result);
      if (resolvedTabId) {
        try {
          const snapshot = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/snapshot?userId=${policy.userId}&includeScreenshot=false&full=false`) as Record<string, unknown>;
          const resultData = result && typeof result === "object" ? result as Record<string, unknown> : {};
          return toToolResult({
            ...resultData,
            url: snapshot.url || resultData.url,
            snapshot: snapshot.snapshot,
            element_count: snapshot.refsCount,
            truncated: snapshot.truncated,
            hasMore: snapshot.hasMore,
            nextOffset: snapshot.nextOffset,
          });
        } catch {
          return toToolResult(result);
        }
      }
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_snapshot",
    description: "Managed-profile DOM/accessibility snapshot. Returns text refs for managed_browser_click/managed_browser_type and does not include a screenshot by default.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        offset: { type: "number", description: "Character offset for paginated snapshots" },
        full: { type: "boolean", description: "Compatibility flag; compact snapshot is the default" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, offset, full = false, profile, site } = params as { tabId?: string; offset?: number; full?: boolean; profile?: string; site?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const qs = offset ? `&offset=${offset}` : "";
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/snapshot?userId=${policy.userId}&includeScreenshot=false&full=${full === true}${qs}`) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: JSON.stringify({ url: result.url, refsCount: result.refsCount, snapshot: result.snapshot, truncated: result.truncated, totalChars: result.totalChars, hasMore: result.hasMore, nextOffset: result.nextOffset, recovered }, null, 2) }],
      };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_click",
    description: "Managed-profile humanized click by accessibility ref such as @e1, or CSS selector fallback.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        ref: { type: "string", description: "Element ref from managed_browser_snapshot, e.g. @e1" },
        selector: { type: "string", description: "CSS selector fallback" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, humanProfile, ...rest } = params as { tabId?: string; profile?: string; site?: string; humanProfile?: string } & Record<string, unknown>;
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/click`, {
        method: "POST",
        body: JSON.stringify(managedHumanPayload(policy, humanProfile, { ...rest, ref: normalizeHermesRef(rest.ref) })),
      }));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_type",
    description: "Managed-profile humanized typing into an element by accessibility ref such as @e2, or CSS selector fallback.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        ref: { type: "string", description: "Element ref from managed_browser_snapshot, e.g. @e2" },
        selector: { type: "string", description: "CSS selector fallback" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["profile", "text"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, humanProfile, ...rest } = params as { tabId?: string; profile?: string; site?: string; humanProfile?: string } & Record<string, unknown>;
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/type`, {
        method: "POST",
        body: JSON.stringify(managedHumanPayload(policy, humanProfile, { ...rest, ref: normalizeHermesRef(rest.ref) })),
      }));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_press",
    description: "Managed-profile humanized keyboard press, e.g. Enter, Tab, Escape, ArrowDown.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        key: { type: "string", description: "Key to press" },
      },
      required: ["profile", "key"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, humanProfile, key } = params as { tabId?: string; profile?: string; site?: string; humanProfile?: string; key: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/press`, {
        method: "POST",
        body: JSON.stringify(managedHumanPayload(policy, humanProfile, { key })),
      }));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_scroll",
    description: "Managed-profile humanized page scroll.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll" },
      },
      required: ["profile", "direction"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, humanProfile, ...rest } = params as { tabId?: string; profile?: string; site?: string; humanProfile?: string } & Record<string, unknown>;
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/scroll`, {
        method: "POST",
        body: JSON.stringify(managedHumanPayload(policy, humanProfile, rest)),
      }));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_back",
    description: "Managed-profile browser history back action.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site } = params as { tabId?: string; profile?: string; site?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/back`, {
        method: "POST",
        body: JSON.stringify({ userId: policy.userId }),
      }));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_console",
    description: "Managed-profile page evaluation or console diagnostics for non-interactive inspection. Do not use it to synthesize clicks, typing, or DOM events.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        expression: { type: "string", description: "JavaScript expression to evaluate for inspection; omit for diagnostics" },
        clear: { type: "boolean", description: "Clear diagnostics after reading when expression is omitted" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, expression, clear = false } = params as { tabId?: string; profile?: string; site?: string; expression?: string; clear?: boolean };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => expression
        ? await fetchApi(baseUrl, `/tabs/${activeTabId}/evaluate`, {
            method: "POST",
            body: JSON.stringify({ userId: policy.userId, expression }),
          })
        : await fetchApi(baseUrl, appendQuery(`/tabs/${activeTabId}/diagnostics`, { userId: policy.userId, clear: clear === true })));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_get_images",
    description: "Managed-profile list of page images with URLs/alt text. Prefer this before screenshot vision when inspecting images.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site } = params as { tabId?: string; profile?: string; site?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => await fetchApi(baseUrl, `/tabs/${activeTabId}/images?userId=${policy.userId}`));
      return toToolResult(addRecoveredMetadata(result, recovered));
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_vision",
    description: "Managed-profile visual fallback. Use only for CAPTCHA, visual ambiguity, or final visual verification; snapshot remains the primary page state source.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        question: { type: "string", description: "What to inspect visually" },
        annotate: { type: "boolean", description: "Compatibility flag for element labels" },
      },
      required: ["profile", "question"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, question } = params as { tabId?: string; profile?: string; site?: string; question: string; annotate?: boolean };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const { result: res, recovered } = await withManagedTabRecovery(ctx, policy, resolvedTabId, async (activeTabId) => {
        const url = `${baseUrl}/tabs/${activeTabId}/screenshot?userId=${policy.userId}`;
        const response = await fetch(url);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${response.status}: ${text}`);
        }
        return response;
      });
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        const text = await res.text();
        return { content: [{ type: "text", text: `Managed visual fallback failed: ${text}${recovered ? `\nRecovered: ${JSON.stringify(recovered)}` : ""}` }] };
      }
      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        content: [
          { type: "text", text: `Managed visual fallback request for ${policy.profile}: ${question}\nPolicy: use managed_browser_snapshot/click/type first; managed_browser_vision is not the primary page state source.${recovered ? `\nRecovered: ${JSON.stringify(recovered)}` : ""}` },
          { type: "image", data: base64, mimeType: contentType || "image/png" },
        ],
      };
    },
  }));

  const managedStatusSnapshot = (ctx: ToolContext, policy: ReturnType<typeof resolveManagedBrowserProfile>) => {
    const contextKey = managedBrowserContextKey(ctx, policy);
    const rememberedTabId = currentManagedTabsByContext.get(contextKey);
    const observedLifecycle: { state?: string; updatedAt: string | null; readySince?: string; currentTabId?: string | null } = managedLifecycleByContext.get(contextKey) || { updatedAt: null, currentTabId: null };
    const lifecycle = lifecycleStateForPolicy(policy, { ...observedLifecycle, currentTabId: rememberedTabId || observedLifecycle.currentTabId });
    const warmup = shouldWarmupManagedProfile(policy, lifecycle);
    const rotation = shouldRotateManagedProfile(policy, lifecycle);
    const readySince = observedLifecycle.readySince || null;
    const readyAgeMs = readySince ? Date.now() - new Date(readySince).getTime() : null;
    const diagnostics = {
      contextKey,
      hasCurrentTab: Boolean(rememberedTabId),
      requiresExistingWindow: Boolean(policy.displayPolicy?.requiresExistingWindow),
      allowServerOwnedVisibleLaunch: Boolean(policy.displayPolicy?.allowServerOwnedVisibleLaunch),
      managedControlPath: policy.displayPolicy?.requiresExistingWindow ? 'bind_existing_server_owned_tab' : 'server_owned_managed_tab',
      readySince,
      readyAgeMs: Number.isFinite(readyAgeMs) ? readyAgeMs : null,
      nextRecommendedAction: rotation.shouldRotate ? 'managed_browser_rotate' : (warmup.shouldWarmup ? 'managed_browser_warmup' : (rememberedTabId ? 'managed_browser_snapshot' : (policy.displayPolicy?.requiresExistingWindow ? 'managed_browser_bind_existing_tab' : 'managed_browser_navigate'))),
      primaryStateTool: 'managed_browser_snapshot',
      visualFallbackTool: 'managed_browser_vision',
    };
    return { rememberedTabId, lifecycle, warmup, rotation, diagnostics };
  };

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_profile_status",
    description: "Inspect managed browser profile resolution, persona keys, display policy, and remembered current tab without opening a browser.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { profile, site } = params as { profile?: string; site?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const { rememberedTabId, lifecycle, warmup, rotation, diagnostics } = managedStatusSnapshot(ctx, policy);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            profile: policy.profile,
            siteKey: policy.siteKey,
            userId: policy.userId,
            sessionKey: policy.sessionKey,
            defaultStartUrl: policy.defaultStartUrl,
            profileDir: policy.profileDir,
            browserPersonaKey: policy.browserPersonaKey,
            humanPersonaKey: policy.humanPersonaKey,
            defaultHumanProfile: policy.defaultHumanProfile,
            displayPolicy: policy.displayPolicy,
            lifecyclePolicy: policy.lifecyclePolicy,
            securityPolicy: policy.securityPolicy,
            lifecycle,
            warmup,
            rotation,
            diagnostics,
            timeline: summarizeAgentHistoryTimeline([]),
            currentTabId: rememberedTabId || null,
          }, null, 2),
        }],
      };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_warmup",
    description: "Explicitly warm up a managed browser profile only when its lifecycle policy allows it; otherwise reports a no-op without opening a browser.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        url: { type: "string", description: "Optional warmup URL; defaults to the profile start URL when policy allows warmup" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { profile, site, humanProfile, url } = params as { profile?: string; site?: string; humanProfile?: string; url?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const before = managedStatusSnapshot(ctx, policy);
      if (!before.warmup.shouldWarmup) {
        return toToolResult({
          profile: policy.profile,
          siteKey: policy.siteKey,
          lifecycle: before.lifecycle,
          warmup: before.warmup,
          started: false,
          currentTabId: before.rememberedTabId || null,
        });
      }

      assertManagedBrowserCanOpenTab(policy, undefined);
      const result = await fetchApi(baseUrl, "/tabs", {
        method: "POST",
        body: JSON.stringify(managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile)),
      });
      rememberManagedTab(ctx, policy, result);
      const after = managedStatusSnapshot(ctx, policy);
      return toToolResult({
        profile: policy.profile,
        siteKey: policy.siteKey,
        lifecycle: after.lifecycle,
        warmup: after.warmup,
        started: true,
        currentTabId: after.rememberedTabId || null,
        result,
      });
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_rotate",
    description: "Explicitly rotate a managed browser profile when its lifecycle is expired, or when force is true. Opens and remembers a fresh managed tab without closing the previous tab.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        url: { type: "string", description: "Optional rotation URL; defaults to the profile start URL" },
        force: { type: "boolean", description: "Rotate even when the current lifecycle is not EXPIRED" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { profile, site, humanProfile, url, force = false } = params as { profile?: string; site?: string; humanProfile?: string; url?: string; force?: boolean };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const before = managedStatusSnapshot(ctx, policy);
      const rotation = shouldRotateManagedProfile(policy, before.lifecycle, { force });
      if (!rotation.shouldRotate) {
        return toToolResult({
          profile: policy.profile,
          siteKey: policy.siteKey,
          lifecycle: before.lifecycle,
          rotationPolicy: policy.lifecyclePolicy?.rotation || {},
          rotation,
          rotated: false,
          currentTabId: before.rememberedTabId || null,
        });
      }

      const previousTabId = before.rememberedTabId || null;
      assertManagedBrowserCanOpenTab(policy, undefined);
      const result = await fetchApi(baseUrl, "/tabs", {
        method: "POST",
        body: JSON.stringify(managedTabCreatePayload(policy, url || policy.defaultStartUrl, humanProfile)),
      });
      rememberManagedTab(ctx, policy, result);
      const after = managedStatusSnapshot(ctx, policy);
      return toToolResult({
        profile: policy.profile,
        siteKey: policy.siteKey,
        lifecycle: after.lifecycle,
        rotationPolicy: policy.lifecyclePolicy?.rotation || {},
        rotation,
        rotated: true,
        previousTabId,
        currentTabId: after.rememberedTabId || null,
        result,
      });
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_click_smart",
    description: "Managed-profile smart humanized click. Uses managed profile policy and the same humanized Camoufox click route.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        ref: { type: "string", description: "Element ref from managed_browser_snapshot, e.g. @e1" },
        selector: { type: "string", description: "CSS selector fallback" },
        fallback_hint: { type: "string", description: "Target healing hint" },
        expected_text: { type: "string", description: "Text expected after successful click" },
        action_key: { type: "string", description: "Stable action identifier" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, humanProfile, site_key, ...rest } = params as { tabId?: string; profile?: string; site?: string; humanProfile?: string; site_key?: string } & Record<string, unknown>;
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/click`, {
        method: "POST",
        body: JSON.stringify(managedHumanPayload(policy, humanProfile, {
          ...rest,
          site_key: policy.siteKey,
          ref: normalizeHermesRef(rest.ref),
        })),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_type_smart",
    description: "Managed-profile smart humanized typing. Uses managed profile policy and the same humanized Camoufox type route.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        ...managedHumanProperties,
        tabId: { type: "string", description: "Optional tab identifier" },
        ref: { type: "string", description: "Element ref from managed_browser_snapshot, e.g. @e2" },
        selector: { type: "string", description: "CSS selector fallback" },
        text: { type: "string", description: "Text to type" },
        clear_first: { type: "boolean", description: "Clear field before typing" },
        fallback_hint: { type: "string", description: "Target healing hint" },
        expected_text: { type: "string", description: "Text expected after typing" },
        action_key: { type: "string", description: "Stable field identifier" },
      },
      required: ["profile", "text"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, humanProfile, clear_first, site_key, ...rest } = params as { tabId?: string; profile?: string; site?: string; humanProfile?: string; clear_first?: boolean; site_key?: string } & Record<string, unknown>;
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/type`, {
        method: "POST",
        body: JSON.stringify(managedHumanPayload(policy, humanProfile, {
          ...rest,
          site_key: policy.siteKey,
          clearFirst: clear_first,
          ref: normalizeHermesRef(rest.ref),
        })),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "managed_browser_record_flow",
    description: "Managed-profile persistence of the current tab interaction history as a reusable local workflow.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        tabId: { type: "string", description: "Optional tab identifier to record from" },
        action_key: { type: "string", description: "Stable workflow identifier" },
        url_patterns: { type: "array", items: { type: "string" }, description: "Compatibility metadata stored as labels" },
        required_signals: { type: "array", items: { type: "string" }, description: "Compatibility metadata stored as labels" },
        confidence: { type: "number", description: "Compatibility metadata stored as label" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { tabId, profile, site, action_key = "default", url_patterns = [], required_signals = [], confidence } = params as { tabId?: string; profile?: string; site?: string; action_key?: string; url_patterns?: string[]; required_signals?: string[]; confidence?: number };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const resolvedTabId = resolveManagedTabId(ctx, policy, tabId);
      const labels = [...url_patterns, ...required_signals];
      if (confidence !== undefined) labels.push(`confidence:${confidence}`);
      const result = await fetchApi(baseUrl, "/memory/record", {
        method: "POST",
        body: JSON.stringify({ userId: policy.userId, tabId: resolvedTabId, siteKey: policy.siteKey, actionKey: action_key, labels }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((_ctx: ToolContext) => ({
    name: "managed_browser_list_memory",
    description: "Managed-profile list/search of locally persisted browser workflows.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        query: { type: "string", description: "Optional search query" },
      },
      required: ["profile"],
    },
    async execute(_id, params) {
      const { profile, site, query = "" } = params as { profile?: string; site?: string; query?: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const result = await fetchApi(baseUrl, appendQuery('/memory/search', { siteKey: policy.siteKey, q: query }));
      return toToolResult(result);
    },
  }));

  api.registerTool((_ctx: ToolContext) => ({
    name: "managed_browser_inspect_memory",
    description: "Managed-profile inspection of one locally persisted browser workflow and metadata.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        action_key: { type: "string", description: "Stable workflow identifier" },
      },
      required: ["profile", "action_key"],
    },
    async execute(_id, params) {
      const { profile, site, action_key } = params as { profile?: string; site?: string; action_key: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const result = await fetchApi(baseUrl, appendQuery('/memory/search', { siteKey: policy.siteKey, q: action_key }));
      return toToolResult(result);
    },
  }));

  api.registerTool((_ctx: ToolContext) => ({
    name: "managed_browser_delete_memory",
    description: "Managed-profile deletion of one locally persisted browser workflow.",
    parameters: {
      type: "object",
      properties: {
        ...managedProfileProperties,
        action_key: { type: "string", description: "Stable workflow identifier" },
      },
      required: ["profile", "action_key"],
    },
    async execute(_id, params) {
      const { profile, site, action_key } = params as { profile?: string; site?: string; action_key: string };
      const policy = resolveManagedBrowserProfile({ profile, site });
      const result = await fetchApi(baseUrl, appendQuery('/memory/delete', { siteKey: policy.siteKey, actionKey: action_key }), {
        method: "DELETE",
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_navigate",
    description:
      "Hermes-compatible browser navigation using the same Camoufox/VNC-visible browser. Creates a tab when tabId is omitted, otherwise navigates the existing tab. Prefer this DOM/accessibility-first tool over VNC vision.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tabId: { type: "string", description: "Optional existing tab identifier" },
      },
      required: ["url"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId?: string; url: string } & Record<string, unknown>;
      const sessionKey = ctx.sessionKey || "default";
      const userId = ctx.agentId || fallbackUserId;
      const result = tabId
        ? await fetchApi(baseUrl, `/tabs/${tabId}/navigate`, {
            method: "POST",
            body: JSON.stringify({ ...rest, userId }),
          })
        : await fetchApi(baseUrl, "/tabs", {
            method: "POST",
            body: JSON.stringify({ ...rest, userId, sessionKey }),
          });
      rememberHermesTab(ctx, result);
      if (tabId) rememberHermesTab(ctx, { tabId });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_snapshot",
    description:
      "Hermes-compatible DOM/accessibility snapshot. Returns text refs for browser_click/browser_type and deliberately does not include a screenshot by default; use browser_vision only as fallback/final visual check.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        offset: { type: "number", description: "Character offset for paginated snapshots" },
        full: { type: "boolean", description: "Compatibility flag; compact snapshot is the default" },
      },
      required: [],
    },
    async execute(_id, params) {
      const { tabId, offset } = params as { tabId?: string; offset?: number; full?: boolean };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const qs = offset ? `&offset=${offset}` : "";
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/snapshot?userId=${userId}&includeScreenshot=false${qs}`) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify({ url: result.url, refsCount: result.refsCount, snapshot: result.snapshot, truncated: result.truncated, totalChars: result.totalChars, hasMore: result.hasMore, nextOffset: result.nextOffset }, null, 2) }],
      };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_click",
    description: "Hermes-compatible click by accessibility ref such as @e1, or CSS selector fallback.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. @e1" },
        selector: { type: "string", description: "CSS selector fallback" },
      },
      required: [],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId?: string } & Record<string, unknown>;
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/click`, {
        method: "POST",
        body: JSON.stringify({ ...rest, ref: normalizeHermesRef(rest.ref), userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_type",
    description: "Hermes-compatible typing into an element by accessibility ref such as @e2, or CSS selector fallback.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. @e2" },
        selector: { type: "string", description: "CSS selector fallback" },
        text: { type: "string", description: "Text to type" },
        pressEnter: { type: "boolean", description: "Press Enter after typing" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId?: string } & Record<string, unknown>;
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/type`, {
        method: "POST",
        body: JSON.stringify({ ...rest, ref: normalizeHermesRef(rest.ref), userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_press",
    description: "Hermes-compatible keyboard press, e.g. Enter, Tab, Escape, ArrowDown.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        key: { type: "string", description: "Key to press" },
      },
      required: ["key"],
    },
    async execute(_id, params) {
      const { tabId, key } = params as { tabId?: string; key: string };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/press`, {
        method: "POST",
        body: JSON.stringify({ key, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_scroll",
    description: "Hermes-compatible page scroll.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "number", description: "Pixels to scroll" },
      },
      required: ["direction"],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId?: string } & Record<string, unknown>;
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/scroll`, {
        method: "POST",
        body: JSON.stringify({ ...rest, userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_back",
    description: "Hermes-compatible browser history back action.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: [],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId?: string };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/back`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_console",
    description: "Hermes-compatible page evaluation/console inspection. Use expression to inspect DOM/page state before falling back to vision.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        expression: { type: "string", description: "JavaScript expression to evaluate in the page context" },
      },
      required: [],
    },
    async execute(_id, params) {
      const { tabId, expression = "document.title" } = params as { tabId?: string; expression?: string };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/evaluate`, {
        method: "POST",
        body: JSON.stringify({ userId, expression }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_get_images",
    description: "Hermes-compatible list of page images with URLs/alt text. Prefer this before screenshot vision when inspecting images.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: [],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId?: string };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/images?userId=${userId}`);
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_vision",
    description:
      "Hermes-compatible visual fallback. Use only for CAPTCHA, visual ambiguity, or final visual verification; browser_snapshot/browser_click/browser_type remain the primary path.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        question: { type: "string", description: "What to inspect visually" },
        annotate: { type: "boolean", description: "Compatibility flag for element labels" },
      },
      required: ["question"],
    },
    async execute(_id, params) {
      const { tabId, question } = params as { tabId?: string; question: string; annotate?: boolean };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const url = `${baseUrl}/tabs/${resolvedTabId}/screenshot?userId=${userId}`;
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        const text = await res.text();
        return { content: [{ type: "text", text: `Visual fallback failed: ${text}` }] };
      }
      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        content: [
          { type: "text", text: `Visual fallback request: ${question}\nPolicy: use browser_snapshot/browser_click/browser_type first; browser_vision is not the primary page state source.` },
          { type: "image", data: base64, mimeType: contentType || "image/png" },
        ],
      };
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_click_smart",
    description: "Hermes-compatible smart click. Uses the same Camoufox tab and lets the backend self-heal from refs/selectors when available.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. @e1" },
        selector: { type: "string", description: "CSS selector fallback" },
        fallback_hint: { type: "string", description: "Operator/LLM hint for target healing" },
        expected_text: { type: "string", description: "Text expected after successful click" },
        site_key: { type: "string", description: "Stable site identifier" },
        action_key: { type: "string", description: "Stable action identifier" },
        allow_console_fallback: { type: "boolean", description: "Compatibility flag; backend stays deterministic/local" },
      },
      required: [],
    },
    async execute(_id, params) {
      const { tabId, ...rest } = params as { tabId?: string } & Record<string, unknown>;
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/click`, {
        method: "POST",
        body: JSON.stringify({ ...rest, ref: normalizeHermesRef(rest.ref), userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_type_smart",
    description: "Hermes-compatible smart typing. Uses Camoufox DOM refs/selectors and supports expected-text/fallback hints for future healing.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        ref: { type: "string", description: "Element ref from browser_snapshot, e.g. @e2" },
        selector: { type: "string", description: "CSS selector fallback" },
        text: { type: "string", description: "Text to type" },
        clear_first: { type: "boolean", description: "Clear field before typing" },
        fallback_hint: { type: "string", description: "Operator/LLM hint for target healing" },
        expected_text: { type: "string", description: "Text expected after typing" },
        site_key: { type: "string", description: "Stable site identifier" },
        action_key: { type: "string", description: "Stable field identifier" },
        allow_console_fallback: { type: "boolean", description: "Compatibility flag; backend stays deterministic/local" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const { tabId, clear_first, ...rest } = params as { tabId?: string; clear_first?: boolean } & Record<string, unknown>;
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs/${resolvedTabId}/type`, {
        method: "POST",
        body: JSON.stringify({ ...rest, clearFirst: clear_first, ref: normalizeHermesRef(rest.ref), userId }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_record_flow",
    description: "Hermes-compatible persistence of the current tab interaction history as a reusable local AgentHistory/browser workflow.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier to record from" },
        site_key: { type: "string", description: "Stable site identifier" },
        action_key: { type: "string", description: "Stable workflow identifier" },
        url: { type: "string", description: "Compatibility metadata; not required by Camoufox recorder" },
        url_patterns: { type: "array", items: { type: "string" }, description: "Compatibility metadata stored as labels" },
        required_signals: { type: "array", items: { type: "string" }, description: "Compatibility metadata stored as labels" },
        confidence: { type: "number", description: "Compatibility metadata stored as label" },
      },
      required: ["site_key"],
    },
    async execute(_id, params) {
      const { tabId, site_key, action_key = "default", url_patterns = [], required_signals = [], confidence } = params as {
        tabId?: string;
        site_key: string;
        action_key?: string;
        url_patterns?: string[];
        required_signals?: string[];
        confidence?: number;
      };
      const resolvedTabId = resolveHermesTabId(ctx, tabId);
      const userId = ctx.agentId || fallbackUserId;
      const labels = [...url_patterns, ...required_signals];
      if (confidence !== undefined) labels.push(`confidence:${confidence}`);
      const result = await fetchApi(baseUrl, "/memory/record", {
        method: "POST",
        body: JSON.stringify({ userId, tabId: resolvedTabId, siteKey: site_key, actionKey: action_key, labels }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_run_memory",
    description: "Hermes-compatible replay of a persisted browser workflow with deterministic local self-healing.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Optional existing tab identifier" },
        site_key: { type: "string", description: "Stable site identifier" },
        action_key: { type: "string", description: "Stable workflow identifier" },
        url: { type: "string", description: "Optional URL to navigate to before replay" },
        record_if_success: { type: "boolean", description: "Compatibility flag" },
        allow_llm_repair: { type: "boolean", description: "Compatibility flag; Camoufox uses local repair" },
        stop_on_error: { type: "boolean", description: "Compatibility flag" },
        timeout_seconds: { type: "number", description: "Compatibility flag" },
        parameters: { type: "object", description: "Parameters for parameterized replay steps" },
      },
      required: ["site_key"],
    },
    async execute(_id, params) {
      const { tabId, site_key, action_key = "default", url, parameters = {} } = params as {
        tabId?: string;
        site_key: string;
        action_key?: string;
        url?: string;
        parameters?: Record<string, unknown>;
      };
      const userId = ctx.agentId || fallbackUserId;
      const sessionKey = ctx.sessionKey || "default";
      let resolvedTabId = tabId;
      if (url) {
        const opened = await fetchApi(baseUrl, "/tabs", {
          method: "POST",
          body: JSON.stringify({ url, userId, sessionKey }),
        }) as Record<string, unknown>;
        resolvedTabId = String(opened.tabId || opened.targetId || resolvedTabId || "");
      }
      const result = await fetchApi(baseUrl, "/memory/replay", {
        method: "POST",
        body: JSON.stringify({ userId, tabId: resolvedTabId, siteKey: site_key, actionKey: action_key, learnRepairs: true, parameters }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((_ctx: ToolContext) => ({
    name: "browser_list_memory",
    description: "Hermes-compatible list/search of locally persisted browser workflows.",
    parameters: {
      type: "object",
      properties: {
        site_key: { type: "string", description: "Optional stable site filter" },
        query: { type: "string", description: "Optional search query" },
      },
      required: ["site_key"],
    },
    async execute(_id, params) {
      const { site_key, query = "" } = params as { site_key: string; query?: string };
      const result = await fetchApi(baseUrl, appendQuery('/memory/search', { siteKey: site_key, q: query }));
      return toToolResult(result);
    },
  }));

  api.registerTool((_ctx: ToolContext) => ({
    name: "browser_inspect_memory",
    description: "Hermes-compatible inspection of one locally persisted browser workflow and metadata.",
    parameters: {
      type: "object",
      properties: {
        site_key: { type: "string", description: "Stable site identifier" },
        action_key: { type: "string", description: "Stable workflow identifier" },
      },
      required: ["site_key", "action_key"],
    },
    async execute(_id, params) {
      const { site_key, action_key } = params as { site_key: string; action_key: string };
      const result = await fetchApi(baseUrl, appendQuery('/memory/search', { siteKey: site_key, q: action_key }));
      return toToolResult(result);
    },
  }));

  api.registerTool((_ctx: ToolContext) => ({
    name: "browser_delete_memory",
    description: "Hermes-compatible deletion of one locally persisted browser workflow.",
    parameters: {
      type: "object",
      properties: {
        site_key: { type: "string", description: "Stable site identifier" },
        action_key: { type: "string", description: "Stable workflow identifier" },
      },
      required: ["site_key", "action_key"],
    },
    async execute(_id, params) {
      const { site_key, action_key } = params as { site_key: string; action_key: string };
      const result = await fetchApi(baseUrl, appendQuery('/memory/delete', { siteKey: site_key, actionKey: action_key }), {
        method: "DELETE",
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "browser_run_flow",
    description: "Hermes-compatible declared flow runner. Replays a local Camoufox AgentHistory flow by flow_name.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Optional existing tab identifier" },
        site_key: { type: "string", description: "Stable site identifier" },
        flow_name: { type: "string", description: "Flow file/action name without extension" },
        start_url: { type: "string", description: "Optional starting URL" },
        allow_console_fallback: { type: "boolean", description: "Compatibility flag" },
        stop_on_error: { type: "boolean", description: "Compatibility flag" },
        timeout_seconds: { type: "number", description: "Compatibility flag" },
      },
      required: ["site_key", "flow_name"],
    },
    async execute(_id, params) {
      const { tabId, site_key, flow_name, start_url } = params as { tabId?: string; site_key: string; flow_name: string; start_url?: string };
      const userId = ctx.agentId || fallbackUserId;
      const sessionKey = ctx.sessionKey || "default";
      let resolvedTabId = tabId;
      if (start_url) {
        const opened = await fetchApi(baseUrl, "/tabs", {
          method: "POST",
          body: JSON.stringify({ url: start_url, userId, sessionKey }),
        }) as Record<string, unknown>;
        resolvedTabId = String(opened.tabId || opened.targetId || resolvedTabId || "");
      }
      const result = await fetchApi(baseUrl, "/memory/replay", {
        method: "POST",
        body: JSON.stringify({ userId, tabId: resolvedTabId, siteKey: site_key, actionKey: flow_name, learnRepairs: true }),
      });
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_list_tabs",
    description: "List all open Camoufox tabs for a user.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    async execute(_id, _params) {
      const userId = ctx.agentId || fallbackUserId;
      const result = await fetchApi(baseUrl, `/tabs?userId=${userId}`);
      return toToolResult(result);
    },
  }));

  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_import_cookies",
    description:
      "Import cookies into the current Camoufox user session (Netscape cookie file). Use to authenticate to sites like LinkedIn without interactive login.",
    parameters: {
      type: "object",
      properties: {
        cookiesPath: { type: "string", description: "Path to Netscape-format cookies.txt file" },
        domainSuffix: {
          type: "string",
          description: "Only import cookies whose domain ends with this suffix",
        },
      },
      required: ["cookiesPath"],
    },
    async execute(_id, params) {
      const { cookiesPath, domainSuffix } = params as {
        cookiesPath: string;
        domainSuffix?: string;
      };

      const userId = ctx.agentId || fallbackUserId;

      const envCfg = loadConfig();
      const cookiesDir = resolve(envCfg.cookiesDir);

      const pwCookies = await readCookieFile({
        cookiesDir,
        cookiesPath,
        domainSuffix,
      });

      if (!envCfg.apiKey) {
        throw new Error(
          "CAMOFOX_API_KEY is not set. Cookie import is disabled unless you set CAMOFOX_API_KEY for both the server and the OpenClaw plugin environment."
        );
      }

      const result = await fetchApi(baseUrl, `/sessions/${encodeURIComponent(userId)}/cookies`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${envCfg.apiKey}`,
        },
        body: JSON.stringify({ cookies: pwCookies }),
      });

      return toToolResult({ imported: pwCookies.length, userId, result });
    },
  }));

  api.registerCommand({
    name: "camofox",
    description: "Camoufox browser server control (status, start, stop)",
    handler: async (args) => {
      const subcommand = args[0] || "status";
      switch (subcommand) {
        case "status":
          try {
            const health = await fetchApi(baseUrl, "/health");
            api.log?.info?.(`Camoufox server at ${baseUrl}: ${JSON.stringify(health)}`);
          } catch {
            api.log?.error?.(`Camoufox server at ${baseUrl}: not reachable`);
          }
          break;
        case "start":
          if (serverProcess) {
            api.log?.info?.("Camoufox server already running (managed)");
            return;
          }
          if (await checkServerRunning(baseUrl)) {
            api.log?.info?.(`Camoufox server already running at ${baseUrl}`);
            return;
          }
          try {
            serverProcess = await startServer(pluginDir, port, api.log, cfg);
          } catch (err) {
            api.log?.error?.(`Failed to start server: ${(err as Error).message}`);
          }
          break;
        case "stop":
          if (serverProcess) {
            serverProcess.kill();
            serverProcess = null;
            api.log?.info?.("Stopped camofox-browser server");
          } else {
            api.log?.info?.("No managed server process running");
          }
          break;
        default:
          api.log?.error?.(`Unknown subcommand: ${subcommand}. Use: status, start, stop`);
      }
    },
  });

  // Register health check for openclaw doctor/status
  if (api.registerHealthCheck) {
    api.registerHealthCheck("camofox-browser", async () => {
      try {
        const health = (await fetchApi(baseUrl, "/health")) as {
          status: string;
          engine?: string;
          activeTabs?: number;
        };
        return {
          status: "ok",
          message: `Server running (${health.engine || "camoufox"})`,
          details: {
            url: baseUrl,
            engine: health.engine,
            activeTabs: health.activeTabs,
            managed: serverProcess !== null,
          },
        };
      } catch {
        return {
          status: serverProcess ? "warn" : "error",
          message: serverProcess
            ? "Server starting..."
            : `Server not reachable at ${baseUrl}`,
          details: {
            url: baseUrl,
            managed: serverProcess !== null,
            hint: "Run: openclaw camofox start",
          },
        };
      }
    });
  }

  // Register RPC methods for gateway integration
  if (api.registerRpc) {
    api.registerRpc("camofox.health", async () => {
      try {
        const health = (await fetchApi(baseUrl, "/health")) as Record<string, unknown>;
        return { status: "ok", ...health };
      } catch (err) {
        return { status: "error", error: (err as Error).message };
      }
    });

    api.registerRpc("camofox.status", async () => {
      const running = await checkServerRunning(baseUrl);
      return {
        running,
        managed: serverProcess !== null,
        pid: serverProcess?.pid || null,
        url: baseUrl,
        port,
      };
    });
  }

  // Register CLI subcommands (openclaw camofox ...)
  if (api.registerCli) {
    api.registerCli(
      ({ program }) => {
        const camofox = program
          .command("camofox")
          .description("Camoufox anti-detection browser automation");

        camofox
          .command("status")
          .description("Show server status")
          .action(async () => {
            try {
              const health = (await fetchApi(baseUrl, "/health")) as {
                status: string;
                engine?: string;
                activeTabs?: number;
              };
              console.log(`Camoufox server: ${health.status}`);
              console.log(`  URL: ${baseUrl}`);
              console.log(`  Engine: ${health.engine || "camoufox"}`);
              console.log(`  Active tabs: ${health.activeTabs ?? 0}`);
              console.log(`  Managed: ${serverProcess !== null}`);
            } catch {
              console.log(`Camoufox server: not reachable`);
              console.log(`  URL: ${baseUrl}`);
              console.log(`  Managed: ${serverProcess !== null}`);
              console.log(`  Hint: Run 'openclaw camofox start' to start the server`);
            }
          });

        camofox
          .command("start")
          .description("Start the camofox server")
          .action(async () => {
            if (serverProcess) {
              console.log("Camoufox server already running (managed by plugin)");
              return;
            }
            if (await checkServerRunning(baseUrl)) {
              console.log(`Camoufox server already running at ${baseUrl}`);
              return;
            }
            try {
              console.log(`Starting camofox server on port ${port}...`);
              serverProcess = await startServer(pluginDir, port, api.log, cfg);
              console.log(`Camoufox server started at ${baseUrl}`);
            } catch (err) {
              console.error(`Failed to start server: ${(err as Error).message}`);
              process.exit(1);
            }
          });

        camofox
          .command("stop")
          .description("Stop the camofox server")
          .action(async () => {
            if (serverProcess) {
              serverProcess.kill();
              serverProcess = null;
              console.log("Stopped camofox server");
            } else {
              console.log("No managed server process running");
            }
          });

        camofox
          .command("configure")
          .description("Configure camofox plugin settings")
          .action(async () => {
            console.log("Camoufox Browser Configuration");
            console.log("================================");
            console.log("");
            console.log("Current settings:");
            console.log(`  Server URL: ${baseUrl}`);
            console.log(`  Port: ${port}`);
            console.log(`  Auto-start: ${autoStart}`);
            console.log("");
            console.log("Plugin config (openclaw.json):");
            console.log("");
            console.log("  plugins:");
            console.log("    entries:");
            console.log("      camofox-browser:");
            console.log("        enabled: true");
            console.log("        config:");
            console.log("          port: 9377");
            console.log("          autoStart: true");
            console.log("");
            console.log("To use camofox as the ONLY browser tool, disable the built-in:");
            console.log("");
            console.log("  tools:");
            console.log('    deny: ["browser"]');
            console.log("");
            console.log("This removes OpenClaw's built-in browser tool, leaving camofox tools.");
          });

        camofox
          .command("tabs")
          .description("List active browser tabs")
          .option("--user <userId>", "Filter by user ID")
          .action(async (opts: { user?: string }) => {
            try {
              const endpoint = opts.user ? `/tabs?userId=${opts.user}` : "/tabs";
              const tabs = (await fetchApi(baseUrl, endpoint)) as Array<{
                tabId: string;
                userId: string;
                url: string;
                title: string;
              }>;
              if (tabs.length === 0) {
                console.log("No active tabs");
                return;
              }
              console.log(`Active tabs (${tabs.length}):`);
              for (const tab of tabs) {
                console.log(`  ${tab.tabId} [${tab.userId}] ${tab.title || tab.url}`);
              }
            } catch (err) {
              console.error(`Failed to list tabs: ${(err as Error).message}`);
            }
          });
      },
      { commands: ["camofox"] }
    );
  }
}
